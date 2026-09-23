# C9 DASH ABR Auto quality selection

Research/implementation snapshot: 2026-09-21 (Asia/Singapore)

## Result and scope

C9 adds an explicit video-only ABR controller, real video media-segment HTTP
measurements, mpv buffer feedback, Auto/manual quality state, conservative
selection policy, session diagnostics, and Auto entries in both existing
quality menus. It does not replace the C8 Representation switch state machine.
Every automatic proposal enters the same C8 watch generation, target
preparation, aligned frontier, cancellation, `RDPKT005` codec generation, and
commit path used by manual selection.

This corrective pass isolates the two gates that prevented top-quality
selection: the bandwidth policy required 1.60 times the advertised target
bitrate after combining two margins, and the buffer policy separately required
12 seconds from a deliberately bounded pipeline. The correction changes only
C9 policy, diagnostics, and tests; the proven C8 switch executor is unchanged.

Pure policy, HTTP measurement, parser/refresh, UI, packet adapter, ClearKey,
subtitle, manual video/audio switch, and pinned-mpv regressions pass. A full
local throttled DASH-to-mpv run and the requested real-stream UI interaction
matrix were not completed. The result remains **PARTIAL**; that original
missing evidence is not hidden.

No Widevine, PlayReady, CBCS expansion, audio ABR, multi-CDN selection,
speculative prefetch, predictive/ML policy, DASH parser replacement, or player
UI redesign was added.

## Architecture and the C8 boundary

`dash_abr.rs` is a pure policy module. Its inputs are stable Representation
IDs, MPD bandwidths, completed download measurements, buffer seconds, current
and pending target state, monotonic time, and quality mode. Its output is
`Hold(reason)` or `Switch { target_id, reason, emergency }`.

It cannot fetch media, create FFmpeg contexts, decrypt packets, write the live
transport, mutate mpv streams, or touch packet queues. The runtime handles an
ABR `Switch` by calling the shared `switch_video_representation(...)` request
function. Manual selection calls the same function. That function advances the
existing C8 watch generation; `serve_live` still performs target preparation,
supersession, exact boundary lookup, random-access validation, codec-generation
registration, wire commit, and stable-state transition.

This follows Shaka's architectural split—ABR proposes and the streaming engine
executes—but not Shaka's implementation. The C9 policy does not use viewport,
dropped frames, device restrictions, CMSD, multiple estimators, or Shaka's
variant/audio coupling.

## Auto and manual mode

Quality ownership is explicit:

```text
VideoQualityMode::Auto
VideoQualityMode::Manual(RepresentationId)
```

The default for a new native DASH session is Auto. Selecting a concrete menu
entry writes `Manual(id)` and advances the C8 switch generation immediately.
That both disables ABR decisions and cancels/supersedes an in-flight ABR target.
The controller may continue collecting measurements in Manual mode, but it
always returns `Hold("manual_mode")`; it never silently lowers a manual choice.

Selecting Auto also advances the generation, superseding any pending manual
target without reloading playback. Auto resumes from the actually committed
Representation. The catalog reports the explicit mode, current committed ID,
optional pending ID, and ABR statistics. The two existing quality surfaces show
`Auto` plus all manual qualities; the Auto row also shows the current quality
label.

## Media download measurement

Only video media-segment responses feed the estimator. MPD, init, audio, and
subtitle requests do not. Each successful sample records:

- stable Representation ID;
- downloaded byte count;
- monotonic request start;
- monotonic first non-empty body chunk time;
- monotonic final-byte time;
- request-start-to-final-byte duration;
- calculated bits per second.

The calculation is:

```text
throughput_bps = complete_response_bytes * 8 / (request_end - request_start)
```

The duration deliberately **includes TTFB**. This is conservative and
consistent. It excludes temporary-file writing, FFmpeg MOV demux, ClearKey
decryption, TTML conversion, and packet production. Memory copies required to
receive the response body remain part of the network receive operation.
Each real sample log now reports both request-start-to-final-byte throughput
and the comparison value from first-byte-to-final-byte. The estimator continues
to use the former. This makes small-segment TTFB bias visible without pretending
that the Representation bitrate is measured throughput. A deterministic
1,000,000-byte sample with 400 ms TTFB and 600 ms remaining transfer time
confirms that the estimator records 8.0 Mbps for the full one-second request;
the comparison transfer-only value is 13.33 Mbps. Several real-segment values
could not be collected without the authorized stream and are not fabricated.

Cancelled requests, non-success HTTP statuses, read failures, empty responses,
zero-byte samples, and zero/non-finite durations never become normal samples.
The controller retains the most recent 20 valid samples for diagnostics.

The deterministic local HTTP test sends a 2,000-byte response as two body
chunks separated by 40 ms. It verifies final-byte duration, first-byte capture,
byte count, and Representation identity. This proves the real reqwest timing
boundary, but it is not the requested full throttled DASH playback test.

## Estimator and conservative bandwidth

The estimator is an EWMA:

```text
estimate = alpha * latest + (1 - alpha) * previous
```

The first sample seeds the estimate. While fewer than three valid samples are
present, `alpha = 0.65`, making startup responsive. From the fourth sample
onward, `alpha = 0.30`, reducing reaction to individual spikes. Confidence is
explicit: `has_stable_estimate` becomes true at three samples.

Available bandwidth after the corrective pass is:

```text
safe_bandwidth = estimate * 0.80
```

The 0.80 factor is the one conservative bandwidth reserve. The up-switch
margin is now 1.00 and therefore does not apply a second reserve for the same
uncertainty:

```text
required_estimate = target * upswitch_margin / safety_factor
```

| Representation | Old requirement (`1.20 / 0.75`) | Corrected requirement (`1.00 / 0.80`) |
| --- | ---: | ---: |
| 0.5 Mbps | 0.80 Mbps | 0.625 Mbps |
| 1 Mbps | 1.60 Mbps | 1.25 Mbps |
| 2 Mbps | 3.20 Mbps | 2.50 Mbps |
| 4 Mbps | 6.40 Mbps | 5.00 Mbps |
| 8 Mbps | 12.80 Mbps | 10.00 Mbps |

The previous 8 Mbps threshold was the bandwidth root cause: two policies were
covering the same uncertainty. It was not a C8 switching failure. All constants
remain in `AbrPolicy`; none are scattered through the scheduler.

## Buffer source and zones

The existing in-process mpv status monitor polls mpv's
`demuxer-cache-duration` every 250 ms. C9 forwards that value as
`buffered_seconds`. It is mpv demux-cache duration after bytes have crossed the
local packet bridge; it is not bridge socket duration, downloaded segment
duration in the Rust scheduler, a decoder queue, or a video-only queue. An
absent or invalid property is treated conservatively and prohibits an
up-switch.

Corrected policy thresholds are:

```text
Critical: buffered_seconds < 1
Low:      1 <= buffered_seconds < 2
Normal:   buffered_seconds >= 2
```

Critical selects the lowest compatible rung immediately and may bypass
cooldown. Low permits a bandwidth-driven down-switch and prohibits an
up-switch. Normal permits the bandwidth policy to raise quality. There is no
second "strong healthy" threshold and no requirement for positive surplus
beyond leaving the pressure zones.

The original run did not play the authorized real stream, so it produced no
defensible observed steady-state range; that missing evidence remains explicit.
The controller now records the minimum and maximum mpv-reported buffer values
for the session and every decision log includes the current value and zone.
The deterministic bounded-pipeline case uses 2.5 seconds—not the old 12
seconds—and proves that this normal level no longer makes the top rung
unreachable.

## Startup, choice, hysteresis, and cooldown

Unknown bandwidth is never infinite. Auto startup chooses the lower-middle
rung of the lowest-bandwidth Representation's codec family, after applying C8
alignment compatibility. For five rungs it chooses index two; for an even
ladder it chooses the lower of the two middle rungs. A focused five-rung test
starts on `v3`. One- and two-rung ladders remain conservative.

After confidence exists, the bandwidth candidate is the highest compatible
Representation whose MPD `bandwidth` is at most safe bandwidth. If none fits,
the lowest compatible Representation wins. Width and height are display data,
not policy inputs.

Down-switches use that fitting rung immediately when safe bandwidth falls
below the current rung. Up-switches are deliberately asymmetric:

- buffer must be outside the critical/low pressure zones (at least 2 seconds);
- at least two consecutive raw samples, after the 0.80 safety factor, must
  support the target;
- the EWMA must have at least three samples of estimator confidence;
- safe bandwidth must be at least `target bandwidth * 1.00`;
- only one ladder rung may be raised per decision;
- the eight-second cooldown must have elapsed.

All non-critical switches respect the eight-second cooldown, including failure
recovery. A critical-buffer down-switch alone bypasses it. A pending identical
target returns `Hold("target_already_pending")`.

## Failures

A failed video request increments a separate consecutive-failure counter and
does not enter EWMA history. In Auto, the scheduler retains the same exact C8
frontier for one conservative retry. At two consecutive failures the ABR policy
proposes one lower compatible rung, subject to non-emergency cooldown. It never
retries an incompatible target. If the lowest rung still fails, the existing
session error path is used. Manual mode performs no hidden downgrade and keeps
the pre-existing error behavior.

This is deliberately not a new general retry/backoff subsystem.

## Compatibility and dynamic MPD refresh

The candidate ladder is rebuilt from the current `ManifestSnapshot` for every
decision. It includes only Representations accepted by C8's codec-family and
exact presentation-interval alignment checks. The first implementation stays
within the active codec family; H.264-to-HEVC/AV1 transitions remain excluded.

ABR stores only stable IDs and bandwidth values, never references into a
manifest generation. Refresh reparses and merges the complete current catalog.
If the selected Representation disappears, C8's deterministic compatible
fallback remains immediate. Auto remains Auto; Manual becomes Manual of that
forced fallback. The watch state, stable selection, controller diagnostics,
and catalog are reconciled together. A stale ABR proposal that cannot be found
when applied is discarded and recomputed rather than committed.

## Pending switch supersession

Automatic and manual targets share C8's monotonically increasing watch
generation. A newer request wakes target preparation, cancels the child token,
resets scheduled/fetching lifecycle state, and prevents stale codec/config
records from committing. Auto to Manual therefore cancels a pending ABR target;
Manual to Auto likewise cancels a pending manual target. The policy never asks
for the current or already-pending target.

## Diagnostics and metrics

Complete decision logs contain no keys and use a specific hold reason for each
gate. `upswitch_headroom` is no longer a catch-all reason:

```text
ABR sample: rep=... bytes=... request_duration=... ttfb=...
            transfer_duration=... request_throughput=...
            transfer_throughput=...
ABR evaluate current=v4000000(4000000bps)
             candidate=v8000000(8000000bps)
             latest=... estimate=... safety_factor=0.80 safe=...
             buffer=... zone=normal up_margin=1.00
             required_estimate=10.000Mbps confidence=.../3
             supporting_samples=.../2 cooldown_remaining=...s
             decision=hold|switch reason=<exact gate>
```

Exact holds distinguish unknown bandwidth, low/unknown buffer veto, estimator
confidence, cooldown, insufficient safe bandwidth, insufficient recent
supporting samples, an already-highest current Representation, pending target,
and Manual mode. Down-switch and failure cooldown holds are also distinct.

Before: an 11.8 Mbps estimate for the 8 Mbps candidate yielded 8.85 Mbps safe
bandwidth but still held because the duplicated 1.20 margin required 9.60 Mbps
safe/12.80 Mbps raw; a sub-12-second buffer independently held it as well.
After: the same estimate yields 9.44 Mbps safe bandwidth, exceeds the 8 Mbps
candidate under the single reserve, and may switch once the separate 2-second
buffer, confidence, recent-evidence, and cooldown controls pass.

The session catalog exposes non-persistent statistics:

- `throughputSampleCount`;
- `currentEstimate`;
- `currentSafeBandwidth`;
- `currentRepresentation`;
- `abrSwitchCount`;
- `downSwitchCount`;
- `upSwitchCount`;
- `lastSwitchReason`;
- `bufferedSeconds`;
- `minimumObservedBufferedSeconds`;
- `maximumObservedBufferedSeconds`.

## Deterministic policy simulator

The pure tests use the requested 500 kbps, 1, 2, 4, and 8 Mbps ladder and
monotonic synthetic transfers.

- Stable 10/9/11/10 Mbps: begins at 2 Mbps, waits for confidence, proposes one
  step to 4 Mbps, and does not switch on every sample.
- Sustained 14/15/13/14/15 Mbps with a normal 3.5-second buffer: progresses
  `2 -> 4 -> 8 Mbps` after cooldown and proves the top rung is reachable.
- Marginal 8.4/8.7/8.2/8.6/8.5 Mbps: remains at 4 Mbps because the 20% reserve
  does not support the 8 Mbps candidate.
- Sustained 14/15/13 Mbps with a bounded 2.5-second buffer: permits 4 -> 8 Mbps
  and guards against restoring an unreachable large-buffer gate.
- Collapse 10/9/2/1.5 Mbps: proposes a fast bandwidth down-switch.
- Recovery 1.5/1.8/6/7/8 Mbps: waits for consecutive evidence and then moves
  from 1 to 2 Mbps, one rung only.
- Noisy 5/2/6/3/5/2.5 Mbps: does not up-switch from a transient peak.
- Low buffer with high throughput: holds until normal buffer health returns.
- Critical buffer: selects the lowest rung and bypasses a fresh cooldown.
- Ordinary up-switch cooldown: returns `Hold("upswitch_cooldown_active")`.
- Manual mode: repeated failures and critical buffer still produce no automatic
  switch.
- Invalid sample and duplicate pending target: sample rejected/decision held.

All thirteen pure ABR tests pass.

## Controlled HTTP and playback results

The local two-chunk throttled HTTP measurement test passes and validates the
network timing boundary used by the live scheduler. The pre-existing C8
multi-Representation playback harness also passes unchanged and proves the
switch executor still performs `320x180 -> 640x360 -> 320x180` in one mpv
session.

The requested combined Phase A 10 Mbps, Phase B 2 Mbps, Phase C 8 Mbps local
DASH origin was **not completed**. Consequently there is no valid claim here
that a real mpv playback run rose, fell, and recovered under that local server,
nor a measured stall count for such a run.

## Real UI result

`pnpm dev` located `/private/tmp/ynotv-c8-mpv.06PcSB/build-c8`, compiled the C9
changes, launched the Tauri application, installed the macOS OpenGL render
surface, and initialized patched libmpv successfully. The process environment
did not contain `RUSTDASH_TEST_MPD`, and the development window was not exposed
through the available UI automation surface. No authorized stream was played
for the required Auto/throttle/manual/audio/subtitle/seek/pause/stop matrix.

Observed automatic switch sequence: simulator `2 Mbps -> 4 Mbps -> 8 Mbps`;
collapse proposed a lower fitting rung; recovery `1 Mbps -> 2 Mbps`. No real UI
automatic sequence is claimed.

Stall/oscillation observation: deterministic traces showed no adjacent-rung
ping-pong and critical buffer bypassed cooldown. Real playback stall and
oscillation observations remain unavailable.

## Files changed

- `packages/app/src-tauri/src/dash_abr.rs`
- `packages/app/src-tauri/src/native_dash.rs`
- `packages/app/src-tauri/src/mpv_core.rs`
- `packages/app/src-tauri/src/lib.rs`
- `packages/ui/src/services/native-dash.ts`
- `packages/ui/src/services/tauri-bridge.ts`
- `packages/ui/src/components/DashQualityModal.tsx`
- `packages/ui/src/components/TrackSelectionModal.tsx`
- `docs/research/12-dash-abr.md`

No mpv patch, packet ABI, DASH parser dependency, DRM implementation, audio
selection behavior, or subtitle implementation changed in C9.

## Exact tests run

```text
cd packages/app/src-tauri
cargo test --lib dash_abr::tests -- --nocapture
cargo test --lib native_dash::tests -- --nocapture
cargo test --lib

pnpm --filter @ynotv/ui exec tsc --noEmit
pnpm --filter @ynotv/ui test -- --run src/services/__tests__/nativeDash.test.ts
pnpm --filter @ynotv/ui test

pnpm --filter @ynotv/local-adapter test
pnpm --filter @ynotv/local-adapter typecheck

node scripts/dev-native-dash.mjs --print-libmpv
pnpm dev

cd experiments/mpv-packet-demux-adapter
./run-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib
./run-live-generation-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib /tmp/ynotv-c8-mpv.06PcSB
python3 live_stream_test.py /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv
./run-track-switch-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib

cd experiments/clearkey-cenc-packet-transform
./run-local-tests.sh
./run-playback-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib

cd /tmp/ynotv-c8-mpv.06PcSB
meson test -C build-c8 --print-errorlogs

cd /path/to/ynotv
git diff --check
```

Observed results: ABR policy 13/13; native DASH focused 17/17, including the
local throttled response measurement and five-rung startup; full Rust 118/118 (C0,
C4, C6, C7, and C8 model coverage included); UI 586/586 and TypeScript check;
local-adapter 39/39 and typecheck; C2 PASS; C3 PASS; C4 local/playback PASS; C6
delayed live PASS; C8 video/audio switch PASS; pinned mpv 39/39; patched-libmpv
Tauri startup smoke PASS; `git diff --check` PASS.

## Current limitations

- No complete three-phase throttled DASH playback integration trace.
- No real normal-UI C9 acceptance run or real automatic switch sequence.
- Buffer health uses mpv's aggregate `demuxer-cache-duration`; it is not a
  separately measured video-only queued range.
- Only the current C8-compatible codec family and aligned segment boundaries
  participate.
- The native parser/session remains one-Period and SegmentTemplate/Timeline
  limited as documented in C8.
- Audio Representation ABR is intentionally absent; language and subtitle
  selection remain manual/existing behavior.
- The EWMA policy has no viewport, dropped-frame, device-capability, latency,
  content-complexity, or CDN model.
- ABR diagnostics are session-local and are not persisted.

Can a UI-selected DASH session automatically choose and switch video
Representations based on measured network throughput and playback buffer,
while preserving manual quality control and the existing audio/subtitle
behavior?

PARTIAL

Evidence:
The production-shaped path now measures complete video media responses, applies
a conservative EWMA/buffer/hysteresis/cooldown policy, and sends stable-ID Auto
proposals through the unchanged generation-safe C8 switch executor. Manual mode
is explicit and suppresses every automatic decision; C0-C8, frontend, ClearKey,
subtitle, manual video/audio, and pinned-mpv regressions pass. The required
combined throttled-DASH playback trace and real UI acceptance matrix were not
completed, so YES would overstate the evidence.
