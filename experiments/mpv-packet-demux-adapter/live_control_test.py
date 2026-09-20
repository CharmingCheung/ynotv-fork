#!/usr/bin/env python3
import argparse
import json
import os
import selectors
import socket
import subprocess
import time
from pathlib import Path


def send_command(socket_path: Path, command: list[object]) -> None:
    deadline = time.monotonic() + 2
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(socket_path))
                client.sendall(json.dumps({"command": command}).encode() + b"\n")
            return
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("seek", "stop", "quit"))
    parser.add_argument("mpv", type=Path)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("log", type=Path)
    parser.add_argument("--dylib-dir")
    args = parser.parse_args()

    socket_path = args.log.with_suffix(".sock")
    socket_path.unlink(missing_ok=True)
    env = os.environ.copy()
    env["RUSTDASH_DELAY_MS"] = "10000"
    if args.dylib_dir:
        env["DYLD_LIBRARY_PATH"] = args.dylib_dir
    command = [
        str(args.mpv), "-v", "--no-config", "--idle=yes",
        f"--input-ipc-server={socket_path}", "--demuxer=rustdash",
        "--demuxer-seekable-cache=no", "--cache=no", "--hwdec=no",
        "--vo=null", "--ao=null", str(args.fixture),
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, env=env)
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    lines: list[str] = []
    sent = False
    saw_seek = False
    saw_shutdown = False
    deadline = time.monotonic() + 8
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            for key, _ in selector.select(0.2):
                line = key.fileobj.readline().decode(errors="replace")
                if not line:
                    continue
                lines.append(line)
                if not sent and "producer waiting group=1" in line:
                    action = ["seek", 0, "absolute"] if args.mode == "seek" else [args.mode]
                    send_command(socket_path, action)
                    sent = True
                if "experimental seek target=" in line:
                    saw_seek = True
                if "bounded producer shutdown" in line:
                    saw_shutdown = True
                    if args.mode == "stop":
                        send_command(socket_path, ["quit"])
                if args.mode == "seek" and saw_seek and "producer waiting group=1" in line:
                    send_command(socket_path, ["quit"])
            if args.mode in ("quit", "stop") and sent and saw_shutdown and process.poll() is not None:
                break
        if process.poll() is None:
            process.kill()
            raise RuntimeError(f"{args.mode} test timed out")
    finally:
        remaining = process.stdout.read().decode(errors="replace")
        if remaining:
            lines.append(remaining)
        process.wait()
        socket_path.unlink(missing_ok=True)
        args.log.write_text("".join(lines))

    text = "".join(lines)
    if not sent or not saw_shutdown:
        raise RuntimeError(f"{args.mode}: command or shutdown evidence missing")
    if args.mode == "seek" and (not saw_seek or "producer wait interrupted" not in text):
        raise RuntimeError("seek did not interrupt the blocking dequeue")
    print(f"PASS mode={args.mode} rc={process.returncode}")


if __name__ == "__main__":
    main()
