#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/mathematics.h>

#include "rustdash_packet_abi.h"

static void fail(const char *what)
{
    fprintf(stderr, "generation_producer: %s\n", what);
    exit(1);
}

static void put_bytes(FILE *f, const void *data, size_t size)
{
    if (fwrite(data, 1, size, f) != size)
        fail("write failed");
}

static void put_u32(FILE *f, uint32_t v)
{
    uint8_t b[4] = {v, v >> 8, v >> 16, v >> 24};
    put_bytes(f, b, sizeof(b));
}

static void put_i32(FILE *f, int32_t v)
{
    put_u32(f, (uint32_t)v);
}

static void put_i64(FILE *f, int64_t v)
{
    uint64_t u = (uint64_t)v;
    uint8_t b[8] = {u, u >> 8, u >> 16, u >> 24,
                    u >> 32, u >> 40, u >> 48, u >> 56};
    put_bytes(f, b, sizeof(b));
}

static AVFormatContext *open_video(const char *path, int *stream_index)
{
    AVFormatContext *input = NULL;
    if (avformat_open_input(&input, path, NULL, NULL) < 0 ||
        avformat_find_stream_info(input, NULL) < 0)
        fail("could not open input or discover streams");
    *stream_index = av_find_best_stream(input, AVMEDIA_TYPE_VIDEO, -1, -1,
                                        NULL, 0);
    if (*stream_index < 0)
        fail("input has no usable video stream");
    return input;
}

static void write_config(FILE *out, AVStream *st, uint32_t generation)
{
    AVCodecParameters *c = st->codecpar;
    const AVCodecDescriptor *desc = avcodec_descriptor_get(c->codec_id);
    const char *name = desc ? desc->name : avcodec_get_name(c->codec_id);
    char codec[RDP_CODEC_NAME_BYTES] = {0};
    snprintf(codec, sizeof(codec), "%s", name);

    put_u32(out, 1);
    put_u32(out, generation);
    put_u32(out, RDP_TRACK_VIDEO);
    put_i32(out, st->time_base.num);
    put_i32(out, st->time_base.den);
    put_i32(out, c->width);
    put_i32(out, c->height);
    put_i32(out, 0);
    put_i32(out, 0);
    put_bytes(out, codec, sizeof(codec));
    put_u32(out, c->extradata_size);
    put_bytes(out, c->extradata, c->extradata_size);
}

static int64_t write_packets(FILE *out, AVFormatContext *input, int stream_index,
                             uint32_t generation, int64_t offset,
                             AVRational output_tb, uint64_t *count)
{
    AVStream *st = input->streams[stream_index];
    AVPacket *pkt = av_packet_alloc();
    if (!pkt)
        fail("av_packet_alloc failed");
    int64_t decode_end = 0;
    int err;
    while ((err = av_read_frame(input, pkt)) >= 0) {
        if (pkt->stream_index != stream_index) {
            av_packet_unref(pkt);
            continue;
        }
        if (av_cmp_q(st->time_base, output_tb))
            fail("generation time bases differ");
        put_u32(out, RDP_RECORD_PACKET);
        put_u32(out, 1);
        put_u32(out, generation);
        put_i64(out, pkt->pts == AV_NOPTS_VALUE ? RDP_NOPTS : pkt->pts + offset);
        put_i64(out, pkt->dts == AV_NOPTS_VALUE ? RDP_NOPTS : pkt->dts + offset);
        put_i64(out, pkt->duration);
        put_i32(out, st->time_base.num);
        put_i32(out, st->time_base.den);
        put_u32(out, pkt->flags & AV_PKT_FLAG_KEY ? RDP_FLAG_KEYFRAME : 0);
        put_u32(out, pkt->size);
        put_bytes(out, pkt->data, pkt->size);
        if (pkt->dts != AV_NOPTS_VALUE)
            decode_end = pkt->dts + pkt->duration;
        (*count)++;
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    if (err != AVERROR_EOF)
        fail("av_read_frame failed before EOF");
    return decode_end;
}

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "usage: %s A.mp4 B.mp4 OUTPUT.rdp\n", argv[0]);
        return 2;
    }
    int a_index, b_index;
    AVFormatContext *a = open_video(argv[1], &a_index);
    AVFormatContext *b = open_video(argv[2], &b_index);
    AVStream *as = a->streams[a_index];
    AVStream *bs = b->streams[b_index];
    bool same_extradata = as->codecpar->extradata_size == bs->codecpar->extradata_size &&
        !memcmp(as->codecpar->extradata, bs->codecpar->extradata,
                as->codecpar->extradata_size);
    if (as->codecpar->codec_id != AV_CODEC_ID_H264 ||
        bs->codecpar->codec_id != AV_CODEC_ID_H264 ||
        as->codecpar->width != 320 || as->codecpar->height != 180 ||
        bs->codecpar->width != 640 || bs->codecpar->height != 360 ||
        same_extradata)
        fail("expected distinct H.264 320x180 and 640x360 configurations");

    FILE *out = fopen(argv[3], "wb");
    if (!out)
        fail(strerror(errno));
    put_bytes(out, RDP_GENERATION_MAGIC, 8);
    put_u32(out, RDP_GENERATION_VERSION);
    put_u32(out, 1);
    put_u32(out, 2);
    write_config(out, as, 1);
    write_config(out, bs, 2);

    uint64_t a_packets = 0, b_packets = 0;
    int64_t offset = write_packets(out, a, a_index, 1, 0, as->time_base,
                                   &a_packets);
    write_packets(out, b, b_index, 2, offset, as->time_base, &b_packets);
    put_u32(out, RDP_RECORD_EOF);
    if (fclose(out))
        fail("close failed");

    printf("track=1 generations=2 A=320x180 B=640x360 "
           "a_packets=%" PRIu64 " b_packets=%" PRIu64
           " b_timestamp_offset=%" PRId64 " time_base=%d/%d\n",
           a_packets, b_packets, offset, as->time_base.num, as->time_base.den);
    avformat_close_input(&a);
    avformat_close_input(&b);
    return 0;
}
