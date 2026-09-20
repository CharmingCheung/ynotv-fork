#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/encryption_info.h>
#include <openssl/evp.h>

#include "cenc_transform.h"
#include "../mpv-packet-demux-adapter/rustdash_packet_abi.h"

struct chosen_track {
    int stream_index;
    uint32_t track_id;
    uint32_t type;
};

static void fail(const char *what)
{
    fprintf(stderr, "cenc_packet_producer: %s\n", what);
    exit(1);
}

static void put_bytes(FILE *f, const void *data, size_t size)
{
    if (size && fwrite(data, 1, size, f) != size)
        fail("write failed");
}

static void put_u32(FILE *f, uint32_t value)
{
    uint8_t bytes[4] = {value, value >> 8, value >> 16, value >> 24};
    put_bytes(f, bytes, sizeof(bytes));
}

static void put_i32(FILE *f, int32_t value)
{
    put_u32(f, (uint32_t)value);
}

static void put_i64(FILE *f, int64_t value)
{
    uint64_t u = (uint64_t)value;
    uint8_t bytes[8] = {u, u >> 8, u >> 16, u >> 24,
                        u >> 32, u >> 40, u >> 48, u >> 56};
    put_bytes(f, bytes, sizeof(bytes));
}

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex_16(const char *text, uint8_t bytes[16])
{
    if (!text || strlen(text) != 32)
        return 0;
    for (int n = 0; n < 16; n++) {
        int high = hex_nibble(text[n * 2]);
        int low = hex_nibble(text[n * 2 + 1]);
        if (high < 0 || low < 0)
            return 0;
        bytes[n] = (uint8_t)((high << 4) | low);
    }
    return 1;
}

static int64_t timestamp_or_nopts(int64_t value)
{
    return value == AV_NOPTS_VALUE ? RDP_NOPTS : value;
}

static int select_tracks(AVFormatContext *format, struct chosen_track tracks[2])
{
    int count = 0;
    int video = av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    int audio = av_find_best_stream(format, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (video >= 0)
        tracks[count++] = (struct chosen_track){video, 1, RDP_TRACK_VIDEO};
    if (audio >= 0)
        tracks[count++] = (struct chosen_track){audio, 2, RDP_TRACK_AUDIO};
    return count;
}

static int selected_index(const struct chosen_track tracks[2], int stream_index)
{
    for (int n = 0; n < 2; n++) {
        if (tracks[n].stream_index == stream_index)
            return n;
    }
    return -1;
}

static int read_selected(AVFormatContext *format,
                         const struct chosen_track tracks[2], AVPacket *packet)
{
    int result;
    while ((result = av_read_frame(format, packet)) >= 0) {
        if (selected_index(tracks, packet->stream_index) >= 0)
            return 1;
        av_packet_unref(packet);
    }
    if (result == AVERROR_EOF)
        return 0;
    fail("av_read_frame failed before EOF");
    return 0;
}

static void verify_configs(AVFormatContext *clear, AVFormatContext *encrypted,
                           const struct chosen_track clear_tracks[2],
                           const struct chosen_track encrypted_tracks[2])
{
    for (int n = 0; n < 2; n++) {
        const AVCodecParameters *a = clear->streams[clear_tracks[n].stream_index]->codecpar;
        const AVCodecParameters *b = encrypted->streams[encrypted_tracks[n].stream_index]->codecpar;
        if (a->codec_type != b->codec_type || a->codec_id != b->codec_id ||
            a->extradata_size != b->extradata_size ||
            memcmp(a->extradata, b->extradata, (size_t)a->extradata_size) != 0)
            fail("clear/encrypted codec configuration differs");
    }
}

static void write_config(FILE *output, AVStream *stream,
                         const struct chosen_track *track)
{
    AVCodecParameters *codec = stream->codecpar;
    const AVCodecDescriptor *descriptor = avcodec_descriptor_get(codec->codec_id);
    const char *name = descriptor ? descriptor->name : avcodec_get_name(codec->codec_id);
    char codec_name[RDP_CODEC_NAME_BYTES] = {0};
    snprintf(codec_name, sizeof(codec_name), "%s", name);
    put_u32(output, track->track_id);
    put_u32(output, 1);
    put_u32(output, track->type);
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

static int digest_sha256(const uint8_t *data, size_t size, uint8_t digest[32])
{
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    unsigned int digest_size = 0;
    int ok = ctx && EVP_DigestInit_ex(ctx, EVP_sha256(), NULL) == 1 &&
             EVP_DigestUpdate(ctx, data, size) == 1 &&
             EVP_DigestFinal_ex(ctx, digest, &digest_size) == 1 &&
             digest_size == 32;
    EVP_MD_CTX_free(ctx);
    return ok;
}

static void write_packet_with_timebase(FILE *output,
                                       const struct chosen_track *track,
                                       const AVPacket *encrypted,
                                       const AVStream *stream,
                                       const struct cenc_clear_packet *clear)
{
    put_u32(output, RDP_RECORD_PACKET);
    put_u32(output, track->track_id);
    put_u32(output, clear->codec_generation);
    put_i64(output, clear->pts);
    put_i64(output, clear->dts);
    put_i64(output, clear->duration);
    put_i32(output, stream->time_base.num);
    put_i32(output, stream->time_base.den);
    put_u32(output, clear->keyframe ? RDP_FLAG_KEYFRAME : 0);
    put_u32(output, (uint32_t)clear->size);
    put_bytes(output, clear->data, clear->size);
    (void)encrypted;
}

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "usage: %s CLEAR.mp4 ENCRYPTED.mp4 OUTPUT.rdp\n", argv[0]);
        return 2;
    }
    struct cenc_key_entry entry;
    memset(&entry, 0, sizeof(entry));
    if (!parse_hex_16(getenv("RUSTDASH_TEST_KID"), entry.kid) ||
        !parse_hex_16(getenv("RUSTDASH_TEST_KEY"), entry.key))
        fail("RUSTDASH_TEST_KID and RUSTDASH_TEST_KEY must each be 32 hex digits");
    struct cenc_key_store store = {&entry, 1};

    AVFormatContext *clear_format = NULL;
    AVFormatContext *encrypted_format = NULL;
    if (avformat_open_input(&clear_format, argv[1], NULL, NULL) < 0)
        fail("could not open clear input");
    if (avformat_open_input(&encrypted_format, argv[2], NULL, NULL) < 0)
        fail("could not open encrypted input");
    struct chosen_track clear_tracks[2];
    struct chosen_track encrypted_tracks[2];
    if (select_tracks(clear_format, clear_tracks) != 2 ||
        select_tracks(encrypted_format, encrypted_tracks) != 2)
        fail("inputs must each contain one H.264 video and one AAC audio track");
    verify_configs(clear_format, encrypted_format, clear_tracks, encrypted_tracks);

    FILE *output = fopen(argv[3], "wb");
    if (!output)
        fail(strerror(errno));
    put_bytes(output, RDP_MAGIC, 8);
    put_u32(output, RDP_VERSION);
    put_u32(output, 2);
    for (int n = 0; n < 2; n++)
        write_config(output,
                     encrypted_format->streams[encrypted_tracks[n].stream_index],
                     &encrypted_tracks[n]);

    AVPacket *clear_packet = av_packet_alloc();
    AVPacket *encrypted_packet = av_packet_alloc();
    if (!clear_packet || !encrypted_packet)
        fail("packet allocation failed");
    uint64_t packet_counts[2] = {0, 0};
    uint64_t subsample_packets = 0;
    uint32_t max_subsamples = 0;
    uint32_t min_iv_size = UINT32_MAX;
    uint32_t max_iv_size = 0;
    int saw_pssh = 0;
    int printed_kid = 0;

    for (int n = 0; n < 2; n++) {
        const AVCodecParameters *codec = encrypted_format->streams[encrypted_tracks[n].stream_index]->codecpar;
        for (int side = 0; side < codec->nb_coded_side_data; side++) {
            if (codec->coded_side_data[side].type == AV_PKT_DATA_ENCRYPTION_INIT_INFO)
                saw_pssh = 1;
        }
    }

    for (;;) {
        int have_clear = read_selected(clear_format, clear_tracks, clear_packet);
        int have_encrypted = read_selected(encrypted_format, encrypted_tracks, encrypted_packet);
        if (have_clear != have_encrypted)
            fail("clear/encrypted packet count differs");
        if (!have_clear)
            break;
        int clear_index = selected_index(clear_tracks, clear_packet->stream_index);
        int encrypted_index = selected_index(encrypted_tracks, encrypted_packet->stream_index);
        if (clear_index != encrypted_index)
            fail("clear/encrypted packet interleave differs");
        AVStream *clear_stream = clear_format->streams[clear_packet->stream_index];
        AVStream *encrypted_stream = encrypted_format->streams[encrypted_packet->stream_index];
        if (clear_stream->time_base.num != encrypted_stream->time_base.num ||
            clear_stream->time_base.den != encrypted_stream->time_base.den ||
            clear_packet->pts != encrypted_packet->pts ||
            clear_packet->dts != encrypted_packet->dts ||
            clear_packet->duration != encrypted_packet->duration ||
            !!(clear_packet->flags & AV_PKT_FLAG_KEY) !=
                !!(encrypted_packet->flags & AV_PKT_FLAG_KEY) ||
            clear_packet->size != encrypted_packet->size)
            fail("clear/encrypted packet metadata differs");

        size_t side_size = 0;
        const uint8_t *side = av_packet_get_side_data(
            encrypted_packet, AV_PKT_DATA_ENCRYPTION_INFO, &side_size);
        if (!side)
            fail("encrypted packet has no AV_PKT_DATA_ENCRYPTION_INFO");
        AVEncryptionInfo *info = av_encryption_info_get_side_data(side, side_size);
        if (!info)
            fail("could not parse AV_PKT_DATA_ENCRYPTION_INFO");
        if (info->iv_size < min_iv_size) min_iv_size = info->iv_size;
        if (info->iv_size > max_iv_size) max_iv_size = info->iv_size;
        if (info->subsample_count) subsample_packets++;
        if (info->subsample_count > max_subsamples) max_subsamples = info->subsample_count;
        if (!printed_kid && info->key_id_size == 16) {
            printf("packet_kid=%02x%02x...%02x%02x key_lookup=attempted\n",
                   info->key_id[0], info->key_id[1], info->key_id[14], info->key_id[15]);
            printed_kid = 1;
        }

        struct cenc_packet input = {
            encrypted_packet->data,
            (size_t)encrypted_packet->size,
            timestamp_or_nopts(encrypted_packet->pts),
            timestamp_or_nopts(encrypted_packet->dts),
            encrypted_packet->duration,
            !!(encrypted_packet->flags & AV_PKT_FLAG_KEY),
            1,
        };
        struct cenc_clear_packet decrypted = {0};
        enum cenc_packet_state state = cenc_decrypt_packet(
            &store, &input, info, 0, &decrypted);
        av_encryption_info_free(info);
        if (state != CENC_ENCRYPTED_PACKET) {
            fprintf(stderr, "cenc_packet_producer: transform=%s\n",
                    cenc_packet_state_name(state));
            return state == CENC_KEY_UNAVAILABLE ? 3 : 1;
        }
        uint8_t clear_hash[32];
        uint8_t decrypted_hash[32];
        if (!digest_sha256(clear_packet->data, (size_t)clear_packet->size, clear_hash) ||
            !digest_sha256(decrypted.data, decrypted.size, decrypted_hash))
            fail("SHA-256 failed");
        if (memcmp(clear_hash, decrypted_hash, 32) != 0 ||
            memcmp(clear_packet->data, decrypted.data, decrypted.size) != 0) {
            fprintf(stderr, "cenc_packet_producer: expected negative or wrong-key payload mismatch packet=%" PRIu64 "\n",
                    packet_counts[0] + packet_counts[1]);
            cenc_clear_packet_free(&decrypted);
            return 4;
        }
        write_packet_with_timebase(output, &encrypted_tracks[encrypted_index],
                                   encrypted_packet, encrypted_stream, &decrypted);
        packet_counts[encrypted_index]++;
        cenc_clear_packet_free(&decrypted);
        av_packet_unref(clear_packet);
        av_packet_unref(encrypted_packet);
    }
    put_u32(output, RDP_RECORD_EOF);
    if (fclose(output) != 0)
        fail("output close failed");

    printf("comparison=PASS packets=%" PRIu64 " video=%" PRIu64
           " audio=%" PRIu64 " metadata=pts,dts,duration,keyframe,size,payload_sha256\n",
           packet_counts[0] + packet_counts[1], packet_counts[0], packet_counts[1]);
    printf("scheme=cenc iv_size=%u..%u subsample_packets=%" PRIu64
           " max_subsamples=%u pssh=%s key_lookup=success\n",
           min_iv_size, max_iv_size, subsample_packets, max_subsamples,
           saw_pssh ? "present" : "absent");

    av_packet_free(&clear_packet);
    av_packet_free(&encrypted_packet);
    avformat_close_input(&clear_format);
    avformat_close_input(&encrypted_format);
    return 0;
}
