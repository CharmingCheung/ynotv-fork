#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>

#include "rustdash_packet_abi.h"

struct chosen_track {
    int stream_index;
    uint32_t track_id;
    uint32_t type;
};

static void fail(const char *what)
{
    fprintf(stderr, "packet_producer: %s\n", what);
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

static int64_t timestamp_or_nopts(int64_t value)
{
    return value == AV_NOPTS_VALUE ? RDP_NOPTS : value;
}

static void write_config(FILE *out, AVStream *st, const struct chosen_track *track)
{
    AVCodecParameters *c = st->codecpar;
    const AVCodecDescriptor *desc = avcodec_descriptor_get(c->codec_id);
    const char *name = desc ? desc->name : avcodec_get_name(c->codec_id);
    char codec[RDP_CODEC_NAME_BYTES] = {0};
    snprintf(codec, sizeof(codec), "%s", name);

    put_u32(out, track->track_id);
    put_u32(out, 1); /* codec/config generation */
    put_u32(out, track->type);
    put_i32(out, st->time_base.num);
    put_i32(out, st->time_base.den);
    put_i32(out, c->width);
    put_i32(out, c->height);
    put_i32(out, c->sample_rate);
    put_i32(out, c->ch_layout.nb_channels);
    put_bytes(out, codec, sizeof(codec));
    put_u32(out, c->extradata_size);
    put_bytes(out, c->extradata, c->extradata_size);
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        fprintf(stderr, "usage: %s INPUT_MEDIA OUTPUT.rdp\n", argv[0]);
        return 2;
    }

    AVFormatContext *input = NULL;
    int err = avformat_open_input(&input, argv[1], NULL, NULL);
    if (err < 0)
        fail("avformat_open_input failed");
    if (avformat_find_stream_info(input, NULL) < 0)
        fail("avformat_find_stream_info failed");

    struct chosen_track tracks[2];
    int num_tracks = 0;
    int video = av_find_best_stream(input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    int audio = av_find_best_stream(input, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (video >= 0)
        tracks[num_tracks++] = (struct chosen_track){video, 1, RDP_TRACK_VIDEO};
    if (audio >= 0)
        tracks[num_tracks++] = (struct chosen_track){audio, 2, RDP_TRACK_AUDIO};
    if (num_tracks != 2)
        fail("fixture must contain one usable video and one usable audio stream");

    FILE *out = fopen(argv[2], "wb");
    if (!out)
        fail(strerror(errno));
    put_bytes(out, RDP_MAGIC, 8);
    put_u32(out, RDP_VERSION);
    put_u32(out, num_tracks);
    for (int n = 0; n < num_tracks; n++)
        write_config(out, input->streams[tracks[n].stream_index], &tracks[n]);

    uint64_t packets = 0;
    uint64_t payload_bytes = 0;
    uint32_t max_packet = 0;
    uint64_t pts_ne_dts = 0;
    int64_t first_pts[2] = {RDP_NOPTS, RDP_NOPTS};
    int64_t last_pts[2] = {RDP_NOPTS, RDP_NOPTS};
    AVPacket *pkt = av_packet_alloc();
    if (!pkt)
        fail("av_packet_alloc failed");
    while ((err = av_read_frame(input, pkt)) >= 0) {
        int selected = -1;
        for (int n = 0; n < num_tracks; n++) {
            if (tracks[n].stream_index == pkt->stream_index)
                selected = n;
        }
        if (selected < 0) {
            av_packet_unref(pkt);
            continue;
        }
        AVStream *st = input->streams[pkt->stream_index];
        put_u32(out, RDP_RECORD_PACKET);
        put_u32(out, tracks[selected].track_id);
        put_u32(out, 1); /* codec/config generation */
        put_i64(out, timestamp_or_nopts(pkt->pts));
        put_i64(out, timestamp_or_nopts(pkt->dts));
        put_i64(out, pkt->duration);
        put_i32(out, st->time_base.num);
        put_i32(out, st->time_base.den);
        put_u32(out, pkt->flags & AV_PKT_FLAG_KEY ? RDP_FLAG_KEYFRAME : 0);
        put_u32(out, pkt->size);
        put_bytes(out, pkt->data, pkt->size);

        int64_t pts = timestamp_or_nopts(pkt->pts);
        if (first_pts[selected] == RDP_NOPTS)
            first_pts[selected] = pts;
        last_pts[selected] = pts;
        packets++;
        payload_bytes += pkt->size;
        if ((uint32_t)pkt->size > max_packet)
            max_packet = pkt->size;
        if (pkt->pts != AV_NOPTS_VALUE && pkt->dts != AV_NOPTS_VALUE && pkt->pts != pkt->dts)
            pts_ne_dts++;
        av_packet_unref(pkt);
    }
    if (err != AVERROR_EOF)
        fail("av_read_frame failed before EOF");
    put_u32(out, RDP_RECORD_EOF);
    if (fclose(out) != 0)
        fail("close failed");

    printf("tracks=%d packets=%" PRIu64 " payload_bytes=%" PRIu64
           " max_packet=%u pts_ne_dts=%" PRIu64 "\n",
           num_tracks, packets, payload_bytes, max_packet, pts_ne_dts);
    printf("video_first_pts=%" PRId64 " video_last_pts=%" PRId64
           " audio_first_pts=%" PRId64 " audio_last_pts=%" PRId64 "\n",
           first_pts[0], last_pts[0], first_pts[1], last_pts[1]);

    av_packet_free(&pkt);
    avformat_close_input(&input);
    return 0;
}
