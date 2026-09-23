# FFmpeg MOV/fMP4 packet laboratory

Research/experiment snapshot: 2026-09-20 (Asia/Singapore)

ynoTV revision at the start of this phase: `437f2364`

## Scope and result

This phase tested only the boundary below:

```text
synthetic init.mp4 + discrete media fragments
                    |
          controlled custom AVIO
                    |
          FFmpeg MOV demuxer
                    |
       AVStream / AVCodecParameters
       AVPacket + packet side data
```

The lab does not use FFmpeg's DASH demuxer. It does not parse an MPD, modify the
DASH timeline model, modify mpv, play media, download media, choose a
representation, or decrypt CENC samples. Nothing in the ynoTV playback path
imports or invokes it.

The packet extraction result is positive. One MOV context emitted all packets
from one init followed by three clear fragments; PTS/DTS and packet bytes agreed
with `ffprobe` reading the original unsplit fMP4. A fresh context also opened a
later independent fragment directly. CENC packet and initialization side data
were available through public FFmpeg APIs.

Three constraints prevent an unqualified result:

1. Appending a different representation's init to an existing context caused
   MOV to report `Found duplicated MOOV Atom. Skipped it`. It emitted the new
   representation's packets while retaining the old width, level, and
   extradata. A new codec/config generation therefore requires a fresh MOV
   context in the tested build.
2. Without `avformat_find_stream_info()`, a strictly init-only post-open
   snapshot contained codec ID, dimensions, audio rate/channel count,
   time bases, extradata, and CENC initialization side data, but not H.264
   profile/level or decoded pixel/sample-format and audio-layout detail.
3. Returning `AVERROR(EAGAIN)` at the A1/A2 fragment boundary without calling
   `avformat_find_stream_info()` was still not surfaced to the caller. One
   `av_read_frame()` invocation made three callback reads that returned EAGAIN,
   then returned `AVERROR_EOF`. A2 remained unavailable and was never read.
   This is conclusion B: resumable EAGAIN still does not work reliably. A
   future controlled MOV producer likely needs a blocking/cancellable AVIO
   source rather than EAGAIN-based starvation signaling.

## Exact toolchain

The experiment ran on macOS 26.6.2 (build 25G83), arm64.

```text
ffmpeg version 8.0
Homebrew formula installation: /opt/homebrew/Cellar/ffmpeg/8.0_1
built with Apple clang version 17.0.0 (clang-1700.0.13.3)

libavformat 62.3.100
libavcodec  62.11.100
libavutil   60.8.100

compiler used for packet_lab:
Apple clang version 21.0.0 (clang-2100.1.1.101)

CENC fixture tool:
MP4 Encrypter 1.7
Bento4 1.6.0.0
```

The FFmpeg build configuration was:

```text
--prefix=/opt/homebrew/Cellar/ffmpeg/8.0_1 --enable-shared
--enable-pthreads --enable-version3 --cc=clang --host-cflags=
--host-ldflags=-Wl,-ld_classic --enable-ffplay --enable-gnutls
--enable-gpl --enable-libaom --enable-libaribb24 --enable-libbluray
--enable-libdav1d --enable-libharfbuzz --enable-libjxl --enable-libmp3lame
--enable-libopus --enable-librav1e --enable-librist --enable-librubberband
--enable-libsnappy --enable-libsrt --enable-libssh --enable-libsvtav1
--enable-libtesseract --enable-libtheora --enable-libvidstab --enable-libvmaf
--enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx264
--enable-libx265 --enable-libxml2 --enable-libxvid --enable-lzma
--enable-libfontconfig --enable-libfreetype --enable-frei0r --enable-libass
--enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenjpeg
--enable-libspeex --enable-libsoxr --enable-libzmq --enable-libzimg
--disable-libjack --disable-indev=jack --enable-videotoolbox
--enable-audiotoolbox --enable-neon
```

## Files added

All executable code is isolated under `experiments/ffmpeg-mov-packet-lab/`:

| File | Purpose |
|---|---|
| `packet_lab.c` | custom AVIO, MOV open/discovery, stream/packet/side-data dump, and terminal-state classification |
| `generate-fixtures.sh` | generate synthetic clear representations and clear H.264/AAC; generate full CENC+PSSH only when Bento4 `mp4encrypt` is available |
| `split_fmp4.py` | split top-level MP4 boxes into one init and discrete `moof`/`mdat` fragments |
| `build.sh` | compile against the installed public FFmpeg libraries |
| `run-experiments.sh` | execute cases A-D, init-only snapshots, conditional CENC+PSSH, both starvation probes, and the `ffprobe` reference |
| `verify_results.py` | assert the observations recorded in this report |
| `.gitignore` | exclude the executable, generated media, and captured results |
| `README.md` | short local entry point |

This report is the only file added outside that directory. No existing source,
timeline, Cargo, lock, mpv, or playback file was changed.

## Reproducible fixtures

The complete fixture command is:

```sh
cd experiments/ffmpeg-mov-packet-lab
./generate-fixtures.sh
```

The script uses only `lavfi` sources (`testsrc2` and a generated sine wave), so
there is no third-party or copyrighted input. It creates:

| Fixture | Content |
|---|---|
| `rep-a` | H.264 High, 320x180, nominal 300 kbit/s, 25 fps, two B-frames, three one-second fragments |
| `rep-b` | H.264 High, 640x360, nominal 700 kbit/s, 25 fps, two B-frames, three one-second fragments |
| `clear-av` | multiplexed 320x180 H.264 plus mono 48 kHz AAC, four physical fragments |
| `cenc` | Bento4 MPEG-CENC encryption of the synthetic representation A, three fragments, plus an empty common-system PSSH |

The clear source files use these material FFmpeg options:

```text
-c:v libx264 -pix_fmt yuv420p -profile:v high
-g 25 -keyint_min 25 -sc_threshold 0 -bf 2
-movflags +dash+frag_keyframe+empty_moov+default_base_moof
-frag_duration 1000000
```

The audio fixture additionally uses `-c:a aac -b:a 96k`. The full CENC+PSSH
fixture requires Bento4 `mp4encrypt`; it uses `--method MPEG-CENC`, a fixed
synthetic KID and IV seed, and a common PSSH system ID. The fixed synthetic
content key exists only in the fixture script and is deliberately suppressed
from command output and experiment logs. It is never passed to `packet_lab`.

There is deliberately no fallback encrypted fixture. If `mp4encrypt` is not on
`PATH`, generation prints a CENC+PSSH skip, removes the capability marker, and
the runner records `CENC_PSSH status=skipped reason=mp4encrypt-unavailable`.
The verifier then skips only the CENC+PSSH assertions. This prevents an FFmpeg
fallback with different PSSH content from being checked against Bento4-specific
expectations.

`split_fmp4.py` parses MP4 top-level box sizes, writes boxes through `moov` to
`init.mp4`, and groups each subsequent `moof` through `mdat` as one `.m4s`.
It does not interpret sample tables or encryption boxes.

## Packet-lab architecture

`packet_lab` loads the named pieces into separately owned buffers but exposes
them as one non-seekable `AVIOContext`. The read callback records when a piece
is exhausted and advances to the next discrete piece. Once the caller-provided
piece list is exhausted, it returns `AVERROR_EOF`.

The normal open/read sequence uses public APIs:

```text
av_find_input_format("mov")
avformat_alloc_context()
avio_alloc_context(read_packet=controlled_piece_reader)
avformat_open_input(... explicitly selected MOV input format ...)
avformat_find_stream_info()
av_read_frame()
```

The corrective modes omit `avformat_find_stream_info()`. The init-only mode
holds every media fragment unavailable until after it prints the post-open
`AVStream`/`AVCodecParameters` snapshot. The A1/A2 starvation mode starts with
init+A1 available, keeps A2 unavailable, and records the result of every
caller-visible `av_read_frame()` invocation.

The lab keeps all timestamp fields as FFmpeg integers plus the exact rational
`AVStream.time_base`; it performs no `f64` conversion. It records codec ID/name,
tag, profile, level, bitrate, sample format/pixel format, dimensions, sample
rate, channel layout, time base, and complete extradata bytes. For every packet
it records stream/type, integer PTS, DTS, duration, rational time base, key flag,
payload size and SHA-256, and every side-data type/size.

`AV_PKT_DATA_ENCRYPTION_INFO` is decoded with
`av_encryption_info_get_side_data()`. Encryption initialization side data is
read from `AVCodecParameters.coded_side_data` and decoded with
`av_encryption_init_info_get_side_data()`.

The MOV demuxer was selected explicitly. No manifest or URL was supplied, and
the FFmpeg DASH demuxer was not involved.

## Init-only snapshot without stream discovery

The strict sequence was:

```text
avformat_open_input()
inspect AVStream / AVCodecParameters
release media input
av_read_frame()
```

At the end of the init piece, the controlled callback continued to report
EAGAIN until `avformat_open_input()` returned. This ensures no media-fragment
bytes were supplied before the snapshot. Relative to the existing normal runs,
the snapshot contained:

| Required field | Init-only result | Normal `find_stream_info` result |
|---|---|---|
| codec ID | H.264 `27`; AAC `86018` | identical |
| H.264 profile / level | unknown (`-99 / -99`) | High `100`, level `12` |
| width / height | `320x180` | identical |
| audio configuration | AAC, 48 kHz, one channel, 5-byte AudioSpecificConfig; channel order unspecified, sample format unknown | same codec/rate/count/extradata; mono native order, planar-float sample format |
| time base | video `1/12800`, audio `1/48000` | identical |
| extradata | complete 46-byte AVC config and 5-byte AAC config | byte-identical |
| encryption initialization side data | 36-byte common-system record, system ID `1077efecc0b24d02ace33c1e52e2fb4b` | byte-identical parsed record |

Thus the init does supply the essential encoded configurations and CENC init
side data, but it does not populate every requested codec-parameter field via
public `AVCodecParameters`. In particular, profile/level are not available in
the immediate snapshot. Also, after the init-end EAGAIN was consumed during
open, clearing `AVIOContext.error`/`eof_reached` and releasing media did not
resume packet reads: the first `av_read_frame()` returned EOF with zero packets.
That init-only gate is a field-inspection control, not a viable feed strategy.

## Observed clear H.264/AAC output

The clear A/V context reported two streams:

```text
video: h264, profile 100, level 12, 320x180, time_base=1/12800,
       extradata_size=46
audio: aac, 48000 Hz, mono, time_base=1/48000, extradata_size=5
```

It emitted 75 video packets and 142 audio packets. All 75 video packets had
different PTS and DTS because of reordering; video had three key packets. AAC
PTS equalled DTS for all 142 packets. Representative stream extradata was:

```text
H.264: 0164000cffe1001a6764000cacd941419f9f011000000300100000030320f142996001000568ebecb22cfdf8f800
AAC:   118856e500
```

The context's reported format duration reflected the amount inspected during
stream discovery rather than the whole later-fed piece list (for example,
`1000000` microseconds for the three-fragment representation run). The packet
timestamps remained complete. This result is a warning not to treat
`AVFormatContext.duration` as an authoritative live/controlled-input duration.

## Case A — same init, multiple fragments

Input:

```text
rep-a/init.mp4
rep-a/segment-1.m4s
rep-a/segment-2.m4s
rep-a/segment-3.m4s
```

One MOV context emitted 75 packets and then `AVERROR_EOF`. The controlled input
recorded every one of the four piece boundaries. There was no demux error and
no timestamp reset:

```text
fragment first packets (packet, PTS, DTS, key):
0   1024   0       1
25  13824  12800   1
50  26624  25600   1

last packet:
74  38400  37888   duration=512 time_base=1/12800 key=0
```

The verifier compared all 75 packets' PTS, DTS, duration, size, SHA-256, and key flag to
`ffprobe` reading the original unsplit `rep-a-full.mp4`; every field matched.
Thus one context can continuously demux same-init fragments in this fixture.

## Case B — B-frames

The encoder was forced to permit two B-frames (`-bf 2`). All 75 video packets
had `PTS != DTS`, DTS increased in exact 512-tick decode steps, and presentation
timestamps showed the expected reordering. The start illustrates the result:

```text
packet  PTS   DTS   duration  time base   key
0       1024  0     512       1/12800     yes
1       2560  512   512       1/12800     no
2       1536  1024  512       1/12800     no
3       2048  1536  512       1/12800     no
```

These integers and flags exactly matched the unsplit-file `ffprobe` reference.
The MOV packet boundary therefore preserves decode order separately from
presentation order; collapsing either timestamp or converting it early to
floating point would lose required information.

## Case C — fresh-context seek

Input to a newly allocated MOV/AVIO context:

```text
rep-a/init.mp4
rep-a/segment-3.m4s
```

The fresh context emitted 25 packets without reading fragments 1 or 2. Its
first packet was:

```text
PTS=26624 DTS=25600 duration=512 time_base=1/12800 keyframe=1 size=6082
```

All 25 packet records matched packets 50-74 from the continuous case, including
PTS, DTS, duration, size, payload SHA-256, and key flag. The embedded `tfdt` time was retained;
the fresh context did not rebase the later fragment to zero. This fixture
therefore supports independent-segment extraction at a random-access fragment
when paired with its init.

## Case D — representation/init switch

Representation A and B share H.264 and time base but deliberately differ in
resolution, level, bitrate target, and AVC configuration:

| Field | A / fresh A context | B / fresh B context |
|---|---|---|
| resolution | 320x180 | 640x360 |
| profile / level | 100 / 12 | 100 / 30 |
| time base | 1/12800 | 1/12800 |
| extradata size | 46 | 46 |
| extradata SHA-256 | `bf0904486aa007bc694bbe9329f790b331303dfc9788fbb63b7640f540c21328` | `eaf2f63ba0f2053992a159e6fd81d935939cab4fad6de4304662e49c8536dcdc` |

The fresh-context sequence was A init + A fragment 1, destroy context, then B
init + B fragment 2. Both contexts emitted 25 packets. B's first packet was a
keyframe at PTS 13824 / DTS 12800. Relative to A's last packet (PTS 12800 / DTS
12288), decode time continued by one 512-tick step. The fresh B context exposed
the correct 640x360 parameters and B extradata.

The reuse attempt supplied this to one context:

```text
init A + fragment A1 + init B + fragment B2
```

MOV logged:

```text
Found duplicated MOOV Atom. Skipped it
```

It emitted 50 packets. Packets 25-49 matched every packet field from the fresh
B context, so timestamp and compressed-payload extraction continued. However,
the sole `AVStream.codecpar` remained A's 320x180, level-12 configuration and
A's extradata hash. It did not change to B's parameters.

This is not a valid seamless configuration transition. In the tested FFmpeg
build the correct demux/config boundary is a fresh MOV context when init/config
generation changes, even when codec and media time base are nominally
compatible. The switch coordinator must preserve the externally assigned track
identity and timestamp continuity while associating packets with the new codec
configuration generation.

## CENC side-data result

The packet lab was never given a decryption key. It emitted all 75 encrypted
packets and found `AV_PKT_DATA_ENCRYPTION_INFO` on all 75. The first record was:

```text
scheme=cenc
KID=11223344556677889900aabbccddeeff
IV=01020304050607080000000000000000
crypt_byte_block=0
skip_byte_block=0
subsamples=1
subsample[0]=867 clear / 6224 protected bytes
```

Later samples had their own IVs and clear/protected byte counts. No content key
was printed or supplied to the demuxer.

MOV also exposed the fixture's PSSH as
`AV_PKT_DATA_ENCRYPTION_INIT_INFO` in `AVCodecParameters.coded_side_data`:

```text
side-data size=36
system_id=1077efecc0b24d02ace33c1e52e2fb4b
key_ids=0
init_data_size=0
```

The PSSH was intentionally empty, so the zero key-ID/data counts are expected;
the effective sample KID came from the track encryption metadata and appeared
on every packet. The init side data was stream/codec-parameter side data, not
repeated on each packet.

With non-seekable custom AVIO, MOV warned that it could not seek to auxiliary
information and would parse `senc` instead. The fixture contains usable `senc`
metadata, and all packets still received parsed encryption info. During
`avformat_find_stream_info()`, FFmpeg also attempted to inspect encrypted H.264
payload as clear H.264 and logged decode errors. Those diagnostics are expected
without a key; no decryption was attempted.

Only `cenc` with per-sample IVs, subsamples, and one empty PSSH was executed.
`cens`, `cbc1`, `cbcs`, constant IV, key rotation, multiple PSSH records, and
`saiz`/`saio`-only layouts remain untested.

## Fragment exhaustion, representation end, and fatal errors

The normal runs show that a physical fragment ending is not a demux EOF when
the callback can immediately advance to another fragment. It is an input-layer
event; MOV reads across it and continues emitting packets.

The original starvation probe returned `AVERROR(EAGAIN)` once between media
fragments 1 and 2 while `avformat_find_stream_info()` was reading ahead. It did
not establish a caller-visible retry boundary.

The corrective probe did not call `avformat_find_stream_info()`. Init+A1 were
available; A2 remained unavailable until and unless `av_read_frame()` returned
EAGAIN. Calls 0 through 24 each returned one A1 packet. Those 25 packet records
exactly matched packets 0 through 24 of the uninterrupted normal run, so there
was no duplication or loss within A1. On call 25, the observable sequence was:

```text
AVIO callback -> AVERROR(EAGAIN)
AVIO callback -> AVERROR(EAGAIN)
AVIO callback -> AVERROR(EAGAIN)
av_read_frame -> AVERROR_EOF
```

Because the caller saw EOF rather than EAGAIN, it did not make A2 available and
could not retry. No A2 packet was extracted. Therefore the experiment cannot
demonstrate resumption without duplication/loss; it demonstrates that the
desired caller boundary was not produced even when stream discovery was
omitted.

The future boundary must consequently keep these three results distinct rather
than map every lack of bytes to EOF:

| State | Evidence-backed meaning |
|---|---|
| fragment temporarily exhausted | the controlled source expects another fragment but it is not available yet; this is source/scheduler state, and both tested EAGAIN paths became caller-visible MOV EOF rather than a retry result |
| representation/input ended | the source declares that no more pieces exist and the already supplied MOV packets have drained; normal runs ended with `AVERROR_EOF` |
| fatal demux error | a negative FFmpeg result other than the explicitly recognized retry/end conditions, retained with its exact error code/message |

Conclusion B applies: resumable EAGAIN still does not work reliably. For a
synchronous MOV read, the safe behavior demonstrated here is to make the next
complete fragment immediately readable. A future producer likely needs a
blocking/cancellable AVIO source rather than EAGAIN-based starvation signaling;
the blocking/cancellation mechanism itself was not implemented or tested.

## Packet information a future boundary must preserve

These are observations about required data, not an mpv adapter design:

| Field | Experimental reason |
|---|---|
| track | A/V produced distinct stream indexes, codec parameters, and time bases |
| integer PTS and rational time base | B-frame presentation order differs from decode order; later-fragment fresh open retained its nonzero media time |
| integer DTS and rational time base | DTS was monotonic while PTS reordered |
| integer duration | every video sample carried 512 ticks; no floating-point conversion was needed |
| keyframe | fresh extraction began on an independently decodable key packet |
| compressed bytes | packet sizes/bytes belong to the selected representation and matched the reference demux |
| codec/config generation | reuse emitted B payload under stale A codec parameters; packets must be paired with the fresh init-derived generation |
| encryption metadata | per-packet scheme/KID/IV/subsamples and stream initialization data were separately exposed |

The lab does not apply DASH Period/PTO offsets. Its timestamps are raw MOV
demux output and remain separate from the compact DASH timeline implemented in
the preceding phase.

## Failures and unknowns

1. Neither EAGAIN experiment established a resumable temporary-starvation
   contract. Omitting `avformat_find_stream_info()` did not change the
   caller-visible EOF result at the A1/A2 boundary.
2. Reusing one MOV context across a second init is invalid for the tested
   configuration change because the second `moov` is skipped.
3. Only independent, keyframe-starting fragments were used for fresh-context
   extraction. Decode preroll and non-independent fragment starts were not
   tested.
4. The two representations deliberately used the same codec and time base.
   Codec changes, timescale changes, audio representation changes, and
   multi-track atomic switches remain untested.
5. The experiment does not prove decoder acceptance, hardware decode behavior,
   A/V synchronization, playback, or any mpv-facing contract.
6. CENC extraction was narrow as listed above, and encrypted payload produced
   expected stream-info decode warnings. No ClearKey or other decryption was
   performed.
7. Custom AVIO was non-seekable. Byte-range/seek callbacks were intentionally
   outside scope.
8. `AVFormatContext.duration` was not stable as fragments became available and
   must not be treated as the representation timeline.
9. The init-only snapshot did not populate H.264 profile/level, pixel/sample
   format, or resolved audio channel order. Calling code must not assume all
   normal post-discovery fields are immediately present.

## Exact commands and tests run

Primary reproducible run:

```sh
cd /path/to/ynotv/experiments/ffmpeg-mov-packet-lab
./generate-fixtures.sh
./build.sh
./run-experiments.sh
./verify_results.py
```

Verifier result:

```text
PASS: packet output, init-only stream fields, B-frames, fresh seek, init switch, CENC capability, and no-stream-info EAGAIN observation
```

`run-experiments.sh` executes the exact input sequences described in cases A-D,
the init-only field snapshots, the no-stream-info A1/EAGAIN/A2 probe, the clear
A/V and conditional CENC+PSSH cases, and:

```sh
ffprobe -v error -select_streams v:0 \
  -show_packets -show_data_hash sha256 -of compact=p=0:nk=0 \
  fixtures/rep-a-full.mp4
```

The C compiler invocation is captured in `build.sh` and completed with
`-std=c11 -Wall -Wextra -Wpedantic -Werror`. The final checks were:

```sh
./build.sh
./run-experiments.sh
./verify_results.py
git diff --check
git status --short --untracked-files=all
```

## Git diff/status

The worktree was clean at the beginning of this phase. All deliverables are new
and untracked, so ordinary `git diff`/`git diff --check` do not include them.
Final `git status --short --untracked-files=all` is:

```text
?? docs/research/04-ffmpeg-mov-packet-lab.md
?? experiments/ffmpeg-mov-packet-lab/.gitignore
?? experiments/ffmpeg-mov-packet-lab/README.md
?? experiments/ffmpeg-mov-packet-lab/build.sh
?? experiments/ffmpeg-mov-packet-lab/generate-fixtures.sh
?? experiments/ffmpeg-mov-packet-lab/packet_lab.c
?? experiments/ffmpeg-mov-packet-lab/run-experiments.sh
?? experiments/ffmpeg-mov-packet-lab/split_fmp4.py
?? experiments/ffmpeg-mov-packet-lab/verify_results.py
```

No generated executable, fixture, or result log appears in status because the
experiment-local `.gitignore` excludes them.

```text
Can FFmpeg MOV provide the packet-level media boundary needed by the future native DASH + mpv architecture?

PARTIAL

Evidence:
FFmpeg MOV reliably emitted exact integer-timestamped AVPackets, codec parameters/extradata, keyframe flags, compressed payloads, and CENC/PSSH metadata from controlled init+fragment input. Same-init continuation and fresh-context access to a later independent fragment matched the unsplit reference exactly. A changed init must use a fresh MOV context because reuse skipped the new moov and retained stale codec parameters. The init alone exposed encoded configuration and encryption init data but not every normal post-discovery codec field. Most importantly, with `avformat_find_stream_info()` omitted, repeated callback EAGAIN at the A1/A2 boundary still became caller-visible `av_read_frame()` EOF. Conclusion B applies: the future controlled MOV producer likely needs a blocking/cancellable AVIO source rather than EAGAIN-based starvation signaling.
```
