#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/evp.h>

#include "cenc_transform.h"

#define CENC_SCHEME (((uint32_t)'c' << 24) | ((uint32_t)'e' << 16) | \
                     ((uint32_t)'n' << 8) | (uint32_t)'c')

static void require(int condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "FAIL: %s\n", message);
        exit(1);
    }
}

static AVEncryptionInfo *make_info(uint32_t subsamples, uint32_t iv_size)
{
    AVEncryptionInfo *info = av_encryption_info_alloc(subsamples, 16, iv_size);
    require(info != NULL, "encryption info allocation");
    info->scheme = CENC_SCHEME;
    return info;
}

static void test_nist_vector(void)
{
    static const uint8_t key[16] = {
        0x2b,0x7e,0x15,0x16,0x28,0xae,0xd2,0xa6,
        0xab,0xf7,0x15,0x88,0x09,0xcf,0x4f,0x3c,
    };
    static const uint8_t iv[16] = {
        0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,
        0xf8,0xf9,0xfa,0xfb,0xfc,0xfd,0xfe,0xff,
    };
    static const uint8_t ciphertext[16] = {
        0x87,0x4d,0x61,0x91,0xb6,0x20,0xe3,0x26,
        0x1b,0xef,0x68,0x64,0x99,0x0d,0xb6,0xce,
    };
    static const uint8_t plaintext[16] = {
        0x6b,0xc1,0xbe,0xe2,0x2e,0x40,0x9f,0x96,
        0xe9,0x3d,0x7e,0x11,0x73,0x93,0x17,0x2a,
    };
    struct cenc_key_entry entry = {{0}, {0}};
    memcpy(entry.key, key, 16);
    struct cenc_key_store store = {&entry, 1};
    struct cenc_packet packet = {ciphertext, sizeof(ciphertext), 1, 2, 3, 1, 7};
    struct cenc_clear_packet clear = {0};
    AVEncryptionInfo *info = make_info(0, 16);
    memcpy(info->iv, iv, 16);
    enum cenc_packet_state state = cenc_decrypt_packet(&store, &packet, info, 0, &clear);
    require(state == CENC_ENCRYPTED_PACKET, "NIST vector state");
    require(clear.size == sizeof(plaintext) && memcmp(clear.data, plaintext, sizeof(plaintext)) == 0,
            "NIST AES-CTR vector");
    require(clear.pts == 1 && clear.dts == 2 && clear.duration == 3 &&
            clear.keyframe == 1 && clear.codec_generation == 7,
            "packet metadata preserved");
    cenc_clear_packet_free(&clear);
    av_encryption_info_free(info);
}

static void encrypt_protected_ranges(const uint8_t key[16], const uint8_t iv[16],
                                     const uint8_t *plain, uint8_t *cipher)
{
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int written = 0;
    memcpy(cipher, plain, 32);
    require(ctx && EVP_EncryptInit_ex(ctx, EVP_aes_128_ctr(), NULL, key, iv) == 1,
            "test encrypt init");
    require(EVP_EncryptUpdate(ctx, cipher + 3, &written, plain + 3, 5) == 1 && written == 5,
            "test encrypt first span");
    require(EVP_EncryptUpdate(ctx, cipher + 10, &written, plain + 10, 22) == 1 && written == 22,
            "test encrypt second span");
    EVP_CIPHER_CTX_free(ctx);
}

static void test_subsamples_and_8_byte_iv(void)
{
    uint8_t plain[32];
    uint8_t cipher[32];
    uint8_t iv[16] = {1,2,3,4,5,6,7,8,0,0,0,0,0,0,0,0};
    struct cenc_key_entry entry = {{0}, {0}};
    for (int n = 0; n < 16; n++) entry.key[n] = (uint8_t)(n * 7 + 1);
    for (int n = 0; n < 32; n++) plain[n] = (uint8_t)(n + 20);
    encrypt_protected_ranges(entry.key, iv, plain, cipher);
    struct cenc_key_store store = {&entry, 1};
    struct cenc_packet packet = {cipher, sizeof(cipher), 0, 0, 32, 0, 1};
    struct cenc_clear_packet clear = {0};
    AVEncryptionInfo *info = make_info(2, 8);
    memcpy(info->iv, iv, 8);
    info->subsamples[0].bytes_of_clear_data = 3;
    info->subsamples[0].bytes_of_protected_data = 5;
    info->subsamples[1].bytes_of_clear_data = 2;
    info->subsamples[1].bytes_of_protected_data = 22;
    require(cenc_decrypt_packet(&store, &packet, info, 0, &clear) == CENC_ENCRYPTED_PACKET,
            "subsample state");
    require(memcmp(clear.data, plain, sizeof(plain)) == 0,
            "clear bytes preserved and CTR continuous across protected spans");
    cenc_clear_packet_free(&clear);
    av_encryption_info_free(info);
}

static void test_errors(void)
{
    uint8_t bytes[16] = {0};
    struct cenc_key_entry entry = {{0}, {0}};
    struct cenc_key_store store = {&entry, 1};
    struct cenc_packet packet = {bytes, sizeof(bytes), 0, 0, 0, 0, 1};
    struct cenc_clear_packet clear = {0};
    require(cenc_decrypt_packet(&store, &packet, NULL, 0, &clear) ==
            CENC_CLEAR_PACKET, "clear packet state");
    require(clear.size == sizeof(bytes) && memcmp(clear.data, bytes, sizeof(bytes)) == 0,
            "clear packet copy");
    cenc_clear_packet_free(&clear);
    AVEncryptionInfo *info = make_info(1, 16);
    info->subsamples[0].bytes_of_protected_data = 15;
    require(cenc_decrypt_packet(&store, &packet, info, 0, &clear) ==
            CENC_MALFORMED_ENCRYPTION_INFO, "malformed subsample total");
    info->subsamples[0].bytes_of_protected_data = 16;
    info->scheme = ((uint32_t)'c' << 24) | ((uint32_t)'b' << 16) |
                   ((uint32_t)'c' << 8) | (uint32_t)'s';
    require(cenc_decrypt_packet(&store, &packet, info, 0, &clear) ==
            CENC_UNSUPPORTED_SCHEME, "unsupported scheme");
    info->scheme = CENC_SCHEME;
    memset(info->key_id, 0xaa, 16);
    require(cenc_decrypt_packet(&store, &packet, info, 0, &clear) ==
            CENC_KEY_UNAVAILABLE, "missing key");
    require(cenc_decrypt_packet(&store, &packet, info, 1, &clear) ==
            CENC_CANCELLED, "cancelled");
    av_encryption_info_free(info);
}

int main(void)
{
    test_nist_vector();
    test_subsamples_and_8_byte_iv();
    test_errors();
    puts("PASS: AES-CTR vectors, 8/16-byte IVs, subsamples, lookup, and explicit errors");
    return 0;
}
