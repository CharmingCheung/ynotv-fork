#!/usr/bin/env python3
"""Fetch a tiny, experiment-only live DASH slice (one video and one audio)."""

import json
import os
from pathlib import Path
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "real-cache"


def local(tag):
    return tag.rsplit("}", 1)[-1]


def children(node, name):
    return [child for child in node if local(child.tag) == name]


def first(node, name):
    return next((child for child in node if local(child.tag) == name), None)


def base_url(parent, node):
    base = first(node, "BaseURL")
    return urllib.parse.urljoin(parent, (base.text or "").strip()) if base is not None else parent


def request(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ynotv-cenc-packet-lab/1"})
    return urllib.request.urlopen(req, timeout=30)


def expand_timeline(template):
    timeline = first(template, "SegmentTimeline")
    entries = children(timeline, "S")
    result = []
    current = None
    for index, entry in enumerate(entries):
        duration = int(entry.attrib["d"])
        start = int(entry.attrib["t"]) if "t" in entry.attrib else current
        if start is None:
            raise ValueError("first S requires t in this narrow extractor")
        repeat = int(entry.attrib.get("r", "0"))
        if repeat < 0:
            if index + 1 >= len(entries) or "t" not in entries[index + 1].attrib:
                raise ValueError("unbounded terminal r=-1 is outside this extractor")
            next_start = int(entries[index + 1].attrib["t"])
            repeat = (next_start - start + duration - 1) // duration - 1
        for n in range(repeat + 1):
            result.append(start + n * duration)
        current = start + (repeat + 1) * duration
    return result


def choose(period, content_type):
    candidates = [node for node in children(period, "AdaptationSet")
                  if node.attrib.get("contentType") == content_type]
    if content_type == "video":
        candidates = [node for node in candidates if "TrickMode" not in " ".join(
            rep.attrib.get("id", "") for rep in children(node, "Representation"))]
    adaptation = candidates[0]
    representations = children(adaptation, "Representation")
    representation = min(representations, key=lambda rep: int(rep.attrib.get("bandwidth", "0")))
    template = first(representation, "SegmentTemplate") or first(adaptation, "SegmentTemplate")
    return adaptation, representation, template


def protection(adaptation):
    kid = None
    scheme = None
    pssh = 0
    for item in children(adaptation, "ContentProtection"):
        if item.attrib.get("schemeIdUri") == "urn:mpeg:dash:mp4protection:2011":
            scheme = item.attrib.get("value")
            kid = next((value for name, value in item.attrib.items() if local(name) == "default_KID"), None)
        pssh += sum(1 for child in item if local(child.tag) == "pssh")
    return scheme, kid, pssh


def fetch_component(mpd_base, period, content_type):
    adaptation, representation, template = choose(period, content_type)
    component_base = base_url(base_url(mpd_base, adaptation), representation)
    rep_id = representation.attrib["id"]
    initialization = template.attrib["initialization"].replace("$RepresentationID$", rep_id)
    media = template.attrib["media"]
    segment_times = expand_timeline(template)
    selected_times = segment_times[-3:-1]
    suffix = "video" if content_type == "video" else "audio"
    init_bytes = request(urllib.parse.urljoin(component_base, initialization)).read()
    parts = [init_bytes]
    for media_time in selected_times:
        relative = media.replace("$RepresentationID$", rep_id).replace("$Time$", str(media_time))
        parts.append(request(urllib.parse.urljoin(component_base, relative)).read())
    output = OUT / f"real-{suffix}.mp4"
    output.write_bytes(b"".join(parts))
    scheme, kid, pssh = protection(adaptation)
    return {
        "type": content_type,
        "adaptation_id": adaptation.attrib.get("id"),
        "representation": rep_id,
        "codec": representation.attrib.get("codecs"),
        "timescale": int(template.attrib.get("timescale", "1")),
        "segment_count": len(selected_times),
        "segment_times": selected_times,
        "scheme": scheme,
        "default_kid": f"{kid[:4]}...{kid[-4:]}" if kid else None,
        "pssh_count": pssh,
        "bytes": output.stat().st_size,
    }


def main():
    mpd_url = os.environ.get("RUSTDASH_TEST_MPD")
    if not mpd_url:
        raise SystemExit("RUSTDASH_TEST_MPD is required")
    OUT.mkdir(parents=True, exist_ok=True)
    with request(mpd_url) as response:
        manifest = response.read()
        final_url = response.geturl()
    root = ET.fromstring(manifest)
    period = first(root, "Period")
    mpd_base = base_url(final_url, root)
    period_base = base_url(mpd_base, period)
    components = [fetch_component(period_base, period, kind) for kind in ("video", "audio")]
    observed = {
        "redirects_followed": final_url != mpd_url,
        "mpd_type": root.attrib.get("type"),
        "profiles": root.attrib.get("profiles"),
        "components": components,
    }
    (OUT / "metadata.json").write_text(json.dumps(observed, indent=2) + "\n")
    print(json.dumps(observed, indent=2))


if __name__ == "__main__":
    main()
