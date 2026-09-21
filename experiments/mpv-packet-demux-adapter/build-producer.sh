#!/bin/sh
set -eu
cc -std=c11 -Wall -Wextra -Werror \
  $(pkg-config --cflags libavformat libavcodec libavutil) \
  packet_producer.c -o packet_producer \
  $(pkg-config --libs libavformat libavcodec libavutil)
cc -std=c11 -Wall -Wextra -Werror \
  $(pkg-config --cflags libavformat libavcodec libavutil) \
  generation_producer.c -o generation_producer \
  $(pkg-config --libs libavformat libavcodec libavutil)
