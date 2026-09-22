#include "cenc_transform.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/evp.h>

#define CENC_SCHEME (((uint32_t)'c' << 24) | ((uint32_t)'e' << 16) | \
                     ((uint32_t)'n' << 8) | (uint32_t)'c')
#define CBCS_SCHEME (((uint32_t)'c' << 24) | ((uint32_t)'b' << 16) | \
                     ((uint32_t)'c' << 8) | (uint32_t)'s')

const uint8_t *cenc_lookup_key(const struct cenc_key_store *store,
                               const uint8_t kid[16])
{
    if (!store || !kid)
        return NULL;
    for (size_t n = 0; n < store->count; n++) {
        if (memcmp(store->entries[n].kid, kid, 16) == 0)
            return store->entries[n].key;
    }
    return NULL;
}

static int add_size(size_t *total, uint32_t value)
{
    if (*total > SIZE_MAX - value)
        return 0;
    *total += value;
    return 1;
}

static int decrypt_cbcs_region(uint8_t *output, const uint8_t *input, size_t size,
                               const uint8_t key[16], const uint8_t iv[16],
                               uint32_t crypt_blocks, uint32_t skip_blocks)
{
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    size_t block = 0;
    size_t blocks = size / 16;
    int no_pattern = crypt_blocks == 0 && skip_blocks == 0;

    if (!ctx || EVP_DecryptInit_ex(ctx, EVP_aes_128_cbc(), NULL, key, iv) != 1 ||
        EVP_CIPHER_CTX_set_padding(ctx, 0) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return 0;
    }
    while (block < blocks) {
        size_t available = blocks - block;
        size_t decrypt_blocks = no_pattern ? available : crypt_blocks;
        if (decrypt_blocks > available)
            decrypt_blocks = available;
        if (decrypt_blocks) {
            size_t bytes = decrypt_blocks * 16;
            int written = 0;
            if (bytes > INT_MAX ||
                EVP_DecryptUpdate(ctx, output + block * 16, &written,
                                  input + block * 16, (int)bytes) != 1 ||
                written != (int)bytes) {
                EVP_CIPHER_CTX_free(ctx);
                return 0;
            }
            block += decrypt_blocks;
        }
        if (no_pattern)
            break;
        if (crypt_blocks == 0) {
            EVP_CIPHER_CTX_free(ctx);
            return 1;
        }
        available = blocks - block;
        size_t skipped = skip_blocks < available ? skip_blocks : available;
        block += skipped;
    }
    EVP_CIPHER_CTX_free(ctx);
    return 1;
}

enum cenc_packet_state cenc_decrypt_packet(
    const struct cenc_key_store *store,
    const struct cenc_packet *packet,
    const AVEncryptionInfo *info,
    int cancelled,
    struct cenc_clear_packet *clear)
{
    EVP_CIPHER_CTX *ctx = NULL;
    enum cenc_packet_state result = CENC_DECRYPT_FAILURE;
    uint8_t expanded_iv[16] = {0};
    const uint8_t *key;
    size_t described = 0;
    size_t offset = 0;

    if (!packet || !clear || (!packet->data && packet->size != 0))
        return CENC_MALFORMED_ENCRYPTION_INFO;
    memset(clear, 0, sizeof(*clear));
    if (cancelled)
        return CENC_CANCELLED;
    if (!info) {
        if (packet->size > SIZE_MAX - EVP_MAX_BLOCK_LENGTH)
            return CENC_DECRYPT_FAILURE;
        clear->data = malloc(packet->size + EVP_MAX_BLOCK_LENGTH);
        if (!clear->data)
            return CENC_DECRYPT_FAILURE;
        if (packet->size)
            memcpy(clear->data, packet->data, packet->size);
        result = CENC_CLEAR_PACKET;
        goto success;
    }
    if (info->scheme != CENC_SCHEME && info->scheme != CBCS_SCHEME)
        return CENC_UNSUPPORTED_SCHEME;
    if (info->scheme == CENC_SCHEME &&
        (info->crypt_byte_block != 0 || info->skip_byte_block != 0))
        return CENC_UNSUPPORTED_SCHEME;
    if (info->key_id_size != 16 || !info->key_id ||
        (info->scheme == CENC_SCHEME
             ? (info->iv_size != 8 && info->iv_size != 16)
             : info->iv_size != 16) ||
        !info->iv)
        return CENC_MALFORMED_ENCRYPTION_INFO;
    if (info->subsample_count && !info->subsamples)
        return CENC_MALFORMED_ENCRYPTION_INFO;
    if (info->subsample_count) {
        for (uint32_t n = 0; n < info->subsample_count; n++) {
            if (!add_size(&described, info->subsamples[n].bytes_of_clear_data) ||
                !add_size(&described, info->subsamples[n].bytes_of_protected_data))
                return CENC_MALFORMED_ENCRYPTION_INFO;
        }
        if (described != packet->size)
            return CENC_MALFORMED_ENCRYPTION_INFO;
    }
    key = cenc_lookup_key(store, info->key_id);
    if (!key)
        return CENC_KEY_UNAVAILABLE;

    if (packet->size > UINT32_MAX)
        return CENC_MALFORMED_ENCRYPTION_INFO;
    clear->data = malloc(packet->size + EVP_MAX_BLOCK_LENGTH);
    if (!clear->data)
        return CENC_DECRYPT_FAILURE;
    if (packet->size)
        memcpy(clear->data, packet->data, packet->size);
    memcpy(expanded_iv, info->iv, info->iv_size);
    if (info->scheme == CENC_SCHEME) {
        ctx = EVP_CIPHER_CTX_new();
        if (!ctx || EVP_DecryptInit_ex(ctx, EVP_aes_128_ctr(), NULL, key,
                                      expanded_iv) != 1)
            goto done;
    }

    uint32_t ranges = info->subsample_count ? info->subsample_count : 1;
    for (uint32_t n = 0; n < ranges; n++) {
        uint32_t clear_bytes = info->subsample_count
            ? info->subsamples[n].bytes_of_clear_data : 0;
        uint32_t protected_bytes = info->subsample_count
            ? info->subsamples[n].bytes_of_protected_data : (uint32_t)packet->size;
        offset += clear_bytes;
        if (cancelled) {
            result = CENC_CANCELLED;
            goto done;
        }
        if (info->scheme == CBCS_SCHEME) {
            if (!decrypt_cbcs_region(clear->data + offset, packet->data + offset,
                                     protected_bytes, key, expanded_iv,
                                     info->crypt_byte_block,
                                     info->skip_byte_block))
                goto done;
            offset += protected_bytes;
        } else {
            while (protected_bytes) {
                int chunk = protected_bytes > INT_MAX ? INT_MAX : (int)protected_bytes;
                int written = 0;
                if (EVP_DecryptUpdate(ctx, clear->data + offset, &written,
                                      packet->data + offset, chunk) != 1 ||
                    written != chunk)
                    goto done;
                offset += (size_t)chunk;
                protected_bytes -= (uint32_t)chunk;
            }
        }
    }
    if (offset != packet->size)
        goto done;
    {
        int final_bytes = 0;
        if (ctx && (EVP_DecryptFinal_ex(ctx, clear->data + offset, &final_bytes) != 1 ||
                    final_bytes != 0))
            goto done;
    }
    result = CENC_ENCRYPTED_PACKET;

success:
    clear->size = packet->size;
    clear->pts = packet->pts;
    clear->dts = packet->dts;
    clear->duration = packet->duration;
    clear->keyframe = packet->keyframe;
    clear->codec_generation = packet->codec_generation;
done:
    EVP_CIPHER_CTX_free(ctx);
    if (result != CENC_CLEAR_PACKET && result != CENC_ENCRYPTED_PACKET)
        cenc_clear_packet_free(clear);
    return result;
}

void cenc_clear_packet_free(struct cenc_clear_packet *packet)
{
    if (!packet)
        return;
    free(packet->data);
    memset(packet, 0, sizeof(*packet));
}

const char *cenc_packet_state_name(enum cenc_packet_state state)
{
    switch (state) {
    case CENC_CLEAR_PACKET: return "ClearPacket";
    case CENC_ENCRYPTED_PACKET: return "EncryptedPacket";
    case CENC_KEY_UNAVAILABLE: return "KeyUnavailable";
    case CENC_UNSUPPORTED_SCHEME: return "UnsupportedScheme";
    case CENC_MALFORMED_ENCRYPTION_INFO: return "MalformedEncryptionInfo";
    case CENC_DECRYPT_FAILURE: return "DecryptFailure";
    case CENC_CANCELLED: return "Cancelled";
    }
    return "Unknown";
}
