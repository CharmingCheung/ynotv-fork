# mpv packet demux adapter experiment

This directory contains the isolated Phase C2 proof. It does not participate in
ynoTV playback. `packet_producer` uses libavformat once to turn the synthetic C1
H.264/AAC fixture into the experimental `RDPKT001` packet file. The patched mpv
demuxer reads that file contract directly; it never receives or parses MP4.

The mpv patch is intentionally represented as one new source file plus a
three-line registration patch. Apply it only to mpv commit
`cfd818bcaef262f82596f49444ee80073fa6d49a`:

```sh
./apply-to-mpv.sh /path/to/mpv
```

After building that checkout, run the validation suite:

```sh
./run-tests.sh /path/to/mpv/build/mpv
```

An optional second argument supplies a directory to prepend to
`DYLD_LIBRARY_PATH`; it was needed in the recorded run because the pinned mpv
requires libplacebo 7.360.1 while the linked Homebrew installation was 7.351.0.

Generated media, logs, the producer executable, and a local `mpv-work/`
checkout are ignored. See `docs/research/05-mpv-packet-demux-adapter.md` for the
contract, exact commands, results, limitations, and maintenance assessment.
