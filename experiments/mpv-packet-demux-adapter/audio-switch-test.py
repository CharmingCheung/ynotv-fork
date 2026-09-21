#!/usr/bin/env python3
"""Switch the two deterministic audio tracks through mpv JSON IPC and inspect PCM."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import wave


def send(sock, command):
    sock.sendall((json.dumps({"command": command}) + "\n").encode())
    return sock.recv(4096)


def frequency(samples, rate):
    crossings = sum((samples[i - 1] < 0 <= samples[i]) for i in range(1, len(samples)))
    return crossings * rate / len(samples)


def decode_tone(mpv, fixture, output, aid):
    result = subprocess.run([
        mpv, "--no-config", "--demuxer=rustdash", "--hwdec=no", "--vo=null",
        "--ao=pcm", "--audio-format=s16", f"--ao-pcm-file={output}", f"--aid={aid}", fixture,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise SystemExit(f"tone decode for aid={aid} failed")
    with wave.open(output, "rb") as wav:
        rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())
    samples = list(memoryview(raw).cast("h"))
    return frequency(samples[len(samples)//4:len(samples)*3//4], rate)


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: audio-switch-test.py MPV FIXTURE RESULT_DIR")
    mpv, fixture, result_dir = sys.argv[1:]
    first = decode_tone(mpv, fixture, os.path.join(result_dir, "aid1.wav"), 1)
    second = decode_tone(mpv, fixture, os.path.join(result_dir, "aid2.wav"), 2)
    if not (380 < first < 500 and 760 < second < 1000):
        raise SystemExit(f"unexpected track source frequencies: {first}, {second}")
    ipc = tempfile.mktemp(prefix="ynotv-c8-ipc-", dir="/tmp")
    log_path = os.path.join(result_dir, "audio-switch.log")
    log = open(log_path, "wb")
    process = subprocess.Popen([
        mpv, "--no-config", "--demuxer=rustdash", "--hwdec=no", "--vo=null",
        "--ao=null", "--video-sync=audio", "-v",
        "--demuxer-readahead-secs=0.1", "--demuxer-max-bytes=32768",
        f"--input-ipc-server={ipc}", fixture,
    ], stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 5
        while not os.path.exists(ipc) and time.time() < deadline:
            time.sleep(0.02)
        client = socket.socket(socket.AF_UNIX)
        client.connect(ipc)
        time.sleep(0.65)
        send(client, ["set_property", "aid", 2])
        time.sleep(1.0)
        send(client, ["set_property", "aid", 1])
        client.close()
        if process.wait(timeout=10) != 0:
            raise SystemExit("mpv audio switch playback failed")
    finally:
        if process.poll() is None:
            process.kill()
        if os.path.exists(ipc):
            os.unlink(ipc)
        log.close()
    text = open(log_path, encoding="utf-8", errors="replace").read()
    if text.count("Selected decoder: aac") < 3 or "finished playback, success" not in text:
        raise SystemExit("mpv did not reinitialize audio for both in-session switches")
    print(f"audio_switch=PASS source_frequencies={first:.1f},{second:.1f} decoder_opens={text.count('Selected decoder: aac')}")


if __name__ == "__main__":
    main()
