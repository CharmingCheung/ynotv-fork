#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/encryption_info.h>
#include <libavutil/error.h>
#include <libavutil/hash.h>
#include <libavutil/mem.h>

enum { IO_BUFFER_SIZE = 4096 };

typedef struct InputPiece {
    const char *path;
    uint8_t *data;
    size_t size;
    size_t position;
    int sent_eagain;
} InputPiece;

typedef struct InputState {
    InputPiece *pieces;
    int piece_count;
    int current_piece;
    int announced_piece;
    int eagain_at_boundary;
} InputState;

static void print_error(const char *operation, int error)
{
    char message[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error, message, sizeof(message));
    fprintf(stderr, "ERROR operation=%s code=%d message=%s\n", operation, error,
            message);
}

static int load_piece(InputPiece *piece, const char *path)
{
    FILE *file = fopen(path, "rb");
    long length;
    if (!file) {
        fprintf(stderr, "ERROR open=%s errno=%d\n", path, errno);
        return -1;
    }
    if (fseek(file, 0, SEEK_END) != 0 || (length = ftell(file)) < 0 ||
        fseek(file, 0, SEEK_SET) != 0) {
        fprintf(stderr, "ERROR size=%s errno=%d\n", path, errno);
        fclose(file);
        return -1;
    }
    piece->data = av_malloc((size_t)length + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!piece->data) {
        fclose(file);
        return -1;
    }
    if (fread(piece->data, 1, (size_t)length, file) != (size_t)length) {
        fprintf(stderr, "ERROR read=%s errno=%d\n", path, errno);
        fclose(file);
        av_freep(&piece->data);
        return -1;
    }
    fclose(file);
    memset(piece->data + length, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    piece->path = path;
    piece->size = (size_t)length;
    piece->position = 0;
    return 0;
}

static int read_packet(void *opaque, uint8_t *buffer, int buffer_size)
{
    InputState *input = opaque;
    while (input->current_piece < input->piece_count) {
        InputPiece *piece = &input->pieces[input->current_piece];
        size_t remaining;
        size_t count;
        if (!input->announced_piece) {
            fprintf(stderr, "INPUT piece=%d path=%s size=%zu\n",
                    input->current_piece, piece->path, piece->size);
            input->announced_piece = 1;
        }
        remaining = piece->size - piece->position;
        if (remaining == 0) {
            fprintf(stderr, "INPUT boundary=fragment-exhausted piece=%d\n",
                    input->current_piece);
            if (input->eagain_at_boundary && input->current_piece > 0 &&
                !piece->sent_eagain) {
                piece->sent_eagain = 1;
                fprintf(stderr, "INPUT status=temporarily-exhausted code=%d\n",
                        AVERROR(EAGAIN));
                return AVERROR(EAGAIN);
            }
            input->current_piece++;
            input->announced_piece = 0;
            continue;
        }
        count = remaining < (size_t)buffer_size ? remaining : (size_t)buffer_size;
        memcpy(buffer, piece->data + piece->position, count);
        piece->position += count;
        return (int)count;
    }
    fprintf(stderr, "INPUT boundary=representation-ended\n");
    return AVERROR_EOF;
}

static void print_hex(const uint8_t *bytes, size_t size)
{
    size_t index;
    if (!bytes || size == 0) {
        fputs("none", stdout);
        return;
    }
    for (index = 0; index < size; index++)
        printf("%02x", bytes[index]);
}

static void print_fourcc(uint32_t value)
{
    putchar((int)((value >> 24) & 0xff));
    putchar((int)((value >> 16) & 0xff));
    putchar((int)((value >> 8) & 0xff));
    putchar((int)(value & 0xff));
}

static void print_init_info(const uint8_t *data, size_t size, const char *owner,
                            int owner_index)
{
    AVEncryptionInitInfo *item = av_encryption_init_info_get_side_data(data, size);
    AVEncryptionInitInfo *head = item;
    int entry = 0;
    if (!item) {
        printf("ENCRYPTION_INIT owner=%s index=%d parse=failed bytes=%zu\n",
               owner, owner_index, size);
        return;
    }
    while (item) {
        uint32_t kid;
        printf("ENCRYPTION_INIT owner=%s index=%d entry=%d system_id=",
               owner, owner_index, entry);
        print_hex(item->system_id, item->system_id_size);
        printf(" key_ids=%u", item->num_key_ids);
        for (kid = 0; kid < item->num_key_ids; kid++) {
            printf(" kid[%u]=", kid);
            print_hex(item->key_ids[kid], item->key_id_size);
        }
        printf(" init_data_size=%u init_data=", item->data_size);
        print_hex(item->data, item->data_size);
        putchar('\n');
        item = item->next;
        entry++;
    }
    av_encryption_init_info_free(head);
}

static void print_stream(const AVFormatContext *format, unsigned int index)
{
    const AVStream *stream = format->streams[index];
    const AVCodecParameters *par = stream->codecpar;
    char channel_layout[128] = "n/a";
    int side_index;
    if (par->codec_type == AVMEDIA_TYPE_AUDIO)
        av_channel_layout_describe(&par->ch_layout, channel_layout,
                                   sizeof(channel_layout));
    printf("STREAM index=%u type=%s codec=%s codec_id=%d codec_tag=0x%08x "
           "profile=%d level=%d bit_rate=%" PRId64 " format=%d "
           "width=%d height=%d sample_rate=%d channels=%d channel_layout=%s "
           "time_base=%d/%d extradata_size=%d extradata=",
           index, av_get_media_type_string(par->codec_type),
           avcodec_get_name(par->codec_id), par->codec_id, par->codec_tag,
           par->profile, par->level, par->bit_rate, par->format,
           par->width, par->height, par->sample_rate, par->ch_layout.nb_channels,
           channel_layout, stream->time_base.num, stream->time_base.den,
           par->extradata_size);
    print_hex(par->extradata, (size_t)par->extradata_size);
    putchar('\n');
    for (side_index = 0; side_index < par->nb_coded_side_data; side_index++) {
        const AVPacketSideData *side = &par->coded_side_data[side_index];
        printf("STREAM_SIDE_DATA stream=%u type=%s size=%zu\n", index,
               av_packet_side_data_name(side->type), side->size);
        if (side->type == AV_PKT_DATA_ENCRYPTION_INIT_INFO)
            print_init_info(side->data, side->size, "stream", (int)index);
    }
}

static void print_packet_encryption(const AVPacket *packet, int packet_index)
{
    size_t side_size = 0;
    const uint8_t *side = av_packet_get_side_data(
        packet, AV_PKT_DATA_ENCRYPTION_INFO, &side_size);
    AVEncryptionInfo *info;
    uint32_t index;
    const uint8_t *init_side;
    size_t init_side_size = 0;
    init_side = av_packet_get_side_data(
        packet, AV_PKT_DATA_ENCRYPTION_INIT_INFO, &init_side_size);
    if (init_side)
        print_init_info(init_side, init_side_size, "packet", packet_index);
    if (!side)
        return;
    info = av_encryption_info_get_side_data(side, side_size);
    if (!info) {
        printf("ENCRYPTION packet=%d parse=failed bytes=%zu\n", packet_index,
               side_size);
        return;
    }
    printf("ENCRYPTION packet=%d scheme=", packet_index);
    print_fourcc(info->scheme);
    printf(" kid=");
    print_hex(info->key_id, info->key_id_size);
    printf(" iv=");
    print_hex(info->iv, info->iv_size);
    printf(" crypt_byte_block=%u skip_byte_block=%u subsamples=%u",
           info->crypt_byte_block, info->skip_byte_block, info->subsample_count);
    for (index = 0; index < info->subsample_count; index++) {
        printf(" subsample[%u]=%u/%u", index,
               info->subsamples[index].bytes_of_clear_data,
               info->subsamples[index].bytes_of_protected_data);
    }
    putchar('\n');
    av_encryption_info_free(info);
}

static int inspect(InputState *input)
{
    AVFormatContext *format = avformat_alloc_context();
    AVIOContext *avio = NULL;
    uint8_t *avio_buffer = NULL;
    const AVInputFormat *mov = av_find_input_format("mov");
    AVPacket *packet = NULL;
    struct AVHashContext *hash = NULL;
    int result;
    int packet_index = 0;
    unsigned int stream_index;

    if (!format || !mov)
        return 1;
    avio_buffer = av_malloc(IO_BUFFER_SIZE);
    if (!avio_buffer)
        goto failure;
    avio = avio_alloc_context(avio_buffer, IO_BUFFER_SIZE, 0, input, read_packet,
                              NULL, NULL);
    if (!avio)
        goto failure;
    format->pb = avio;
    format->flags |= AVFMT_FLAG_CUSTOM_IO;
    format->probesize = 32768;

    result = avformat_open_input(&format, "packet-lab.mov", mov, NULL);
    if (result < 0) {
        print_error("avformat_open_input", result);
        goto failure;
    }
    result = avformat_find_stream_info(format, NULL);
    if (result < 0) {
        print_error("avformat_find_stream_info", result);
        goto failure;
    }
    if (input->eagain_at_boundary && format->pb->error == AVERROR(EAGAIN)) {
        fprintf(stderr, "AVIO action=clear-consumed-eagain-after-stream-info\n");
        format->pb->error = 0;
        format->pb->eof_reached = 0;
    }
    printf("FORMAT name=%s streams=%u duration=%" PRId64 " seekable=%d\n",
           format->iformat->name, format->nb_streams, format->duration,
           format->pb ? format->pb->seekable : 0);
    for (stream_index = 0; stream_index < format->nb_streams; stream_index++)
        print_stream(format, stream_index);

    packet = av_packet_alloc();
    if (!packet || av_hash_alloc(&hash, "sha256") < 0)
        goto failure;
    while ((result = av_read_frame(format, packet)) >= 0) {
        const AVStream *stream = format->streams[packet->stream_index];
        int side_index;
        uint8_t data_hash[AV_HASH_MAX_SIZE * 2 + 1];
        av_hash_init(hash);
        av_hash_update(hash, packet->data, (size_t)packet->size);
        av_hash_final_hex(hash, data_hash, sizeof(data_hash));
        printf("PACKET n=%d stream=%d type=%s pts=%" PRId64 " dts=%" PRId64
               " duration=%" PRId64 " time_base=%d/%d keyframe=%d size=%d"
               " sha256=%s side_data=%d\n",
               packet_index, packet->stream_index,
               av_get_media_type_string(stream->codecpar->codec_type),
               packet->pts, packet->dts, packet->duration,
               stream->time_base.num, stream->time_base.den,
               !!(packet->flags & AV_PKT_FLAG_KEY), packet->size,
               data_hash, packet->side_data_elems);
        for (side_index = 0; side_index < packet->side_data_elems; side_index++) {
            const AVPacketSideData *side = &packet->side_data[side_index];
            printf("PACKET_SIDE_DATA packet=%d type=%s size=%zu\n",
                   packet_index, av_packet_side_data_name(side->type), side->size);
        }
        print_packet_encryption(packet, packet_index);
        packet_index++;
        av_packet_unref(packet);
    }
    if (result == AVERROR(EAGAIN))
        printf("DEMUX status=fragment-temporarily-exhausted packets=%d\n",
               packet_index);
    else if (result == AVERROR_EOF)
        printf("DEMUX status=representation-ended packets=%d\n", packet_index);
    else {
        char message[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(result, message, sizeof(message));
        printf("DEMUX status=fatal-error packets=%d code=%d message=%s\n",
               packet_index, result, message);
    }

    av_packet_free(&packet);
    av_hash_freep(&hash);
    avformat_close_input(&format);
    avio_context_free(&avio);
    return result == AVERROR_EOF ? 0 : 2;

failure:
    av_packet_free(&packet);
    av_hash_freep(&hash);
    if (format)
        avformat_close_input(&format);
    if (avio)
        avio_context_free(&avio);
    else
        av_free(avio_buffer);
    return 1;
}

int main(int argc, char **argv)
{
    InputState input = {0};
    int index;
    int result;
    int first_path = 1;
    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 0);
    if (argc > 1 && strcmp(argv[1], "--eagain-at-boundary") == 0) {
        input.eagain_at_boundary = 1;
        first_path++;
    }
    if (argc - first_path < 2) {
        fprintf(stderr, "usage: %s [--eagain-at-boundary] INIT.mp4 "
                        "SEGMENT.m4s [SEGMENT.m4s ...]\n",
                argv[0]);
        return 64;
    }
    input.piece_count = argc - first_path;
    input.pieces = av_calloc((size_t)input.piece_count, sizeof(*input.pieces));
    if (!input.pieces)
        return 1;
    for (index = 0; index < input.piece_count; index++) {
        if (load_piece(&input.pieces[index], argv[index + first_path]) < 0) {
            result = 1;
            goto done;
        }
    }
    result = inspect(&input);

done:
    for (index = 0; index < input.piece_count; index++)
        av_free(input.pieces[index].data);
    av_free(input.pieces);
    return result;
}
