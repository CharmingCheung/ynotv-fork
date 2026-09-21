#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

cc -std=c11 -Wall -Wextra -Wpedantic -Werror \
  $(pkg-config --cflags libavformat libavcodec libavutil openssl) \
  cenc_transform.c cenc_packet_producer.c -o cenc_packet_producer \
  $(pkg-config --libs libavformat libavcodec libavutil openssl)

cc -std=c11 -Wall -Wextra -Wpedantic -Werror \
  $(pkg-config --cflags libavutil openssl) \
  cenc_transform.c test_cenc_transform.c -o test_cenc_transform \
  $(pkg-config --libs libavutil openssl)

cc -std=c11 -Wall -Wextra -Wpedantic -Werror \
  $(pkg-config --cflags libavformat libavcodec libavutil openssl) \
  cenc_transform.c cenc_component_producer.c -o cenc_component_producer \
  $(pkg-config --libs libavformat libavcodec libavutil openssl)
