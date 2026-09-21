# Compact DASH timeline foundation

Research/implementation snapshot: 2026-09-20 (Asia/Singapore)

ynoTV revision at the start of this phase: `4dd7c69c`

This phase implements only the exact time and compact `SegmentTimeline` model recommended by `01-ynotv-mpv-architecture.md` and `02-shaka-native-dash-architecture.md`. It does not modify mpv, use FFmpeg, parse MPDs, access the network, implement playback, or implement DRM.

## Scope and isolation

The experiment is `packages/app/src-tauri/src/dash_timeline.rs`. `lib.rs` declares the module, but nothing calls it from a Tauri command, application state, or playback path. It has no Tauri, mpv, FFmpeg, XML, or networking dependency.

The module is currently `pub(crate)` and deliberately has no stable public API. This keeps the experiment available to the Rust crate without changing existing ynoTV behavior.

## Rust structures

### Exact time

```text
ExactTime {
    numerator: i128,
    denominator: u64,
}
```

`ExactTime` is a reduced signed rational. A DASH time value is constructed as `ticks / timescale`; `f64` is never authoritative storage. Zero is canonicalized to `0/1`.

The type supports checked addition, subtraction, comparison, and rescaling. Arithmetic uses checked `i128` intermediates. Comparisons avoid potentially overflowing cross-multiplication: they compare Euclidean integer quotients, then compare the two sub-unit remainders using `u128` products. Invalid zero timescales and arithmetic overflow are returned as errors.

Rescaling explicitly selects one of:

- `Floor`: toward negative infinity;
- `Ceil`: toward positive infinity;
- `TowardZero`;
- `AwayFromZero`;
- `NearestTiesAway`: nearest integral tick, with exact half ticks away from zero.

No implicit rounding mode exists.

### Timeline declarations and runs

`TimelineEntry { t: Option<i128>, d: i128, r: i64 }` is the already-parsed form of one DASH `S` element. It is input to this experiment; XML parsing and inheritance are intentionally absent.

Each entry becomes at most one compact run:

```text
TimelineRun {
    media_start: i128,
    duration: i128,
    count: u64,
    first_position: u64,
    source_entry: usize,
    last_end_override: Option<i128>,
}
```

`CompactTimeline` owns a `Vec<TimelineRun>`, the representation timescale/PTO, and exact Period start/end. A `SegmentRef` is a cheap value produced only by `get()`; references are not cached or stored per represented segment.

Positions are DASH segment numbers. The first position equals `startNumber`; later positions add the represented segment count. Front eviction changes a retained run's `media_start`, `count`, and `first_position`, but never renumbers a retained segment.

## Presentation-time conversion

The implementation performs the required formula as exact rational arithmetic:

```text
presentation time =
    media_ticks / timescale
    + Period.start
    - presentationTimeOffset / timescale
```

Both reference start and end remain `ExactTime`. Conversion to an integer timebase is deferred until a caller explicitly requests a target timescale and rounding mode.

`$Time$`-style media time is retained independently in `SegmentRef.media_time`; PTO and Period placement do not overwrite it.

## SegmentTimeline algorithm

Construction is a single pass over `S` entries:

1. An explicit `S@t` starts a run there. Missing `t` starts at the previous run's nominal end; the first missing `t` starts at media time zero.
2. `S@r >= 0` becomes `count = r + 1` without expansion.
3. `S@r = -1` followed by an explicit next `S@t` becomes `ceil((next_t - start) / d)` segments.
4. A terminal `r=-1` with finite Period duration is bounded by the Period end, converted conservatively with exact ceiling arithmetic. A terminal negative repeat without a finite bound is rejected in this experiment.
5. A new explicit `t` must be strictly after the previous run's final segment start. For starts `0,10,20`, a next `t=15` is rejected, while `t=25` may clip the final `[20,30)` reference to `[20,25)`.
6. When the next explicit `t` differs from the previous nominal end, `last_end_override` changes only the prior run's final reference end. A positive difference models Shaka's gap behavior by stretching the prior reference; a negative difference clips the overlap.
7. Runs are clipped to the Period at construction. Arithmetic determines how many non-final references end before the Period, then the run's one effective final end—including `last_end_override`—decides whether that final reference survives. Entirely out-of-Period segments disappear, boundary-crossing references are clipped, and their original segment positions remain intact.

`get(position)` binary-searches `first_position`, computes the within-run offset arithmetically, converts its boundaries exactly, and applies the Period clip. Its result is `Result<Option<SegmentRef>, TimelineError>`: `Ok(None)` means the position is absent, while `Err` preserves arithmetic/timeline failure.

`find(presentation_time)` performs a fallible binary search over run presentation starts, maps the query back to media time exactly, computes an arithmetic within-run guess, and verifies the half-open interval `[start, end)`. It likewise returns `Result<Option<u64>, TimelineError>` rather than collapsing arithmetic failure into absence. An exact segment boundary selects the following reference; the Period end selects none.

`evict_before(time)` removes references with `presentation_end <= time`. It drains complete leading runs once, then binary-searches and trims at most one leading run. Stable absolute positions are retained, and internal lookup failures are propagated.

## Complexity

Let `R` be the number of retained `S` runs and `N` the represented segment count.

| Operation | Time | Additional memory |
|---|---:|---:|
| construct | O(R) | O(R) |
| `find(time)` | O(log R) | O(1) |
| `get(position)` | O(log R) | O(1) |
| `first_position` / `last_position` | O(1) | O(1) |
| `evict_before(time)` | O(R) worst case for removed runs plus O(log N-in-run) and `Vec` compaction | O(1) |

Persistent memory is O(R), not O(N). `get()` creates one returned `SegmentRef` value and does not populate a cache.

## Edge-case behavior

- Durations must be positive. Zero/negative `d`, `r < -1`, counter overflow, and arithmetic overflow are errors.
- A new explicit run start must be strictly greater than the previous run's final segment start, not merely greater than the previous run's first start. This preserves temporal ordering required by logarithmic lookup.
- A negative repeat requires either the immediately following `S@t` or a finite Period end. Invalid/non-forward bounds are errors.
- Missing `t` follows the previous nominal repeated duration, before a later explicit `t` applies its gap/overlap end override.
- Gaps and overlaps follow the Shaka scenario behavior recorded in report 02: the previous final reference ends at the next explicit start.
- References use half-open intervals. This makes boundary lookup deterministic.
- PTO may be positive or negative; media timestamps and Period offsets are signed.
- Period start and duration are exact rationals and need not share the representation timescale.
- Period clipping can remove leading segment numbers, so `first_position()` may be greater than `startNumber`.
- Leading clipping uses the final reference's effective overridden end. A gap-extended final reference can survive even when its nominal end precedes PTO; an overlap-shortened final reference is removed when its effective end is at or before PTO.
- For a valid arithmetic domain, `first_position()` never identifies a position for which `get()` returns `Ok(None)`. An arithmetic failure is preserved as `Err` rather than misreported as absence.
- Eviction is idempotent for already-removed time and does not shift retained positions.

## Tests executed

Focused command:

```text
cd packages/app/src-tauri
cargo test --lib dash_timeline -- --nocapture
```

Result after the corrective pass: **22 passed, 0 failed**. The focused cases cover:

- `1/90000` and all declared rounding modes;
- very large timestamps and detected rescale overflow;
- negative offsets and negative rounding;
- unrelated `30000`, `44100`, and `90000` timescales;
- exact presentation conversion with non-zero Period start and PTO;
- missing `t`;
- positive repeats;
- `r=-1` resolved by the next `S@t`;
- terminal `r=-1` bounded by finite Period duration;
- terminal `r=-1` combined with non-zero Period start, non-zero PTO, and an exact fractional finite Period end;
- rejection of unbounded terminal `r=-1`;
- gaps and overlaps;
- PTO clipping of a gap-extended final reference and an overlap-shortened final reference;
- rejection of an explicit start inside the previous run before its final segment start, while preserving a valid overlap inside only the final segment;
- Period clipping at both ends;
- `startNumber`, `find`, `get`, and stable positions after eviction;
- distinct absent-reference and arithmetic-failure lookup results;
- a single run representing 1,000,000 segments.

Full library regression command:

```text
cd packages/app/src-tauri
cargo test --lib
```

Result after the corrective pass: **78 passed, 0 failed**. The build emitted 66 pre-existing warnings in unrelated application modules; the corrected module added no warnings or test failures.

`git diff --check` also passed.

## Stress-test result

The stress fixture uses one `S` equivalent to `t=0, d=9000, r=999999` at timescale 90000. It represents exactly 1,000,000 segments.

Observed in the debug test build on this machine:

```text
run count:                  1
represented segment count: 1,000,000
Vec run capacity bytes:     96
construction observation:  approximately 0.0034 ms in the final warm test run
```

The test also performs a lookup in the millionth segment. The allocation measurement is `Vec::capacity() * size_of::<TimelineRun>()`; it directly demonstrates run storage rather than per-segment objects. Timing is an observational sanity check, not a stable benchmark claim.

## Remaining unknowns

1. This is not an MPD parser. Attribute inheritance, XML validation/recovery, SegmentTemplate URL generation, and manifest refresh/patch behavior remain undefined.
2. Live timelines need an append/merge API with identity checks. The current constructor deliberately resolves all retained runs to finite counts.
3. DASH permits compatibility choices around terminal `r=-1` in an unbounded dynamic Period. This experiment rejects it; a live refresh design may instead retain an explicitly open run.
4. Shaka warns/ignores some malformed entries, whereas this experiment returns strict errors. Parser-level compatibility policy must decide when to skip, stop, or fail.
5. Explicit starts at or before the previous final segment start are rejected. Real-world evidence is needed before deciding whether any non-ordered compatibility fallback is worthwhile.
6. Multi-Period `MetaSegmentIndex`, live availability windows, partial segments, low-latency availability, and refresh eviction are outside this phase.
7. Period clipping currently models segment-reference bounds, not sample-level decode preroll or packet clipping.
8. Property/fuzz tests should be added for arithmetic limits, randomly generated run patterns, and agreement with an independent small expanded oracle.
9. The eventual mpv boundary will require an explicit conversion timebase and rounding policy; this phase intentionally stops before choosing one.

## Git diff/status

The worktree was clean at the start of the original implementation. Final status after the corrective pass is:

```text
 A packages/app/src-tauri/src/dash_timeline.rs
 M packages/app/src-tauri/src/lib.rs
?? docs/research/03-compact-dash-timeline.md
```

The leading-space ` A` is Git's intent-to-add state for the new Rust file; no content is staged. `git diff --stat` reports 1,024 Rust lines plus the three-line module declaration. The untracked report is omitted from that ordinary diff. `git diff --check` reports no whitespace errors.

No mpv source, FFmpeg integration, playback path, networking path, DRM path, Cargo dependency, or lockfile was changed.

## Verdict

```text
Is this timeline/index model suitable as the foundation of the native DASH engine?

YES

Reason:
It preserves DASH media and presentation time exactly, makes all lossy rescaling explicit, resolves finite SegmentTimeline semantics into compact searchable runs, keeps positions stable through clipping and eviction, and represents one million segments with one run. The remaining work is around parsing, live refresh/merge, multi-Period composition, and packet-boundary semantics rather than a flaw in this time/index foundation.
```
