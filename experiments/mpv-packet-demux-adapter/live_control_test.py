#!/usr/bin/env python3
import argparse
import json
import os
import re
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
                client.settimeout(max(0.1, deadline - time.monotonic()))
                client.connect(str(socket_path))
                client.sendall(json.dumps({"command": command}).encode() + b"\n")
                response = b""
                while b"\n" not in response:
                    chunk = client.recv(4096)
                    if not chunk:
                        break
                    response += chunk
            return
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("seek", "stop", "quit", "queued-stop",
                                         "producer-fail"))
    parser.add_argument("mpv", type=Path)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("log", type=Path)
    parser.add_argument("--dylib-dir")
    args = parser.parse_args()

    socket_path = Path(f"/tmp/rdp-{os.getpid()}-{args.mode}.sock")
    socket_path.unlink(missing_ok=True)
    env = os.environ.copy()
    env["RUSTDASH_DELAY_MS"] = "500" if args.mode == "producer-fail" else \
                                "0" if args.mode == "queued-stop" else "10000"
    if args.dylib_dir:
        env["DYLD_LIBRARY_PATH"] = args.dylib_dir
    command = [
        str(args.mpv), "-v", "--no-config", "--idle=yes",
        f"--input-ipc-server={socket_path}", "--demuxer=rustdash",
        "--demuxer-seekable-cache=no", "--cache=no", "--hwdec=no",
        "--vo=null", "--ao=null", str(args.fixture),
    ]
    if args.mode == "queued-stop":
        command.insert(-1, "--demuxer-max-bytes=1")
    process = subprocess.Popen(command, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, env=env)
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    lines: list[str] = []
    sent = False
    saw_seek = False
    saw_shutdown = False
    saw_failure = False
    quit_sent = False
    deadline = time.monotonic() + 8
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            for key, _ in selector.select(0.2):
                chunk = os.read(key.fileobj.fileno(), 65536).decode(errors="replace")
                if not chunk:
                    continue
                lines.append(chunk)
                output = "".join(lines)
                trigger = "producer blocked queue_count=" if args.mode == "queued-stop" \
                          else "producer waiting group=1"
                if not sent and trigger in output:
                    if args.mode == "producer-fail":
                        os.truncate(args.fixture, 64)
                    else:
                        action = ["seek", 0, "absolute"] if args.mode == "seek" \
                                 else ["stop"] if args.mode == "queued-stop" \
                                 else [args.mode]
                        send_command(socket_path, action)
                    sent = True
                if "experimental seek target=" in output:
                    saw_seek = True
                if "fatal producer error;" in output:
                    saw_failure = True
                    if args.mode == "producer-fail" and not quit_sent:
                        send_command(socket_path, ["quit"])
                        quit_sent = True
                if not saw_shutdown and "bounded producer shutdown" in output:
                    saw_shutdown = True
                    if args.mode in ("stop", "queued-stop"):
                        send_command(socket_path, ["quit"])
                if args.mode == "seek" and saw_seek and not quit_sent and \
                        output.count("producer waiting group=1") >= 2:
                    send_command(socket_path, ["quit"])
                    quit_sent = True
            if args.mode in ("quit", "stop", "queued-stop", "producer-fail") and \
                    sent and saw_shutdown and process.poll() is not None:
                break
        if process.poll() is None:
            process.kill()
            raise RuntimeError(f"{args.mode} test timed out")
    finally:
        remaining_bytes = process.stdout.read()
        remaining = (remaining_bytes or b"").decode(errors="replace")
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
    if args.mode == "queued-stop":
        match = re.search(r"queued_at_cancel=(\d+)", text)
        if not match or int(match.group(1)) == 0:
            raise RuntimeError("stop did not cancel with a non-empty adapter FIFO")
    if args.mode == "producer-fail":
        if not saw_failure or "experimental producer final EOF" in text:
            raise RuntimeError("producer failure was not distinct from final EOF")
    print(f"PASS mode={args.mode} rc={process.returncode}")


if __name__ == "__main__":
    main()
