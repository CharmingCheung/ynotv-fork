#!/usr/bin/env python3
from pathlib import Path

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

print("PASS: local packet equivalence and explicit ClearKey error cases")
