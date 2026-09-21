#!/usr/bin/env python3
"""Exercise the RDPKT006 seek-epoch handshake with mpv's real seek path."""
import http.server
import pathlib
import socketserver
import struct
import subprocess
import sys
import threading

root = pathlib.Path(__file__).resolve().parent
data = (root / "fixture.rdp").read_bytes()
if data[:8] != b"RDPKT001":
    raise SystemExit("bad fixture")
pos = 16
configs = []
for _ in range(2):
    start = pos
    pos += 68
    extra = struct.unpack_from("<I", data, pos)[0]
    pos += 4 + extra
    configs.append(data[start:pos] + struct.pack("<III", 0, 0, 0))
records_start = pos
while struct.unpack_from("<I", data, pos)[0] != 0x31464F45:
    pos += 52 + struct.unpack_from("<I", data, pos + 48)[0]
records = data[records_start:pos]

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        self.wfile.write(b"RDPKT006" + struct.pack("<II", 6, 2) + b"".join(configs))
        self.wfile.write(struct.pack("<IQq", 0x314B4553, 7, 2000))
        self.wfile.write(records)
        self.wfile.write(struct.pack("<I", 0x31464F45))
        self.wfile.flush()

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    result = subprocess.run([
        sys.argv[1], "-v", "--no-config", "--demuxer=rustdash",
        "--demuxer-seekable-cache=no", "--cache=yes", "--hwdec=no",
        "--vo=null", "--ao=null", "--start=2", "--frames=10",
        f"http://127.0.0.1:{server.server_address[1]}/dvr.rdp",
    ], text=True, capture_output=True, timeout=30)
    thread.join()

log = result.stdout + result.stderr
required = ["rustdash-live-v6", "DASH seek epoch ready epoch=7", "DASH seek committed"]
if result.returncode or any(marker not in log for marker in required):
    print(log)
    raise SystemExit("DVR seek handshake failed")
print("PASS: RDPKT006 prepared a seek epoch and mpv committed it without reloading")
