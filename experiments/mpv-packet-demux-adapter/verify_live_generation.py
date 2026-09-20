#!/usr/bin/env python3
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"


def read(name: str) -> str:
    return (RESULTS / name).read_text(errors="replace")


live = read("live-delay.log")
assert live.count("producer waiting group=") == 2
assert live.count("producer released group=") == 2
assert "experimental producer final EOF" in live
assert "finished playback, success" in live
queue = re.search(r"max_packets=(\d+) max_bytes=(\d+)", live)
assert queue and int(queue.group(1)) <= 8 and int(queue.group(2)) <= 131072
assert int(re.search(r"WALL_SECONDS=(\d+)", read("live-delay-time.log")).group(1)) >= 4

seek = read("cancel-seek.log")
assert "producer wait interrupted for queued seek" in seek
assert "experimental seek target=0.000" in seek
assert "producer waiting group=1 delay_ms=10000 epoch=2" in seek
for mode in ("seek", "stop", "quit"):
    log = read(f"cancel-{mode}.log")
    assert "producer waiting group=1 delay_ms=10000" in log
    assert "bounded producer shutdown" in log

queued_stop = read("cancel-queued-stop.log")
queued = re.search(r"queued_at_cancel=(\d+)", queued_stop)
assert queued and int(queued.group(1)) > 0
assert "bounded producer shutdown" in queued_stop

audio_disabled = read("audio-disabled.log")
skip_stats = re.search(r"skipped_unselected=(\d+) empty_successes=(\d+)",
                       audio_disabled)
assert skip_stats and int(skip_stats.group(1)) > 0
assert int(skip_stats.group(2)) == 0
assert "experimental producer final EOF" in audio_disabled
assert "finished playback, success" in audio_disabled

producer_failure = read("producer-failure.log")
assert "producer failed reading packet" in producer_failure
assert "fatal producer error; mpv's boolean demux API" in producer_failure
assert "experimental producer final EOF" not in producer_failure

destroy = read("cancel-destroy.log")
elapsed = float(re.search(r"DESTROY_RETURNED_SECONDS=([0-9.]+)", destroy).group(1))
assert elapsed < 2.0

producer = read("generation-producer.log")
assert "track=1 generations=2 A=320x180 B=640x360" in producer
for name, hwdec, format_a, format_b in (
    ("generation-software.log", "Using software decoding.",
     "Decoder format: 320x180 yuv420p", "Decoder format: 640x360 yuv420p"),
    ("generation-vt-copy.log", "Using hardware decoding (videotoolbox-copy).",
     "Decoder format: 320x180 nv12", "Decoder format: 640x360 nv12"),
    ("generation-vt-direct.log", "Using hardware decoding (videotoolbox).",
     "Decoder format: 320x180 videotoolbox[nv12]",
     "Decoder format: 640x360 videotoolbox[nv12]"),
):
    log = read(name)
    assert log.count("Selected decoder: h264") == 2, name
    assert log.count(hwdec) >= 2, name
    assert format_a in log and format_b in log, name
    assert "TRACKS=1" in log, name
    assert "experimental producer final EOF" in log, name
    assert "finished playback, success" in log, name

assert "EXPECTED_LAVC_RESOLUTION_CHANGE_FAILURE" in read("generation-encode-status.log")
assert "resolution changes not supported" in read("generation-encode.log")

print("PASS: bounded live waits/cancellation, packet filtering/failure, and "
      "software/VideoToolbox generation transition")
