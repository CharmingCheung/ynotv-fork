#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

cc -std=c11 -Wall -Wextra -Wpedantic -Werror \
  $(pkg-config --cflags libavformat libavcodec libavutil) \
  "$SCRIPT_DIR/packet_lab.c" \
  $(pkg-config --libs libavformat libavcodec libavutil) \
  -o "$SCRIPT_DIR/packet_lab"
