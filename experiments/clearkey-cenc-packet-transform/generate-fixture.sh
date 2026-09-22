#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
c1_dir="$script_dir/../ffmpeg-mov-packet-lab"
fixtures="$script_dir/fixtures"
clear_source="$c1_dir/fixtures/clear-av-full.mp4"

if ! command -v mp4encrypt >/dev/null 2>&1; then
  echo "Bento4 mp4encrypt is required" >&2
  exit 1
fi
if [ ! -f "$clear_source" ]; then
  "$c1_dir/generate-fixtures.sh"
fi

mkdir -p "$fixtures"
test_key=$(printf '%s' 'ynotv-c4-local-clearkey-key-v1' | \
  openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' \n' | cut -c1-32)
test_kid=$(printf '%s' 'ynotv-c4-local-clearkey-kid-v1' | \
  openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' \n' | cut -c1-32)

umask 077
{
  printf "RUSTDASH_TEST_KID='%s'\n" "$test_kid"
  printf "RUSTDASH_TEST_KEY='%s'\n" "$test_key"
  printf "export RUSTDASH_TEST_KID RUSTDASH_TEST_KEY\n"
} > "$script_dir/local-test.env"

cp "$clear_source" "$fixtures/clear-av-full.mp4"
mp4encrypt --method MPEG-CENC \
  --key "1:${test_key}:0102030405060708" \
  --key "2:${test_key}:1112131415161718" \
  --property "1:KID:${test_kid}" \
  --property "2:KID:${test_kid}" \
  --pssh 1077efecc0b24d02ace33c1e52e2fb4b: \
  "$fixtures/clear-av-full.mp4" "$fixtures/cenc-av-full.mp4" >/dev/null 2>&1

# AC-3 in fragmented MP4 is deliberately included because FFmpeg coalesces
# encrypted samples until the MOV demuxer receives the ClearKey.  The component
# producer must decrypt in the demuxer and recover one 1536-sample syncframe per
# packet rather than forwarding a multi-second encrypted aggregate.
ffmpeg -y -v error -f lavfi \
  -i 'sine=frequency=440:sample_rate=48000:duration=6' \
  -c:a ac3 -b:a 384k \
  -movflags +dash+frag_keyframe+delay_moov+default_base_moof \
  "$fixtures/clear-ac3-full.mp4"
mp4encrypt --method MPEG-CENC \
  --key "1:${test_key}:2122232425262728" \
  --property "1:KID:${test_kid}" \
  "$fixtures/clear-ac3-full.mp4" "$fixtures/cenc-ac3-full.mp4" >/dev/null 2>&1

python3 "$c1_dir/split_fmp4.py" "$fixtures/clear-av-full.mp4" "$fixtures/clear-av"
python3 "$c1_dir/split_fmp4.py" "$fixtures/cenc-av-full.mp4" "$fixtures/cenc-av"
unset test_key RUSTDASH_TEST_KEY
echo "generated deterministic synthetic clear and CENC A/V fixtures"
