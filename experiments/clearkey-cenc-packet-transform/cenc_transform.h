#ifndef YNOTV_CENC_TRANSFORM_H
#define YNOTV_CENC_TRANSFORM_H

#include <stddef.h>
#include <stdint.h>

#include <libavutil/encryption_info.h>

enum cenc_packet_state {
    CENC_CLEAR_PACKET = 0,
    CENC_ENCRYPTED_PACKET,
    CENC_KEY_UNAVAILABLE,
    CENC_UNSUPPORTED_SCHEME,
    CENC_MALFORMED_ENCRYPTION_INFO,
    CENC_DECRYPT_FAILURE,
    CENC_CANCELLED,
};

struct cenc_key_entry {
    uint8_t kid[16];
    uint8_t key[16];
};

struct cenc_key_store {
    const struct cenc_key_entry *entries;
    size_t count;
};

struct cenc_packet {
    const uint8_t *data;
    size_t size;
    int64_t pts;
    int64_t dts;
    int64_t duration;
    int keyframe;
    uint32_t codec_generation;
};

struct cenc_clear_packet {
    uint8_t *data;
    size_t size;
    int64_t pts;
    int64_t dts;
    int64_t duration;
    int keyframe;
    uint32_t codec_generation;
};

const uint8_t *cenc_lookup_key(const struct cenc_key_store *store,
                               const uint8_t kid[16]);

enum cenc_packet_state cenc_decrypt_packet(
    const struct cenc_key_store *store,
    const struct cenc_packet *packet,
    const AVEncryptionInfo *info,
    int cancelled,
    struct cenc_clear_packet *clear);

void cenc_clear_packet_free(struct cenc_clear_packet *packet);
const char *cenc_packet_state_name(enum cenc_packet_state state);

#endif
