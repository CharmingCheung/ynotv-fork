#!/usr/bin/env python3
import argparse
import struct
from pathlib import Path

RDP_RECORD_PACKET = 0x31544B50
RDP_RECORD_EOF = 0x31464F45
RDP_FLAG_KEYFRAME = 1
RDP_TRACK_VIDEO = 1
RDP_TRACK_AUDIO = 2
RDP_NOPTS = -(1 << 63)


def u32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], "little")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    data = args.source.read_bytes()
    if data[:8] != b"RDPKT001" or u32(data, 8) != 1 or u32(data, 12) != 2:
        raise ValueError("expected an RDPKT001 v1 two-track fixture")

    offset = 16
    for _ in range(2):
        offset += 9 * 4 + 32
        extradata_size = u32(data, offset)
        offset += 4 + extradata_size
    header = data[:offset]

    records: list[bytearray] = []
    while True:
        marker = u32(data, offset)
        if marker == RDP_RECORD_EOF:
            break
        if marker != RDP_RECORD_PACKET:
            raise ValueError(f"unexpected record marker at byte {offset}")
        payload_size = u32(data, offset + 48)
        end = offset + 52 + payload_size
        records.append(bytearray(data[offset:end]))
        offset = end

    audio = next(i for i, record in enumerate(records)
                 if u32(record, 4) == RDP_TRACK_AUDIO)
    keyframe = next(i for i, record in enumerate(records)
                    if u32(record, 4) == RDP_TRACK_VIDEO and
                    u32(record, 44) & RDP_FLAG_KEYFRAME)

    records[keyframe][12:20] = (-512).to_bytes(8, "little", signed=True)
    records[keyframe][20:28] = (-1024).to_bytes(8, "little", signed=True)
    records[audio][12:20] = RDP_NOPTS.to_bytes(8, "little", signed=True)
    records[audio][20:28] = RDP_NOPTS.to_bytes(8, "little", signed=True)

    leading_audio = records.pop(audio)
    if audio < keyframe:
        keyframe -= 1
    records.insert(0, leading_audio)
    keyframe += 1
    if keyframe != 1:
        raise ValueError("base fixture did not begin with its first video keyframe")

    args.output.write_bytes(header + b"".join(records) +
                            struct.pack("<I", RDP_RECORD_EOF))
    print("negative_keyframe_packet=1 pts=-512 dts=-1024 "
          "nopts_packet=0 pts=RDP_NOPTS dts=RDP_NOPTS")


if __name__ == "__main__":
    main()
