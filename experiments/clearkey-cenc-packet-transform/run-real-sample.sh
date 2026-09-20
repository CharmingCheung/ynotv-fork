#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: RUSTDASH_TEST_MPD=... RUSTDASH_TEST_KID=... RUSTDASH_TEST_KEY=... $0 /path/to/patched/mpv [extra-dylib-directory]" >&2
  exit 2
fi
: "${RUSTDASH_TEST_MPD:?RUSTDASH_TEST_MPD is required}"
: "${RUSTDASH_TEST_KID:?RUSTDASH_TEST_KID is required}"
: "${RUSTDASH_TEST_KEY:?RUSTDASH_TEST_KEY is required}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv_bin=$1
extra_dylib=${2-}
results="$script_dir/results"
cache="$script_dir/real-cache"
mkdir -p "$results" "$cache"
if [ -n "$extra_dylib" ]; then
  export DYLD_LIBRARY_PATH=$extra_dylib
fi

"$script_dir/build.sh"
"$script_dir/fetch_real_sample.py" > "$results/real-metadata.log"
"$script_dir/cenc_component_producer" \
  "$cache/real-video.mp4" "$cache/real-audio.mp4" \
  "$cache/real-decrypted.rdp" > "$results/real-transform.log" 2>&1
"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --video-sync=audio \
  --term-playing-msg='TRACKS=${track-list/count} VCODEC=${video-codec} ACODEC=${audio-codec} HWDEC=${hwdec-current}' \
  "$cache/real-decrypted.rdp" > "$results/real-software.log" 2>&1
"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=videotoolbox-copy \
  --vo=null --ao=null --frames=50 \
  "$cache/real-decrypted.rdp" > "$results/real-hardware-copy.log" 2>&1
"$mpv_bin" -v --no-config --demuxer=rustdash --hwdec=videotoolbox \
  --vo=gpu-next --gpu-api=vulkan --ao=null --frames=50 \
  "$cache/real-decrypted.rdp" > "$results/real-hardware-direct.log" 2>&1

grep -q 'real_transform=PASS.*video_codec=hevc.*audio_codec=aac' "$results/real-transform.log"
grep -q 'TRACKS=2.*VCODEC=.*HEVC.*ACODEC=.*AAC.*HWDEC=no' "$results/real-software.log"
grep -q 'experimental producer final EOF' "$results/real-software.log"
grep -q 'finished playback, success' "$results/real-software.log"
grep -q 'Using hardware decoding (videotoolbox-copy)' "$results/real-hardware-copy.log"
grep -q 'Using hardware decoding (videotoolbox)' "$results/real-hardware-direct.log"
echo "PASS: authorized real CENC sample transform and software/VideoToolbox playback"
