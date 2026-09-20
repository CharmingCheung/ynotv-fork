#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 /path/to/patched/mpv [extra-dylib-directory]" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv_bin=$1
extra_dylib=${2-}
fixture_source="$script_dir/../ffmpeg-mov-packet-lab/fixtures/clear-av-full.mp4"
fixture="$script_dir/fixture.rdp"
results="$script_dir/results"

mkdir -p "$results"
if [ -n "$extra_dylib" ]; then
  export DYLD_LIBRARY_PATH=$extra_dylib
fi

cd "$script_dir"
./build-producer.sh
./packet_producer "$fixture_source" "$fixture" > "$results/producer.log"
"$mpv_bin" --version > "$results/version.log"

"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --video-sync=audio \
  --term-playing-msg='TRACKS=${track-list/count} VCODEC=${video-codec} ACODEC=${audio-codec} HWDEC=${hwdec-current}' \
  "$fixture" > "$results/software.log" 2>&1

rm -f "$results/software-decoded.mkv"
"$mpv_bin" --no-config --demuxer=rustdash --hwdec=no \
  --o="$results/software-decoded.mkv" --ovc=ffv1 --oac=pcm_s16le \
  "$fixture" > "$results/encode.log" 2>&1
ffprobe -v error -count_frames \
  -show_entries stream=index,codec_name,codec_type,nb_read_frames \
  -show_entries format=duration -of json \
  "$results/software-decoded.mkv" > "$results/encode.json"

"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --start=2 --frames=10 \
  --term-playing-msg='SEEK_PRESENTED=${time-pos}' \
  "$fixture" > "$results/seek.log" 2>&1

"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=videotoolbox-copy \
  --vo=null --ao=null --frames=20 \
  --term-playing-msg='HWDEC=${hwdec-current}' \
  "$fixture" > "$results/hardware.log" 2>&1

"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=videotoolbox \
  --vo=gpu-next --gpu-api=vulkan --ao=null --frames=20 \
  --term-playing-msg='HWDEC=${hwdec-current} VO=${current-vo}' \
  "$fixture" > "$results/hardware-direct.log" 2>&1

"$mpv_bin" --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --frames=5 --demuxer-max-bytes=32768 \
  --demuxer-readahead-secs=0.25 \
  --term-playing-msg='CACHE=${demuxer-cache-state}' \
  "$fixture" > "$results/backpressure.log" 2>&1

python3 "$script_dir/verify_results.py"
