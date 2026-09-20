#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FIXTURES="$SCRIPT_DIR/fixtures"
RESULTS="$SCRIPT_DIR/results"
LAB="$SCRIPT_DIR/packet_lab"
mkdir -p "$RESULTS"

run() {
  name=$1
  shift
  "$LAB" "$@" >"$RESULTS/$name.txt" 2>&1
}

run clear-av \
  "$FIXTURES/clear-av/init.mp4" \
  "$FIXTURES/clear-av"/segment-*.m4s

run same-init-a \
  "$FIXTURES/rep-a/init.mp4" \
  "$FIXTURES/rep-a/segment-1.m4s" \
  "$FIXTURES/rep-a/segment-2.m4s" \
  "$FIXTURES/rep-a/segment-3.m4s"

ffprobe -v error -select_streams v:0 -show_packets -show_data_hash sha256 \
  -of compact=p=0:nk=0 \
  "$FIXTURES/rep-a-full.mp4" >"$RESULTS/rep-a-ffprobe.txt"

run fresh-a-later \
  "$FIXTURES/rep-a/init.mp4" \
  "$FIXTURES/rep-a/segment-3.m4s"

run switch-reuse \
  "$FIXTURES/rep-a/init.mp4" \
  "$FIXTURES/rep-a/segment-1.m4s" \
  "$FIXTURES/rep-b/init.mp4" \
  "$FIXTURES/rep-b/segment-2.m4s"

run switch-fresh-a \
  "$FIXTURES/rep-a/init.mp4" \
  "$FIXTURES/rep-a/segment-1.m4s"

run switch-fresh-b \
  "$FIXTURES/rep-b/init.mp4" \
  "$FIXTURES/rep-b/segment-2.m4s"

run cenc \
  "$FIXTURES/cenc/init.mp4" \
  "$FIXTURES/cenc"/segment-*.m4s

"$LAB" --eagain-at-boundary \
  "$FIXTURES/rep-a/init.mp4" \
  "$FIXTURES/rep-a/segment-1.m4s" \
  "$FIXTURES/rep-a/segment-2.m4s" \
  >"$RESULTS/temporary-exhaustion.txt" 2>&1 || test $? -eq 2

printf 'results written to %s\n' "$RESULTS"
