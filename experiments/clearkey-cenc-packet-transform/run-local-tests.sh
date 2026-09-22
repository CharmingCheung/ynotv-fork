#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
results="$script_dir/results"
mkdir -p "$results"

"$script_dir/generate-fixture.sh" > "$results/generate.log"
"$script_dir/build.sh"
"$script_dir/test_cenc_transform" > "$results/unit.log"

. "$script_dir/local-test.env"
RUSTDASH_AUDIO_COMPONENTS=1 \
  "$script_dir/cenc_component_producer" \
  "$script_dir/fixtures/cenc-av-full.mp4" \
  "$script_dir/fixtures/cenc-ac3-full.mp4" \
  "$script_dir/fixtures/decrypted-ac3.rdp" \
  > "$results/ac3-component.log" 2>&1

"$script_dir/cenc_packet_producer" \
  "$script_dir/fixtures/clear-av-full.mp4" \
  "$script_dir/fixtures/cenc-av-full.mp4" \
  "$script_dir/fixtures/decrypted-av.rdp" \
  > "$results/local-positive.log" 2>&1

real_kid=$RUSTDASH_TEST_KID
real_key=$RUSTDASH_TEST_KEY
RUSTDASH_TEST_KID=$(printf '%032x' 1)
export RUSTDASH_TEST_KID
if "$script_dir/cenc_packet_producer" \
  "$script_dir/fixtures/clear-av-full.mp4" \
  "$script_dir/fixtures/cenc-av-full.mp4" \
  "$script_dir/fixtures/missing-key.rdp" \
  > "$results/missing-key.log" 2>&1; then
  echo "missing-key test unexpectedly succeeded" >&2
  exit 1
else
  status=$?
  [ "$status" -eq 3 ] || exit "$status"
fi

RUSTDASH_TEST_KID=$real_kid
RUSTDASH_TEST_KEY=$(printf '%032x' 2)
export RUSTDASH_TEST_KID RUSTDASH_TEST_KEY
if "$script_dir/cenc_packet_producer" \
  "$script_dir/fixtures/clear-av-full.mp4" \
  "$script_dir/fixtures/cenc-av-full.mp4" \
  "$script_dir/fixtures/wrong-key.rdp" \
  > "$results/wrong-key.log" 2>&1; then
  echo "wrong-key test unexpectedly succeeded" >&2
  exit 1
else
  status=$?
  [ "$status" -eq 4 ] || exit "$status"
fi
RUSTDASH_TEST_KEY=$real_key
export RUSTDASH_TEST_KEY
unset real_key

python3 "$script_dir/verify_results.py"
