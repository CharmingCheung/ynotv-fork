#!/usr/bin/env python3
"""Serve an RDPKT001 fixture as delayed RDPKT003 and verify explicit EOF."""
import http.server, pathlib, socketserver, struct, subprocess, sys, threading, time

root = pathlib.Path(__file__).resolve().parent
data = (root / "fixture.rdp").read_bytes()
if data[:8] != b"RDPKT001": raise SystemExit("bad fixture")
pos = 16
configs = []
for _ in range(2):
    start = pos
    pos += 68
    extra = struct.unpack_from("<I", data, pos)[0]
    pos += 4 + extra
    configs.append(data[start:pos])
records = []
while struct.unpack_from("<I", data, pos)[0] != 0x31464F45:
    start = pos
    pos += 52
    size = struct.unpack_from("<I", data, pos - 4)[0]
    pos += size
    records.append(data[start:pos])

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "application/octet-stream"); self.end_headers()
        self.wfile.write(b"RDPKT003" + struct.pack("<II", 3, 2) + b"".join(configs))
        cut = len(records) // 2
        for record in records[:cut]: self.wfile.write(record)
        self.wfile.flush(); time.sleep(1.0)
        for record in records[cut:]: self.wfile.write(record)
        self.wfile.write(struct.pack("<I", 0x31464F45)); self.wfile.flush()

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    thread = threading.Thread(target=server.handle_request); thread.start()
    result = subprocess.run([sys.argv[1], "-v", "--no-config", "--demuxer=rustdash", "--vo=null", "--ao=null", f"http://127.0.0.1:{server.server_address[1]}/live.rdp"], text=True, capture_output=True)
    thread.join()
log = result.stdout + result.stderr
if result.returncode or "rustdash-live-v3" not in log or "experimental producer final EOF" not in log:
    print(log); raise SystemExit("live stream test failed")
print("PASS: RDPKT003 waited across delayed media and ended only on explicit EOF")
