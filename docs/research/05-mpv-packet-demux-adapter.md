# Experimental mpv packet demux adapter

Research/experiment snapshot: 2026-09-20 (Asia/Singapore)

## Scope and result

This phase tested only this boundary:

```text
synthetic clear H.264/AAC fixture
        |
standalone FFmpeg packet producer
        |
experimental RDPKT001 packet file
        |
demux_rustdash in pinned mpv
        |
unchanged mpv decoders / A-V sync / hwdec / output
```

The result is positive for stable, clear, finite audio/video tracks. The custom
demuxer never sees MP4 bytes. It creates one H.264 video track and one AAC audio
track from externally serialized configuration, then passes externally
serialized compressed packets into mpv's ordinary decode graph.

No MPD parser, DASH networking, ABR, DRM, ClearKey, live behavior,
representation switching, or ynoTV playback integration was added. This is a
file-backed experimental contract, not the production ABI.

## Exact revisions and environment

The mpv source revision was exactly:

```text
cfd818bcaef262f82596f49444ee80073fa6d49a
describe: v0.41.0-604-gcfd818bcae
```

This is the revision pinned by ynoTV's Windows libmpv development package in
Phase A. The patched binary identified itself as
`mpv v0.41.0-604-gcfd818bca-dirty`.

The experiment ran on macOS 26.6.2 (25G83), arm64, Apple M4. The build used
Apple clang 21.0.0, Meson 1.7.0, Ninja 1.12.1, FFmpeg 8.0 libraries, and
libplacebo 7.360.1. The C1 fixture and producer used the Homebrew FFmpeg 8.0
installation described in `04-ffmpeg-mov-packet-lab.md`.

## Artifacts

Everything specific to the proof is isolated under
`experiments/mpv-packet-demux-adapter/`:

| File | Purpose |
|---|---|
| `rustdash_packet_abi.h` | constants for the deliberately small packet-file contract |
| `packet_producer.c` | demux the local fixture once with public libavformat APIs and serialize configurations/packets |
| `build-producer.sh` | compile the producer |
| `mpv-patch/demux_rustdash.c` | new mpv demuxer implementation |
| `mpv-patch/rdp_endian.h` | portable little-endian integer decoding shared with the unit test |
| `mpv-patch/register.patch` | register the demuxer and add it to the Meson source list |
| `apply-to-mpv.sh` | revision-gated patch application helper |
| `make-regression-fixture.py` | derive the negative-timestamp/no-timestamp seek fixture |
| `tests/test_rdp_endian.c` | signed i32/i64 and `RDP_NOPTS` decoding vectors |
| `run-tests.sh` | software, output, seek, hwdec, A/V sync, EOF, and backpressure checks |
| `verify_results.py` | assertions over the captured results |
| `README.md` | short entry point |

Generated packet files, decoded output, logs, and local mpv checkouts are
ignored. Nothing imports this experiment into ynoTV.

## mpv files changed and patch size

The mpv checkout has only four changed files:

| mpv file | Change |
|---|---|
| `demux/demux_rustdash.c` | new, 303 lines |
| `demux/rdp_endian.h` | new, 29 lines |
| `demux/demux.c` | two added registry lines |
| `meson.build` | one added source-list line |

The mpv patch surface is **335 inserted lines, zero deleted lines, four files**.
No decoder, filter, player, stream implementation, public client API, or output
driver was changed.

The standalone producer and validation harness are not included in that patch
count.

## Experimental packet/config contract

All integers are fixed-width little-endian. Strings and blobs have explicit
bounds. The file begins with:

```text
8 bytes   magic = "RDPKT001"
u32       version = 1
u32       track count = 2
2 x       track configuration
N x       packet record
u32       final EOF marker = "EOF1"
```

Each track configuration contains:

```text
u32       stable track id
u32       codec/config generation
u32       type (video or audio)
i32/i32   native time-base numerator/denominator
i32/i32   coded width/height
i32/i32   audio sample rate/channel count
char[32]  FFmpeg codec name
u32+bytes codec extradata length and bytes
```

Each packet record contains:

```text
u32       "PKT1" marker
u32       track id
u32       codec/config generation
i64       PTS, or INT64_MIN for no timestamp
i64       DTS, or INT64_MIN for no timestamp
i64       duration
i32/i32   packet time-base numerator/denominator
u32       flags (bit 0 = keyframe)
u32+bytes compressed payload length and bytes
```

This preserves every field required by the phase: track identity,
codec/config generation, PTS, DTS, duration, exact time base, keyframe state,
and compressed bytes. Initial decoder configuration preserves codec identity
and extradata, plus the basic video or audio parameters needed by mpv.

The prototype deliberately accepts only generation `1`. Packet generation and
time base must match the owning track configuration. It caps extradata at 1
MiB and a packet at 64 MiB. There is no byte-order negotiation, capability
exchange, side-data model, language/role metadata, encryption metadata,
integrity checksum, live state, or runtime configuration record. Those
omissions are why this is not a proposed production ABI.

Signed fields are decoded by splitting the unsigned bit pattern into its
non-negative and negative ranges. The negative range is reconstructed with
representable signed arithmetic; the adapter does not depend on an
out-of-range unsigned-to-signed C conversion. Unit vectors cover negative
i32/i64 values, both signed minima, and the `INT64_MIN` `RDP_NOPTS` sentinel.

## Producer and fixture

The input was the synthetic clear C1 fixture:

```text
experiments/ffmpeg-mov-packet-lab/fixtures/clear-av-full.mp4
SHA-256 a4a6b9439377f8beca931c48274bab193685a5ed176d866e2ae645a74acee528
```

It contains 320x180 H.264 High video at 25 fps with two B-frames and mono
48 kHz AAC. `packet_producer` calls `avformat_open_input()`,
`avformat_find_stream_info()`, `av_find_best_stream()`, and
`av_read_frame()`, then writes only configurations and compressed packets to
the packet file.

The generated file was 173,278 bytes and had SHA-256
`51ad1e5e8eefdf2c90e009a5bbcfd71c5a01b219082060e357e880c71b6eeb42`.
The producer reported:

```text
tracks=2 packets=217 payload_bytes=161779 max_packet=7091 pts_ne_dts=75
video_first_pts=1024 video_last_pts=38400
audio_first_pts=0 audio_last_pts=147200
```

There were 75 video and 142 audio packets. Every video packet had distinct PTS
and DTS, so the adapter was exercised with actual decode/presentation
reordering rather than an all-I/P-frame shortcut.

The corrective regression fixture is derived deterministically from that file.
It moves an audio packet carrying `RDP_NOPTS` for both PTS and DTS to packet 0,
then gives the first video random-access packet PTS `-512` (-0.040 s) and DTS
`-1024` (-0.080 s) at time base 1/12800. Its SHA-256 is
`bee2439b7efb1f7adfdbf3270c5cdb0e97644d6b2325dae472d94ec20d6d12c2`.

## How tracks are created

`rustdash_open()` is selected explicitly with `--demuxer=rustdash`. It rejects
non-seekable input, validates the magic/version/two-track shape, and reads both
configuration records.

For each record it:

1. allocates an mpv `sh_stream` with `demux_alloc_sh_stream()`;
2. populates its private `mp_codec_params` with codec name, extradata, native
   time base, dimensions, or sample rate/channel map;
3. assigns the external track ID as `sh_stream.demuxer_id`; and
4. publishes the immutable track through `demux_add_sh_stream()`.

The external IDs are video `1` and audio `2`. mpv displays both as user track
ID `1` because mpv numbers audio and video user-facing IDs independently; the
underlying demuxer IDs remain distinct.

The demuxer then scans packet headers into a compact offset/metadata index. It
does not retain packet payloads during this scan. The index makes the finite
fixture deterministically seekable while keeping live payload ownership to one
packet at a time.

## How packets enter mpv

`rustdash_read_packet()` walks the packet index, skips unselected tracks using
`demux_stream_is_selected()`, allocates one ordinary `demux_packet` from
`demuxer->packet_pool` with `new_demux_packet()`, reads the compressed payload,
and fills:

```text
stream
pts
dts
duration
keyframe
pos
buffer / len
```

It returns that normal packet to mpv. From that point onward the existing
demux queues, H.264/AAC decoders, filter graph, A/V synchronization, hwdec, and
output drivers are unchanged.

The cursor advances only after `*out` receives the completed packet. Allocation
failure leaves the cursor in place for retry; payload seek/read failure also
leaves it in place and emits an explicit error with packet index, offset, and
size instead of silently consuming the indexed packet. Packets belonging to
unselected tracks are intentionally skipped.

## PTS/DTS and B-frame result

Timestamps stay as signed integers with their rational time base until the
mpv boundary. The demuxer converts each one independently to mpv's seconds
representation:

```text
seconds = integer_timestamp * time_base_num / time_base_den
```

It never substitutes PTS for DTS or vice versa. The first C1 video packets use
the already-verified B-frame ordering from Phase C1, and the producer counted
75/75 video packets with `PTS != DTS`.

The software decode/output test decoded and losslessly re-encoded all **75
video frames** to FFV1. The output also contained decoded PCM audio and had a
3.072 s container duration. This proves the reordered compressed stream reached
and was accepted by mpv's ordinary decoder path.

## Seek and flush behavior

The adapter's `seek` callback receives mpv's target seconds (or a factor when
`SEEK_FACTOR` is set). It chooses the latest video keyframe at or before the
target and resets its packet cursor. mpv performs its normal high-resolution
seek from that decode point.

For `--start=2`, the captured sequence was:

```text
experimental seek target=2.000 keyframe=1.080 packet=70
hr-seek, skipping to 2.000000
SEEK_PRESENTED=00:00:02
playback restart complete @ 2.000000, audio=playing, video=playing
```

Thus the controlled fixture seek decoded preroll from the preceding random
access point and presented the requested 2.000 s position with both tracks
running.

The target-zero regression selected packet 1, whose keyframe PTS is negative:

```text
experimental seek target=0.000 keyframe=-0.040 packet=1
```

The candidate search now tracks whether a keyframe was found instead of using
zero as the initial best timestamp, and ignores keyframes without a PTS.

mpv's `queue_seek()` clears reader state and switches to a fresh cache range
before the low-level callback. Player seek handling flushes decoder state. A
custom demuxer's `seek` implementation must independently reposition and flush
any producer-owned queue; `demux_flush()` clears mpv's queues but does not call
the demuxer's `drop_buffers` hook. This file-backed adapter has no producer
queue. Its `drop_buffers` hook only drops stream buffering.

## Software decode and output result

Software playback used:

```text
--hwdec=no --vo=null --ao=null --video-sync=audio
```

mpv reported:

```text
Using software decoding.
Selected decoder: h264
Selected decoder: aac
TRACKS=2 ... HWDEC=no
playback restart complete @ 0.080000, audio=playing, video=playing
experimental producer final EOF
finished playback, success
```

An additional decoded-output run used mpv's existing `vo=lavc`/`ao=lavc`
path to produce FFV1 plus PCM. `ffprobe -count_frames` found 75 video frames;
the audio encoder wrote 294,912 bytes of PCM in nine muxed frames. The resulting
file was 1,091,060 bytes and 3.072 s. This provides a material decoded output
artifact rather than relying only on decoder-open logs.

## Hardware decode and display result

Two VideoToolbox checks succeeded on the Apple M4 host.

The headless-compatible check used `--hwdec=videotoolbox-copy --vo=null` and
reported:

```text
Using hardware decoding (videotoolbox-copy).
Decoder format: 320x180 nv12
HWDEC=videotoolbox-copy
```

The direct hardware/display check used:

```text
--hwdec=videotoolbox --vo=gpu-next --gpu-api=vulkan --ao=null
```

It created the macOS Metal/Vulkan `gpu-next` output, retained the hardware
surface, and reported:

```text
Using hardware decoding (videotoolbox).
VO: [gpu-next] 320x180 videotoolbox[nv12]
HWDEC=videotoolbox VO=gpu-next
```

One frame was dropped during startup while the short 20-frame direct-output
test compiled GPU pipelines. The copy-mode and software tests did not report a
decode failure. Windows D3D11VA and other platform hwdec paths were not tested.

## A/V sync result

The real-time null-output run used mpv's normal `video-sync=audio` behavior and
the ordinary null audio clock. Across 85 captured status samples, reported
`A-V` minimum, maximum, and maximum absolute delta were all `0.000` seconds.
Both audio and video were explicitly in the `playing` state at playback
restart, and both drained normally at EOF.

The verifier parses all 85 captured `A-V` values and independently checks their
minimum and maximum; it no longer treats one matching status line as evidence
for the reported range.

This is a reasonable controlled-fixture result, not a long-duration drift
measurement. The fixture is approximately three seconds and uses generated
content rather than a clap/flash perceptual sync target.

## Backpressure observations

The adapter stores packet metadata/offsets for the preloaded finite fixture but
does not preload payloads. `read_packet()` allocates at most one live payload
before transferring ownership to mpv. The largest observed input packet was
7,091 bytes.

The constrained run set:

```text
--demuxer-max-bytes=32768 --demuxer-readahead-secs=0.25
```

At playback start, `demuxer-cache-state` reported:

```json
{
  "cache-duration": 0.250667,
  "eof": false,
  "total-bytes": 29056,
  "fw-bytes": 29056
}
```

mpv also logged a transient queue-overflow diagnostic at 33,440 video bytes.
Its queue limit is checked between whole packets, so one packet may cross the
threshold before reading stops. The observed bound is therefore the configured
limit plus at most one packet, not an exact byte ceiling. No unbounded adapter
or mpv packet accumulation was required.

The verifier checks every byte observation in this log: each cache
`total-bytes` value and the sum of all per-stream bytes in each queue-overflow
diagnostic. The observed values were 29,056 and 33,440. Their maximum must not
exceed the 32,768-byte limit plus the fixture's 7,091-byte maximum packet.

The offset index is O(packet count), which is acceptable for this preloaded
fixture but is not a live design. A production live producer would need a
bounded rolling index and explicit producer/consumer signaling.

## mpv requirements learned

### Codec/extradata generation

`sh_stream` and its `mp_codec_params` become immutable after
`demux_add_sh_stream()`. Initial codec/extradata must therefore be complete
before track publication.

mpv has an internal segmented-packet mechanism: a `demux_packet` marked
`segmented` may carry a distinct `packet->codec`. The decoder wrapper detects a
new segment/codec pointer, drains and resets the current decoder, and calls its
reinitialization path. The codec object must remain alive while any cached
packet references it. That is the likely internal mechanism for a future
generation change, but this phase did not implement or validate it.

### Discontinuity

A user seek provides a well-defined discontinuity: clear demux queues, invoke
the demuxer `seek` callback, flush decoder/playback state, decode from a random
access point, and high-resolution discard to the target.

For an unsolicited in-stream discontinuity, merely changing numeric timestamps
is insufficient. The producer/adapter must define a boundary, decoder drain or
flush policy, timestamp mapping, and random-access requirement. mpv's internal
segmented packet fields (`segmented`, `start`, `end`, `codec`) can express a
decoder boundary, but that path was not fixture-tested here.

### Seek/flush

The producer must be able to map a presentation target to a decodable packet
position, normally the preceding video random-access packet, and reset all
component cursors coherently. It must discard any producer-owned queued packets
from the old position. mpv can then perform exact presentation discard, as the
2.000 s test demonstrated.

### Temporary no-packet state

The private demux API documents `read_packet() == true` with `*packet == NULL`
as "not EOF; call again." In the current demux thread this is treated as
progress and immediately retried. Used for live starvation without another
wait mechanism, it can busy-loop.

Therefore a live implementation cannot model starvation as repeated empty
returns. It needs a cancellation-aware blocking dequeue or a small additional
mpv wait/wakeup integration tied to producer notification. The file-backed
prototype intentionally has no temporary-no-packet state.

### Final EOF

Returning `false` from `read_packet()` is final EOF. mpv marks all streams EOF,
drains audio/video decoders and outputs, and ends playback. The explicit
`EOF1` record led to `experimental producer final EOF`, normal decoder drain,
and `finished playback, success` in the test.

EOF must not be used for temporary starvation: once signaled, resumption would
require an explicit core wakeup/reset design and is not part of this adapter.

## mpv private APIs and structures touched

The patch depends on these non-public mpv internals:

| Internal surface | Use |
|---|---|
| `demuxer_desc` | register `open`, `read_packet`, `seek`, and `drop_buffers` callbacks |
| `demuxer` fields | access stream, packet pool, private state; set duration, seekability, and file type |
| `demux_alloc_sh_stream()` / `demux_add_sh_stream()` | create and publish stable tracks |
| `sh_stream` / `mp_codec_params` | IDs, codec name, extradata, time base, dimensions, sample rate, channels |
| `demux_stream_is_selected()` | avoid delivering packets for disabled tracks |
| `new_demux_packet()` / `demux_packet` | allocate payload and set timestamps, duration, stream, keyframe, and position |
| `stream_read()` / `stream_seek()` / `stream_tell()` / `stream_drop_buffers()` | access the experimental packet file |
| `demuxer->packet_pool` | use mpv's existing packet allocation pool |
| `MP_TARRAY_APPEND` and talloc | own the packet offset index and demuxer state |
| `demuxer_list[]` in `demux/demux.c` | make the descriptor selectable by name |
| the Meson `sources` list | compile the new source file |

The investigation also relied on, but did not modify, the decoder wrapper's
private segmented-packet behavior and demux queue/seek implementation.

## Upgrade and maintenance risks

1. There is no external demuxer plugin ABI. Every mpv upgrade requires
   rebasing and retesting the patch against private structures and callbacks.
2. `sh_stream`, `mp_codec_params`, `demux_packet`, packet-pool ownership,
   selection, and seek/cache behavior may change without compatibility
   guarantees.
3. Runtime codec-generation changes would rely on the internal segmented
   packet convention and careful codec-object lifetime management; this is a
   larger risk than the stable-track code proven here.
4. Live starvation still needs cancellation-aware producer waiting or a small
   wakeup extension. An incorrect implementation can spin, deadlock shutdown,
   or confuse starvation with EOF.
5. The current adapter scans an O(packet count) index and requires seekable
   file input. Neither property belongs in the production live path.
6. The contract carries no packet side data. HDR metadata, captions, Dolby
   Vision, gapless audio, encryption metadata, and other codecs may require it.
7. Numeric FFmpeg codec IDs were deliberately avoided, but codec names,
   extradata interpretation, and decoder requirements still follow the linked
   FFmpeg build.
8. Cross-platform hwdec remains a packaging and test-matrix obligation. Only
   VideoToolbox on Apple M4 was exercised.

## Exact commands run

The pinned source was obtained and patched with:

```sh
lab_tmp=$(mktemp -d /tmp/ynotv-mpv-adapter.XXXXXX)
git clone --filter=blob:none https://github.com/mpv-player/mpv.git "$lab_tmp/mpv"
git -C "$lab_tmp/mpv" checkout --detach cfd818bcaef262f82596f49444ee80073fa6d49a

cd experiments/mpv-packet-demux-adapter
./apply-to-mpv.sh "$lab_tmp/mpv"
```

The installed libplacebo was 7.351.0, below pinned mpv's required 7.360.1.
The Homebrew 7.360.1 bottle was unpacked into the temporary lab directory, its
placeholder install names were relocated to that directory and `/opt/homebrew`,
and the relocated dylib was ad-hoc signed. No Homebrew package was installed or
upgraded. The dependency preparation commands were:

```sh
brew fetch libplacebo
dep_tmp="$lab_tmp/deps"
mkdir -p "$dep_tmp"
tar -xzf "$(brew --cache libplacebo)" -C "$dep_tmp"
plroot="$dep_tmp/libplacebo/7.360.1"
sed -i '' "s#@@HOMEBREW_CELLAR@@/libplacebo/7.360.1#$plroot#" \
  "$plroot/lib/pkgconfig/libplacebo.pc"
install_name_tool -id "$plroot/lib/libplacebo.360.dylib" \
  "$plroot/lib/libplacebo.360.dylib"
install_name_tool -change \
  '@@HOMEBREW_PREFIX@@/opt/shaderc/lib/libshaderc_shared.1.dylib' \
  '/opt/homebrew/opt/shaderc/lib/libshaderc_shared.1.dylib' \
  "$plroot/lib/libplacebo.360.dylib"
install_name_tool -change \
  '@@HOMEBREW_PREFIX@@/opt/vulkan-loader/lib/libvulkan.1.dylib' \
  '/opt/homebrew/opt/vulkan-loader/lib/libvulkan.1.dylib' \
  "$plroot/lib/libplacebo.360.dylib"
install_name_tool -change \
  '@@HOMEBREW_PREFIX@@/opt/little-cms2/lib/liblcms2.2.dylib' \
  '/opt/homebrew/opt/little-cms2/lib/liblcms2.2.dylib' \
  "$plroot/lib/libplacebo.360.dylib"
codesign --force --sign - "$plroot/lib/libplacebo.360.dylib"
```

The build configuration was:

```sh
PKG_CONFIG_PATH="$lab_tmp/deps/libplacebo/7.360.1/lib/pkgconfig" \
meson setup "$lab_tmp/mpv/build-probe" "$lab_tmp/mpv" \
  -Dbuild-date=false -Dcplayer=true -Dlibmpv=true -Dtests=true \
  -Dgl=disabled -Djavascript=disabled -Dlua=disabled

PKG_CONFIG_PATH="$lab_tmp/deps/libplacebo/7.360.1/lib/pkgconfig" \
meson compile -C "$lab_tmp/mpv/build-probe"
```

The complete adapter validation was run after the final harness change:

```sh
cd experiments/mpv-packet-demux-adapter
./run-tests.sh \
  /tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv \
  /tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib
```

The script expands to these material tests:

```sh
cc -std=c11 -Wall -Wextra -Werror tests/test_rdp_endian.c \
  -o /tmp/rdp-endian-test
/tmp/rdp-endian-test

./build-producer.sh
./packet_producer ../ffmpeg-mov-packet-lab/fixtures/clear-av-full.mp4 fixture.rdp
python3 make-regression-fixture.py fixture.rdp regression-fixture.rdp

mpv -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --video-sync=audio fixture.rdp

mpv --no-config --demuxer=rustdash --hwdec=no \
  --o=results/software-decoded.mkv --ovc=ffv1 --oac=pcm_s16le fixture.rdp
ffprobe -v error -count_frames -show_entries \
  stream=index,codec_name,codec_type,nb_read_frames \
  -show_entries format=duration -of json results/software-decoded.mkv

mpv -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --start=2 --frames=10 fixture.rdp

mpv -v --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --aid=no --start=0 --frames=10 regression-fixture.rdp

mpv -v --no-config --demuxer=rustdash --hwdec=videotoolbox-copy \
  --vo=null --ao=null --frames=20 fixture.rdp

mpv -v --no-config --demuxer=rustdash --hwdec=videotoolbox \
  --vo=gpu-next --gpu-api=vulkan --ao=null --frames=20 fixture.rdp

mpv --no-config --demuxer=rustdash --hwdec=no \
  --vo=null --ao=null --frames=5 --demuxer-max-bytes=32768 \
  --demuxer-readahead-secs=0.25 fixture.rdp

python3 verify_results.py
```

The verifier result was:

```text
PASS: producer, software decode, decoded output, seek, hwdec, A/V sync, EOF, and bounded queue
```

The pinned mpv regression suite was also run:

```sh
PKG_CONFIG_PATH=/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib/pkgconfig \
DYLD_LIBRARY_PATH=/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib \
meson test -C build-probe --print-errorlogs
```

Result: **39 passed, 0 failed, 0 skipped**.

`git diff --check` passed in the patched mpv checkout and in the ynoTV
workspace.

## Failures and unknowns

The initial unmodified pinned-mpv configuration failed because the linked
Homebrew libplacebo was 7.351.0 and this mpv commit requires at least 7.360.1.
Using a relocated 7.360.1 bottle resolved configuration. The first launch of
that relocated dylib was killed by macOS after install-name edits invalidated
its signature; ad-hoc signing the temporary dylib resolved it. These were build
environment issues, not adapter failures.

Still unknown or deliberately untested:

1. dynamic codec/extradata generations and compatible/incompatible
   representation switches;
2. unsolicited timestamp discontinuities and multi-Period transitions;
3. temporary no-packet/live starvation, wakeup, cancellation, and shutdown;
4. a bounded live producer queue and rolling seek index;
5. packet side data and all encrypted/CENC behavior;
6. non-H.264/AAC codecs, more tracks, language/role metadata, and subtitles;
7. long-duration clock drift and perceptual lip-sync fixtures;
8. Windows/Linux build, output, and hwdec behavior;
9. ynoTV/libmpv lifecycle integration and packaging of the fork.

None of these unknowns is hidden by the verdict: it applies only to the stable,
clear, finite packet-sink question posed by this phase.

```text
Can a small custom mpv demux adapter serve as the packet sink for the native DASH engine?

YES

Evidence:
A 335-line mpv patch created two stable tracks from external codec/extradata
configuration and fed 217 externally supplied H.264/AAC packets into unchanged
mpv decode, synchronization, hwdec, and output code. All 75 reordered B-frame
video packets decoded; software output contained 75 frames and decoded audio;
real-time A/V status stayed at 0.000 s in the controlled fixture; a seek landed
at 2.000 s after keyframe preroll; a 32 KiB queue remained bounded to the limit
plus one packet; final EOF drained normally; VideoToolbox copy and direct
gpu-next hardware paths both succeeded. Runtime reconfiguration and live
starvation require additional private-contract work and were not implemented.
```
