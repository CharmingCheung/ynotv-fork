# C6 dynamic MPD refresh

Research/implementation snapshot: 2026-09-20 (Asia/Singapore)

## Result

C6 is **PARTIAL pending real-stream UI acceptance**. The immutable
manifest-generation model, stable identity merge, compact SegmentTimeline
refresh corpus, application refresh loop, and explicit live `RDPKT003`
transport were implemented. The adapter preserves
the C3 8-packet/128-KiB bounded queue, blocks while the live source has no next
record, resumes when records arrive, and ends only on an explicit EOF record.

The application now gives mpv a session-local loopback HTTP source. It writes
the initial two complete segments, keeps the connection open without EOF,
refreshes the MPD, merges identities, downloads/demuxes only new segment
identities, rebases their packet timestamps to the original presentation epoch,
and appends them to that same player session.

No subtitles, ABR, Widevine, PlayReady, CBCS, multi-Period transition, player
reload workaround, or UI redesign was added.

## Snapshot model

`ManifestSnapshot` records an increasing generation, wall-clock fetch time,
successful-publication instant, parsed `publishTime`, effective
`minimumUpdatePeriod`, dynamic/static type, Period identities, selected
representation identities, inherited templates/base URLs, and one C0
`CompactTimeline` per selected representation. Parsing builds a candidate off
to the side and returns it only after the complete MPD validates.

The selected Period is still deliberately limited to one. Explicit `Period@id`,
`AdaptationSet@id`, and `Representation@id` are preferred. A missing Period ID
falls back to exact Period start; a missing AdaptationSet ID falls back to a
stable kind/content-type/MIME tuple. Representation array position is never an
identity.

## Segment identity and merge

For SegmentTemplate/SegmentTimeline, identity is:

```text
(Period identity, AdaptationSet identity, Representation identity,
 media kind, unscaled media_time)
```

The current `$Number$` is locator metadata, not identity. Consequently a
sliding MPD may change `startNumber` without renumbering an overlapping `$Time$`
segment. The refreshed descriptor replaces URL/number metadata for that stable
identity.

`SegmentIndex::merge` first marks old records unadvertised, merges every new C0
reference by identity, and then marks vanished, not-yet-used records expired.
It reports added, retained, and expired counts. Lifecycle state explicitly
contains `Known`, `Scheduled`, `Fetching`, `Fetched`, `Demuxed`, and `Expired`;
separate fetched/demuxed identity sets prevent an overlapping generation from
becoming schedulable again.

This semantic merge is called by the running playback refresh task.

## Timeline behavior

Every generation constructs a new C0 `CompactTimeline`; C6 does not implement a
second timeline expander. Tests cover append-only growth, positive-repeat
growth, sliding explicit starts, changing `startNumber`, `r=-1` bounded by the
next `S@t`, changed finite Period bounds, nonzero PTO, nonzero Period start, and
the same representation across refresh. A one-million-reference timeline
remains one compact run. The existing C0 rule still rejects a terminal
unbounded `r=-1`; C6 did not weaken or replace that rule.

## minimumUpdatePeriod and publishTime

Both attributes parse into snapshot metadata. A valid positive MUP is clamped
to a 250-ms lower bound to prevent a request storm. Missing or explicit zero
uses an isolated conservative two-second fallback. The intended scheduling
anchor is the successful snapshot publication instant, not parser recursion.

`publishTime` is parsed as RFC 3339 UTC time. The merge tests demonstrate that
an equal generation adds nothing and does not reschedule fetched/demuxed media.
The runtime logs `native DASH refresh produced no newer media`; stale and failed
refreshes keep the connection open and retry instead of producing EOF.

## Dynamic starvation versus final EOF

The mpv experiment adds `RDPKT003`. Its header publishes two initial codec
configurations; packet records may then arrive indefinitely. The adapter's
producer thread blocks in the source read and its consumer continues to use the
C3 condition-variable queue. Temporary lack of bytes does not set
`producer_done`. Only `RDP_RECORD_EOF` produces final EOF. Unexpected transport
closure is producer failure.

`live_stream_test.py` converts the deterministic C2 playable fixture to
`RDPKT003`, sends half its packets, waits one second, sends the remainder, and
finally sends explicit EOF. Patched mpv selected `rustdash-live-v3`, waited,
resumed, and finished successfully without reload.

The Rust UI session now serves this framing over its loopback connection.

## FFmpeg and ClearKey continuity

Each new batch uses cached init bytes plus only newly fetched media. The C4
helper demuxes that batch, packet timestamps are placed on the continuous DASH
epoch, and codec generation remains 1 only when codec configs match exactly.
Packet-KID ClearKey lookup remains authoritative. Key rotation is not claimed.

## Cancellation/session generation

The existing application generation and `CancellationToken` remain active for
manifest fetch, segment fetch, helper wait, stop, replacement load, and app
exit. The `RDPKT003` adapter uses mpv cancellation to wake the bounded consumer
and stop its producer. Each replacement load owns a distinct token and
listener, so an old task cannot write into the new session.

## Deterministic and real acceptance

The requested successive-MPD HTTP fixture (`G1/G2/G3`, including a repeated
stale response) was not completed. The model corpus deterministically verifies
the corresponding merge shapes and duplicate scheduling rule, while the live
adapter test independently verifies starvation/resume/explicit-EOF behavior.
Those two halves have not been joined into one playable local refresh test.

The real test credentials were not present in this process environment, so no
real MPD request or UI run was made. Real generations crossed: **0**. There is
no real-stream duplicate-fetch evidence. Pause/resume, stop, switching, return,
and replay across manifest generations remain unverified.

## Files changed

- `packages/app/src-tauri/src/native_dash.rs`: snapshot/identity/index model,
  MUP/publishTime parsing, refresh loop, live source, packet timestamp
  continuation, lifecycle states, merge and timeline tests.
- `packages/app/src-tauri/src/mpv_core.rs`: accepts the live source URL.
- `scripts/dev-native-dash.mjs` and root `package.json`: `pnpm dev`
  automatically locates and verifies an `RDPKT003` patched UI libmpv, injects
  its link path, and refuses to fall back to an unpatched library.
- `experiments/mpv-packet-demux-adapter/rustdash_packet_abi.h`: `RDPKT003`
  constants.
- `experiments/mpv-packet-demux-adapter/mpv-patch/demux_rustdash.c`: streaming
  bounded producer mode with explicit EOF.
- `experiments/mpv-packet-demux-adapter/live_stream_test.py`: delayed playable
  live-source regression.
- `docs/research/09-dynamic-mpd-refresh.md`: this report.

## Exact tests run

```text
cd packages/app/src-tauri
cargo check --lib
cargo test --lib native_dash::tests -- --nocapture
cargo test --lib dash_timeline::tests
cargo test --lib

cd experiments/mpv-packet-demux-adapter
python3 live_stream_test.py /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv
./run-tests.sh /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv
./run-live-generation-tests.sh /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv '' /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv

cd experiments/clearkey-cenc-packet-transform
./run-local-tests.sh

pnpm --filter @ynotv/ui test -- --run src/services/__tests__/nativeDash.test.ts
pnpm --filter @ynotv/local-adapter test -- --run src/__tests__/m3u-kodiprop.test.ts

cd /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv
PKG_CONFIG_PATH=/private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib/pkgconfig \
DYLD_LIBRARY_PATH=/private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib \
meson test -C build-probe --print-errorlogs
```

Results: native refresh/packet model 9/9, C0 22/22, Rust library 87/87,
frontend routing 6/6, M3U KODIPROP 1/1, C2 playback PASS, C3
live/generation/cancellation PASS, C4 local equivalence/errors PASS,
RDPKT003 delayed starvation PASS, pinned mpv 39/39. The first million-segment
C6 assertion expected one million after PTO clipped twenty leading references;
the fixture was corrected to start at PTO and then passed. One combined cargo
invocation used two test filters and was rejected by cargo; the filters were
run separately and passed.

## Failures and unsupported cases

- No deterministic successive-MPD playable HTTP server.
- No real UI acceptance and no real generation/duplicate-fetch log.
- Terminal unbounded `r=-1`, multi-Period, key rotation/init change, subtitles,
  ABR, Widevine, PlayReady, and CBCS remain unsupported.

Can one UI-selected dynamic ClearKey DASH session continuously play across
multiple MPD generations without player reload, duplicate segment scheduling,
or snapshot-exhaustion EOF?

PARTIAL

Evidence:
Immutable snapshots and stable semantic merge pass focused C0/C6 regression
tests, overlapping fetched segments are not rescheduled, and ynoTV now supplies
the bounded RDPKT003 source that waits through temporary starvation and resumes
without reload. The authorized real stream was unavailable in this process, so
the required multi-generation UI acceptance and generation count remain open.
