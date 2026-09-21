#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <mpv/client.h>

static double now_seconds(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1000000000.0;
}

static void check(int result, const char *what)
{
    if (result < 0) {
        fprintf(stderr, "%s: %s\n", what, mpv_error_string(result));
        exit(1);
    }
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: %s fixture.rdp\n", argv[0]);
        return 2;
    }
    mpv_handle *mpv = mpv_create();
    if (!mpv)
        return 1;
    check(mpv_set_option_string(mpv, "config", "no"), "config");
    check(mpv_set_option_string(mpv, "demuxer", "rustdash"), "demuxer");
    check(mpv_set_option_string(mpv, "demuxer-seekable-cache", "no"), "seek cache");
    check(mpv_set_option_string(mpv, "cache", "no"), "cache");
    check(mpv_set_option_string(mpv, "vo", "null"), "vo");
    check(mpv_set_option_string(mpv, "ao", "null"), "ao");
    check(mpv_request_log_messages(mpv, "v"), "logs");
    check(mpv_initialize(mpv), "initialize");
    const char *load[] = {"loadfile", argv[1], NULL};
    check(mpv_command(mpv, load), "loadfile");

    bool waiting = false;
    double deadline = now_seconds() + 5;
    while (!waiting && now_seconds() < deadline) {
        mpv_event *event = mpv_wait_event(mpv, 0.25);
        if (event->event_id == MPV_EVENT_LOG_MESSAGE) {
            mpv_event_log_message *message = event->data;
            fputs(message->text, stdout);
            waiting = strstr(message->text, "producer waiting group=1") != NULL;
        }
    }
    if (!waiting) {
        fprintf(stderr, "producer did not enter delayed wait\n");
        mpv_terminate_destroy(mpv);
        return 1;
    }
    double start = now_seconds();
    mpv_terminate_destroy(mpv);
    double elapsed = now_seconds() - start;
    printf("DESTROY_RETURNED_SECONDS=%.6f\n", elapsed);
    return elapsed < 2.0 ? 0 : 1;
}
