/* Experimental packet sink for ynoTV research. Not a production ABI. */
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio/chmap.h"
#include "common/common.h"
#include "demux.h"
#include "misc/thread_tools.h"
#include "osdep/timer.h"
#include "packet.h"
#include "rdp_endian.h"
#include "stheader.h"
#include "stream/stream.h"

#define RDP_MAGIC "RDPKT001"
#define RDP_VERSION 1u
#define RDP_GENERATION_MAGIC "RDPKT002"
#define RDP_GENERATION_VERSION 2u
#define RDP_CODEC_NAME_BYTES 32u
#define RDP_RECORD_PACKET 0x31544b50u
#define RDP_RECORD_EOF    0x31464f45u
#define RDP_TRACK_VIDEO 1u
#define RDP_TRACK_AUDIO 2u
#define RDP_FLAG_KEYFRAME 1u
#define RDP_NOPTS INT64_MIN
#define RDP_MAX_EXTRADATA (1024u * 1024u)
#define RDP_MAX_PACKET (64u * 1024u * 1024u)
#define RDP_MAX_TRACKS 4
#define RDP_MAX_GENERATIONS 8
#define RDP_QUEUE_PACKETS 8
#define RDP_QUEUE_BYTES (128u * 1024u)

struct rdp_track {
    uint32_t id;
    uint32_t type;
    struct sh_stream *sh;
};

struct rdp_generation {
    uint32_t track;
    uint32_t generation;
    int32_t tb_num;
    int32_t tb_den;
    struct mp_codec_params *codec;
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
    int group;
};

struct rdp_ready_packet {
    int index;
    uint8_t *payload;
};

struct priv {
    struct demuxer *demuxer;
    struct rdp_track tracks[RDP_MAX_TRACKS];
    int num_tracks;
    struct rdp_generation generations[RDP_MAX_GENERATIONS];
    int num_generations;
    struct rdp_packet_index *packets;
    int num_packets;
    bool generation_fixture;

    FILE *source;
    mp_thread producer_thread;
    bool producer_started;
    mp_mutex lock;
    mp_cond wakeup;
    struct rdp_ready_packet *queue[RDP_QUEUE_PACKETS];
    int queue_head;
    int queue_count;
    size_t queue_bytes;
    int max_queue_count;
    size_t max_queue_bytes;
    int producer_cursor;
    int producer_group;
    uint64_t epoch;
    bool interrupted;
    bool stopping;
    bool producer_done;
    bool producer_failed;
    int delay_ms;
    int waits;
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

static struct rdp_generation *find_generation(struct priv *p, uint32_t track,
                                               uint32_t generation)
{
    for (int n = 0; n < p->num_generations; n++) {
        struct rdp_generation *g = &p->generations[n];
        if (g->track == track && g->generation == generation)
            return g;
    }
    return NULL;
}

static bool read_config(struct demuxer *demuxer, struct priv *p, bool publish)
{
    struct stream *s = demuxer->stream;
    uint32_t id, generation, type, extradata_size;
    int32_t tb_num, tb_den, width, height, sample_rate, channels;
    char codec_name[RDP_CODEC_NAME_BYTES + 1] = {0};
    if (!get_u32(s, &id) || !get_u32(s, &generation) || !get_u32(s, &type) ||
        !get_i32(s, &tb_num) || !get_i32(s, &tb_den) ||
        !get_i32(s, &width) || !get_i32(s, &height) ||
        !get_i32(s, &sample_rate) || !get_i32(s, &channels) ||
        !read_exact(s, codec_name, RDP_CODEC_NAME_BYTES) ||
        !get_u32(s, &extradata_size))
        return false;
    if (!id || !generation || tb_num <= 0 || tb_den <= 0 ||
        extradata_size > RDP_MAX_EXTRADATA ||
        (type != RDP_TRACK_VIDEO && type != RDP_TRACK_AUDIO) ||
        p->num_generations >= RDP_MAX_GENERATIONS)
        return false;

    struct rdp_track *track = find_track(p, id);
    if (publish) {
        if (track || p->num_tracks >= RDP_MAX_TRACKS)
            return false;
        track = &p->tracks[p->num_tracks++];
        track->id = id;
        track->type = type;
        enum stream_type stype = type == RDP_TRACK_VIDEO ? STREAM_VIDEO : STREAM_AUDIO;
        track->sh = demux_alloc_sh_stream(stype);
        track->sh->demuxer_id = id;
    } else if (!track || track->type != type) {
        return false;
    }

    struct mp_codec_params *codec = publish ? track->sh->codec
                                             : talloc_zero(demuxer, struct mp_codec_params);
    codec->type = type == RDP_TRACK_VIDEO ? STREAM_VIDEO : STREAM_AUDIO;
    codec->codec = talloc_strdup(codec, codec_name);
    codec->native_tb_num = tb_num;
    codec->native_tb_den = tb_den;
    if (type == RDP_TRACK_VIDEO) {
        codec->disp_w = width;
        codec->disp_h = height;
    } else {
        codec->samplerate = sample_rate;
        mp_chmap_from_channels(&codec->channels, channels);
    }
    if (extradata_size) {
        codec->extradata = talloc_size(codec, extradata_size);
        if (!read_exact(s, codec->extradata, extradata_size))
            return false;
        codec->extradata_size = extradata_size;
    }
    if (publish)
        demux_add_sh_stream(demuxer, track->sh);
    p->generations[p->num_generations++] = (struct rdp_generation) {
        .track = id,
        .generation = generation,
        .tb_num = tb_num,
        .tb_den = tb_den,
        .codec = codec,
    };
    return true;
}

static bool scan_packet(struct demuxer *demuxer, struct priv *p, int *group,
                        bool *seen_video_keyframe)
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
    struct rdp_generation *generation =
        find_generation(p, packet.track, packet.generation);
    if (!track || !generation || packet.tb_num != generation->tb_num ||
        packet.tb_den != generation->tb_den ||
        packet.payload_size > RDP_MAX_PACKET || packet.payload_size > RDP_QUEUE_BYTES ||
        packet.duration < 0 || (packet.flags & ~RDP_FLAG_KEYFRAME))
        return false;
    if (track->type == RDP_TRACK_VIDEO && (packet.flags & RDP_FLAG_KEYFRAME)) {
        if (*seen_video_keyframe)
            *group += 1;
        *seen_video_keyframe = true;
    }
    packet.group = *group;
    packet.payload_offset = stream_tell(s);
    if (!stream_seek(s, packet.payload_offset + packet.payload_size))
        return false;
    MP_TARRAY_APPEND(p, p->packets, p->num_packets, packet);

    double end = to_seconds(packet.pts, packet.tb_num, packet.tb_den);
    if (end != MP_NOPTS_VALUE) {
        double duration = to_seconds(packet.duration, packet.tb_num, packet.tb_den);
        demuxer->duration = MPMAX(demuxer->duration, end + duration);
    }
    return true;
}

static void free_ready(struct rdp_ready_packet *ready)
{
    if (ready) {
        free(ready->payload);
        free(ready);
    }
}

static void clear_queue_locked(struct priv *p)
{
    while (p->queue_count) {
        struct rdp_ready_packet *ready = p->queue[p->queue_head];
        p->queue[p->queue_head] = NULL;
        p->queue_head = (p->queue_head + 1) % RDP_QUEUE_PACKETS;
        p->queue_count--;
        p->queue_bytes -= p->packets[ready->index].payload_size;
        free_ready(ready);
    }
    p->queue_head = 0;
}

static bool wait_for_group_delay_locked(struct priv *p, int group, uint64_t epoch)
{
    if (!p->delay_ms || group == p->producer_group)
        return true;
    int64_t until = mp_time_ns_add(mp_time_ns(), p->delay_ms / 1000.0);
    MP_INFO(p->demuxer, "producer waiting group=%d delay_ms=%d epoch=%" PRIu64 "\n",
            group, p->delay_ms, epoch);
    while (!p->stopping && !p->interrupted && p->epoch == epoch &&
           mp_time_ns() < until)
        mp_cond_timedwait_until(&p->wakeup, &p->lock, until);
    if (p->stopping || p->interrupted || p->epoch != epoch)
        return false;
    p->producer_group = group;
    MP_INFO(p->demuxer, "producer released group=%d epoch=%" PRIu64 "\n",
            group, epoch);
    return true;
}

static MP_THREAD_VOID producer_thread(void *ctx)
{
    struct priv *p = ctx;
    mp_thread_set_name("rdp-producer");
    mp_mutex_lock(&p->lock);
    while (!p->stopping) {
        while (p->interrupted && !p->stopping)
            mp_cond_wait(&p->wakeup, &p->lock);
        if (p->stopping)
            break;
        if (p->producer_cursor >= p->num_packets) {
            p->producer_done = true;
            mp_cond_broadcast(&p->wakeup);
            uint64_t epoch = p->epoch;
            while (!p->stopping && p->epoch == epoch)
                mp_cond_wait(&p->wakeup, &p->lock);
            continue;
        }

        int index = p->producer_cursor;
        struct rdp_packet_index *packet = &p->packets[index];
        uint64_t epoch = p->epoch;
        if (!wait_for_group_delay_locked(p, packet->group, epoch))
            continue;
        while (!p->stopping && !p->interrupted && p->epoch == epoch &&
               (p->queue_count == RDP_QUEUE_PACKETS ||
                p->queue_bytes + packet->payload_size > RDP_QUEUE_BYTES))
            mp_cond_wait(&p->wakeup, &p->lock);
        if (p->stopping || p->interrupted || p->epoch != epoch)
            continue;

        mp_mutex_unlock(&p->lock);
        struct rdp_ready_packet *ready = calloc(1, sizeof(*ready));
        if (ready)
            ready->payload = malloc(packet->payload_size);
        bool read_ok = ready && ready->payload &&
            fseeko(p->source, packet->payload_offset, SEEK_SET) == 0 &&
            fread(ready->payload, 1, packet->payload_size, p->source) == packet->payload_size;
        mp_mutex_lock(&p->lock);
        if (!read_ok) {
            free_ready(ready);
            p->producer_failed = true;
            MP_ERR(p->demuxer, "producer failed reading packet %d: %s\n",
                   index, strerror(errno));
            mp_cond_broadcast(&p->wakeup);
            break;
        }
        if (p->stopping || p->interrupted || p->epoch != epoch) {
            free_ready(ready);
            continue;
        }
        ready->index = index;
        int tail = (p->queue_head + p->queue_count) % RDP_QUEUE_PACKETS;
        p->queue[tail] = ready;
        p->queue_count++;
        p->queue_bytes += packet->payload_size;
        p->max_queue_count = MPMAX(p->max_queue_count, p->queue_count);
        p->max_queue_bytes = MPMAX(p->max_queue_bytes, p->queue_bytes);
        p->producer_cursor++;
        mp_cond_broadcast(&p->wakeup);
    }
    mp_mutex_unlock(&p->lock);
    MP_THREAD_RETURN();
}

static void cancel_wait(void *ctx)
{
    struct priv *p = ctx;
    mp_mutex_lock(&p->lock);
    p->stopping = true;
    mp_cond_broadcast(&p->wakeup);
    mp_mutex_unlock(&p->lock);
}

static int read_delay_ms(void)
{
    const char *value = getenv("RUSTDASH_DELAY_MS");
    if (!value || !value[0])
        return 0;
    char *end = NULL;
    long delay = strtol(value, &end, 10);
    return end && !*end && delay >= 0 && delay <= 60000 ? delay : 0;
}

static int rustdash_open(struct demuxer *demuxer, enum demux_check check)
{
    if (check != DEMUX_CHECK_REQUEST && check != DEMUX_CHECK_FORCE)
        return -1;
    struct stream *s = demuxer->stream;
    if (!s || !s->seekable)
        return -1;

    char magic[8];
    uint32_t version, num_tracks, num_generations;
    if (!read_exact(s, magic, sizeof(magic)) || !get_u32(s, &version) ||
        !get_u32(s, &num_tracks))
        return -1;
    bool generation_fixture = !memcmp(magic, RDP_GENERATION_MAGIC, 8) &&
                              version == RDP_GENERATION_VERSION;
    if (generation_fixture) {
        if (!get_u32(s, &num_generations) || num_tracks != 1 || num_generations != 2)
            return -1;
    } else {
        if (memcmp(magic, RDP_MAGIC, 8) || version != RDP_VERSION || num_tracks != 2)
            return -1;
        num_generations = num_tracks;
    }

    struct priv *p = talloc_zero(demuxer, struct priv);
    demuxer->priv = p;
    p->demuxer = demuxer;
    p->generation_fixture = generation_fixture;
    for (uint32_t n = 0; n < num_generations; n++) {
        if (!read_config(demuxer, p, !generation_fixture || n == 0))
            return -1;
    }
    if (p->num_tracks != (int)num_tracks)
        return -1;

    int group = 0;
    bool seen_video_keyframe = false;
    while (true) {
        uint32_t record;
        if (!get_u32(s, &record))
            return -1;
        if (record == RDP_RECORD_EOF)
            break;
        if (record != RDP_RECORD_PACKET ||
            !scan_packet(demuxer, p, &group, &seen_video_keyframe))
            return -1;
    }
    if (!p->num_packets)
        return -1;

    p->source = fopen(demuxer->filename, "rb");
    if (!p->source) {
        MP_ERR(demuxer, "could not open producer fixture %s: %s\n",
               demuxer->filename, strerror(errno));
        return -1;
    }
    mp_mutex_init(&p->lock);
    mp_cond_init(&p->wakeup);
    p->delay_ms = read_delay_ms();
    p->producer_group = p->packets[0].group;
    mp_cancel_set_cb(demuxer->cancel, cancel_wait, p);
    if (mp_thread_create(&p->producer_thread, producer_thread, p)) {
        mp_cancel_set_cb(demuxer->cancel, NULL, NULL);
        return -1;
    }
    p->producer_started = true;

    demuxer->seekable = true;
    demuxer->filetype = generation_fixture ? "rustdash-generation-v2"
                                            : "rustdash-live-v1";
    MP_INFO(demuxer, "bounded producer started packets=%d groups=%d "
            "queue_packets=%d queue_bytes=%u delay_ms=%d\n",
            p->num_packets, group + 1, RDP_QUEUE_PACKETS, RDP_QUEUE_BYTES,
            p->delay_ms);
    return 0;
}

static bool rustdash_read_packet(struct demuxer *demuxer, struct demux_packet **out)
{
    struct priv *p = demuxer->priv;
    mp_mutex_lock(&p->lock);
    while (!p->queue_count && !p->producer_done && !p->producer_failed &&
           !p->stopping && !p->interrupted) {
        p->waits++;
        MP_VERBOSE(demuxer, "consumer blocked wait=%d epoch=%" PRIu64 "\n",
                   p->waits, p->epoch);
        mp_cond_wait(&p->wakeup, &p->lock);
    }
    if (p->interrupted) {
        mp_mutex_unlock(&p->lock);
        return true;
    }
    if (!p->queue_count) {
        bool final_eof = p->producer_done && !p->producer_failed && !p->stopping;
        mp_mutex_unlock(&p->lock);
        if (final_eof)
            MP_INFO(demuxer, "experimental producer final EOF\n");
        return false;
    }
    struct rdp_ready_packet *ready = p->queue[p->queue_head];
    p->queue[p->queue_head] = NULL;
    p->queue_head = (p->queue_head + 1) % RDP_QUEUE_PACKETS;
    p->queue_count--;
    struct rdp_packet_index *src = &p->packets[ready->index];
    p->queue_bytes -= src->payload_size;
    mp_cond_broadcast(&p->wakeup);
    mp_mutex_unlock(&p->lock);

    struct rdp_track *track = find_track(p, src->track);
    struct rdp_generation *generation =
        find_generation(p, src->track, src->generation);
    if (!demux_stream_is_selected(track->sh)) {
        free_ready(ready);
        return true;
    }
    struct demux_packet *packet = new_demux_packet(demuxer->packet_pool,
                                                    src->payload_size);
    if (!packet) {
        MP_ERR(demuxer, "could not allocate packet %d (%u bytes)\n",
               ready->index, src->payload_size);
        free_ready(ready);
        return false;
    }
    memcpy(packet->buffer, ready->payload, src->payload_size);
    packet->stream = track->sh->index;
    packet->pts = to_seconds(src->pts, src->tb_num, src->tb_den);
    packet->dts = to_seconds(src->dts, src->tb_num, src->tb_den);
    packet->duration = to_seconds(src->duration, src->tb_num, src->tb_den);
    packet->keyframe = src->flags & RDP_FLAG_KEYFRAME;
    packet->pos = src->payload_offset;
    if (p->generation_fixture) {
        packet->segmented = true;
        packet->codec = generation->codec;
    }
    *out = packet;
    free_ready(ready);
    return true;
}

static void rustdash_interrupt(struct demuxer *demuxer)
{
    struct priv *p = demuxer->priv;
    mp_mutex_lock(&p->lock);
    p->interrupted = true;
    p->epoch++;
    clear_queue_locked(p);
    MP_INFO(demuxer, "producer wait interrupted for queued seek epoch=%" PRIu64 "\n",
            p->epoch);
    mp_cond_broadcast(&p->wakeup);
    mp_mutex_unlock(&p->lock);
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
        if (pts != MP_NOPTS_VALUE && pts <= target && (!found || pts >= chosen_pts)) {
            chosen = n;
            chosen_pts = pts;
            found = true;
        }
    }
    mp_mutex_lock(&p->lock);
    clear_queue_locked(p);
    p->producer_cursor = chosen;
    p->producer_group = p->packets[chosen].group;
    p->producer_done = false;
    p->producer_failed = false;
    p->interrupted = false;
    p->epoch++;
    uint64_t epoch = p->epoch;
    mp_cond_broadcast(&p->wakeup);
    mp_mutex_unlock(&p->lock);
    MP_INFO(demuxer, "experimental seek target=%.3f keyframe=%.3f packet=%d epoch=%" PRIu64 "\n",
            target, chosen_pts, chosen, epoch);
}

static void rustdash_close(struct demuxer *demuxer)
{
    struct priv *p = demuxer->priv;
    mp_cancel_set_cb(demuxer->cancel, NULL, NULL);
    mp_mutex_lock(&p->lock);
    p->stopping = true;
    mp_cond_broadcast(&p->wakeup);
    mp_mutex_unlock(&p->lock);
    if (p->producer_started)
        mp_thread_join(p->producer_thread);
    mp_mutex_lock(&p->lock);
    clear_queue_locked(p);
    mp_mutex_unlock(&p->lock);
    MP_INFO(demuxer, "bounded producer shutdown waits=%d max_packets=%d "
            "max_bytes=%zu\n", p->waits, p->max_queue_count,
            p->max_queue_bytes);
    if (p->source)
        fclose(p->source);
    mp_cond_destroy(&p->wakeup);
    mp_mutex_destroy(&p->lock);
}

const struct demuxer_desc demuxer_desc_rustdash = {
    .name = "rustdash",
    .desc = "experimental externally supplied packet stream",
    .open = rustdash_open,
    .read_packet = rustdash_read_packet,
    .interrupt = rustdash_interrupt,
    .close = rustdash_close,
    .seek = rustdash_seek,
};
