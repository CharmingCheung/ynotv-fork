#!/usr/bin/env python3
"""Verify that selecting a subtitle does not synthesize an RDPKT006 seek."""
import http.server
import json
import os
import pathlib
import selectors
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time


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

subtitle_codec = b"subrip".ljust(32, b"\0")
subtitle_config = struct.pack(
    "<IIIiiiiii32sIIII",
    3, 1, 3, 1, 1000, 0, 0, 0, 0, subtitle_codec,
    0, 0, 0, 0,
)

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
        self.wfile.write(
            b"RDPKT006" + struct.pack("<II", 6, 3)
            + b"".join(configs) + subtitle_config + records
            + struct.pack("<I", 0x31464F45)
        )
        self.wfile.flush()


def send_command(socket_path, command):
    deadline = time.monotonic() + 3
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(socket_path))
                client.sendall(json.dumps({"command": command}).encode() + b"\n")
                response = b""
                while b"\n" not in response:
                    response += client.recv(4096)
                return json.loads(response.splitlines()[0])
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)


with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    socket_path = pathlib.Path(f"/tmp/rdp-sub-switch-{os.getpid()}.sock")
    socket_path.unlink(missing_ok=True)
    env = os.environ.copy()
    env["RUSTDASH_DELAY_MS"] = "500"
    process = subprocess.Popen([
        sys.argv[1], "-v", "--no-config", "--idle=yes",
        f"--input-ipc-server={socket_path}", "--demuxer=rustdash",
        "--demuxer-seekable-cache=no", "--cache=no", "--hwdec=no",
        "--vo=null", "--ao=null",
        f"http://127.0.0.1:{server.server_address[1]}/dvr.rdp",
    ], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    output = ""
    switched = False
    deadline = time.monotonic() + 12
    try:
        while time.monotonic() < deadline and process.poll() is None:
            for key, _ in selector.select(0.2):
                output += os.read(key.fileobj.fileno(), 65536).decode(errors="replace")
            if not switched and socket_path.exists():
                tracks = send_command(socket_path, ["get_property", "track-list/count"])
                position = send_command(socket_path, ["get_property", "time-pos"])
                if (tracks.get("error") == "success" and tracks.get("data") == 3
                        and position.get("error") == "success"
                        and isinstance(position.get("data"), (int, float))
                        and position["data"] >= 0.75):
                    response = send_command(socket_path, ["set_property", "sid", 1])
                    if response.get("error") != "success":
                        raise RuntimeError(f"subtitle switch failed: {response}")
                    switched = True
            if switched and "bounded producer shutdown" in output:
                break
            if switched and "EOF code:" in output:
                break
        if not switched:
            raise RuntimeError("playback did not reach the subtitle switch point\n" + output[-4000:])
        if "DASH seek committed" in output or "DASH seek epoch ready" in output:
            raise RuntimeError("subtitle switch incorrectly entered the DVR seek handshake")
        if "EOF code:" not in output:
            raise RuntimeError("playback froze after selecting the subtitle\n" + output[-4000:])
    finally:
        if process.poll() is None:
            try:
                send_command(socket_path, ["quit"])
            except OSError:
                process.kill()
        output += process.communicate(timeout=3)[0] or ""
        socket_path.unlink(missing_ok=True)
        thread.join()

print("PASS: RDPKT006 subtitle selection did not trigger an unprepared seek")
