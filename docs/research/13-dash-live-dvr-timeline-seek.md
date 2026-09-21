# C10 DASH live DVR presentation timeline and seekbar

Research/implementation snapshot: 2026-09-21 (Asia/Singapore)

## Result and scope

C10 adds a Rust-owned presentation-timeline view, manifest-backed DVR range calculation, normal-player progress mapping, a native DASH seek coordinator, and the `RDPKT006` seek-epoch handshake with the pinned mpv demux adapter. The deterministic 12-hour model, sliding-window behavior, UI mapping, v6 adapter build, real mpv seek/flush path, C0-C9 regressions, and pinned mpv suite pass.

The result is **PARTIAL**, not YES. The authorized approximately-12-hour stream and its credentials were not available to this process, so the requested normal-UI acceptance matrix and a same-snapshot numeric Shaka comparison were not run. In addition, C0 lookup remains compact and logarithmic, but C6's existing runtime `SegmentIndex::merge` still materializes one lightweight descriptor per advertised segment. A 12-hour/6-second fixture is practical (7,200 complete references), but that runtime layer is not yet O(runs) and therefore does not fully satisfy the strongest large-window compactness requirement.

No Widevine, PlayReady, CBCS expansion, ABR redesign, C0 rewrite, URL-restart seek, player recreation, or multi-Period work was added.

## PresentationTimelineState

`native_dash.rs` now owns exact internal state:

```text
PresentationTimeline {
    seek_range_start: ExactTime,
    seek_range_end: ExactTime,
    current_time: ExactTime,
    live_edge: ExactTime,
    origin: ExactTime,
    is_live: bool,
    generation: u64,
}
```

Only `PresentationTimelineState` crosses the player/UI boundary as seconds:

```text
seekRangeStart, seekRangeEnd, currentTime, liveEdge,
isLive, isAtLiveEdge, windowDuration, generation
```

The mpv status monitor samples relative `time-pos` every 250 ms and maps it through the immutable session origin. It emits the compact `native-dash-timeline` event. No MPD, SegmentTimeline, or segment list is sent to React.

The immutable mpv origin is the initial seek-range start, not the startup live segment. This keeps every initial 12-hour DVR target non-negative on mpv's relative player timeline while Rust and the UI retain absolute presentation times.

The time concepts stay separate:

- Segment availability window: the advertised complete references still present in the current snapshot, optionally constrained by `timeShiftBufferDepth`.
- Seekable range: the intersection of actual selected video and audio complete-media bounds, after the TSBD lower bound.
- Buffered range: mpv's `demuxer-cache-duration`; it remains an ABR input and is not the DVR slider range.
- Current presentation position: session origin plus mpv's relative playback clock.
- Live edge: the end of the newest complete media-backed selected A/V interval.

## Seekable-range derivation

The parser now preserves `availabilityStartTime`, `timeShiftBufferDepth`, and `suggestedPresentationDelay`. Period start, SegmentTemplate timescale/PTO, and SegmentTimeline remain handled by C0 exact arithmetic.

For each selected A/V Representation, C10 obtains first and last complete references from `CompactTimeline`. Dynamic input excludes the newest advertised reference under the pre-existing completion policy. It then computes:

```text
media_start = max(video_complete_start, audio_complete_start)
media_end   = min(video_complete_end,   audio_complete_end)

tsbd_start  = media_end - timeShiftBufferDepth   (when present)

seek_range_start = max(media_start, tsbd_start)
seek_range_end   = media_end
```

This never exposes wall-clock time for which indexed A/V media is absent. `availabilityStartTime` is retained for future wall-clock labels, but C10 does not substitute `now - TSBD` for indexed media. `availabilityTimeOffset` remains outside the already-supported manifest subset.

## Live edge and presentation delay

C10 deliberately defines:

```text
live_edge == seek_range_end
```

It is the end of the newest complete selected A/V media, not an optimistic wall-clock point. `suggestedPresentationDelay` is parsed, retained, and logged, but no additional delay is subtracted from the media-backed edge. This matches the phase's preference for a safe complete-segment edge and avoids introducing a partial low-latency DASH policy.

## Progress-bar mapping and live follow

The existing normal timeshift UI now accepts native DASH state even when mpv packet-cache timeshift is disabled. `dvrProgressPercent` implements:

```text
(currentTime - seekRangeStart) / (seekRangeEnd - seekRangeStart)
```

with clamping to 0-100%. Both player layouts and the mini-player use the same presentation window. Nonzero absolute presentation timestamps are preserved; the UI does not assume a zero start.

The Rust status monitor makes the two sources mutually exclusive: it continues to sample mpv cache duration for ABR, but it does not emit the zero-based `timeshift-update` cache range while a native DASH presentation timeline exists. This prevents the progress bar from alternating between DVR and packet-cache timelines.

The monitor also distinguishes a missing mpv `time-pos` from a real zero timestamp. It retains the last clock through cache/decoder reconfiguration and rejects unsolicited presentation-clock jumps larger than 30 seconds; native seeks remain valid because the seek coordinator first moves the authoritative current time to the requested target. The frontend uses the interacted progress element rather than a shared ref across its alternate layouts, and suppresses the synthetic click following drag completion, so one drag produces one seek epoch.

The current presentation position is not rewritten on refresh. If the window slides while the user remains behind live, only the normalized thumb position changes naturally. `isAtLiveEdge` uses a three-second tolerance. A session already scheduling at its frontier continues to follow new complete segments. A backward seek moves the scheduler frontier to the requested historical segment and refresh continues without snapping it forward.

The existing Go Live controls seek to the current safe edge (or their configured small live offset) through the same native seek command. They do not reload the URL or player.

## Integrated seek state machine

`mpv_seek` first asks the active native DASH session to prepare the presentation target. Non-DASH playback retains the old direct mpv behavior.

```text
UI target presentation time
  -> validate finite value
  -> clamp to current exact seek range
  -> coalesce queued seek commands (newest epoch wins)
  -> cancel an in-progress segment batch
  -> locate video/audio/subtitle references
  -> clear old fetched/demuxed/cue epoch state
  -> fetch + MOV-demux + ClearKey-transform the target batch
  -> write SEK1(epoch, relative target) + target packets
  -> invoke mpv seek on the same player instance
  -> demux interrupt clears stale queued packets
  -> v6 adapter waits for the prepared epoch
  -> mpv flushes demux/decoder/subtitle playback state
  -> adapter releases only target-epoch packets
  -> mpv high-resolution discard presents the requested time
```

Targets before the window clamp to `seek_range_start`; targets after it clamp to the media-backed live edge. Rapid queued seeks are drained and superseded completions receive an explicit error; only the newest command is prepared at each cancellation point.

## Video, audio, and subtitle mapping

Video uses `CompactTimeline::find/get`, so target-to-reference lookup is O(log runs). The selected target fragment must begin with a video key packet; otherwise the existing random-access validation rejects it. The log records Representation, segment number, exact segment start, and the segment-start RAP policy. mpv starts at that fragment and performs high-resolution discard to the requested target.

Audio is independently mapped with its own CompactTimeline at the same presentation target. It is not assumed to start at the video segment number or media timestamp.

The selected subtitle Representation is independently mapped as well. A seek clears the per-session logical-cue set, schedules the segment covering the target, and runs the existing TTML/IMSC bridge again. mpv's normal seek flush plus the v6 queue epoch prevents old ASS or bitmap packets from entering after the seek. Cues active at the target are recoverable from the covering subtitle document, subject to the existing TTML fixture/profile limits.

## RDPKT006 and mpv integration

`RDPKT006` keeps the v5 stable tracks and runtime codec generations, and adds:

```text
SEK1
u64 epoch
i64 target milliseconds on the relative player timeline
```

The producer thread clears its bounded FIFO when it reads `SEK1`, holds new packets behind `seek_ready`, and wakes the demux thread. mpv's existing queued-seek interrupt clears old packets. The low-level seek callback waits until the matching prepared epoch exists, then releases it. The same `sh_stream` objects, logical track IDs, player, render surface, audio output, subtitle selection, and decoder graph remain in use.

The native DASH load applies the file-local option `demuxer-seekable-cache=no`. Forward packet caching stays enabled for playback and ABR feedback, but mpv may not satisfy a DVR seek from its small packet cache and bypass the RDPKT006 low-level seek callback.

The deterministic `dvr_seek_test.py` runs this through the actual pinned mpv binary with `--start=2`. It observed `rustdash-live-v6`, epoch-ready, and seek-committed diagnostics without a reload.

## Refresh, expiry, tracks, and ABR

Manifest refresh continues at MUP while time-shifted. Refresh updates the exact seek bounds but does not change `current_time` or scheduler frontier. C6 identity/merge semantics remain authoritative; SegmentTimeline positions are not renumbered when the window slides.

If a paused position expires, resume compares exact current time to the new start. It prepares a seek to the new start before unpausing and logs a concise expiry diagnostic.

Video quality mode, committed Representation, logical audio AdaptationSet, and subtitle AdaptationSet live outside the seek command and are preserved. A seek clears a pending batch/switch opportunity through the shared generation/cancellation path, but does not reset those selections.

ABR retains its EWMA estimate, drops recent-sample confidence to at most one sample, clears consecutive failures, and clears switch cooldown. Old in-flight batches are cancelled by the seek token; new segment measurements rebuild confidence. Manual mode remains manual and Auto remains Auto.

## Shaka comparison

The semantics follow the Shaka model researched in report 02: presentation time is distinct from media time, the seek range is derived from available indexed media, TSBD constrains the start, and refresh moves the range without moving a time-shifted playhead.

No credentialed same-MPD Shaka run was available. Therefore no numeric `seekRange.start/end` table is claimed. One intentional policy difference from common Shaka configurations is documented rather than hidden: C10 uses the complete-segment media edge directly, whereas Shaka may subtract its configured presentation delay from the availability end.

## Deterministic tests

`c10-12h-dvr.mpd` describes one compact six-second TimelineRun with 7,201 advertised references; the newest is excluded, leaving exactly 7,200 complete references and 43,200 seconds. Its absolute presentation timestamps begin at 1,360,000 seconds.

The Rust test verifies the exact window and reference selection at live, -30 seconds, -10 minutes, -1 hour, -6 hours, and near -12 hours. The C0 index remains one run. A separate generation test moves start/end by 60 seconds and verifies that an eight-hour current presentation position is unchanged.

The UI test verifies a nonzero absolute range, a sliding window with stable current time, and out-of-window clamping. The adapter test verifies the real mpv epoch handshake. Existing C2/C3 cancellation, queue bounds, generation, C4 ClearKey, C6 starvation, and C8 track-switch tests remain green.

## Files changed

- `packages/app/src-tauri/src/native_dash.rs`
- `packages/app/src-tauri/src/dash_abr.rs`
- `packages/app/src-tauri/src/mpv_core.rs`
- `packages/app/src-tauri/src/lib.rs`
- `packages/ui/src/hooks/useTimeshift.ts`
- `packages/ui/src/hooks/__tests__/useTimeshift.test.ts`
- `packages/ui/src/components/NowPlayingBar.tsx`
- `packages/ui/src/components/ChannelPanel.tsx`
- `experiments/mpv-packet-demux-adapter/rustdash_packet_abi.h`
- `experiments/mpv-packet-demux-adapter/mpv-patch/demux_rustdash.c`
- `experiments/mpv-packet-demux-adapter/dvr_seek_test.py`
- `experiments/mpv-packet-demux-adapter/fixtures/c10-12h-dvr.mpd`
- `scripts/dev-native-dash.mjs`
- `docs/research/13-dash-live-dvr-timeline-seek.md`

## Exact tests run

```text
cd packages/app/src-tauri
cargo test --lib twelve_hour_dvr -- --nocapture
cargo test --lib sliding_dvr_window -- --nocapture
cargo test --lib parses_real_world_iso_8601_dash_durations_exactly -- --nocapture
cargo test --lib native_dash::tests --no-fail-fast
cargo test --lib

pnpm --filter @ynotv/ui test -- --run src/hooks/__tests__/useTimeshift.test.ts
pnpm --filter @ynotv/ui test
pnpm --filter @ynotv/ui exec tsc --noEmit
pnpm --filter @ynotv/local-adapter test
pnpm --filter @ynotv/local-adapter typecheck

experiments/mpv-packet-demux-adapter/apply-to-mpv.sh /tmp/ynotv-c10-mpv.tpMSlv
meson setup build-c10 ...
meson compile -C build-c10
python3 dvr_seek_test.py /tmp/ynotv-c10-mpv.tpMSlv/build-c10/mpv
./run-tests.sh /tmp/ynotv-c10-mpv.tpMSlv/build-c10/mpv ...
./run-live-generation-tests.sh /tmp/ynotv-c10-mpv.tpMSlv/build-c10/mpv ... /tmp/ynotv-c10-mpv.tpMSlv
python3 live_stream_test.py /tmp/ynotv-c10-mpv.tpMSlv/build-c10/mpv
./run-track-switch-tests.sh /tmp/ynotv-c10-mpv.tpMSlv/build-c10/mpv ...
meson test -C build-c10 --print-errorlogs

git diff --check
```

Observed completed results: full Rust 124/124; deterministic DVR tests PASS; exact ISO-8601 DASH durations including `PT12H` PASS; UI progress tests 3/3; UI full suite 589/589 and TypeScript PASS; local-adapter 39/39 and typecheck PASS; v6 real mpv seek handshake PASS; C2 PASS; C3 PASS; C4 local/playback PASS; C6 live starvation PASS; C8 video/audio switch PASS; pinned mpv 39/39. Pre-existing Rust warnings remain.

## Real 12-hour UI acceptance

Not run. The process had no authorized real MPD/KID/key values, and inventing or persisting credentials would be inappropriate. Consequently these items remain unaccepted in a real UI session: repeated hour-scale seeks, multi-refresh playback while hours behind live, Go Live, post-seek quality/Auto/audio/subtitle switching, pause-expiry recovery, stop/reopen, and numeric Shaka comparison.

## Known limitations

- Real approximately-12-hour normal-UI acceptance is missing.
- Same-snapshot Shaka numeric comparison is missing.
- C6's runtime `SegmentIndex` still materializes descriptors per advertised segment during merge even though C0 lookup and the new direct seek lookup are compact/O(log runs).
- The native parser remains one-Period and SegmentTemplate/SegmentTimeline limited.
- `availabilityTimeOffset` is not newly implemented; this is not low-latency DASH.
- `suggestedPresentationDelay` is retained/logged but not subtracted from the complete-media live edge.
- Wall-clock progress labels are not shown, although `availabilityStartTime` is retained.
- The new seek test proves the mpv epoch/flush handshake with deterministic A/V, not a full encrypted A/V/TTML seek storm through the normal Tauri UI.

Can a UI-selected dynamic DASH stream expose its full live DVR window in
the normal progress bar and seek repeatedly to arbitrary available
presentation times, including hours behind live, while preserving
continuous video/audio/subtitle playback and MPD refresh?

PARTIAL

Evidence:
The Rust presentation timeline, media-backed 12-hour range, nonzero-start UI mapping, exact video/audio/subtitle target selection, seek-epoch cancellation, same-instance mpv flush/seek handshake, sliding refresh semantics, pause-expiry clamp, track preservation, and conservative ABR reset are implemented and pass deterministic and regression tests. The pinned mpv adapter committed an RDPKT006 seek epoch without reloading. However, the authorized real 12-hour stream was unavailable, so repeated hour-scale normal-UI acceptance and numeric Shaka comparison were not performed; the inherited per-segment C6 runtime merge also remains less compact than the C0 run index.
