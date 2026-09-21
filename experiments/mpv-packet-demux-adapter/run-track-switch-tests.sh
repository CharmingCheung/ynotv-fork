#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: $0 /path/to/patched/mpv [extra-dylib-dir]" >&2
  exit 2
fi

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv=$1
extra=${2:-}
fflab="$here/../ffmpeg-mov-packet-lab"
cenc="$here/../clearkey-cenc-packet-transform"
results="$here/results/c8"
mkdir -p "$results"

"$fflab/generate-fixtures.sh"
"$cenc/build.sh"
for spec in "en:440" "zh:880"; do
  name=${spec%:*}; hz=${spec#*:}
  ffmpeg -v error -y -f lavfi -i "sine=frequency=$hz:sample_rate=48000:duration=3" \
    -c:a aac -b:a 96k -movflags +dash+frag_keyframe+empty_moov+default_base_moof \
    -frag_duration 1000000 "$results/$name.mp4"
done
mkdir -p "$results/rep-a" "$results/rep-b" "$results/audio-en" "$results/audio-zh"
cp "$fflab/fixtures/rep-a/"* "$results/rep-a/"
cp "$fflab/fixtures/rep-b/"* "$results/rep-b/"
python3 "$fflab/split_fmp4.py" "$results/en.mp4" "$results/audio-en"
python3 "$fflab/split_fmp4.py" "$results/zh.mp4" "$results/audio-zh"
for rep in a b; do
  RUSTDASH_AUDIO_COMPONENTS=2 \
  RUSTDASH_TEST_KID=00112233445566778899aabbccddeeff \
  RUSTDASH_TEST_KEY=000102030405060708090a0b0c0d0e0f \
    "$cenc/cenc_component_producer" "$fflab/fixtures/rep-$rep-full.mp4" \
    "$results/en.mp4" "$results/zh.mp4" "$results/$rep.rdp" >/dev/null
done
python3 "$here/make-track-switch-fixture.py" "$results/a.rdp" "$results/b.rdp" "$results/switch.rdp"

env_cmd=""
if [ -n "$extra" ]; then env_cmd="DYLD_LIBRARY_PATH=$extra"; fi
env $env_cmd "$mpv" -v --no-config --demuxer=rustdash --hwdec=no --vo=null --ao=null \
  --term-playing-msg='TRACKS=${track-list/count} SIZE=${width}x${height}' \
  "$results/switch.rdp" >"$results/playback.log" 2>&1

grep -q 'rustdash-live-v5' "$results/playback.log"
grep -q 'runtime codec generation registered' "$results/playback.log"
grep -q 'Decoder format: 320x180' "$results/playback.log"
grep -q 'Decoder format: 640x360' "$results/playback.log"
test "$(grep -c '^\[cplayer\].*Audio  --aid=' "$results/playback.log")" -eq 2
grep -q 'finished playback, success' "$results/playback.log"
env $env_cmd python3 "$here/audio-switch-test.py" "$mpv" "$results/switch.rdp" "$results"
echo "PASS: RDPKT005 changed 320x180 -> 640x360 -> 320x180 on one video track and exposed two audio tracks"
