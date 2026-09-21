#ifndef MPV_RDP_ENDIAN_H
#define MPV_RDP_ENDIAN_H

#include <stdint.h>

static inline uint32_t rdp_read_le_u32(const uint8_t b[4])
{
    return (uint32_t)b[0] | (uint32_t)b[1] << 8 |
           (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}

static inline int32_t rdp_read_le_i32(const uint8_t b[4])
{
    uint32_t u = rdp_read_le_u32(b);
    return u <= INT32_MAX ? (int32_t)u
                          : -1 - (int32_t)(UINT32_MAX - u);
}

static inline int64_t rdp_read_le_i64(const uint8_t b[8])
{
    uint64_t u = (uint64_t)b[0] | (uint64_t)b[1] << 8 |
                 (uint64_t)b[2] << 16 | (uint64_t)b[3] << 24 |
                 (uint64_t)b[4] << 32 | (uint64_t)b[5] << 40 |
                 (uint64_t)b[6] << 48 | (uint64_t)b[7] << 56;
    return u <= INT64_MAX ? (int64_t)u
                          : -1 - (int64_t)(UINT64_MAX - u);
}

#endif
