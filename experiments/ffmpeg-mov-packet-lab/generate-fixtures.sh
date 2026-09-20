#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FIXTURES="$SCRIPT_DIR/fixtures"
mkdir -p "$FIXTURES"

make_video() {
  output=$1
  size=$2
  bitrate=$3
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=25:duration=3" \
    -an -c:v libx264 -preset medium -pix_fmt yuv420p -profile:v high \
    -b:v "$bitrate" -maxrate "$bitrate" -bufsize "$((bitrate * 2))" \
    -g 25 -keyint_min 25 -sc_threshold 0 -bf 2 \
    -movflags +dash+frag_keyframe+empty_moov+default_base_moof \
    -frag_duration 1000000 "$output"
}

make_video "$FIXTURES/rep-a-full.mp4" 320x180 300000
make_video "$FIXTURES/rep-b-full.mp4" 640x360 700000

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=3" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset medium -pix_fmt yuv420p -profile:v high \
  -b:v 300k -maxrate 300k -bufsize 600k \
  -g 25 -keyint_min 25 -sc_threshold 0 -bf 2 \
  -c:a aac -b:a 96k \
  -movflags +dash+frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 "$FIXTURES/clear-av-full.mp4"

# Fixed, synthetic-test-only values. Suppress encryptor output so the content
# key is never printed in logs. The packet lab never receives the content key.
CENC_TEST_KEY=00112233445566778899aabbccddeeff
CENC_TEST_KID=11223344556677889900aabbccddeeff
if command -v mp4encrypt >/dev/null 2>&1; then
  mp4encrypt --method MPEG-CENC \
    --key "1:${CENC_TEST_KEY}:0102030405060708" \
    --property "1:KID:${CENC_TEST_KID}" \
    --pssh 1077efecc0b24d02ace33c1e52e2fb4b: \
    "$FIXTURES/rep-a-full.mp4" "$FIXTURES/cenc-full.mp4" >/dev/null 2>&1
  : >"$FIXTURES/cenc-with-pssh.available"
else
  rm -f "$FIXTURES/cenc-with-pssh.available" "$FIXTURES/cenc-full.mp4"
  printf '%s\n' \
    'SKIP: full CENC+PSSH fixture requires Bento4 mp4encrypt' >&2
fi
unset CENC_TEST_KEY

python3 "$SCRIPT_DIR/split_fmp4.py" "$FIXTURES/rep-a-full.mp4" "$FIXTURES/rep-a"
python3 "$SCRIPT_DIR/split_fmp4.py" "$FIXTURES/rep-b-full.mp4" "$FIXTURES/rep-b"
python3 "$SCRIPT_DIR/split_fmp4.py" "$FIXTURES/clear-av-full.mp4" "$FIXTURES/clear-av"
if [ -f "$FIXTURES/cenc-with-pssh.available" ]; then
  python3 "$SCRIPT_DIR/split_fmp4.py" "$FIXTURES/cenc-full.mp4" "$FIXTURES/cenc"
fi
