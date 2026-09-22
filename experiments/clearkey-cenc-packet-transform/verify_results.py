#!/usr/bin/env python3
from pathlib import Path
import struct

root = Path(__file__).resolve().parent
results = root / "results"

positive = (results / "local-positive.log").read_text()
assert "comparison=PASS packets=217 video=75 audio=142" in positive
assert "scheme=cenc" in positive
assert "subsample_packets=75" in positive
assert "key_lookup=success" in positive

missing = (results / "missing-key.log").read_text()
assert "transform=KeyUnavailable" in missing

wrong = (results / "wrong-key.log").read_text()
assert "wrong-key payload mismatch" in wrong

unit = (results / "unit.log").read_text()
assert unit.startswith("PASS:")

ac3 = (results / "ac3-component.log").read_text()
assert "audio_codec=ac3" in ac3
assert "audio_packets=188" in ac3

rdp = (root / "fixtures" / "decrypted-ac3.rdp").read_bytes()
track_count = struct.unpack_from("<I", rdp, 12)[0]
offset = 16
for _ in range(track_count):
    extradata_size = struct.unpack_from("<I", rdp, offset + 68)[0]
    offset += 72 + extradata_size
audio_packets = []
while struct.unpack_from("<I", rdp, offset)[0] != 0x31464F45:
    record = struct.unpack_from("<IIIqqqiiII", rdp, offset)
    _, track, _, pts, _, duration, tb_num, tb_den, _, size = record
    if track == 2:
        audio_packets.append((pts, duration, tb_num, tb_den, size))
    offset += 52 + size
assert len(audio_packets) == 188
assert all(packet[1:] == (1536, 1, 48000, 1536) for packet in audio_packets)
assert all(right[0] - left[0] == 1536 for left, right in zip(audio_packets, audio_packets[1:]))

print("PASS: local packet equivalence, AC-3 framing, and explicit ClearKey error cases")
