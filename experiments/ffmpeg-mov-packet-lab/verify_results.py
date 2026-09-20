#!/usr/bin/env python3
"""Assert the packet-level observations used by the research report."""

from __future__ import annotations

import pathlib
import re


ROOT = pathlib.Path(__file__).resolve().parent
RESULTS = ROOT / "results"


def read(name: str) -> str:
    return (RESULTS / name).read_text()


def packets(text: str) -> list[dict[str, int | str]]:
    found = []
    pattern = re.compile(
        r"^PACKET n=(?P<n>\d+) stream=(?P<stream>\d+) type=\w+ "
        r"pts=(?P<pts>-?\d+) dts=(?P<dts>-?\d+) duration=(?P<duration>\d+) "
        r"time_base=(?P<tb_num>\d+)/(?P<tb_den>\d+) keyframe=(?P<key>\d+) "
        r"size=(?P<size>\d+) sha256=(?P<sha256>[0-9a-f]+)",
        re.MULTILINE,
    )
    for match in pattern.finditer(text):
        found.append(
            {
                key: value if key == "sha256" else int(value)
                for key, value in match.groupdict().items()
            }
        )
    return found


def streams(text: str) -> dict[str, dict[str, str]]:
    found = {}
    for line in text.splitlines():
        if not line.startswith("STREAM index="):
            continue
        fields = dict(re.findall(r"(\w+)=([^ ]+)", line))
        found[fields["type"]] = fields
    return found


def assert_fields_equal(
    left: dict[str, str], right: dict[str, str], fields: tuple[str, ...]
) -> None:
    assert {field: left[field] for field in fields} == {
        field: right[field] for field in fields
    }


same = read("same-init-a.txt")
same_packets = packets(same)
assert len(same_packets) == 75
assert [p["n"] for p in same_packets if p["key"]] == [0, 25, 50]
assert [p["dts"] for p in same_packets if p["key"]] == [0, 12800, 25600]
assert any(p["pts"] != p["dts"] for p in same_packets)
assert "DEMUX status=representation-ended packets=75" in same
ffprobe_packets = []
for line in read("rep-a-ffprobe.txt").splitlines():
    fields = dict(field.split("=", 1) for field in line.split("|"))
    ffprobe_packets.append(
        {
            "pts": int(fields["pts"]),
            "dts": int(fields["dts"]),
            "duration": int(fields["duration"]),
            "size": int(fields["size"]),
            "key": int("K" in fields["flags"]),
            "sha256": fields["data_hash"].removeprefix("SHA256:"),
        }
    )
assert [
    {
        key: packet[key]
        for key in ("pts", "dts", "duration", "size", "key", "sha256")
    }
    for packet in same_packets
] == ffprobe_packets

fresh_later = packets(read("fresh-a-later.txt"))
assert len(fresh_later) == 25
assert fresh_later[0]["key"] == 1
assert fresh_later[0]["pts"] == same_packets[50]["pts"]
assert fresh_later[0]["dts"] == same_packets[50]["dts"]
assert [
    {key: value for key, value in packet.items() if key != "n"}
    for packet in fresh_later
] == [
    {key: value for key, value in packet.items() if key != "n"}
    for packet in same_packets[50:]
]

fresh_a_text = read("switch-fresh-a.txt")
fresh_b_text = read("switch-fresh-b.txt")
reuse_text = read("switch-reuse.txt")
assert "width=320 height=180" in fresh_a_text
assert "width=640 height=360" in fresh_b_text
extra_a = re.search(r"extradata=([0-9a-f]+)", fresh_a_text).group(1)
extra_b = re.search(r"extradata=([0-9a-f]+)", fresh_b_text).group(1)
assert extra_a != extra_b
assert "Found duplicated MOOV Atom. Skipped it" in reuse_text
assert "width=320 height=180" in reuse_text and f"extradata={extra_a}" in reuse_text
reuse_packets = packets(reuse_text)
fresh_b_packets = packets(fresh_b_text)
assert len(reuse_packets) == 50
assert [
    {key: value for key, value in packet.items() if key != "n"}
    for packet in reuse_packets[25:]
] == [
    {key: value for key, value in packet.items() if key != "n"}
    for packet in fresh_b_packets
]

clear_av = read("clear-av.txt")
assert "streams=2" in clear_av
assert "type=video codec=h264" in clear_av
assert "type=audio codec=aac" in clear_av

no_info_a = read("init-only-a.txt")
assert "STREAM_SNAPSHOT phase=post-open" in no_info_a
assert "INPUT status=init-only-boundary" in no_info_a
normal_video = streams(same)["video"]
no_info_video = streams(no_info_a)["video"]
assert_fields_equal(
    no_info_video,
    normal_video,
    ("codec_id", "width", "height", "time_base", "extradata_size", "extradata"),
)
assert no_info_video["profile"] == "-99" and no_info_video["level"] == "-99"
assert normal_video["profile"] == "100" and normal_video["level"] == "12"

no_info_clear_av = read("init-only-clear-av.txt")
normal_audio = streams(clear_av)["audio"]
no_info_audio = streams(no_info_clear_av)["audio"]
assert_fields_equal(
    no_info_audio,
    normal_audio,
    ("codec_id", "sample_rate", "channels", "time_base", "extradata_size", "extradata"),
)
assert no_info_audio["profile"] == normal_audio["profile"] == "-99"
assert no_info_audio["channel_order"] == "0"
assert normal_audio["channel_order"] == "1"
assert no_info_audio["format"] == "-1" and normal_audio["format"] == "8"

cenc_capability = read("cenc-capability.txt")
if "status=executed" in cenc_capability:
    cenc = read("cenc.txt")
    cenc_packets = packets(cenc)
    assert len(cenc_packets) == 75
    assert cenc.count("ENCRYPTION packet=") == 75
    assert "scheme=cenc" in cenc
    assert "STREAM_SIDE_DATA stream=0 type=Encryption initialization data" in cenc
    assert "ENCRYPTION_INIT owner=stream" in cenc
    no_info_cenc = read("init-only-cenc.txt")
    assert "STREAM_SNAPSHOT phase=post-open" in no_info_cenc
    assert "STREAM_SIDE_DATA stream=0 type=Encryption initialization data" in no_info_cenc
    assert_fields_equal(
        streams(no_info_cenc)["video"],
        streams(cenc)["video"],
        ("codec_id", "width", "height", "time_base", "extradata_size", "extradata"),
    )
    normal_init = re.findall(r"^ENCRYPTION_INIT owner=stream.*$", cenc, re.MULTILINE)
    no_info_init = re.findall(
        r"^ENCRYPTION_INIT owner=stream.*$", no_info_cenc, re.MULTILINE
    )
    assert no_info_init == normal_init
else:
    assert cenc_capability.strip() == (
        "CENC_PSSH status=skipped reason=mp4encrypt-unavailable"
    )

temporary = read("temporary-exhaustion.txt")
assert "INPUT status=temporarily-exhausted" in temporary
assert "DEMUX status=representation-ended packets=25" in temporary
assert len(packets(temporary)) == 25

resumable = read("no-stream-info-resumable-eagain.txt")
resumable_packets = packets(resumable)
assert re.search(
    r"INPUT status=temporarily-exhausted code=-\d+ available_pieces=2",
    resumable,
)
assert re.search(r"READ_CALL n=25 result=eof code=-\d+ packets=25", resumable)
assert "result=eagain" not in resumable
assert "INPUT action=make-next-fragment-available" not in resumable
assert resumable.count("INPUT boundary=fragment-exhausted piece=1") == 3
assert "INPUT piece=2" not in resumable
assert "DEMUX status=representation-ended packets=25" in resumable
assert resumable_packets == same_packets[:25]

print(
    "PASS: packet output, init-only stream fields, B-frames, fresh seek, "
    "init switch, CENC capability, and no-stream-info EAGAIN observation"
)
