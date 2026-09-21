#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 /path/to/patched/mpv [extra-dylib-directory]" >&2
  exit 2
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv_bin=$1
extra_dylib=${2-}
results="$script_dir/results"
fixture="$script_dir/fixtures/decrypted-av.rdp"
mkdir -p "$results"
if [ -n "$extra_dylib" ]; then
  export DYLD_LIBRARY_PATH=$extra_dylib
fi

"$script_dir/run-local-tests.sh"
"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --video-sync=audio \
  --term-playing-msg='TRACKS=${track-list/count} VCODEC=${video-codec} ACODEC=${audio-codec} HWDEC=${hwdec-current}' \
  "$fixture" > "$results/software.log" 2>&1
"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=videotoolbox-copy \
  --vo=null --ao=null --frames=20 \
  --term-playing-msg='HWDEC=${hwdec-current}' \
  "$fixture" > "$results/hardware-copy.log" 2>&1
"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=videotoolbox \
  --vo=gpu-next --gpu-api=vulkan --ao=null --frames=20 \
  --term-playing-msg='HWDEC=${hwdec-current} VO=${current-vo}' \
  "$fixture" > "$results/hardware-direct.log" 2>&1

grep -q 'TRACKS=2.*VCODEC=.*H.264.*ACODEC=.*AAC.*HWDEC=no' "$results/software.log"
grep -q 'experimental producer final EOF' "$results/software.log"
grep -q 'finished playback, success' "$results/software.log"
grep -q 'Using hardware decoding (videotoolbox-copy)' "$results/hardware-copy.log"
grep -q 'Using hardware decoding (videotoolbox)' "$results/hardware-direct.log"
echo "PASS: local software, AAC/H.264, EOF, VideoToolbox-copy, and direct VideoToolbox"
