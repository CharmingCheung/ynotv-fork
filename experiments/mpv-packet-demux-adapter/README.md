# mpv packet demux adapter experiment

This directory contains the isolated Phase C2 proof and the follow-on bounded
producer/runtime-generation experiment. It does not participate in ynoTV
playback. The standalone producers use libavformat to turn synthetic C1 media
into deterministic packet fixtures; the patched mpv demuxer never receives or
parses MP4.

The mpv patch is intentionally represented as one new source file, one small
endian helper header, and a small registration/interrupt patch. Apply it only to mpv commit
`cfd818bcaef262f82596f49444ee80073fa6d49a`:

```sh
./apply-to-mpv.sh /path/to/mpv
```

After building that checkout, run the validation suite:

```sh
./run-tests.sh /path/to/mpv/build/mpv
./run-live-generation-tests.sh /path/to/mpv/build/mpv \
  /optional/dylib/directory /path/to/mpv/source
./run-track-switch-tests.sh /path/to/mpv/build/mpv /optional/dylib/directory
```

The C8 command generates two aligned H.264 qualities plus 440/880 Hz logical
audio tracks, exercises the `RDPKT005` runtime codec-generation record, checks
the decoded `320x180 -> 640x360 -> 320x180` sequence on one video stream, and
uses JSON IPC plus PCM frequency checks to prove both audio-track switches.
`fixtures/c8-manual-switch.mpd` is the matching deterministic DASH catalog.

An optional second argument supplies a directory to prepend to
`DYLD_LIBRARY_PATH`; it was needed in the recorded run because the pinned mpv
requires libplacebo 7.360.1 while the linked Homebrew installation was 7.351.0.

Generated media, logs, the producer executable, and a local `mpv-work/`
checkout are ignored. See `docs/research/05-mpv-packet-demux-adapter.md` for the
contracts, exact commands, results, limitations, and maintenance assessment in
research reports 05 and 06.
