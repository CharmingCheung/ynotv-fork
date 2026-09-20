#include <assert.h>
#include <limits.h>
#include <stdint.h>

#include "../mpv-patch/rdp_endian.h"

int main(void)
{
    static const uint8_t minus_512_i32[] = {0x00, 0xfe, 0xff, 0xff};
    static const uint8_t int32_min[] = {0x00, 0x00, 0x00, 0x80};
    static const uint8_t minus_1024_i64[] = {
        0x00, 0xfc, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    };
    static const uint8_t rdp_nopts[] = {
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
    };

    assert(rdp_read_le_i32(minus_512_i32) == -512);
    assert(rdp_read_le_i32(int32_min) == INT32_MIN);
    assert(rdp_read_le_i64(minus_1024_i64) == -1024);
    assert(rdp_read_le_i64(rdp_nopts) == INT64_MIN);
    return 0;
}
