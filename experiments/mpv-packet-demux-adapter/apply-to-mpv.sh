#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/mpv-cfd818b-checkout" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv_src=$1
expected=cfd818bcaef262f82596f49444ee80073fa6d49a
actual=$(git -C "$mpv_src" rev-parse HEAD)
if [ "$actual" != "$expected" ]; then
  echo "expected mpv $expected, got $actual" >&2
  exit 1
fi
if [ -e "$mpv_src/demux/demux_rustdash.c" ]; then
  echo "demux/demux_rustdash.c already exists" >&2
  exit 1
fi

cp "$script_dir/mpv-patch/demux_rustdash.c" "$mpv_src/demux/demux_rustdash.c"
cp "$script_dir/mpv-patch/rdp_endian.h" "$mpv_src/demux/rdp_endian.h"
git -C "$mpv_src" apply "$script_dir/mpv-patch/register.patch"
git -C "$mpv_src" diff --check
echo "experimental mpv adapter applied to $mpv_src"
