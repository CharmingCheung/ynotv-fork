# ClearKey CENC packet-transform experiment

This isolated experiment decrypts FFmpeg MOV `AVPacket` payloads from public
`AV_PKT_DATA_ENCRYPTION_INFO` metadata, verifies every decrypted packet against
the equivalent synthetic clear H.264/AAC source, and writes the existing
`RDPKT001` input consumed by `demux_rustdash`.

Run the transform and negative tests with:

```sh
./run-local-tests.sh
```

Pass the C3-patched mpv binary to `run-playback-tests.sh` for the local
software and VideoToolbox checks. For the authorized external probe, export
`RUSTDASH_TEST_MPD`, `RUSTDASH_TEST_KID`, and `RUSTDASH_TEST_KEY`, then invoke
`run-real-sample.sh` with the same mpv binary. The real-sample extractor follows
redirects and intentionally supports only the SegmentTemplate/SegmentTimeline
shape needed by this experiment.

The generated test key is deterministic but is kept in the gitignored
`local-test.env`; scripts and logs never print it. The transform accepts only
`cenc` AES-CTR and uses OpenSSL EVP rather than a custom AES implementation.
Generated media, packet files, binaries, logs, and the local environment file
are ignored.
