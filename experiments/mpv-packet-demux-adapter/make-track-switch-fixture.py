#!/usr/bin/env python3
"""Compose a deterministic RDPKT005 A->B->A video and two-audio fixture."""

import struct
import sys
from pathlib import Path


def u32(data, at): return struct.unpack_from("<I", data, at)[0]


def parse(path):
    data = Path(path).read_bytes()
    if data[:8] != b"RDPKT001" or u32(data, 8) != 1:
        raise SystemExit(f"invalid input fixture: {path}")
    pos = 16
    configs = []
    for _ in range(u32(data, 12)):
        start = pos
        pos += 72 + u32(data, pos + 68)
        configs.append(bytearray(data[start:pos]))
    packets = []
    while u32(data, pos) != 0x31464F45:
        if u32(data, pos) != 0x31544B50:
            raise SystemExit("invalid packet marker")
        end = pos + 52 + u32(data, pos + 48)
        packets.append(bytearray(data[pos:end]))
        pos = end
    return configs, packets


def seconds(packet):
    dts = struct.unpack_from("<q", packet, 20)[0]
    num, den = struct.unpack_from("<ii", packet, 36)
    return dts * num / den


def metadata(config, language, title, default=False):
    flags = 1 if default else 0
    language_bytes = language.encode()
    title_bytes = title.encode()
    return bytes(config) + struct.pack("<II", flags, len(language_bytes)) + language_bytes + struct.pack("<I", len(title_bytes)) + title_bytes


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: make-track-switch-fixture.py A.rdp B.rdp OUTPUT.rdp")
    a_configs, a_packets = parse(sys.argv[1])
    b_configs, b_packets = parse(sys.argv[2])
    if len(a_configs) != 3 or len(b_configs) != 3:
        raise SystemExit("expected one video and two audio tracks")
    b_video = b_configs[0]
    struct.pack_into("<I", b_video, 4, 2)

    selected = []
    for packet in a_packets:
        track = u32(packet, 4)
        t = seconds(packet)
        keep_audio = track == 2 and (t < 1.0 or t >= 2.0) or track == 3 and 1.0 <= t < 2.0
        if track == 1 and (t < 1.0 or t >= 2.0) or keep_audio:
            selected.append((t, 0, packet))
    for packet in b_packets:
        if u32(packet, 4) == 1 and 1.0 <= seconds(packet) < 2.0:
            struct.pack_into("<I", packet, 8, 2)
            selected.append((seconds(packet), 1, packet))
    selected.sort(key=lambda item: (item[0], item[1], u32(item[2], 4)))

    output = bytearray(b"RDPKT005" + struct.pack("<II", 5, 3))
    output += metadata(a_configs[0], "", "")
    output += metadata(a_configs[1], "en", "English 440 Hz", True)
    output += metadata(a_configs[2], "zh", "中文 880 Hz")
    config_written = False
    for _, source, packet in selected:
        if source == 1 and not config_written:
            output += struct.pack("<I", 0x31474643) + b_video
            config_written = True
        output += packet
    output += struct.pack("<I", 0x31464F45)
    Path(sys.argv[3]).write_bytes(output)
    print(f"switch_fixture=PASS packets={len(selected)} video_generations=2 audio_tracks=2")


if __name__ == "__main__":
    main()
