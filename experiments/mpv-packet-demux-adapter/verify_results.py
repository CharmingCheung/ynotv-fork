#!/usr/bin/env python3
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"


def text(name: str) -> str:
    return (RESULTS / name).read_text(errors="replace")


producer = text("producer.log")
assert "tracks=2 packets=217" in producer
assert "pts_ne_dts=75" in producer

software = text("software.log")
for expected in (
    "indexed 217 externally supplied packets",
    "Using software decoding.",
    "Selected decoder: aac",
    "TRACKS=2",
    "A-V:  0.000",
    "experimental producer final EOF",
    "finished playback, success",
):
    assert expected in software, expected

av_samples = [float(value) for value in
              re.findall(r"A-V:\s*([-+]?\d+\.\d+)", software)]
assert len(av_samples) == 85, len(av_samples)
assert min(av_samples) == 0.0, min(av_samples)
assert max(av_samples) == 0.0, max(av_samples)

encoded = json.loads(text("encode.json"))
streams = {stream["codec_type"]: stream for stream in encoded["streams"]}
assert streams["video"]["codec_name"] == "ffv1"
assert streams["video"]["nb_read_frames"] == "75"
assert streams["audio"]["codec_name"] == "pcm_s16le"
assert streams["audio"]["nb_read_frames"] == "9"
assert 3.0 <= float(encoded["format"]["duration"]) <= 3.1

seek = text("seek.log")
assert "experimental seek target=2.000 keyframe=1.080" in seek
assert "hr-seek, skipping to 2.000000" in seek
assert "SEEK_PRESENTED=00:00:02" in seek
assert "playback restart complete @ 2.000000" in seek

regression_fixture = text("regression-fixture.log")
assert "negative_keyframe_packet=1 pts=-512 dts=-1024" in regression_fixture
assert "nopts_packet=0 pts=RDP_NOPTS dts=RDP_NOPTS" in regression_fixture

negative_seek = text("negative-seek.log")
assert "experimental seek target=0.000 keyframe=-0.040 packet=1" in negative_seek
assert "finished playback, success" in negative_seek

hardware = text("hardware.log")
assert "Using hardware decoding (videotoolbox-copy)." in hardware
assert "HWDEC=videotoolbox-copy" in hardware

hardware_direct = text("hardware-direct.log")
assert "Using hardware decoding (videotoolbox)." in hardware_direct
assert "VO: [gpu-next] 320x180 videotoolbox[nv12]" in hardware_direct
assert "HWDEC=videotoolbox VO=gpu-next" in hardware_direct

backpressure = text("backpressure.log")
cache_bytes = [int(value) for value in
               re.findall(r'"total-bytes":\s*(\d+)', backpressure)]
queue_blocks = re.findall(
    r"Too many packets in the demuxer packet queues:\n"
    r"((?:\[rustdash\]\s+.*\d+ packets, \d+ bytes\n)+)",
    backpressure,
)
queue_bytes = [
    sum(int(value) for value in re.findall(r"\d+ packets, (\d+) bytes", block))
    for block in queue_blocks
]
observed_bytes = cache_bytes + queue_bytes
assert cache_bytes, "missing demuxer-cache-state total-bytes"
assert queue_bytes, "missing demux queue overflow samples"
assert max(observed_bytes) <= 32768 + 7091, max(observed_bytes)
assert '"eof":false' in backpressure

print("PASS: producer, software decode, decoded output, seek, hwdec, A/V sync, EOF, and bounded queue")
