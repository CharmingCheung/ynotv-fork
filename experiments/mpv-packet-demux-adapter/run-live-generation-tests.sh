#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 /path/to/patched/mpv [extra-dylib-directory] [mpv-source]" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv_bin=$1
extra_dylib=${2-}
mpv_source=${3-$(CDPATH= cd -- "$(dirname -- "$mpv_bin")/.." && pwd)}
fixtures="$script_dir/../ffmpeg-mov-packet-lab/fixtures"
results="$script_dir/results"
live_fixture="$script_dir/fixture.rdp"
generation_fixture="$script_dir/generation-fixture.rdp"
failure_fixture="$script_dir/producer-failure-fixture.rdp"

mkdir -p "$results"
if [ -n "$extra_dylib" ]; then
  export DYLD_LIBRARY_PATH=$extra_dylib
fi

cd "$script_dir"
./build-producer.sh
./packet_producer "$fixtures/clear-av-full.mp4" "$live_fixture" \
  > "$results/live-producer.log"
./generation_producer "$fixtures/rep-a-full.mp4" "$fixtures/rep-b-full.mp4" \
  "$generation_fixture" > "$results/generation-producer.log"

start=$(date +%s)
RUSTDASH_DELAY_MS=1500 "$mpv_bin" -v --no-config --demuxer=rustdash \
  --demuxer-seekable-cache=no --cache=no --hwdec=no --vo=null --ao=null \
  --video-sync=audio "$live_fixture" > "$results/live-delay.log" 2>&1
end=$(date +%s)
echo "WALL_SECONDS=$((end - start))" > "$results/live-delay-time.log"

for mode in seek stop quit queued-stop; do
  if [ -n "$extra_dylib" ]; then
    python3 live_control_test.py "$mode" "$mpv_bin" "$live_fixture" \
      "$results/cancel-$mode.log" --dylib-dir "$extra_dylib"
  else
    python3 live_control_test.py "$mode" "$mpv_bin" "$live_fixture" \
      "$results/cancel-$mode.log"
  fi
done

python3 dvr_track_switch_test.py "$mpv_bin"

"$mpv_bin" -v --no-config --demuxer=rustdash --demuxer-seekable-cache=no \
  --cache=no --hwdec=no --vo=null --ao=null --aid=no \
  "$live_fixture" > "$results/audio-disabled.log" 2>&1

cp "$live_fixture" "$failure_fixture"
if [ -n "$extra_dylib" ]; then
  python3 live_control_test.py producer-fail "$mpv_bin" "$failure_fixture" \
    "$results/producer-failure.log" --dylib-dir "$extra_dylib"
else
  python3 live_control_test.py producer-fail "$mpv_bin" "$failure_fixture" \
    "$results/producer-failure.log"
fi
rm -f "$failure_fixture"

cc -std=c11 -Wall -Wextra -Werror -I"$mpv_source/include" session_destroy.c \
  -L"$(dirname -- "$mpv_bin")" -lmpv -o "$results/session_destroy"
RUSTDASH_DELAY_MS=10000 \
DYLD_LIBRARY_PATH="$(dirname -- "$mpv_bin")${extra_dylib:+:$extra_dylib}" \
  "$results/session_destroy" "$live_fixture" > "$results/cancel-destroy.log" 2>&1

"$mpv_bin" -v --no-config --demuxer=rustdash --demuxer-seekable-cache=no \
  --hwdec=no --vo=null --ao=null \
  --term-playing-msg='TRACKS=${track-list/count} SIZE=${width}x${height} HWDEC=${hwdec-current}' \
  "$generation_fixture" > "$results/generation-software.log" 2>&1

"$mpv_bin" -v --no-config --demuxer=rustdash --demuxer-seekable-cache=no \
  --hwdec=videotoolbox-copy --vo=null --ao=null \
  --term-playing-msg='TRACKS=${track-list/count} SIZE=${width}x${height} HWDEC=${hwdec-current}' \
  "$generation_fixture" > "$results/generation-vt-copy.log" 2>&1

"$mpv_bin" -v --no-config --demuxer=rustdash --demuxer-seekable-cache=no \
  --hwdec=videotoolbox --vo=gpu-next --gpu-api=vulkan --ao=null \
  --term-playing-msg='TRACKS=${track-list/count} SIZE=${width}x${height} HWDEC=${hwdec-current} VO=${current-vo}' \
  "$generation_fixture" > "$results/generation-vt-direct.log" 2>&1

rm -f "$results/generation-decoded.mkv"
if "$mpv_bin" --no-config --demuxer=rustdash --demuxer-seekable-cache=no \
  --hwdec=no --o="$results/generation-decoded.mkv" --ovc=ffv1 \
  --no-audio "$generation_fixture" > "$results/generation-encode.log" 2>&1; then
  echo "UNEXPECTED_SUCCESS" > "$results/generation-encode-status.log"
else
  echo "EXPECTED_LAVC_RESOLUTION_CHANGE_FAILURE" > "$results/generation-encode-status.log"
fi

python3 verify_live_generation.py
