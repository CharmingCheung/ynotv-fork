#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/encryption_info.h>
#include <libavutil/mathematics.h>

#include "cenc_transform.h"
#include "../mpv-packet-demux-adapter/rustdash_packet_abi.h"

struct component {
    AVFormatContext *format;
    AVPacket *packet;
    struct cenc_clear_packet clear;
    int stream_index;
    int have_packet;
    int64_t base_dts;
    uint32_t track_id;
    uint32_t track_type;
    uint64_t packets;
    uint64_t subsample_packets;
    uint32_t max_subsamples;
    uint32_t min_iv;
    uint32_t max_iv;
    int pssh_count;
};

static void fail(const char *message)
{
    fprintf(stderr, "cenc_component_producer: %s\n", message);
    exit(1);
}

static void put_bytes(FILE *file, const void *data, size_t size)
{
    if (size && fwrite(data, 1, size, file) != size)
        fail("write failed");
}

static void put_u32(FILE *file, uint32_t value)
{
    uint8_t bytes[4] = {value, value >> 8, value >> 16, value >> 24};
    put_bytes(file, bytes, sizeof(bytes));
}

static void put_i32(FILE *file, int32_t value)
{
    put_u32(file, (uint32_t)value);
}

static void put_i64(FILE *file, int64_t value)
{
    uint64_t u = (uint64_t)value;
    uint8_t bytes[8] = {u, u >> 8, u >> 16, u >> 24,
                        u >> 32, u >> 40, u >> 48, u >> 56};
    put_bytes(file, bytes, sizeof(bytes));
}

static int nibble(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static int parse_hex_16(const char *text, uint8_t output[16])
{
    if (!text || strlen(text) != 32)
        return 0;
    for (int n = 0; n < 16; n++) {
        int high = nibble(text[n * 2]);
        int low = nibble(text[n * 2 + 1]);
        if (high < 0 || low < 0)
            return 0;
        output[n] = (uint8_t)((high << 4) | low);
    }
    return 1;
}

static int64_t packet_time(int64_t value)
{
    return value == AV_NOPTS_VALUE ? RDP_NOPTS : value;
}

static void open_component(struct component *component, const char *path,
                           enum AVMediaType type, uint32_t track_id,
                           uint32_t track_type)
{
    memset(component, 0, sizeof(*component));
    component->base_dts = AV_NOPTS_VALUE;
    component->track_id = track_id;
    component->track_type = track_type;
    component->min_iv = UINT32_MAX;
    if (avformat_open_input(&component->format, path, NULL, NULL) < 0)
        fail("could not open component input");
    component->stream_index = av_find_best_stream(
        component->format, type, -1, -1, NULL, 0);
    if (component->stream_index < 0)
        fail("component has no expected stream");
    component->packet = av_packet_alloc();
    if (!component->packet)
        fail("packet allocation failed");
    AVCodecParameters *codec = component->format->streams[component->stream_index]->codecpar;
    for (int n = 0; n < codec->nb_coded_side_data; n++) {
        if (codec->coded_side_data[n].type == AV_PKT_DATA_ENCRYPTION_INIT_INFO)
            component->pssh_count++;
    }
}

static void write_config(FILE *output, const struct component *component)
{
    AVStream *stream = component->format->streams[component->stream_index];
    AVCodecParameters *codec = stream->codecpar;
    const AVCodecDescriptor *descriptor = avcodec_descriptor_get(codec->codec_id);
    const char *name = descriptor ? descriptor->name : avcodec_get_name(codec->codec_id);
    char codec_name[RDP_CODEC_NAME_BYTES] = {0};
    snprintf(codec_name, sizeof(codec_name), "%s", name);
    put_u32(output, component->track_id);
    put_u32(output, 1);
    put_u32(output, component->track_type);
    put_i32(output, stream->time_base.num);
    put_i32(output, stream->time_base.den);
    put_i32(output, codec->width);
    put_i32(output, codec->height);
    put_i32(output, codec->sample_rate);
    put_i32(output, codec->ch_layout.nb_channels);
    put_bytes(output, codec_name, sizeof(codec_name));
    put_u32(output, (uint32_t)codec->extradata_size);
    put_bytes(output, codec->extradata, (size_t)codec->extradata_size);
}

static int read_component(struct component *component,
                          const struct cenc_key_store *store, int *printed_kid)
{
    int result;
    av_packet_unref(component->packet);
    cenc_clear_packet_free(&component->clear);
    while ((result = av_read_frame(component->format, component->packet)) >= 0) {
        if (component->packet->stream_index == component->stream_index)
            break;
        av_packet_unref(component->packet);
    }
    if (result == AVERROR_EOF) {
        component->have_packet = 0;
        return 0;
    }
    if (result < 0)
        fail("component demux failed before EOF");

    size_t side_size = 0;
    const uint8_t *side = av_packet_get_side_data(
        component->packet, AV_PKT_DATA_ENCRYPTION_INFO, &side_size);
    if (side) {
        AVEncryptionInfo *info = av_encryption_info_get_side_data(side, side_size);
        if (!info)
            fail("could not parse packet encryption info");
        if (!*printed_kid && info->key_id_size == 16) {
            printf("packet_kid=%02x%02x...%02x%02x key_lookup=attempted\n",
                   info->key_id[0], info->key_id[1], info->key_id[14], info->key_id[15]);
            *printed_kid = 1;
        }
        if (info->iv_size < component->min_iv) component->min_iv = info->iv_size;
        if (info->iv_size > component->max_iv) component->max_iv = info->iv_size;
        if (info->subsample_count) component->subsample_packets++;
        if (info->subsample_count > component->max_subsamples)
            component->max_subsamples = info->subsample_count;
        struct cenc_packet input = {
            component->packet->data, (size_t)component->packet->size,
            packet_time(component->packet->pts), packet_time(component->packet->dts),
            component->packet->duration, !!(component->packet->flags & AV_PKT_FLAG_KEY), 1,
        };
        enum cenc_packet_state state = cenc_decrypt_packet(store, &input, info, 0,
                                                           &component->clear);
        av_encryption_info_free(info);
        if (state != CENC_ENCRYPTED_PACKET) {
            fprintf(stderr, "cenc_component_producer: transform=%s\n",
                    cenc_packet_state_name(state));
            exit(state == CENC_KEY_UNAVAILABLE ? 3 : 1);
        }
    } else {
        component->clear.data = malloc((size_t)component->packet->size);
        if (!component->clear.data)
            fail("clear packet allocation failed");
        memcpy(component->clear.data, component->packet->data,
               (size_t)component->packet->size);
        component->clear.size = (size_t)component->packet->size;
        component->clear.pts = packet_time(component->packet->pts);
        component->clear.dts = packet_time(component->packet->dts);
        component->clear.duration = component->packet->duration;
        component->clear.keyframe = !!(component->packet->flags & AV_PKT_FLAG_KEY);
        component->clear.codec_generation = 1;
    }
    if (component->base_dts == AV_NOPTS_VALUE) {
        component->base_dts = component->packet->dts != AV_NOPTS_VALUE
            ? component->packet->dts : component->packet->pts;
    }
    if (component->clear.pts != RDP_NOPTS)
        component->clear.pts -= component->base_dts;
    if (component->clear.dts != RDP_NOPTS)
        component->clear.dts -= component->base_dts;
    component->have_packet = 1;
    return 1;
}

static void write_packet(FILE *output, struct component *component)
{
    AVStream *stream = component->format->streams[component->stream_index];
    put_u32(output, RDP_RECORD_PACKET);
    put_u32(output, component->track_id);
    put_u32(output, 1);
    put_i64(output, component->clear.pts);
    put_i64(output, component->clear.dts);
    put_i64(output, component->clear.duration);
    put_i32(output, stream->time_base.num);
    put_i32(output, stream->time_base.den);
    put_u32(output, component->clear.keyframe ? RDP_FLAG_KEYFRAME : 0);
    put_u32(output, (uint32_t)component->clear.size);
    put_bytes(output, component->clear.data, component->clear.size);
    component->packets++;
}

static int earlier(const struct component *a, const struct component *b)
{
    int64_t a_time = a->packet->dts != AV_NOPTS_VALUE ? a->packet->dts : a->packet->pts;
    int64_t b_time = b->packet->dts != AV_NOPTS_VALUE ? b->packet->dts : b->packet->pts;
    AVRational a_base = a->format->streams[a->stream_index]->time_base;
    AVRational b_base = b->format->streams[b->stream_index]->time_base;
    return av_compare_ts(a_time, a_base, b_time, b_base) <= 0;
}

static void close_component(struct component *component)
{
    cenc_clear_packet_free(&component->clear);
    av_packet_free(&component->packet);
    avformat_close_input(&component->format);
}

int main(int argc, char **argv)
{
    if (argc < 4 || argc > 10) {
        fprintf(stderr, "usage: %s VIDEO.mp4 AUDIO.mp4 [SUBTITLE.mp4 ...] OUTPUT.rdp\n", argv[0]);
        return 2;
    }
    struct cenc_key_entry entry;
    memset(&entry, 0, sizeof(entry));
    if (!parse_hex_16(getenv("RUSTDASH_TEST_KID"), entry.kid) ||
        !parse_hex_16(getenv("RUSTDASH_TEST_KEY"), entry.key))
        fail("RUSTDASH_TEST_KID and RUSTDASH_TEST_KEY must each be 32 hex digits");
    struct cenc_key_store store = {&entry, 1};

    int component_count = argc - 2;
    struct component components[8];
    open_component(&components[0], argv[1], AVMEDIA_TYPE_VIDEO, 1, RDP_TRACK_VIDEO);
    open_component(&components[1], argv[2], AVMEDIA_TYPE_AUDIO, 2, RDP_TRACK_AUDIO);
    for (int n = 2; n < component_count; n++)
        open_component(&components[n], argv[n + 1], AVMEDIA_TYPE_SUBTITLE,
                       (uint32_t)n + 1, RDP_TRACK_SUBTITLE);
    FILE *output = fopen(argv[argc - 1], "wb");
    if (!output)
        fail(strerror(errno));
    put_bytes(output, RDP_MAGIC, 8);
    put_u32(output, RDP_VERSION);
    put_u32(output, (uint32_t)component_count);
    for (int n = 0; n < component_count; n++)
        write_config(output, &components[n]);

    int printed_kid = 0;
    for (int n = 0; n < component_count; n++)
        read_component(&components[n], &store, &printed_kid);
    while (1) {
        struct component *next = NULL;
        for (int n = 0; n < component_count; n++)
            if (components[n].have_packet && (!next || earlier(&components[n], next)))
                next = &components[n];
        if (!next)
            break;
        write_packet(output, next);
        read_component(next, &store, &printed_kid);
    }
    put_u32(output, RDP_RECORD_EOF);
    if (fclose(output) != 0)
        fail("output close failed");

    AVCodecParameters *video_codec = components[0].format->streams[components[0].stream_index]->codecpar;
    AVCodecParameters *audio_codec = components[1].format->streams[components[1].stream_index]->codecpar;
    printf("real_transform=PASS video_codec=%s audio_codec=%s video_packets=%" PRIu64
           " audio_packets=%" PRIu64 " key_lookup=success\n",
           avcodec_get_name(video_codec->codec_id), avcodec_get_name(audio_codec->codec_id),
           components[0].packets, components[1].packets);
    printf("video_iv=%u..%u video_subsample_packets=%" PRIu64
           " video_max_subsamples=%u audio_iv=%u..%u audio_subsample_packets=%" PRIu64
           " audio_max_subsamples=%u pssh_records=%d\n",
           components[0].min_iv, components[0].max_iv, components[0].subsample_packets, components[0].max_subsamples,
           components[1].min_iv, components[1].max_iv, components[1].subsample_packets, components[1].max_subsamples,
           components[0].pssh_count + components[1].pssh_count);
    for (int n = 0; n < component_count; n++)
        close_component(&components[n]);
    return 0;
}
