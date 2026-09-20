# mpv bounded-live and codec-generation contract

Research/experiment snapshot: 2026-09-20 (Asia/Singapore)

## Scope and result

This phase answers only the two packet-boundary questions left by C2:

1. can a custom mpv demuxer consume a delayed, bounded packet producer without
   spinning or turning temporary starvation into EOF; and
2. can one logical H.264 track move from configuration A (320x180) to
   configuration B (640x360) through mpv's internal segmented-packet path?

Both answers are positive in the pinned experimental build. Delayed playback,
seek interruption, stop (including with a non-empty adapter FIFO), quit,
session destruction, disabled-audio filtering, software decode,
VideoToolbox-copy, and direct VideoToolbox completed without a deadlock, retry
burst, or new user-visible track.

This remains an isolated experiment under
`experiments/mpv-packet-demux-adapter/`. It adds no MPD parsing, DASH
networking, DRM, ClearKey, ynoTV playback integration, subtitles, ABR, live MPD,
multiple Periods, or production networking.

## Exact revision and environment

The mpv source remains the ynoTV-pinned revision:

```text
cfd818bcaef262f82596f49444ee80073fa6d49a
describe: v0.41.0-604-gcfd818bcae
patched binary: mpv v0.41.0-604-gcfd818bca-dirty
```

Tests ran on macOS 26.6.2 (25G83), arm64, Apple M4, with Apple clang 21.0.0,
Meson 1.7.0, Ninja 1.12.1, FFmpeg 8.0, and libplacebo 7.360.1. The fixtures are
the synthetic H.264/AAC media from C1.

## Experimental artifacts

The C2 directory was extended with:

| File | Purpose |
|---|---|
| `generation_producer.c` | serializes two H.264 codec generations on one stable video track |
| `live_control_test.py` | issues seek/stop/quit, stops with a non-empty FIFO, and induces a producer read failure |
| `session_destroy.c` | calls `mpv_terminate_destroy()` while the consumer is blocked |
| `run-live-generation-tests.sh` | reproduces delayed-live, cancellation, generation, and output-failure tests |
| `verify_live_generation.py` | asserts the recorded outcomes |

The existing `packet_producer` still supplies a deterministic local fixture,
but packet payloads are no longer read synchronously by `read_packet()` or
retained wholesale. A dedicated producer thread reads them into the bounded
queue. The file is test input, not the proposed production producer API.

## Producer/consumer queue model

### States and flow

At demux open the adapter reads configurations and a compact packet metadata
index. It does not preload packet payloads. After open:

```text
fixture payload source
        |
        | producer thread: seek/read one payload
        v
bounded FIFO (8 packets and 128 KiB)
        |
        | mpv demux thread: blocking dequeue
        v
ordinary mpv demux_packet queues and decoders
```

The producer groups the synthetic C2 stream at video random-access packets.
With `RUSTDASH_DELAY_MS=1500`, the tested sequence was:

```text
release packet group 0
wait 1500 ms
release packet group 1
wait 1500 ms
release packet group 2
drain queue
final EOF
```

The log recorded exactly two `producer waiting` / `producer released` pairs,
then final EOF and successful playback. Total wall time was six seconds for
the approximately three-second fixture, showing that packet availability was
actually delayed rather than preloaded behind the test.

### Blocking and wakeup behavior

One mutex protects queue slots, byte/count totals, producer cursor, epoch,
interruption, terminal state, and shutdown state. Both directions use one
condition variable:

- the consumer waits while the FIFO is empty and the producer is neither done,
  failed, interrupted, nor stopping;
- the producer waits while either capacity limit would be exceeded;
- enqueue wakes the consumer;
- dequeue wakes the producer;
- delay expiry, seek interruption, and cancellation broadcast to all waiters.

All condition waits recheck their predicate in a loop. There is no timed poll
in the dequeue path and no `read_packet() == true, packet == NULL` retry loop
during ordinary starvation or track filtering. Unselected packets are consumed
inside the same `read_packet()` call until a selected packet, a real wait, seek
interruption, cancellation, fatal failure, or final EOF is reached. Empty
successful returns are reserved for seek interruption and cancellation.

Temporary starvation therefore remains a blocking state. Only a drained queue
plus `producer_done` takes the normal final-EOF path. Producer failure takes a
separate terminal branch and emits an explicit fatal diagnostic; the private
boolean callback limitation is described below.

### Maximum queue size

The adapter's hard limits are:

```text
maximum ready payloads: 8 packets
maximum ready payload bytes: 131072 bytes (128 KiB)
maximum accepted single payload: 131072 bytes
```

Both predicates must permit an enqueue. The producer owns at most one
additional in-flight payload while reading outside the mutex, so adapter-owned
payload memory is bounded by 128 KiB plus one accepted packet. The recorded
delayed A/V run peaked at eight queued packets and 20,264 queued payload bytes.
The generation runs peaked at eight packets and 48,208 bytes.

mpv's downstream packet queues remain independently governed by
`demuxer-max-bytes` and its whole-packet overshoot rule established in C2. The
C2 constrained regression still passed.

The metadata index remains O(total fixture packet count). That is acceptable
for this deterministic experiment but is not a production live index; a real
producer must replace it with a bounded seek map/window.

## Ownership rules

The exact payload ownership transfer is:

1. The producer owns its `FILE *` and an allocated ready payload while reading.
2. After enqueue, the FIFO exclusively owns that payload.
3. On dequeue, the demux thread exclusively owns the ready item.
4. The demux thread allocates an ordinary mpv `demux_packet`, copies the bytes,
   and frees the ready item.
5. After `*out` is assigned, mpv's packet pool/queues own the `demux_packet`.
6. Seek or shutdown frees every ready item still in the adapter FIFO. An
   in-flight producer read carries an epoch; if its epoch became stale, the
   producer frees it instead of enqueueing it.

The queue never borrows caller payload memory and mpv never owns a pointer into
the producer FIFO.

## Cancellation and shutdown contract

### Stop, quit, and playback-session destruction

The adapter registers a callback on `demuxer->cancel`, mpv's existing playback
cancellation object. Stop, quit, or `mpv_terminate_destroy()` triggers it. The
callback sets `stopping`, broadcasts the queue condition, and does no mpv core
call while the cancellation lock may be held.

`read_packet()` checks `stopping` before inspecting or dequeuing the FIFO, so
already queued producer packets cannot outrun cancellation. The regression
waited for the producer to block on a full eight-packet FIFO, issued `stop`, and
recorded `queued_at_cancel=8`; shutdown delivered none of those queued packets.

The blocked consumer returns immediately. During demux close the adapter:

1. removes the cancellation callback;
2. sets `stopping` again and broadcasts defensively;
3. joins the producer thread;
4. frees queued ready payloads;
5. closes the producer fixture; and
6. destroys the condition variable and mutex.

The producer owns no state outside the demuxer's lifetime. Codec-generation
objects are deliberately not freed in the close callback; they remain talloc
children of the demuxer until mpv has flushed its packet queues and destroys
the demuxer root.

Observed results while the producer was in a 10-second delay:

| Action | Result |
|---|---|
| `stop` | bounded producer shutdown completed; idle mpv remained responsive and accepted `quit` |
| `quit` | process exited normally after bounded producer shutdown |
| `mpv_terminate_destroy()` | returned in 0.106858 seconds |

No test waited for the artificial 10-second delay to expire.

### Seek while blocked

mpv normally queues a seek behind an active `read_packet()` call. Since that
call is intentionally blocked, the experiment adds one private demux-core
hook: optional `demuxer_desc.interrupt`. `demux_seek()` invokes it only when a
low-level seek was queued.

The adapter's interrupt callback, called while mpv's demux lock is held, only
locks the separate producer mutex, marks the current epoch interrupted, clears
the ready FIFO, increments the epoch, and broadcasts. It never calls back into
mpv. The blocked `read_packet()` wakes and returns `true` with no packet, which
means “not EOF.” mpv reacquires its demux lock and executes the already-queued
seek callback.

The low-level seek then:

- chooses the latest video keyframe at or before the target;
- clears any newly queued old-epoch packets;
- resets the producer cursor and group to that packet;
- clears terminal/interrupted state;
- increments the epoch again; and
- broadcasts to restart producer and consumer.

Any file read that was already in flight sees an old epoch and discards its
payload. The tested seek from the group-1 wait to zero logged:

```text
producer wait interrupted for queued seek epoch=1
experimental seek target=0.000 keyframe=0.000 packet=0 epoch=2
producer waiting group=1 delay_ms=10000 epoch=2
```

This proves that the seek ran while the dequeue was blocked and that production
resumed from the new epoch. The test used `--demuxer-seekable-cache=no` so it
necessarily exercised the low-level callback. An in-cache seek does not invoke
the new interrupt hook because it does not require the blocked low-level reader
to change position.

## Codec/config generation fixture

`generation_producer` creates `RDPKT002` with one stable logical video track
and two complete codec configurations:

| Generation | Codec | Coded size | Packets |
|---|---|---:|---:|
| A / 1 | H.264 High | 320x180 | 75 |
| B / 2 | H.264 High | 640x360 | 75 |

The producer rejects the fixture if the two extradata blobs are equal. B starts
at its own independent/keyframe boundary. Its DTS/PTS are shifted by 38,400
ticks at time base 1/12800 so decode time continues from A instead of resetting.
The generated fixture SHA-256 was:

```text
04c2e711bd12a806eb6180df57e45824c41ec1b678ca635524f2f54a02f6d0cd
```

## Codec-generation lifetime ownership

The initial `sh_stream` owns generation A's `mp_codec_params`. Generation B's
`mp_codec_params`, codec string, and extradata are separate talloc children of
the demuxer. The user-visible `sh_stream` is never replaced or republished.

Every generation-fixture packet is marked:

```text
demux_packet.segmented = true
demux_packet.codec = generation-specific mp_codec_params pointer
demux_packet.start = MP_NOPTS_VALUE
demux_packet.end = MP_NOPTS_VALUE
```

`demux_packet.codec` is explicitly non-refcounted in mpv. Consequently the
contract is conservative: every codec generation stays immutable and alive for
the entire demuxer lifetime, including while packets may exist in adapter,
mpv cache, decoder-wrapper, or output queues. Runtime eviction of generation
objects is not permitted by this prototype.

## Segmented-packet behavior

On the first B packet, mpv's unchanged decoder wrapper observes that the
segmented packet's codec pointer differs from the active pointer. It feeds EOF
to drain A, resets the decoder, swaps to B's codec parameters, calls the normal
decoder reinitialization path, and then feeds the saved B packet. No player
reload and no second `sh_stream` is involved.

In each decode mode the log contained exactly two `Selected decoder: h264`
events, first a 320x180 decoder format and then a 640x360 decoder format. The
initial term message reported `TRACKS=1`, and normal EOF followed after both
generations. There was no full player reload in any transition test.

## Software decoder transition result

Software decode succeeded:

```text
Using software decoding.
Decoder format: 320x180 yuv420p
TRACKS=1 ... HWDEC=no
Selected decoder: h264                 # second open at B
Using software decoding.
Decoder format: 640x360 yuv420p
finished playback, success
```

mpv reconfigured the null video output to 640x360 and drained all input to
normal EOF. This is a successful ordinary decoder reinitialization on one
logical track.

## Hardware decoder transition result

VideoToolbox-copy also succeeded. It opened VideoToolbox independently for both
generations and changed from `320x180 nv12` to `640x360 nv12`; the null video
output reconfigured and playback ended successfully.

Direct VideoToolbox was practical and succeeded with `vo=gpu-next` and Vulkan:

```text
Using hardware decoding (videotoolbox).
VO: [gpu-next] 320x180 videotoolbox[nv12]
TRACKS=1 ... HWDEC=videotoolbox VO=gpu-next
Selected decoder: h264                 # second open at B
Using hardware decoding (videotoolbox).
VO: [gpu-next] 640x360 videotoolbox[nv12]
finished playback, success
```

Only VideoToolbox on this Apple M4 was tested. D3D11VA, VA-API, and other
hardware backends remain unknown.

## mpv private APIs touched

The experiment continues to depend on the C2 private surfaces and adds the
items marked “new”:

| Private surface | Use |
|---|---|
| `demuxer_desc` callbacks | `open`, blocking `read_packet`, `close`, `seek` |
| `demuxer_desc.interrupt` (new experimental field) | wake a blocked read after a low-level seek is queued |
| `demux_seek()` / `demux_internal.seeking` (new two-line call site) | invoke the interrupt only for a queued low-level seek |
| `demuxer->cancel` and `mp_cancel_set_cb()` (new use) | stop/quit/destroy wakeup |
| mpv `mp_thread`, `mp_mutex`, `mp_cond` wrappers (new use) | producer and bounded FIFO synchronization |
| `demux_packet.segmented` / `.codec` (new use) | identify immutable codec generation per packet |
| `mp_codec_params` (expanded use) | own generation-specific codec, extradata, and dimensions |
| `demux_alloc_sh_stream()` / `demux_add_sh_stream()` | publish the one stable logical track (or C2 A/V tracks) |
| `new_demux_packet()` / packet pool | transfer payloads into ordinary mpv ownership |
| `demux_stream_is_selected()` | avoid delivery to a disabled stable track |
| `demuxer_list[]` and Meson source list | register/build the experiment |

The normal decoder-wrapper segmented path was exercised but not modified.

## Patch-size change from C2

C2 changed four mpv files with **335 insertions, zero deletions**:

```text
demux_rustdash.c 303
rdp_endian.h      29
demux.c            2
meson.build        1
```

This phase's complete mpv patch changes five files with **692 insertions, zero
deletions** relative to unmodified pinned mpv:

```text
demux_rustdash.c 654
rdp_endian.h      29
demux.c            5
demux.h            3
meson.build        1
```

The change from C2 is therefore **+357 inserted lines and +1 mpv file**. No
decoder, video output, player reload path, public client API, or ynoTV file was
modified. Producer/test harness code is excluded from the mpv patch count.

## Tests run

The final C2 regression suite was rerun against the new adapter:

```sh
./run-tests.sh \
  /tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv \
  /tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib
```

Result:

```text
PASS: producer, software decode, decoded output, seek, hwdec, A/V sync, EOF, and bounded queue
```

The new suite was:

```sh
./run-live-generation-tests.sh \
  /tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv \
  /tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib \
  /tmp/ynotv-mpv-adapter.d2hA1O/mpv
```

Its verifier result after the final output-failure check was:

```text
PASS: bounded live waits/cancellation, packet filtering/failure, and software/VideoToolbox generation transition
```

That suite covers delayed groups A/B/final, normal EOF, FIFO bounds, seek while
blocked, stop while blocked, stop with a non-empty FIFO, quit while blocked,
`mpv_terminate_destroy()` while blocked, disabled-audio filtering without empty
retry returns, explicit producer-failure diagnostics, software generation
change, VideoToolbox-copy generation change, direct VideoToolbox generation
change, stable track count, and the lavc output limitation below.

The pinned mpv regression suite was rerun after the final patch:

```text
39 passed, 0 failed, 0 skipped
```

`git diff --check` passed, and the registration/interrupt patch applied cleanly
to a fresh detached worktree at the pinned commit.

## Failures and unknowns

1. mpv's `vo=lavc` output path cannot reconfigure resolution in one output
   file. The explicit FFV1 encode probe wrote 75 A frames, then failed at B
   with `resolution changes not supported`. This does not hide a playback
   failure: `vo=null`, VideoToolbox-copy, and direct displayed output all
   reconfigured and reached normal EOF. It does mean this output path cannot be
   used as the frame-count oracle for the two-resolution fixture.
2. The producer source is still a deterministic local packet fixture and the
   seek map is a full metadata index. The queue behavior is live and bounded,
   but production networking and a bounded rolling seek window were not built.
3. Generation objects live until demux destruction. A production design that
   evicts old generations needs explicit reference accounting because
   `demux_packet.codec` is not refcounted.
4. The experiment changes a private `demuxer_desc` structure and a seek call
   site. There is no stable external mpv demux plugin ABI, so every mpv upgrade
   must rebase and retest this contract.
5. The seek test forced a low-level seek by disabling mpv's seekable demux
   cache. Cached seeks use existing buffered packets and were not a cancellation
   target in this phase.
6. Producer read errors are terminal and distinct inside the adapter: they log
   `fatal producer error`, never log the normal `experimental producer final
   EOF` marker, and discard queued payloads rather than delivering beyond the
   failure. The pinned private `demuxer_desc.read_packet` API returns only
   boolean success/EOF; its demux core converts every `false` return to stream
   EOF. There is no established runtime fatal-error channel to propagate a
   third state. This is the same limitation used by the pinned lavf demuxer,
   which logs a fatal read error and returns `false`. Consequently the adapter
   cannot make downstream mpv distinguish fatal producer failure from EOF
   without a broader private demux API change. Retry/backoff, reconnect,
   network timeouts, and representation scheduling remain undefined.
7. Only one video track changes generation. Atomic audio+video generation
   changes, timescale changes, codec changes, and discontinuous timestamps are
   untested.
8. Only H.264 software and VideoToolbox were tested. Other codecs and hardware
   backends remain unknown.

```text
Can the custom mpv adapter support a bounded live producer and runtime codec/config generations?

YES

Evidence:
An 8-packet/128-KiB condition-variable FIFO delivered three delayed packet groups without polling or premature EOF, then drained normally. Seek woke the blocked demux read through a narrow private interrupt hook, invalidated old-epoch payloads, and resumed from the selected keyframe; stop, quit, and mpv_terminate_destroy() also woke and joined the producer without deadlock. On one stable user-visible video track, generation-specific segmented packets caused mpv's unchanged decoder wrapper to drain and reinitialize H.264 from 320x180/extradata A to 640x360/extradata B. Software decode, VideoToolbox-copy, and direct VideoToolbox all reconfigured and reached successful EOF without a player reload.
```
