#!/usr/bin/env python3
"""Split a synthetic fragmented MP4 into one init file and moof/mdat fragments."""

from __future__ import annotations

import argparse
import pathlib
import struct


def boxes(data: bytes):
    offset = 0
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError(f"truncated MP4 box header at byte {offset}")
        size, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            if len(data) - offset < 16:
                raise ValueError(f"truncated extended MP4 box header at byte {offset}")
            size = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        elif size == 0:
            size = len(data) - offset
        if size < header or offset + size > len(data):
            raise ValueError(f"invalid MP4 box size {size} at byte {offset}")
        yield kind, data[offset : offset + size]
        offset += size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("output_dir", type=pathlib.Path)
    args = parser.parse_args()

    init_parts: list[bytes] = []
    fragments: list[bytes] = []
    pending: list[bytes] = []
    saw_moov = False
    saw_moof = False

    for kind, raw in boxes(args.source.read_bytes()):
        if not saw_moov:
            init_parts.append(raw)
            saw_moov = kind == b"moov"
            continue

        pending.append(raw)
        if kind == b"moof":
            if saw_moof:
                raise ValueError("encountered a second moof before mdat")
            saw_moof = True
        elif kind == b"mdat" and saw_moof:
            fragments.append(b"".join(pending))
            pending = []
            saw_moof = False

    if not saw_moov or not fragments:
        raise ValueError("source is not an initialized fragmented MP4")
    if pending:
        fragments[-1] += b"".join(pending)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "init.mp4").write_bytes(b"".join(init_parts))
    for index, fragment in enumerate(fragments, start=1):
        (args.output_dir / f"segment-{index}.m4s").write_bytes(fragment)

    print(f"{args.output_dir}: init + {len(fragments)} fragments")


if __name__ == "__main__":
    main()
