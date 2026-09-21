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
#define RDP_LIVE_MAGIC "RDPKT003"
#define RDP_LIVE_VERSION 3u
#define RDP_SUBTITLE_MAGIC "RDPKT004"
#define RDP_SUBTITLE_VERSION 4u
#define RDP_SWITCH_MAGIC "RDPKT005"
#define RDP_SWITCH_VERSION 5u
#define RDP_DVR_MAGIC "RDPKT006"
#define RDP_DVR_VERSION 6u
#define RDP_CODEC_NAME_BYTES 32u
#define RDP_RECORD_PACKET 0x31544b50u
#define RDP_RECORD_EOF    0x31464f45u
#define RDP_RECORD_CONFIG 0x31474643u
#define RDP_RECORD_SEEK   0x314b4553u
#define RDP_TRACK_VIDEO 1u
#define RDP_TRACK_AUDIO 2u
#define RDP_TRACK_SUBTITLE 3u
#define RDP_FLAG_KEYFRAME 1u
#define RDP_TRACK_FLAG_DEFAULT 1u
#define RDP_TRACK_FLAG_FORCED 2u
#define RDP_NOPTS INT64_MIN
#define RDP_MAX_EXTRADATA (1024u * 1024u)
#define RDP_MAX_PACKET (64u * 1024u * 1024u)
#define RDP_MAX_TRACKS 8
#define RDP_MAX_GENERATIONS 64
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
    struct rdp_packet_index live_packet;
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
    bool live_source;
    bool switch_source;
    bool seek_source;

    FILE *source;
    mp_thread producer_thread;
    bool producer_started;
    mp_mutex lock;
    mp_cond wakeup;
    bool sync_initialized;
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
    const char *producer_error;
    bool producer_failure_reported;
    bool seek_ready;
    uint64_t seek_epoch;
    int64_t seek_target_ms;
    int delay_ms;
    int waits;
    int skipped_unselected;
    int empty_successes;
    int queued_at_cancel;
};

static bool read_exact(struct stream *s, void *dst, size_t size)
{
    uint8_t *out = dst;
    while (size) {
        int request = size > INT_MAX ? INT_MAX : (int)size;
        int read = stream_read(s, out, request);
        if (read <= 0)
            return false;
        out += read;
        size -= read;
    }
    return true;
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

static bool read_config(struct demuxer *demuxer, struct priv *p, bool publish,
                        bool has_metadata)
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
        (type != RDP_TRACK_VIDEO && type != RDP_TRACK_AUDIO &&
         type != RDP_TRACK_SUBTITLE) ||
        p->num_generations >= RDP_MAX_GENERATIONS)
        return false;

    struct rdp_track *track = find_track(p, id);
    if (publish) {
        if (track || p->num_tracks >= RDP_MAX_TRACKS)
            return false;
        track = &p->tracks[p->num_tracks++];
        track->id = id;
        track->type = type;
        enum stream_type stype = type == RDP_TRACK_VIDEO ? STREAM_VIDEO :
                                 type == RDP_TRACK_AUDIO ? STREAM_AUDIO : STREAM_SUB;
        track->sh = demux_alloc_sh_stream(stype);
        track->sh->demuxer_id = id;
    } else if (!track || track->type != type) {
        return false;
    }
    if (find_generation(p, id, generation))
        return false;

    struct mp_codec_params *codec = publish ? track->sh->codec
                                             : talloc_zero(demuxer, struct mp_codec_params);
    codec->type = type == RDP_TRACK_VIDEO ? STREAM_VIDEO :
                  type == RDP_TRACK_AUDIO ? STREAM_AUDIO : STREAM_SUB;
    codec->codec = talloc_strdup(codec, codec_name);
    codec->native_tb_num = tb_num;
    codec->native_tb_den = tb_den;
    if (type == RDP_TRACK_VIDEO) {
        codec->disp_w = width;
        codec->disp_h = height;
    } else if (type == RDP_TRACK_AUDIO) {
        codec->samplerate = sample_rate;
        mp_chmap_from_channels(&codec->channels, channels);
    }
    if (extradata_size) {
        codec->extradata = talloc_size(codec, extradata_size);
        if (!read_exact(s, codec->extradata, extradata_size))
            return false;
        codec->extradata_size = extradata_size;
    }
    if (has_metadata) {
        uint32_t track_flags, lang_size, title_size;
        char lang[64] = {0};
        char title[256] = {0};
        if (!get_u32(s, &track_flags) || !get_u32(s, &lang_size) ||
            lang_size >= sizeof(lang) || !read_exact(s, lang, lang_size) ||
            !get_u32(s, &title_size) || title_size >= sizeof(title) ||
            !read_exact(s, title, title_size) ||
            (track_flags & ~(RDP_TRACK_FLAG_DEFAULT | RDP_TRACK_FLAG_FORCED)))
            return false;
        if (publish) {
            if (lang_size)
                track->sh->lang = talloc_strdup(track->sh, lang);
            if (title_size)
                track->sh->title = talloc_strdup(track->sh, title);
            track->sh->default_track = track_flags & RDP_TRACK_FLAG_DEFAULT;
            track->sh->forced_track = track_flags & RDP_TRACK_FLAG_FORCED;
        }
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
        p->queue_bytes -= p->live_source ? ready->live_packet.payload_size
                                        : p->packets[ready->index].payload_size;
        free_ready(ready);
    }
    p->queue_head = 0;
}

static bool read_live_packet_header(struct priv *p, struct rdp_packet_index *packet)
{
    struct stream *s = p->demuxer->stream;
    if (!get_u32(s, &packet->track) || !get_u32(s, &packet->generation) ||
        !get_i64(s, &packet->pts) || !get_i64(s, &packet->dts) ||
        !get_i64(s, &packet->duration) || !get_i32(s, &packet->tb_num) ||
        !get_i32(s, &packet->tb_den) || !get_u32(s, &packet->flags) ||
        !get_u32(s, &packet->payload_size))
        return false;
    struct rdp_track *track = find_track(p, packet->track);
    struct rdp_generation *generation =
        find_generation(p, packet->track, packet->generation);
    bool valid = track && generation && packet->tb_num == generation->tb_num &&
                 packet->tb_den == generation->tb_den &&
                 packet->payload_size <= RDP_MAX_PACKET && packet->duration >= 0 &&
                 !(packet->flags & ~RDP_FLAG_KEYFRAME);
    if (!valid) {
        MP_ERR(p->demuxer, "invalid live packet track=%u generation=%u "
               "tb=%d/%d expected=%d/%d size=%u duration=%" PRId64
               " flags=0x%x track_found=%d generation_found=%d\n",
               packet->track, packet->generation, packet->tb_num, packet->tb_den,
               generation ? generation->tb_num : 0,
               generation ? generation->tb_den : 0,
               packet->payload_size, packet->duration, packet->flags,
               !!track, !!generation);
    }
    return valid;
}

static MP_THREAD_VOID live_producer_thread(void *ctx)
{
    struct priv *p = ctx;
    mp_thread_set_name("rdp-live-producer");
    while (true) {
        mp_mutex_lock(&p->lock);
        while (!p->stopping &&
               (p->queue_count == RDP_QUEUE_PACKETS ||
                p->queue_bytes >= RDP_QUEUE_BYTES)) {
            // Reaching the bounded queue is normal producer/consumer
            // backpressure, not a playback warning. Keep it available for
            // verbose adapter diagnostics without flooding normal app logs.
            MP_VERBOSE(p->demuxer,
                       "producer blocked queue_count=%d queue_bytes=%zu\n",
                       p->queue_count, p->queue_bytes);
            mp_cond_wait(&p->wakeup, &p->lock);
        }
        bool stopping = p->stopping;
        mp_mutex_unlock(&p->lock);
        if (stopping)
            break;

        uint32_t record = 0;
        if (!get_u32(p->demuxer->stream, &record)) {
            mp_mutex_lock(&p->lock);
            if (!p->stopping) {
                p->producer_failed = true;
                p->producer_error = "record header ended before EOF marker";
            }
            mp_cond_broadcast(&p->wakeup);
            mp_mutex_unlock(&p->lock);
            break;
        }
        if (record == RDP_RECORD_EOF) {
            mp_mutex_lock(&p->lock);
            p->producer_done = true;
            mp_cond_broadcast(&p->wakeup);
            mp_mutex_unlock(&p->lock);
            break;
        }
        if (record == RDP_RECORD_CONFIG && p->switch_source) {
            if (!read_config(p->demuxer, p, false, false)) {
                mp_mutex_lock(&p->lock);
                p->producer_failed = true;
                p->producer_error = "invalid runtime codec generation";
                mp_cond_broadcast(&p->wakeup);
                mp_mutex_unlock(&p->lock);
                break;
            }
            MP_INFO(p->demuxer, "runtime codec generation registered\n");
            continue;
        }
        if (record == RDP_RECORD_SEEK && p->seek_source) {
            int64_t target_ms;
            uint32_t epoch_low, epoch_high;
            if (!get_u32(p->demuxer->stream, &epoch_low) ||
                !get_u32(p->demuxer->stream, &epoch_high) ||
                !get_i64(p->demuxer->stream, &target_ms)) {
                mp_mutex_lock(&p->lock);
                p->producer_failed = true;
                p->producer_error = "invalid seek epoch record";
                mp_cond_broadcast(&p->wakeup);
                mp_mutex_unlock(&p->lock);
                break;
            }
            mp_mutex_lock(&p->lock);
            clear_queue_locked(p);
            p->seek_epoch = (uint64_t)epoch_low | (uint64_t)epoch_high << 32;
            p->seek_target_ms = target_ms;
            p->seek_ready = true;
            MP_INFO(p->demuxer, "DASH seek epoch ready epoch=%" PRIu64
                    " target=%.3f\n", p->seek_epoch, target_ms / 1000.0);
            mp_cond_broadcast(&p->wakeup);
            mp_mutex_unlock(&p->lock);
            continue;
        }
        struct rdp_ready_packet *ready = calloc(1, sizeof(*ready));
        if (record != RDP_RECORD_PACKET || !ready ||
            !read_live_packet_header(p, &ready->live_packet)) {
            free_ready(ready);
            mp_mutex_lock(&p->lock);
            p->producer_failed = true;
            p->producer_error = "invalid live packet header";
            mp_cond_broadcast(&p->wakeup);
            mp_mutex_unlock(&p->lock);
            break;
        }

        struct rdp_packet_index *packet = &ready->live_packet;
        mp_mutex_lock(&p->lock);
        while (!p->stopping &&
               (p->queue_count == RDP_QUEUE_PACKETS ||
                (p->queue_count > 0 &&
                 p->queue_bytes + packet->payload_size > RDP_QUEUE_BYTES)))
            mp_cond_wait(&p->wakeup, &p->lock);
        stopping = p->stopping;
        mp_mutex_unlock(&p->lock);
        if (stopping) {
            free_ready(ready);
            break;
        }
        ready->payload = malloc(packet->payload_size);
        if (!ready->payload ||
            !read_exact(p->demuxer->stream, ready->payload, packet->payload_size)) {
            free_ready(ready);
            mp_mutex_lock(&p->lock);
            if (!p->stopping)
                p->producer_failed = true;
            p->producer_error = "live packet payload ended early";
            mp_cond_broadcast(&p->wakeup);
            mp_mutex_unlock(&p->lock);
            break;
        }

        mp_mutex_lock(&p->lock);
        if (p->stopping) {
            mp_mutex_unlock(&p->lock);
            free_ready(ready);
            break;
        }
        int tail = (p->queue_head + p->queue_count) % RDP_QUEUE_PACKETS;
        p->queue[tail] = ready;
        p->queue_count++;
        p->queue_bytes += packet->payload_size;
        p->max_queue_count = MPMAX(p->max_queue_count, p->queue_count);
        p->max_queue_bytes = MPMAX(p->max_queue_bytes, p->queue_bytes);
        mp_cond_broadcast(&p->wakeup);
        mp_mutex_unlock(&p->lock);
    }
    MP_THREAD_RETURN();
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
        bool queue_full = p->queue_count == RDP_QUEUE_PACKETS ||
                          p->queue_bytes + packet->payload_size > RDP_QUEUE_BYTES;
        if (queue_full) {
            MP_VERBOSE(p->demuxer,
                       "producer blocked queue_count=%d queue_bytes=%zu\n",
                       p->queue_count, p->queue_bytes);
        }
        while (!p->stopping && !p->interrupted && p->epoch == epoch && queue_full) {
            mp_cond_wait(&p->wakeup, &p->lock);
            queue_full = p->queue_count == RDP_QUEUE_PACKETS ||
                         p->queue_bytes + packet->payload_size > RDP_QUEUE_BYTES;
        }
        if (p->stopping || p->interrupted || p->epoch != epoch)
            continue;

        mp_mutex_unlock(&p->lock);
        errno = 0;
        struct rdp_ready_packet *ready = calloc(1, sizeof(*ready));
        if (ready)
            ready->payload = malloc(packet->payload_size);
        bool seek_ok = ready && ready->payload &&
                       fseeko(p->source, packet->payload_offset, SEEK_SET) == 0;
        bool read_ok = seek_ok &&
            fread(ready->payload, 1, packet->payload_size, p->source) == packet->payload_size;
        mp_mutex_lock(&p->lock);
        if (!read_ok) {
            const char *reason = errno ? strerror(errno) :
                                 "unexpected end of producer source";
            free_ready(ready);
            p->producer_failed = true;
            MP_ERR(p->demuxer, "producer failed reading packet %d: %s\n",
                   index, reason);
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
    p->queued_at_cancel = p->queue_count;
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
    if (!s)
        return -1;

    char magic[8];
    uint32_t version, num_tracks, num_generations;
    if (!read_exact(s, magic, sizeof(magic)) || !get_u32(s, &version) ||
        !get_u32(s, &num_tracks))
        return -1;
    bool generation_fixture = !memcmp(magic, RDP_GENERATION_MAGIC, 8) &&
                              version == RDP_GENERATION_VERSION;
    bool live_v3 = !memcmp(magic, RDP_LIVE_MAGIC, 8) &&
                       version == RDP_LIVE_VERSION;
    bool live_v4 = !memcmp(magic, RDP_SUBTITLE_MAGIC, 8) &&
                   version == RDP_SUBTITLE_VERSION;
    bool live_v5 = !memcmp(magic, RDP_SWITCH_MAGIC, 8) &&
                   version == RDP_SWITCH_VERSION;
    bool live_v6 = !memcmp(magic, RDP_DVR_MAGIC, 8) &&
                   version == RDP_DVR_VERSION;
    bool live_source = live_v3 || live_v4 || live_v5 || live_v6;
    if (generation_fixture) {
        if (!get_u32(s, &num_generations) || num_tracks != 1 || num_generations != 2)
            return -1;
    } else if (live_source) {
        if (num_tracks < 1 || num_tracks > RDP_MAX_TRACKS)
            return -1;
        num_generations = num_tracks;
    } else {
        if (memcmp(magic, RDP_MAGIC, 8) || version != RDP_VERSION ||
            num_tracks < 1 || num_tracks > RDP_MAX_TRACKS)
            return -1;
        num_generations = num_tracks;
    }

    struct priv *p = talloc_zero(demuxer, struct priv);
    demuxer->priv = p;
    p->demuxer = demuxer;
    p->generation_fixture = generation_fixture;
    p->live_source = live_source;
    p->switch_source = live_v5 || live_v6;
    p->seek_source = live_v6;
    for (uint32_t n = 0; n < num_generations; n++) {
        if (!read_config(demuxer, p, !generation_fixture || n == 0,
                         live_v4 || live_v5 || live_v6))
            return -1;
    }
    if (p->num_tracks != (int)num_tracks)
        return -1;

    int group = 0;
    if (!live_source) {
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
    }
    mp_mutex_init(&p->lock);
    mp_cond_init(&p->wakeup);
    p->sync_initialized = true;
    p->delay_ms = read_delay_ms();
    p->producer_group = live_source ? 0 : p->packets[0].group;
    mp_cancel_set_cb(demuxer->cancel, cancel_wait, p);
    if (mp_thread_create(&p->producer_thread,
                         live_source ? live_producer_thread : producer_thread, p)) {
        mp_cancel_set_cb(demuxer->cancel, NULL, NULL);
        if (p->source)
            fclose(p->source);
        p->source = NULL;
        mp_cond_destroy(&p->wakeup);
        mp_mutex_destroy(&p->lock);
        p->sync_initialized = false;
        return -1;
    }
    p->producer_started = true;

    demuxer->seekable = !live_source || live_v6;
    demuxer->filetype = live_v6 ? "rustdash-live-v6" : live_v5 ? "rustdash-live-v5" : live_v4 ? "rustdash-live-v4" : live_source ? "rustdash-live-v3" :
        (generation_fixture ? "rustdash-generation-v2" : "rustdash-live-v1");
    MP_INFO(demuxer, "bounded producer started packets=%d groups=%d "
            "queue_packets=%d queue_bytes=%u delay_ms=%d\n",
            live_source ? -1 : p->num_packets, live_source ? -1 : group + 1,
            RDP_QUEUE_PACKETS, RDP_QUEUE_BYTES,
            p->delay_ms);
    return 0;
}

static bool rustdash_read_packet(struct demuxer *demuxer, struct demux_packet **out)
{
    struct priv *p = demuxer->priv;
    mp_mutex_lock(&p->lock);
    while (true) {
        while (!p->queue_count && !p->producer_done && !p->producer_failed &&
               !p->stopping && !p->interrupted && !p->seek_ready) {
            p->waits++;
            MP_VERBOSE(demuxer, "consumer blocked wait=%d epoch=%" PRIu64 "\n",
                       p->waits, p->epoch);
            mp_cond_wait(&p->wakeup, &p->lock);
        }
        if (p->stopping || p->interrupted) {
            p->empty_successes++;
            mp_mutex_unlock(&p->lock);
            return true;
        }
        if (p->seek_ready) {
            mp_cond_wait(&p->wakeup, &p->lock);
            continue;
        }
        if (p->producer_failed) {
            bool report = !p->producer_failure_reported;
            p->producer_failure_reported = true;
            mp_mutex_unlock(&p->lock);
            if (report) {
                MP_ERR(demuxer, "fatal producer error; mpv's boolean demux API "
                       "will represent this terminal failure as EOF; reason=%s\n",
                       p->producer_error ? p->producer_error : "unknown");
            }
            return false;
        }
        if (!p->queue_count) {
            mp_mutex_unlock(&p->lock);
            MP_INFO(demuxer, "experimental producer final EOF\n");
            return false;
        }
        struct rdp_ready_packet *ready = p->queue[p->queue_head];
        p->queue[p->queue_head] = NULL;
        p->queue_head = (p->queue_head + 1) % RDP_QUEUE_PACKETS;
        p->queue_count--;
        struct rdp_packet_index *src = p->live_source ? &ready->live_packet
                                                      : &p->packets[ready->index];
        p->queue_bytes -= src->payload_size;
        mp_cond_broadcast(&p->wakeup);
        mp_mutex_unlock(&p->lock);

        struct rdp_track *track = find_track(p, src->track);
        struct rdp_generation *generation =
            find_generation(p, src->track, src->generation);
        if (!demux_stream_is_selected(track->sh)) {
            free_ready(ready);
            mp_mutex_lock(&p->lock);
            p->skipped_unselected++;
            continue;
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
        if (p->generation_fixture || p->switch_source) {
            packet->segmented = true;
            packet->codec = generation->codec;
        }
        free_ready(ready);
        mp_mutex_lock(&p->lock);
        if (p->stopping || p->interrupted) {
            p->empty_successes++;
            mp_mutex_unlock(&p->lock);
            talloc_free(packet);
            return true;
        }
        *out = packet;
        mp_mutex_unlock(&p->lock);
        return true;
    }
}

static void rustdash_interrupt(struct demuxer *demuxer)
{
    struct priv *p = demuxer->priv;
    mp_mutex_lock(&p->lock);
    p->interrupted = true;
    p->epoch++;
    if (!p->seek_ready)
        clear_queue_locked(p);
    MP_INFO(demuxer, "producer wait interrupted for queued seek epoch=%" PRIu64 "\n",
            p->epoch);
    mp_cond_broadcast(&p->wakeup);
    mp_mutex_unlock(&p->lock);
}

static void rustdash_seek(struct demuxer *demuxer, double seek_pts, int flags)
{
    struct priv *p = demuxer->priv;
    if (p->live_source && !p->seek_source)
        return;
    double target = flags & SEEK_FACTOR ? seek_pts * demuxer->duration : seek_pts;
    if (p->seek_source) {
        mp_mutex_lock(&p->lock);
        while (!p->seek_ready && !p->producer_failed && !p->stopping)
            mp_cond_wait(&p->wakeup, &p->lock);
        if (p->seek_ready) {
            p->interrupted = false;
            p->seek_ready = false;
            p->epoch = p->seek_epoch;
            MP_INFO(demuxer, "DASH seek committed requested=%.3f actual=%.3f "
                    "delta=%.3f epoch=%" PRIu64 "\n", target,
                    p->seek_target_ms / 1000.0,
                    target - p->seek_target_ms / 1000.0, p->epoch);
            mp_cond_broadcast(&p->wakeup);
        }
        mp_mutex_unlock(&p->lock);
        return;
    }
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
    if (!p)
        return;
    if (!p->sync_initialized) {
        if (p->source)
            fclose(p->source);
        return;
    }
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
            "max_bytes=%zu skipped_unselected=%d empty_successes=%d "
            "queued_at_cancel=%d\n",
            p->waits, p->max_queue_count, p->max_queue_bytes,
            p->skipped_unselected, p->empty_successes, p->queued_at_cancel);
    if (p->source)
        fclose(p->source);
    mp_cond_destroy(&p->wakeup);
    mp_mutex_destroy(&p->lock);
    p->sync_initialized = false;
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
