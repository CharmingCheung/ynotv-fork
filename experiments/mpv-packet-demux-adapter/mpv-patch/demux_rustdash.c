/* Experimental packet sink for ynoTV research. Not a production ABI. */
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>

#include "audio/chmap.h"
#include "common/common.h"
#include "demux.h"
#include "packet.h"
#include "rdp_endian.h"
#include "stheader.h"
#include "stream/stream.h"

#define RDP_MAGIC "RDPKT001"
#define RDP_VERSION 1u
#define RDP_CODEC_NAME_BYTES 32u
#define RDP_RECORD_PACKET 0x31544b50u
#define RDP_RECORD_EOF    0x31464f45u
#define RDP_TRACK_VIDEO 1u
#define RDP_TRACK_AUDIO 2u
#define RDP_FLAG_KEYFRAME 1u
#define RDP_NOPTS INT64_MIN
#define RDP_MAX_EXTRADATA (1024u * 1024u)
#define RDP_MAX_PACKET (64u * 1024u * 1024u)

struct rdp_track {
    uint32_t id;
    uint32_t generation;
    uint32_t type;
    int32_t tb_num;
    int32_t tb_den;
    struct sh_stream *sh;
};

struct rdp_packet_index {
    int64_t payload_offset;
    uint32_t payload_size;
    uint32_t track;
    uint32_t generation;
    int64_t pts;
    int64_t dts;
    int64_t duration;
    int32_t tb_num;
    int32_t tb_den;
    uint32_t flags;
};

struct priv {
    struct rdp_track tracks[2];
    int num_tracks;
    struct rdp_packet_index *packets;
    int num_packets;
    int cursor;
};

static bool read_exact(struct stream *s, void *dst, size_t size)
{
    return size <= INT_MAX && stream_read(s, dst, size) == size;
}

static bool get_u32(struct stream *s, uint32_t *value)
{
    uint8_t b[4];
    if (!read_exact(s, b, sizeof(b)))
        return false;
    *value = rdp_read_le_u32(b);
    return true;
}

static bool get_i32(struct stream *s, int32_t *value)
{
    uint8_t b[4];
    if (!read_exact(s, b, sizeof(b)))
        return false;
    *value = rdp_read_le_i32(b);
    return true;
}

static bool get_i64(struct stream *s, int64_t *value)
{
    uint8_t b[8];
    if (!read_exact(s, b, sizeof(b)))
        return false;
    *value = rdp_read_le_i64(b);
    return true;
}

static double to_seconds(int64_t value, int32_t num, int32_t den)
{
    return value == RDP_NOPTS ? MP_NOPTS_VALUE : (double)value * num / den;
}

static struct rdp_track *find_track(struct priv *p, uint32_t id)
{
    for (int n = 0; n < p->num_tracks; n++) {
        if (p->tracks[n].id == id)
            return &p->tracks[n];
    }
    return NULL;
}

static bool read_track_config(struct demuxer *demuxer, struct rdp_track *track)
{
    struct stream *s = demuxer->stream;
    int32_t width, height, sample_rate, channels;
    char codec[RDP_CODEC_NAME_BYTES + 1] = {0};
    uint32_t extradata_size;

    if (!get_u32(s, &track->id) || !get_u32(s, &track->generation) ||
        !get_u32(s, &track->type) || !get_i32(s, &track->tb_num) ||
        !get_i32(s, &track->tb_den) || !get_i32(s, &width) ||
        !get_i32(s, &height) || !get_i32(s, &sample_rate) ||
        !get_i32(s, &channels) || !read_exact(s, codec, RDP_CODEC_NAME_BYTES) ||
        !get_u32(s, &extradata_size))
        return false;
    if (!track->id || track->generation != 1 || track->tb_num <= 0 ||
        track->tb_den <= 0 || extradata_size > RDP_MAX_EXTRADATA ||
        (track->type != RDP_TRACK_VIDEO && track->type != RDP_TRACK_AUDIO))
        return false;

    enum stream_type type = track->type == RDP_TRACK_VIDEO ? STREAM_VIDEO : STREAM_AUDIO;
    struct sh_stream *sh = demux_alloc_sh_stream(type);
    sh->demuxer_id = track->id;
    sh->codec->codec = talloc_strdup(sh, codec);
    sh->codec->native_tb_num = track->tb_num;
    sh->codec->native_tb_den = track->tb_den;
    if (type == STREAM_VIDEO) {
        sh->codec->disp_w = width;
        sh->codec->disp_h = height;
    } else {
        sh->codec->samplerate = sample_rate;
        mp_chmap_from_channels(&sh->codec->channels, channels);
    }
    if (extradata_size) {
        sh->codec->extradata = talloc_size(sh, extradata_size);
        if (!read_exact(s, sh->codec->extradata, extradata_size)) {
            talloc_free(sh);
            return false;
        }
        sh->codec->extradata_size = extradata_size;
    }
    demux_add_sh_stream(demuxer, sh);
    track->sh = sh;
    return true;
}

static bool scan_packet(struct demuxer *demuxer, struct priv *p)
{
    struct stream *s = demuxer->stream;
    struct rdp_packet_index packet = {0};
    if (!get_u32(s, &packet.track) || !get_u32(s, &packet.generation) ||
        !get_i64(s, &packet.pts) || !get_i64(s, &packet.dts) ||
        !get_i64(s, &packet.duration) || !get_i32(s, &packet.tb_num) ||
        !get_i32(s, &packet.tb_den) || !get_u32(s, &packet.flags) ||
        !get_u32(s, &packet.payload_size))
        return false;

    struct rdp_track *track = find_track(p, packet.track);
    if (!track || packet.generation != track->generation ||
        packet.tb_num != track->tb_num || packet.tb_den != track->tb_den ||
        packet.payload_size > RDP_MAX_PACKET ||
        packet.duration < 0 || (packet.flags & ~RDP_FLAG_KEYFRAME))
        return false;
    packet.payload_offset = stream_tell(s);
    if (!stream_seek(s, packet.payload_offset + packet.payload_size))
        return false;
    MP_TARRAY_APPEND(p, p->packets, p->num_packets, packet);

    double end = to_seconds(packet.pts, packet.tb_num, packet.tb_den);
    if (end != MP_NOPTS_VALUE)
        demuxer->duration = MPMAX(demuxer->duration, end + to_seconds(packet.duration, packet.tb_num, packet.tb_den));
    return true;
}

static int rustdash_open(struct demuxer *demuxer, enum demux_check check)
{
    if (check != DEMUX_CHECK_REQUEST && check != DEMUX_CHECK_FORCE)
        return -1;
    struct stream *s = demuxer->stream;
    if (!s || !s->seekable)
        return -1;

    char magic[8];
    uint32_t version, num_tracks;
    if (!read_exact(s, magic, sizeof(magic)) || memcmp(magic, RDP_MAGIC, 8) ||
        !get_u32(s, &version) || version != RDP_VERSION ||
        !get_u32(s, &num_tracks) || num_tracks != 2)
        return -1;

    struct priv *p = talloc_zero(demuxer, struct priv);
    demuxer->priv = p;
    p->num_tracks = num_tracks;
    for (int n = 0; n < p->num_tracks; n++) {
        if (!read_track_config(demuxer, &p->tracks[n]))
            return -1;
    }
    if (!find_track(p, 1) || !find_track(p, 2) ||
        find_track(p, 1)->type != RDP_TRACK_VIDEO ||
        find_track(p, 2)->type != RDP_TRACK_AUDIO)
        return -1;

    while (true) {
        uint32_t record;
        if (!get_u32(s, &record))
            return -1;
        if (record == RDP_RECORD_EOF)
            break;
        if (record != RDP_RECORD_PACKET || !scan_packet(demuxer, p))
            return -1;
    }
    if (!p->num_packets)
        return -1;

    demuxer->seekable = true;
    demuxer->filetype = "rustdash-packet-v1";
    MP_INFO(demuxer, "indexed %d externally supplied packets; max live adapter payload is one packet\n",
            p->num_packets);
    return 0;
}

static bool rustdash_read_packet(struct demuxer *demuxer, struct demux_packet **out)
{
    struct priv *p = demuxer->priv;
    while (p->cursor < p->num_packets) {
        struct rdp_packet_index *src = &p->packets[p->cursor];
        struct rdp_track *track = find_track(p, src->track);
        if (!demux_stream_is_selected(track->sh)) {
            p->cursor++;
            continue;
        }
        struct demux_packet *packet = new_demux_packet(demuxer->packet_pool,
                                                        src->payload_size);
        if (!packet) {
            MP_ERR(demuxer, "could not allocate packet %d (%u bytes)\n",
                   p->cursor, src->payload_size);
            return true;
        }
        if (!stream_seek(demuxer->stream, src->payload_offset)) {
            MP_ERR(demuxer, "could not seek to payload for packet %d at offset %" PRId64 "\n",
                   p->cursor, src->payload_offset);
            free_demux_packet(packet);
            return false;
        }
        if (!read_exact(demuxer->stream, packet->buffer, src->payload_size)) {
            MP_ERR(demuxer, "could not read payload for packet %d at offset %" PRId64
                   " (%u bytes)\n", p->cursor, src->payload_offset,
                   src->payload_size);
            free_demux_packet(packet);
            return false;
        }
        packet->stream = track->sh->index;
        packet->pts = to_seconds(src->pts, src->tb_num, src->tb_den);
        packet->dts = to_seconds(src->dts, src->tb_num, src->tb_den);
        packet->duration = to_seconds(src->duration, src->tb_num, src->tb_den);
        packet->keyframe = src->flags & RDP_FLAG_KEYFRAME;
        packet->pos = src->payload_offset;
        *out = packet;
        p->cursor++;
        return true;
    }
    MP_INFO(demuxer, "experimental producer final EOF\n");
    return false;
}

static void rustdash_seek(struct demuxer *demuxer, double seek_pts, int flags)
{
    struct priv *p = demuxer->priv;
    double target = flags & SEEK_FACTOR ? seek_pts * demuxer->duration : seek_pts;
    int chosen = 0;
    double chosen_pts = 0;
    bool found = false;
    for (int n = 0; n < p->num_packets; n++) {
        struct rdp_packet_index *packet = &p->packets[n];
        struct rdp_track *track = find_track(p, packet->track);
        if (track->type != RDP_TRACK_VIDEO || !(packet->flags & RDP_FLAG_KEYFRAME))
            continue;
        double pts = to_seconds(packet->pts, packet->tb_num, packet->tb_den);
        if (pts != MP_NOPTS_VALUE && pts <= target &&
            (!found || pts >= chosen_pts)) {
            chosen = n;
            chosen_pts = pts;
            found = true;
        }
    }
    p->cursor = chosen;
    MP_INFO(demuxer, "experimental seek target=%.3f keyframe=%.3f packet=%d\n",
            target, chosen_pts, chosen);
}

static void rustdash_drop_buffers(struct demuxer *demuxer)
{
    stream_drop_buffers(demuxer->stream);
}

const struct demuxer_desc demuxer_desc_rustdash = {
    .name = "rustdash",
    .desc = "experimental externally supplied packet stream",
    .open = rustdash_open,
    .read_packet = rustdash_read_packet,
    .drop_buffers = rustdash_drop_buffers,
    .seek = rustdash_seek,
};
