# Shaka Player as a reference for native DASH architecture

Research snapshot: 2026-09-20 (Asia/Singapore)

Shaka Player repository: <https://github.com/shaka-project/shaka-player>

Exact Shaka revision: `bf7ea8dc386991fd84963df8eb5e271b046082fa` (2026-09-18, `fix(DRM): Ignore session creation during teardown (#10614)`)

Git description at the time of research: `v5.2.11-main-1-gbf7ea8dc3`. `package.json` still contains version `5.2.0`, so the commit hash, not the package version, is the authoritative snapshot identifier.

Baseline: `docs/research/01-ynotv-mpv-architecture.md`, researched against ynoTV `9c05fe316de3b1ddd0bf60a450c5c1f2413e2481`, mpv `cfd818bcaef262f82596f49444ee80073fa6d49a`, and FFmpeg `n8.0` commit `140fd653aed8cad774f991ba083e2d01e86420c7`.

No playback, DASH, ClearKey, Widevine, or PlayReady implementation was performed in this phase.

## 1. Evidence conventions and executive conclusions

The report uses these labels:

- **Source-confirmed** means the behavior follows directly from the named source symbol or test at the researched revision.
- **Interpretation** means a consequence inferred from several source facts.
- **Recommendation** means guidance for a future Rust design, not a description of Shaka.

The most important conclusions are:

1. **Source-confirmed:** Shaka has durable architectural boundaries worth reproducing: a normalized manifest, a presentation timeline, lazy stream indexes, per-content-type scheduling state, an abortable networking layer, representation selection separate from switch execution, a cue-based text pipeline, and a DRM session lifecycle separate from segment scheduling.
2. **Source-confirmed:** Shaka does not keep DASH `SegmentTimeline` repeats compact. `MpdUtils.createTimeline()` expands every `<S>` repeat into a `TimeRange`; `TimelineSegmentIndex` lazily creates the heavier `SegmentReference` objects only on `get()`. A large positive `r` therefore costs O(number of repeated segments) time and O(number of segments) timeline memory.
3. **Recommendation:** reproduce Shaka's `SegmentIndex` contract, stable positions, lazy URI/reference materialization, update/eviction semantics, and tests, but use a compact run-based Rust index rather than Shaka's expanded timeline array.
4. **Source-confirmed:** Shaka's canonical DASH conversion is `presentation time = media time / timescale + Period@start - presentationTimeOffset / timescale`. It encodes the additive part as `SegmentReference.timestampOffset = periodStart - scaledPTO`; MSE applies it to embedded timestamps. Append windows clip samples to Period boundaries.
5. **Recommendation:** without MSE, the Rust/FFmpeg/mpv boundary must apply this conversion to packet PTS and DTS, while preserving decode order, duration, keyframe status, and Period clipping. It must not rely on mpv to infer DASH Period or PTO semantics.
6. **Source-confirmed:** dynamic refresh is identity-based. Periods are keyed by `Period@id` (or a start-time fallback), representations by `(Period id, Representation id)`, and multi-period logical tracks by semantic matching in `PeriodCombiner`. Counts may change. This is materially safer than FFmpeg's positional/count-preserving refresh.
7. **Source-confirmed:** Shaka flattens Period-local streams into logical streams backed by `MetaSegmentIndex`. It can carry codec/container changes in `fullMimeTypes`, union KIDs, combine compatible DRM information, and use MSE `changeType()` or a full MediaSource reset at boundaries.
8. **Recommendation:** B+C1 remains the strongest production-shaped candidate. FFmpeg MOV can provide access units and CENC side data; the Rust scheduler can provide Shaka-like timeline/index/ABR/DRM semantics; a custom mpv demux adapter can expose stable tracks and clear packets. The difficult part is an explicit reconfiguration/discontinuity contract, not MPD parsing alone.
9. **Recommendation:** D remains useful as a no-fork experiment for clear, codec-stable, separately-addressed audio/video/text. It cannot prove packet-level DRM, dynamic stream discovery, robust multi-period reconfiguration, or live seek semantics.

## 2. Playback architecture and actual load graph

### 2.1 Source call graph

**Source-confirmed:** a normal MSE DASH load follows this graph. Preloading is part of the normal path, not a separate parser implementation.

```text
shaka.Player.load(assetUri, startTime, mimeType)
  lib/player.js:1843
  -> Player.preloadInner_()
  -> Player.makePreloadManager_()
       creates ManifestFilterer and parser/DRM/network PlayerInterfaces
  -> new shaka.media.PreloadManager(...)
  -> PreloadManager.start()
       lib/media/preload_manager.js:390
       -> parseManifestInner_()
          -> ManifestParser.getFactory(uri, mimeType)
          -> new shaka.dash.DashParser()
          -> DashParser.configure()
          -> DashParser.start(uri, manifestPlayerInterface)
             lib/dash/dash_parser.js:264
             -> requestManifest_()
                -> NetworkingEngine.request(MANIFEST, ..., {type: MPD})
                -> parseManifest()/processParsedMpd()
                -> processManifest_()
                   -> create/update PresentationTimeline
                   -> parsePeriods_()
                      -> parsePeriod_()
                         -> parseAdaptationSet_()
                            -> ContentProtection.parseFromAdaptationSet()
                            -> parseRepresentation_()
                               -> SegmentBase/List/Template.createStreamInfo()
                               -> Stream {createSegmentIndex, ...}
                   -> PeriodCombiner.combinePeriods()
                      -> logical Stream + Variant arrays
                      -> lazy MetaSegmentIndex across Periods
                   -> Manifest {presentationTimeline, variants, textStreams...}
       -> chooseInitialVariant_()
       -> initializeDrm()
          -> DrmEngine.initForPlayback(playableVariants, sessions, dynamic)
          -> ManifestFilterer.filterManifest() after key-system selection
       -> optional initial segment-index creation and prefetch
  -> Player.load() receives parser, manifest, DRM engine, ABR manager, prefetch
  -> initializeMediaSourceEngineInner_()
       -> MediaSourceEngine owns MediaSource/SourceBuffers/TextDisplayer
  -> Player.loadInner_()
       lib/player.js:3060
       -> AbrManager.init(Player.switch_ callback)
       -> create StreamingEngine(manifest, playerInterface)
       -> chooseVariant_(initialSelection=true)
       -> selected Stream.createSegmentIndex() lazily
       -> StreamingEngine.switchVariant_(initial variant)
       -> StreamingEngine.switchTextStream() if selected/visible
       -> StreamingEngine.start()
          -> initStreams_()
             -> MediaSourceEngine.init(streamsByType, sequenceMode, ...)
             -> MediaState_ for audio/video/text
             -> scheduleUpdate_(state, 0)
          -> onUpdate_()/update_()
             -> SegmentIndex iterator -> SegmentReference
             -> fetchAndAppend_()
                -> fetch init if changed
                -> NetworkingEngine.request(SEGMENT)
                -> beforeAppendSegment() -> DrmEngine.parseInbandPssh()
                -> MediaSourceEngine.setStreamProperties()
                -> MediaSourceEngine.appendBuffer()
                   video/audio -> SourceBuffer queue/appendBuffer
                   text -> TextEngine -> parser -> Cue -> TextDisplayer
```

The key production files are `lib/player.js`, `lib/media/preload_manager.js`, `lib/dash/dash_parser.js`, `lib/util/periods.js`, `lib/media/presentation_timeline.js`, `lib/media/segment_index.js`, `lib/media/streaming_engine.js`, `lib/net/networking_engine.js`, `lib/abr/simple_abr_manager.js`, `lib/drm/drm_engine.js`, `lib/media/media_source_engine.js`, and `lib/text/text_engine.js`.

### 2.2 Ownership boundaries

| State category | Shaka owner | Important state/symbols | Native lesson |
|---|---|---|---|
| normalized manifest | `DashParser`, `PeriodCombiner` | `Manifest`, `Stream`, `Variant`, `streamMap_`, `parsedPeriodCache_` | immutable-ish description plus controlled live updates |
| timeline | `PresentationTimeline` | duration, AST, delay, availability duration, clock offset, known segment bounds | session-owned clock/range service |
| runtime streaming | `StreamingEngine` | `currentVariant_`, `currentTextStream_`, `mediaStates_` | per-session, with one state per logical media type |
| per-stream runtime | `StreamingEngine.MediaState_` | iterator, last media/init ref, current operation, timers, switch/clear/error flags | do not put these fields in the manifest model |
| networking | `NetworkingEngine` and scheme plugin | retry attempt, URI rotation, filters, backoff, pending request, progress | request-scoped mutable state and cancellation token |
| buffering | `MediaSourceEngine` plus `StreamingEngine` | SourceBuffer queues/ranges; buffer goals and buffer-behind policy | split policy from sink implementation |
| ABR | `SimpleAbrManager`, Player, StreamingEngine | estimator/choice; switch callback; actual safe fetch/append | selection is not commitment |
| DRM | `DrmEngine` | selected `DrmInfo`, sessions, requests, key statuses, expiration | separate system selection/session manager from sample decrypt |
| browser/MSE | `MediaSourceEngine` | `MediaSource`, `SourceBuffer`, append queues, `changeType`, append windows | reject as an implementation boundary, retain the media semantics |
| text | `TextEngine`, format parsers, TextDisplayer | cue parser, timing context, cue buffer, render model | parsing/normalization reusable; DOM/native cue rendering is not |

**Interpretation:** Shaka's manifest is not a DOM-shaped public playback model. XML nodes survive only in parser-local inheritance/patch contexts. Playback consumes normalized logical `Stream`/`Variant` objects and indexes.

## 3. DASH manifest normalization

### 3.1 Traversal and inheritance

**Source-confirmed:** `DashParser.processManifest_()` creates a mutable, shallow-copyable `DashParser.Context`. Traversal is:

```text
MPD attributes/BaseURL
  -> Context {dynamic, PresentationTimeline, MPD availabilityTimeOffset, ...}
  -> parsePeriods_()
     -> createFrame_(Period, root base-URI getter)
     -> parseAdaptationSet_()
        -> createFrame_(AdaptationSet, Period frame)
        -> parse roles/accessibility/ContentProtection
        -> parseRepresentation_()
           -> createFrame_(Representation, AdaptationSet frame)
           -> SegmentBase/List/Template-specific inheritance
           -> normalized Stream
```

`DashParser.createFrame_()` in `lib/dash/dash_parser.js:3215` inherits ordinary representation metadata by taking a child value or its parent value: content type, MIME type, codecs, supplemental codecs, width, height, frame rate, SAR, in-band event schemes, audio channels, audio sample rate, segment-sequence cadence, and producer-reference time. `BaseURL` is composed at every frame with `URL.resolveUris(parentUris, childUris)` and retained as a getter so content steering can change the result later.

Segment descriptors are retained in the frame as the nearest `SegmentBase`, `SegmentList`, or `SegmentTemplate` node. Their individual attributes and children are inherited representation-first, then AdaptationSet, then Period by `MpdUtils.getNodes()`, `inheritAttribute()`, and `inheritChild()` (`lib/dash/mpd_utils.js:453-521`). MPD-level `BaseURL` participates, but Shaka's segment-descriptor inheritance frames begin at Period; it does not model a general MPD-level `SegmentTemplate` frame.

`availabilityTimeOffset` is additive rather than simple override: the parent total plus the current frame's first `BaseURL@availabilityTimeOffset`, `SegmentBase@availabilityTimeOffset`, and `SegmentTemplate@availabilityTimeOffset`. The MPD-level first BaseURL value seeds `context.availabilityTimeOffset`.

### 3.2 Field normalization

| MPD input | Shaka result | Parsing-only/transient state |
|---|---|---|
| MPD type, duration, AST, SPD, TSBD, MUP | `PresentationTimeline`; manifest `isLowLatency`, service description | `manifestPatchContext_`, XML MPD node |
| Period id/start/duration | Period-local normalized times and `Period.id`; later `MetaSegmentIndex` boundaries | `PeriodInfo`, fallback id `__shaka_period_<start>` |
| AdaptationSet id | `Stream.groupId` when audio groups enabled; `AdaptationInfo.id` | generated `__fake__<n>` when absent |
| Representation id | `Stream.originalId`; stable parser key `(Period id, Representation id)` | `contextId`, `globalId_` runtime numeric `Stream.id` |
| bandwidth | `Stream.bandwidth`; summed into `Variant.bandwidth` | `context.bandwidth` during parsing |
| language | normalized BCP-47-ish `Stream.language`; original retained | inheritance-frame raw `lang` |
| roles/accessibility | `roles`, `primary`, text `kind`, `forced`, accessibility purpose, CEA channel map | parsed descriptor arrays |
| MIME/codecs/frame rate/resolution/audio layout | normalized `Stream` fields and `fullMimeTypes` across Periods | inheritance frames |
| SegmentBase | lazy range/index fetch; MP4 `sidx` or WebM index becomes references | XML node and async shallow context copy |
| SegmentList | explicit URL/range list plus duration/timeline becomes references | `SegmentListInfo` |
| SegmentTemplate duration | arithmetic/lazy `FixedDurationSegmentIndex_` | `SegmentTemplateInfo` and reference factory |
| SegmentTemplate timeline | expanded `TimeRange[]`, lazy `TimelineSegmentIndex` references | `SegmentTemplateInfo` retained by the index |
| ContentProtection | per-stream `encrypted`, `drmInfos`, `keyIds`; init data/KID | `ContentProtection.Context`, parsed XML elements |
| BaseURL | late URI getter yielding alternatives, optionally steered | XML nodes, service-location registrations |

`timescale` defaults to 1; `startNumber` defaults to 1 and may be 0 for `SegmentTemplate` but is forced back to 1 for `SegmentList`; PTO defaults to 0 (`MpdUtils.parseSegmentInfo()`). `Stream.createSegmentIndex()` closes over a copied parser context and is the lazy boundary.

**Recommendation:** a Rust manifest should retain stable protocol identity, normalized metadata, protection descriptors, and segment addressing declarations. It should not retain an XML DOM, parser cursor, patch XPath objects, response objects, timers, current iterators, or buffer state. A practical split is:

- `Manifest`: MPD identity/type/publish time/update rules, service locations, presentation timing, Period list.
- `Period`: stable id, presentation start/end, event metadata, AdaptationSets.
- `AdaptationSet`: stable id, type/language/roles/accessibility, shared protection/addressing defaults.
- `Representation`: stable id, quality/codec/container metadata, resolved effective segment addressing, effective DRM declarations.
- parser-only `InheritanceContext`: raw optional values and BaseURL resolution stack, discarded after normalization except where MPD Patch needs a compact addressable form.

## 4. Presentation timeline and timestamp domains

### 4.1 Timeline model and formulas

`PresentationTimeline` (`lib/media/presentation_timeline.js`) stores presentation start wall-clock time, presentation delay, duration, availability-window duration, maximum known segment duration, minimum known segment start, maximum known segment end, server clock offset, live/static state, and low-latency availability offset.

**Source-confirmed formulas:** with `nowServer = (Date.now() + clockOffsetMs) / 1000`:

```text
nominalLiveEdge = max(0,
    nowServer - maxSegmentDuration - availabilityStartTime)

segmentAvailabilityEnd = dynamic
    ? min(nominalLiveEdge + availabilityTimeOffset, presentationDuration)
    : min(maxKnownSegmentEnd if known, presentationDuration)

segmentAvailabilityStart = max(userSeekStart,
    segmentAvailabilityEnd - timeShiftBufferDepth)

seekRangeEnd = max(0,
    segmentAvailabilityEnd - (dynamic ? presentationDelay : 0))

safeSeekRangeStart(offset) = max(
    earliestKnownSegmentStart,
    min(segmentAvailabilityStart + offset, seekRangeEnd))
```

For static content, `timeShiftBufferDepth` is effectively infinite and safe start is the earliest segment time rounded upward to a millisecond. `getSeekRangeStart()` uses offset zero. The UI/media-element playback position is presentation time and must remain inside this seek range; it is not a media timestamp or wall clock.

When explicit SegmentTimeline/List ranges are known, `notifyTimeRange()`/`notifySegments()` derive max segment duration and max segment end. Before `lockStartTime()`, optional drift correction may replace AST with:

```text
correctedAvailabilityStartTime =
    nowServer - maxKnownSegmentEnd - maxSegmentDuration
```

This is why `usingPresentationStartTime()` becomes false when explicit segment timing plus drift correction is available. The parser locks the start after the initial complete Period parse to prevent live updates/ad insertion from moving the window unpredictably.

**Source-confirmed UTCTiming:** `DashParser.parseUtcTiming_()` tries entries in order. It supports HTTP HEAD (uses `Date` response header), HTTP xsdate/ISO GET (parses response body), and direct date values. It returns `serverDateMs - Date.now()`. NTP/SNTP schemes are explicitly unsupported. A configured `clockSyncUri` is a HEAD fallback. Failures move to the next source and finally use offset zero.

`publishTime` is not part of live-edge math. It is retained for MPD Patch validation and PatchLocation TTL. `minimumUpdatePeriod` drives refresh scheduling, not segment availability.

### 4.2 Timestamp vocabulary

| Domain | Meaning in Shaka | Conversion |
|---|---|---|
| unscaled media time | `S@t`, `tfdt`, template `$Time$`, in representation timescale units | divide by `timescale` for seconds |
| media timestamp seconds | timestamp embedded in a component stream before DASH placement | `unscaled / timescale` |
| PTO-adjusted Period-relative time | SegmentTimeline `TimeRange.start/end` | `(S time - PTO) / timescale` |
| presentation time | common playback axis, Period 0 based | `Period.start + Period-relative time` |
| segment availability window | which segment references may still/become downloadable | `[availabilityStart, availabilityEnd]` on presentation axis |
| seekable range | safe UI/playhead range | availability range minus presentation delay at the end |
| wall-clock/program time | UTC mapping for live/UI | `AST + presentationTime`, or PRFT/program-date-time mapping |

For a DASH media sample:

```text
presentationPTS = mediaPTS + Period.start - PTO / timescale
presentationDTS = mediaDTS + Period.start - PTO / timescale

SegmentReference.timestampOffset = Period.start - PTO / timescale
appendWindow = [Period.start, Period.end)
```

Other source-confirmed conversions use the same domain separation:

```text
EventStream event presentation time =
    Period.start + (Event@presentationTime - EventStream@presentationTimeOffset)
                   / EventStream@timescale

EventStream event duration = Event@duration / EventStream@timescale

PRFT program start wall clock =
    ProducerReferenceTime.wallClockTime
    - ProducerReferenceTime.presentationTime / representation timescale

UI/program date for presentation time t =
    program-date-time region.pdt + (t - region.start), when a region applies,
    otherwise initialProgramDateTime + t
```

For `SegmentTemplate`, `$Time$` deliberately uses the original unadjusted media time. `MpdUtils.createTimeline()` subtracts PTO for its Period-relative ranges; `TimelineSegmentIndex.get()` adds PTO back to `range.unscaledStart` for `$Time$`. Tests at `test/dash/dash_parser_segment_template_unit.js:99-153,390-405,548-568` pin both behaviors.

### 4.3 What MSE currently supplies and native code must supply

**Source-confirmed:** `StreamingEngine.initSourceBuffer_()` passes the reference's timestamp offset and Period append window to `MediaSourceEngine.setStreamProperties()`. In MSE segments mode, `SourceBuffer.timestampOffset` adds the offset to coded timestamps; append windows discard coded frames outside Period boundaries. Shaka also extracts an actual media timestamp and can recalculate an HLS offset, but for ordinary DASH the manifest formula is the intended value.

**Recommendation:** the native engine should expose only presentation-axis packet timestamps to mpv. With FFmpeg MOV:

1. preserve raw `AVPacket.pts`, `dts`, time base, duration, and any edit-list behavior emitted by MOV;
2. rescale to a stable high-precision unit;
3. add `Period.start - PTO/timescale` to both PTS and DTS;
4. clip/drop samples outside `[Period.start, Period.end)` with decode-preroll handled explicitly rather than blindly truncating packets;
5. signal discontinuity/decoder generations at Period and incompatible representation boundaries;
6. report presentation time, seek range, and wall-clock mapping separately to UI.

mpv already owns decode clocks and final A/V sync, but it does not own DASH PTO, Period placement, segment availability, or Period clipping.

## 5. SegmentIndex and SegmentTimeline

### 5.1 Core structures and complexity

`SegmentReference` (`lib/media/segment_reference.js`) contains presentation start/end, lazy URI getter, byte range, init reference, timestamp offset, append window, partial references, availability/missing status, independence, discontinuity sequence, codec/MIME/bandwidth, and optional cached bytes. `InitSegmentReference` contains URIs/range, media-quality metadata, timescale learned from init data, codec/MIME, encrypted flag, and a Period `boundaryEnd`.

`SegmentIndex` (`lib/media/segment_index.js`) is a sorted reference array with a stable `numEvicted_` prefix count:

- `find(time)` uses binary search: O(log n).
- `get(position)` is O(1).
- `merge()` binary-searches the replacement point then truncates/appends: O(log n + appended + discarded storage work).
- `evict()` binary-searches by end time then slices: O(log n + remaining array copy).
- stable public positions survive front eviction through `numEvicted_`.
- `SegmentIterator` traverses full/partial references and backs up to an independent partial on entry.
- `MetaSegmentIndex` stitches per-Period indexes. Its `find/get` are O(number of retained Period indexes plus child lookup); it removes empty leading indexes during eviction.

`SegmentTemplate@duration` uses `FixedDurationSegmentIndex_`: it allocates a sparse array of slots and computes position arithmetically, materializing a reference on `get()`. Live creation is initially bounded by `dash.initialSegmentLimit`, then `updateEvery()` creates newly available references and evicts old ones. Low-latency ATO reduces its timer interval to 100 ms.

`SegmentTemplate/SegmentTimeline` uses `TimelineSegmentIndex`: its lightweight `TimeRange[]` is eager; the URI-bearing `SegmentReference` is lazy and cached per requested position. Lookup is binary search.

### 5.2 `<S>` expansion semantics

**Source-confirmed:** `MpdUtils.createTimeline()` implements:

- `t` present: `start = t - unscaledPTO`;
- `t` missing: `start = previous end`, initialized to `-unscaledPTO`;
- `d` missing/zero: warn and ignore that `S`;
- omitted `r`: zero;
- positive `r`: create `r + 1` ranges;
- `r = -1` with a following `S@t`: `ceil((nextT - start)/d) - 1` repeats;
- terminal `r = -1` with finite Period duration: `ceil((periodDuration*timescale - start)/d) - 1`;
- terminal negative repeat with infinite Period: warn and ignore the terminal entry;
- negative repeat followed by missing/invalid `t`, or whose start is not before the next `t`: stop processing the remaining timeline;
- a gap/overlap before the current `S`: change the previous range's end to the current start; warn if at least the global tolerance;
- segment number: `timeline.length + startNumber`.

The Period boundary is enforced later by `TimelineSegmentIndex.fitTimeline()` and `get()`. Ranges wholly outside the Period are dropped. The final reference end is normally the Period end for finite Periods; dynamic manifests cap a materially mismatched final segment at the smaller end. Append windows also enforce the Period boundary.

**Source-confirmed memory behavior:** repeats are expanded during MPD parsing, before the lazy index is exposed. For `<S r="1176">`, there are 1,177 `TimeRange` objects. Lazy reference generation saves URI/reference object cost, not timeline-run cost. Eviction slices both the expanded timeline and any materialized reference cache. Full MPD refresh constructs another expanded timeline and appends entries whose end exceeds the cached final end.

This differs from Phase A's FFmpeg `dashdec.c`: FFmpeg retains one compact `struct timeline` per XML `<S>` and a repeat count, but performs linear/repeat iteration in several lookups. Shaka gets O(log n) lookup after paying O(expanded segments) parse/memory; FFmpeg saves memory but has repeated traversal costs.

**Recommendation:** use a compact Rust run index:

```text
TimelineRun {
  first_unscaled_time_after_pto,
  duration,
  count,                 // finite after resolving r=-1 against next t/Period
  first_segment_number,
  partial_count/cadence,
  source descriptor id
}
```

Keep runs in a searchable prefix structure (cumulative counts/end times). Then `find(time)` and `get(position)` can be O(log runs), reference creation O(1), memory O(number of `<S>` elements), and eviction can trim whole runs plus at most one run prefix. Preserve Shaka's stable-position count and its exact gap/overlap, missing-`t`, negative-repeat, Period-fit, and `$Time$` behavior as tests.

## 6. Dynamic MPD refresh and MPD Patch

### 6.1 Scheduling and requests

`DashParser.start()` requests once and schedules a one-shot timer. `onUpdate_()` awaits a refresh, emits the manifest-updated callback, then schedules the next one. `setUpdateTimer_(offset)` uses:

```text
configuredUpdatePeriod if >= 0, else MPD minimumUpdatePeriod
delay = max(updatePeriod - requestAndParseDuration,
            EWMA estimate of update duration)
```

Missing MUP (`-1`) means no periodic updates; explicitly zero still updates. `onInitialVariantChosen()` can shorten the first refresh to the gap between the last reference end and availability end. Updates can be paused while the media element is paused unless configured otherwise. Manifest requests use normal NetworkingEngine retry/cancellation.

**Source-confirmed:** there is no ETag/If-None-Match or Last-Modified conditional request logic in `DashParser` or `NetworkingEngine`. Redirect response URIs are prepended to future manifest URIs and become the BaseURL basis.

### 6.2 Full refresh identity and merge

Stable identity is layered:

1. Period identity is `Period@id`; absent IDs become `__shaka_period_<start>`.
2. On dynamic full refresh, unchanged inner Periods are reused from `parsedPeriodCache_`; boundary Periods are reparsed because their duration/timeline commonly changes.
3. A representation is cached as `streamMap_[Period id + ',' + Representation id]`. Dynamic MPDs reject duplicate representation IDs across the Period.
4. `SegmentList` calls `mergeAndEvict()` on the existing index. `SegmentTimeline` calls `appendTemplateInfo()` and evicts before/after parsing. Fixed-duration indexes update from presentation availability timers.
5. `PeriodCombiner.usedPeriodIds_` detects new Periods and semantically extends logical streams across them. Matching uses generated keys then compatibility/best-match rules (DRM, language, roles, label, codec/profile, resolution, channels, sample rate, bandwidth depending on type), not array positions.
6. Before parsing every update, all existing indexes are evicted at current availability start, including streams whose Period disappeared from the MPD.
7. `cleanStreamMap_()` keeps a removed Period's streams while their indexes still contain available references. Once empty, it removes them from `PeriodCombiner`, `streamMap_`, and the Period index map.

Thus new/removed Periods and changing representation counts do not cause the positional failure seen in FFmpeg. New tracks are exposed by recomputing `manifest.variants`, `textStreams`, and `imageStreams`, then re-filtering. Removed logical material is retained only as needed for the still-live window. A limitation is that `PeriodCombiner` is chiefly append/new-Period oriented; arbitrary mutation of already-combined logical identity is more complex than the representation cache alone suggests.

### 6.3 MPD Patch

Patch requests are used when valid `PatchLocation` elements exist, the original MPD has `id` and `publishTime`, and location TTL has not expired. `processPatchManifest_()` verifies `mpdId` and `originalPublishTime`; mismatch clears PatchLocation state and raises a recoverable invalid-patch error so the next update returns to a full MPD.

Supported patch operations include MPD duration/type/publishTime, PatchLocation changes, Period add/remove, SegmentTemplate changes, and SegmentTimeline/`S` additions/removals/attribute modifications. `contextCache_`, keyed by Period and Representation IDs, stores cloned parsing contexts with a cloned SegmentTemplate but without the full original document. Modified timelines are reparsed into the existing index. Added Periods go through ordinary Period parsing and combining.

**Recommendation:** native refresh should require stable Period/AdaptationSet/Representation keys and perform a two-phase update: parse/validate a candidate snapshot, then atomically merge identity/index changes into the playback session. Never match representations by array position or require unchanged counts. Conditional HTTP should be an independent Rust capability even though Shaka does not currently demonstrate it.

## 7. Multi-period semantics

### 7.1 Shaka's generic model

`DashParser.parsePeriods_()` calculates start/duration using explicit start, previous end, next Period start, Period duration, and MPD duration. If next start and explicit duration disagree, it logs a gap/overlap, counts a positive gap, and favors the next Period start as effective duration so flattened indexes meet at Period boundaries.

`PeriodCombiner` (`lib/util/periods.js`) converts Period-local streams into logical presentation streams:

- a logical stream has `matchedStreams` across Periods;
- `createSegmentIndex()` lazily builds a `MetaSegmentIndex` of child indexes;
- missing text/image in a Period is represented with dummy matches, so later tracks can continue;
- text may change MIME/codec and even caption/subtitle `kind`, but not language or forcedness;
- A/V matching allows codec/container changes and requires DRM compatibility; `fullMimeTypes` records all encountered types;
- KIDs and roles are unioned, bandwidth becomes the maximum, and common DRM systems/init data are combined;
- no common DRM across encrypted Periods is `INCONSISTENT_DRM_ACROSS_PERIODS`;
- clear is treated as DRM-compatible with encrypted content.

Resolution/frame rate/channel count/sample rate of the original logical stream remain its representative metadata for matching. PeriodCombiner tests cover ad insertion with new resolutions, language changes, unrelated Periods, text gaps, channel/sample-rate changes, roles, related codecs, KID-based duplicate filtering, and stability over many Periods (`test/util/periods_unit.js`).

### 7.2 Boundary behavior delegated to MSE/browser

At a new reference, `StreamingEngine.initSourceBuffer_()` compares init reference, codec, MIME, timestamp offset, and append window. `MediaSourceEngine.codecSwitchIfNecessary_()` chooses:

- no action if normalized codec and basic MIME remain compatible;
- `SourceBuffer.changeType()` when configured for smooth switching and the device/key system reports support;
- full `MediaSource` reset and SourceBuffer recreation otherwise.

`crossBoundaryStrategy` may stop buffering at an init-segment `boundaryEnd`, internally seek just over the boundary, and reset MSE. Strategies include always reset, reset until encrypted, reset on encryption-state change, and keep when compatible. The clear→encrypted integration fixture expects an MSE reset; encrypted→encrypted may be retained under the configured strategy. This behavior is platform-policy-laden, not a general statement that every clear/encrypted or KID change needs a decoder reset.

New Period init data reaches `ManifestFilterer.processDrmInfos()` and `DrmEngine.newInitData()`, enabling new sessions for key rotation. In-band PSSH may also block append until sessions load.

### 7.3 Native equivalent semantics

**Recommendation:** separate three events that MSE conflates:

| Boundary | Rust/FFmpeg MOV requirement | mpv requirement |
|---|---|---|
| same codec config, new Period/PTO | open/continue appropriate fragment context; rebase PTS/DTS; apply Period clip; new init only if required | explicit discontinuity marker only if timestamps/decoder demand it |
| compatible codec with new extradata/resolution | new MOV/init generation; emit codec-parameter generation at an independent access point | flush/reconfigure decoder or prove seamless hwdec support |
| incompatible codec/container/audio config | create/switch MOV context and packet stream generation | rebuild the affected decoder chain; coordinate A/V boundary |
| new KID/PSSH, same codec | retain per-packet crypto info; create/update DRM session before affected packet | decoder need not reset after successful decrypt unless codec config changed |
| clear ↔ encrypted | transform policy changes, not necessarily codec | flush only if packet/security/backend contract requires it |
| gap | expose no packets for interval or a discontinuity/gap event | let player clock jump/seek according to explicit policy |
| overlap | deterministic clipping/dedup at Period boundary | never feed ambiguous duplicate presentation intervals |

FFmpeg `AVFormatContext` instances should be considered representation/init-generation scoped, not assumed safe forever across arbitrary init changes. `AVPacket` should carry presentation PTS/DTS only after Rust's DASH placement and decryption transform. The custom mpv demux adapter needs a typed `stream_config_changed`/discontinuity signal; byte EOF is not enough.

## 8. StreamingEngine and scheduler state machine

### 8.1 State and update loop

The concrete per-type state is `StreamingEngine.MediaState_` at the end of `lib/media/streaming_engine.js`. Important fields are current `stream`, `segmentIterator`, last media/init references, last MSE properties, `endOfStream`, `performingUpdate`, `updateTimer`, pending clear/flush flags, `clearingBuffer`, `seeked`, `adaptation`, `recovering`, `hasError`, current abortable network `operation`, prefetch object, and optional dependency state.

A simplified state machine is:

```text
IDLE/TIMER
  -> onUpdate_
     -> pending clear? -> CLEARING -> schedule immediately
     -> no index? -> CREATING_INDEX
     -> update_
        -> buffer goal met/paused/run-ahead/no ref -> WAITING (timer)
        -> reference found -> FETCHING
             -> optional INIT_FETCH/INIT_APPEND
             -> MEDIA_FETCH (possibly chunk callbacks)
             -> APPENDING
             -> update last reference/iterator
             -> schedule immediately

external events:
  seek -> abort/clear or retarget iterator -> schedule
  switch -> replace stream, invalidate iterator, optionally clear,
            decide whether in-flight request should be aborted
  error -> retry backoff / disable stream / terminal error
  all non-text states endOfStream -> MediaSource.endOfStream()
```

There is no single enum; the state machine is represented by mutually constrained fields. `onUpdate_()` asserts that an update is neither already running nor clearing. Stream switches during async index creation or update are detected and abandoned/deferred safely.

### 8.2 Scheduling policy

`update_()` calculates buffer ahead from the sink and targets `max(rebufferingGoal, bufferingGoal) * bufferingScale`, floored at one second. It stops/polls when paused (if configured), at goal, or while streaming is temporarily disallowed. It chooses the next reference from the current iterator; on switch it re-enters the new index at the last manifest reference end or buffer end; on an empty buffer it starts around presentation time with an inaccurate-manifest tolerance.

One stream is prevented from outrunning another by comparing manifest-domain `timeNeeded` across active audio/video/text states. Embedded captions and muxed audio are excluded. A stream waits when it is ahead by:

```text
max(maxSegmentDuration * 1 segment, 0.5 seconds)
```

This comparison intentionally uses `lastSegmentReference`, not the actual buffered end, because container timestamps can drift from manifest times. That distinction is directly reusable.

`SegmentPrefetch` may fetch ahead and keep init data. The scheduler reuses prefetched requests, evicts prefetched items by reference time, and can prefetch alternate audio variants. Low-latency Fetch streaming can append complete `mdat` chunks incrementally.

On switch, ABR selection is already done. `switchInternal_()` changes the logical stream and iterator, preserves or swaps prefetch state, defers destruction of an index used by an in-flight update, optionally clears buffered media, and calls `makeAbortDecision_()`. An old download is aborted when the new estimated segment can finish inside buffered safety margin, when it is smaller than bytes remaining, or when size is unknowable.

Eviction removes sink data behind the playhead using a limit at least one maximum segment duration and evicts old child indexes. Quota errors progressively reduce buffer goals or temporarily disable a stream. Network/media errors use backoff and stream disabling. Text failures can be ignored independently.

Playback starvation is observed outside the fetch loop by `BufferingObserver` (`lib/media/buffering_observer.js`) and `Player.startBufferManagement_()`/`pollBufferState_()` (`lib/player.js:4442-4550`). It is a two-state hysteresis machine: `SATISFIED` enters `STARVING` below a smaller threshold, while `STARVING` requires the configured `rebufferingGoal` before returning to `SATISFIED`; media-element waiting/playing/seeking/timeupdate events can also force a state. This is distinct from StreamingEngine's larger steady-state `bufferingGoal`.

### 8.3 Generic versus MSE-specific

Reusable scheduling concepts are reference selection, one runtime state per media type, manifest-time run-ahead limits, lazy index creation, prefetch ownership, cancellation, switch-vs-request abort decisions, retry/disable policy, seek generation invalidation, EOS agreement across audio/video, and bounded buffer goals.

MSE-specific actions are `appendBuffer`, SourceBuffer queues, timestampOffset/append windows, `abort()` splicing, SourceBuffer removal, quota interpretation, `changeType`, MediaSource reset, and browser buffered-range queries.

**Recommendation:** model Rust states explicitly, for example `Idle`, `Selecting`, `FetchingInit`, `FetchingMedia`, `WaitingForKey`, `Demuxing`, `ReadyPackets`, `Draining`, `SwitchPending`, `Seeking`, `Ended`, and `Failed`, with a session generation for cancellation. Track sink queue depth in presentation seconds and bytes. Preserve Shaka's manifest-time A/V run-ahead rule, but define a separate packet backpressure contract with mpv.

## 9. NetworkingEngine and DASH request behavior

### 9.1 Generic behavior

`NetworkingEngine` (`lib/net/networking_engine.js`) takes typed requests (`MANIFEST`, `SEGMENT`, `LICENSE`, etc.) and richer contexts (`MPD`, `MPD_PATCH`, `INIT_SEGMENT`, `MEDIA_SEGMENT`). A request has ordered alternative URIs, method/body/headers, credential flag, retry parameters, optional byte-stream callback, and DRM/session context.

Source-confirmed behavior:

- request and response filters are sequential and may mutate URLs, headers, credentials, signed query strings, body, or response;
- retries rotate `request.uris` by attempt modulo URI count;
- per-attempt headers reset before filters, avoiding a CDN-specific header leaking to another URI;
- exponential backoff has max attempts, base delay, factor, random fuzz, total timeout, connection timeout, and stall timeout; defaults are 2 attempts, 1 s base, factor 2, fuzz 0.5, 30 s total, 10 s connect, 5 s stall;
- pending requests and backoff waits are abortable; destroy aborts them;
- progress feeds bytes/time/bytes-remaining to ABR, and complete-response timing is used when progress is unavailable;
- range requests are produced by `NetworkingUtils.createSegmentRequest()` from inclusive reference byte ranges;
- response URI records redirects; Fetch follows browser redirect policy;
- cross-site cookies are opt-in via `allowCrossSiteCredentials`, mapped to Fetch `credentials: include`;
- request filters are the explicit signed-URL/header mutation hook;
- BaseURL inheritance yields multiple URIs; content steering can order/clone pathways, change locations, reload steering metadata, and ban a failed location.

There is no application-level priority queue in `NetworkingEngine`; “plugin priority” only selects which URI-scheme plugin is registered. Browser Fetch/XHR owns socket pooling, HTTP/2 multiplexing, HTTP/3 negotiation, cookie storage, redirect mechanics, CORS, TLS, and decompression. Shaka makes no explicit HTTP/2 or HTTP/3 scheduling assumption in these files.

### 9.2 Rust network capability list

**Recommendation:** the native layer should provide:

- typed request context and metrics for manifest, patch, init, media, text, license, timing, steering, and certificate;
- ordered alternate URLs with attempt-local mutation and service-location identity;
- cancellable DNS/connect/body/backoff phases and session-generation cancellation;
- max attempts, exponential backoff with jitter, total/connect/stall timeouts, and retry classification;
- byte ranges and streamed response chunks with backpressure;
- redirect result URL and policy limits;
- shared cookie jar with per-session credential policy;
- request/response hooks for authorization, signed URL renewal, custom headers, and observability;
- conditional manifest requests (`ETag`, `If-Modified-Since`) as a native enhancement;
- HTTP/2 multiplexing and HTTP/3 through the chosen transport library, without exposing protocol details to the scheduler;
- content-steering pathway ordering, clones, TTL/reload URI, bans, and CDN health;
- request priority/deadline classes, which Shaka delegates to the browser but a native engine should make explicit;
- CMCD/CMSD integration only behind a policy interface, not embedded in index code.

## 10. ABR selection and switch lifecycle

`SimpleAbrManager` uses `EwmaBandwidthEstimator`: samples under 16 KiB are ignored by default; 128 KiB total is required before trusting the estimate; fast and slow EWMAs default to 2 s and 5 s half-lives; the lower estimate is used. Cached/very-fast results below `cacheLoadThreshold` are not sampled.

The candidate set is already filtered by application restrictions, key-system support, MediaCapabilities/codec support, temporary disabling, and adaptation-set criteria. `chooseVariant()` additionally applies ABR resolution/bandwidth restrictions and optional viewport or screen size multiplied by device-pixel ratio. It sorts by bandwidth and selects the highest range satisfying hysteresis:

```text
minimum estimate for candidate = playbackRate * candidateBandwidth
                                 / bandwidthDowngradeTarget

maximum estimate before next = playbackRate * nextBandwidth
                               / bandwidthUpgradeTarget
```

Defaults in `lib/util/player_configuration.js:310-344` are switch interval 8 s, upgrade target 0.85, downgrade target 0.95. Initial choice uses the configured default estimate or Network Information API value until enough samples exist. CMSD may alter the estimate or cap bitrate.

Dropped frames are a separate protection loop. When enabled, `getVideoPlaybackQuality()` is polled; a default 15% drop ratio temporarily disables the current video stream for 30 s. It does not directly enter the bandwidth formula. Playback rates above 1 disable this ban logic.

**Source-confirmed:** current `SimpleAbrManager` does not use buffer level in representation choice. Buffer level influences whether StreamingEngine fetches, whether an old request is safe to abort, and the clear-buffer safe margin, but not `chooseVariant()` itself.

The lifecycle is:

```text
segment request progress/completion
  -> Player NetworkingEngine progress callback
  -> AbrManager.segmentDownloaded(time, bytes, allowSwitch)
  -> EWMA sample
  -> startup sample gate + switch interval
  -> chooseVariant()
  -> Player switch callback
     -> Player filters no-op/unsupported choice
     -> StreamingEngine.switchVariant()
        -> set new Stream(s), iterator=null
        -> optional buffer clear
        -> decide whether to finish or abort in-flight request
        -> next update enters new SegmentIndex at presentation frontier
        -> fetch new init if InitSegmentReference changed
        -> MediaSource codec no-op/changeType/reset
        -> append media at independent reference
```

**Interpretation:** “choose” is a policy result; “commit” occurs only when the scheduler has a reference at the correct frontier, required init/extradata is ready, the in-flight old request is handled, and the sink/decoder accepts the new configuration.

**Recommendation:** retain this split. A Rust `AbrController` should propose `(logical track, representation, reason, estimate)`. The scheduler should accept/reject/defer based on random-access independence, segment alignment, init availability, codec/extradata compatibility, DRM key readiness, buffered old packets, and mpv decoder/hwdec transition capability. There is no native equivalent to assume for `changeType()`.

## 11. Subtitle and closed-caption architecture

### 11.1 Fetch and parse path

Text representations are ordinary `Stream`s with SegmentIndexes. `StreamingEngine` creates a text `MediaState_`, fetches init/media through the same NetworkingEngine, and sends bytes to `MediaSourceEngine.appendBuffer()`. For text, that method bypasses SourceBuffer and calls `TextEngine.appendBuffer()`.

`TextEngine` selects a parser by full MIME type, supplies a `TimeContext` (`periodStart`, segment start/end, VTT offset, MPEG-TS flag), filters cues by append window, tracks text buffered start/end even for empty-cue segments, and sends normalized `shaka.text.Cue` objects to a `TextDisplayer`.

Formats:

- plain WebVTT: `lib/text/vtt_text_parser.js`, registered for `text/vtt`, parses cue settings, regions, CSS-like STYLE blocks, nested/ruby/voice/karaoke markup, and HLS `X-TIMESTAMP-MAP`/33-bit rollover;
- `wvtt` in MP4: `lib/text/mp4_vtt_parser.js`, reads init timescale and fragment `tfdt`/`tfhd`/`trun`/`mdat`, extracts `vttc`/`vtte`, then reuses VTT cue-setting parsing;
- TTML/IMSC text: `lib/text/ttml_text_parser.js`, resolves nested timing, frame/tick rates, inherited styles, regions, origin/extent, writing modes, decorations, ruby, images, and clips cues to segment bounds;
- `stpp`/IMSC in MP4: `lib/text/mp4_ttml_parser.js`, extracts samples and optional image subsamples from `moof`/`mdat`, computes per-sample timing, then delegates documents to the TTML parser;
- CEA-608/708: DASH Accessibility descriptors create logical caption streams; video init/media is parsed by `ClosedCaptionParser` plus `Mp4CeaParser`/`TsCeaParser`, `CeaDecoder`, 608 data channels, and 708 services/windows. Cues are timestamp-shifted by the video's offset, cached per caption service, and sent through TextEngine/TextDisplayer.

`Cue`/`CueRegion` are the format-neutral styling/positioning model. `UITextDisplayer` is browser DOM rendering; `NativeTextDisplayer` maps to browser `TextTrack`/`VTTCue`. These rendering implementations should not be copied into Rust.

### 11.2 Native value

**Recommendation:** reproduce the parsing contract and a normalized cue IR: start/end on presentation time, payload tree/spans, line/position/size/alignment, writing mode, region geometry, colors/background/outline/font attributes, ruby, images, language/kind, and source segment identity. Then convert that IR to ASS/libass with documented lossiness.

Useful behaviors to preserve include VTT regions/settings/styles, VTT offset rules, MP4 sample composition timing, TTML nested-time inheritance, frame/tick-rate conversion, segment clipping, multi-`mdat` TTML, IMSC image subsamples, CEA service separation, caption decoder reset per continuity timeline, and live cue removal/append-window filtering.

## 12. DRM model: reusable lifecycle versus EME

### 12.1 Manifest association

`ContentProtection` (`lib/dash/content_protection.js`) parses `schemeIdUri`, `cenc:default_KID`, `cenc:pssh`, `mspr:pro`, encryption scheme, license URL, and certificate URL. AdaptationSet parsing establishes the candidate `DrmInfo[]`, generic init data, and default KID. Representation parsing may replace unknown/absent AdaptationSet data on the first representation, intersect key systems on later representations, and select a Representation KID over the AdaptationSet default.

Each normalized `Stream` has `encrypted`, `drmInfos`, and `keyIds`. A `DrmInfo` carries key-system identity, encryption scheme, license endpoint, robustness/persistence requirements, certificate, init-data records, and KIDs. Variants combine audio/video DRM only when they have a common system. PeriodCombiner unions stream KIDs and common DRM init data across Periods.

### 12.2 Generic lifecycle concepts to retain

The reusable sequence in `DrmEngine` is:

```text
candidate Stream/Variant DrmInfo sets
  -> select one compatible DRM system/configuration
  -> merge/deduplicate init data and KIDs
  -> create or restore session objects
  -> init data produces a challenge
  -> typed LICENSE request through NetworkingEngine filters/retries
  -> apply response to session
  -> observe per-KID status and expiration
  -> announce usability/restrictions
  -> accept new manifest or in-band PSSH
  -> create additional session if init data is new
  -> renew/retry/close session as required
```

`newInitData()` deduplicates byte-equivalent init data when configured, creates a new session for new data, and resets the “all sessions loaded” barrier for rotation. `ManifestFilterer` feeds new init data after live manifest updates. `parseInbandPssh()` scans media before append and waits for sessions. `keyStatusByKeyId_` distinguishes loaded from usable, batches status changes, and reports all-expired. Expiration is polled; renewal behavior is system-dependent. Multiple active sessions and multiple KIDs are normal.

Before keys exist, manifest filtering removes variants unsupported by the selected key system but permits candidates whose sessions are still loading. After key-status events, `Player.onKeyStatus_()` updates `Variant.allowedByKeySystem` from every stream KID; missing or restricted keys can make a variant unavailable, trigger another ABR choice, and ultimately produce a restrictions error if no variant remains. This is selection policy around key usability, separate from media-sample decryption.

**Recommendation:** a native generic interface should expose system selection, session id/type/state, init-data sets, KID sets, challenge messages, opaque responses, key status/expiration, renewal reason, and `decrypt(EncryptedPacket)` or secure-decode submission. It must not assume one key per track or one session per presentation.

### 12.3 EME/browser-specific behavior to reject

Do not reproduce these as Rust architecture:

- `navigator.requestMediaKeySystemAccess`, MediaCapabilities `keySystemAccess`, and browser robustness negotiation;
- `MediaKeys`, `MediaKeySession`, `generateRequest()`, `session.update()`, `session.keyStatuses`, `session.closed`, and `setServerCertificate()` API shapes;
- the HTMLMediaElement `encrypted` event and `video.setMediaKeys()`;
- browser-specific key-ID byte-order repairs and polyfilled WebKit EME paths;
- MSE fake-encryption workarounds and SourceBuffer encryption expectations;
- browser playback-target/remote-playback session teardown quirks.

The semantics behind them—system capability negotiation, session lifecycle, init data, challenge/response, status, expiration, renewal, output policy, and rotation—remain required. This research does not reverse engineer CDMs or license protocols.

## 13. MSE dependency audit

| MSE behavior | Why Shaka uses it / media semantic | mpv equivalent | Rust responsibility | custom demux support |
|---|---|---|---|---|
| `SourceBuffer.appendBuffer` | parse container fragments, enqueue coded frames, update buffered ranges | mpv demux queues accept packets, not fragment bytes | C1/MOV must parse fragments and schedule packets | demux adapter must deliver packets/backpressure |
| `timestampOffset` | add Period/PTO/discontinuity offset to coded timestamps | none DASH-aware; mpv consumes packet PTS/DTS | rebase PTS and DTS before mpv | packet timestamps must be explicit |
| `appendWindowStart/End` | discard coded frames outside Period/play range | no direct demux append window | clip/dedup Period packets; handle preroll | discontinuity/seek contract may be needed |
| `changeType` | reuse a SourceBuffer across codec/container change | decoder chain can be rebuilt, but no equivalent promise | compatibility matrix and generation transition | stream parameter change event/reinit |
| `remove(start,end)` | explicit back-buffer eviction and switch clearing | mpv demux/cache has its own bounded queues; seek flushes | bound Rust segment/packet caches; request mpv flush on seek/switch | optional cache-range invalidation |
| `buffered` ranges | scheduling, starvation, seek decisions, UI ranges | mpv cache/buffer properties are not identical presentation ranges | maintain downloaded/demuxed/queued ranges; combine with mpv feedback | expose queue depth/consumption feedback |
| coded-frame eviction / quota | browser controls memory and may throw quota | mpv queue limits/cache eviction | enforce byte/time budgets and backpressure | adapter must block/yield without deadlock |
| `abort()` | reset MSE decode-timestamp/splice state before overlap/offset change | decoder/demux flush on seek or reinit | explicit flush/discontinuity semantics | command/event to flush affected track(s) |
| sequence mode | ignore embedded timestamps and place appends sequentially | no safe general equivalent for independent packet streams | reject for native DASH unless explicitly remuxed/re-timestamped | not normally needed for DASH |
| segments mode | embedded timestamps plus offset determine placement | closest to timestamped demux packets | normal native mode | standard packet contract |
| MediaSource duration/live seekable range | browser UI seek model | mpv duration/demux seek properties are partly equivalent | authoritative timeline and seek validation | dynamic duration/range control API likely needed |
| `endOfStream()` | tell browser no more coded frames | demux EOF | scheduler decides final EOF only after active A/V ends | distinguish temporary live starvation from EOF |
| SourceBuffer per-type operation queues | serialize mutations for each track | mpv demux thread/queues serialize differently | per-track async state and cancellation | callback/thread-safety contract |
| full MediaSource reset | rebuild all SourceBuffers and preserve playhead across incompatible boundary | reload/rebuild decoder chains | coordinated A/V flush, new configs, seek to boundary | essential boundary-reset operation |

**Interpretation:** the native engine should reproduce media semantics, not SourceBuffer calls. The biggest hidden MSE services are timestamp placement, sample clipping, codec-generation transitions, buffering feedback, memory pressure, and atomic A/V resets.

## 14. Test-suite archaeology

The following are high-value behavioral fixtures. Descriptions are summaries, not copied test source.

| Test file/group | Scenario | Expected behavior worth porting |
|---|---|---|
| `test/dash/mpd_utils_unit.js:183-408` | normal/missing `t`, gaps, overlaps, positive/negative repeats, invalid next `t`, terminal `r=-1`, PTO | exact timeline expansion/error-stop and previous-end adjustment rules |
| `test/dash/dash_parser_segment_template_unit.js:69-215` | duration/startNumber/PTO/large live duration index | presentation refs use Period/PTO; `$Time$` does not; live initial count bounded |
| same file `:736-1013` | timeline find/get/multi-period/merge/PTO change/eviction | binary lookup, lazy ref, Period clamp, stable positions, append-only update |
| same file `:1014-1270` | patterned timelines and large `r` | current implementation expands pattern/repeats correctly; exposes scalability target |
| `test/media/segment_index_unit.js` | find boundary rules, merge, partial/preload refs, eviction, iterator, MetaSegmentIndex | stable indexes and independent-part entry semantics |
| `test/dash/dash_parser_live_unit.js:224-415` | single/multi-period eviction and live duration | old refs evict, live duration stays infinite |
| same file `:597-832` | redirects, update failure, MUP missing/zero/value, slow updates, Location | exact refresh scheduling and redirect behavior |
| same file `:834-1045` | SPD, ATO, TSBD override, max-segment duration | live range/delay calculations |
| same file `:1053-1175` | parser stop during manifest/UTCTiming | all outstanding operations abort cleanly |
| same file `:1570-1718` | IPR clock sync and content-steering location change | clock offset applies; steered BaseURLs change dynamically |
| same file `:1723-1913` | Period cache | inner Period reuse, boundary reparsing, fallback IDs, no-overlap reparsing |
| `test/dash/dash_parser_patch_unit.js` | patch identity mismatch, TTL, Period add, `S` add, repeat mutation, shared timeline | invalid patch falls back; patches mutate stable cached contexts/indexes |
| `test/dash/dash_parser_manifest_unit.js:309-387,3833-3898` | implicit Period times and gaps | next Period start governs prior duration; gap count increments |
| `test/util/periods_unit.js` | ad-like Periods, unrelated Periods, track gaps, codec/language/channel/role changes, KID duplicates | semantic logical-track matching and stable output variants |
| `test/media/presentation_timeline_unit.js` | drift, availability, clock offset, safe seek start, delay, PDT regions | exact timeline formulas and millisecond rounding |
| `test/media/streaming_engine_unit.js:614-1432` | VOD/live, reverse, small gaps, EOS, append fudge, run-ahead | per-type scheduling and bounded lead |
| same file `:1433-2450` | switches and buffered/unbuffered VOD/live seeks | iterator invalidation, deferred cleanup, clear only when needed |
| same file `:2620-3838` | retry/disable/quota/network downgrade | retry policy and in-flight request abort safety |
| same file `:3938-4203,4645-5017` | embedded captions, lazy indexes, prefetch, destroy | caption state, on-demand index, cancellation, init reuse |
| `test/media/streaming_engine_integration.js:353-520` | live Period transition, seeks outside availability, gaps | transition and recovery against a real media element |
| `test/player_cross_boundary_integration.js` | clear→encrypted and encrypted boundary reset strategies | boundary stop/reset/recovery event semantics |
| `test/media/media_source_engine_unit.js` | SourceBuffer queueing, timestamp offset, append/remove/EOS/reset | identifies MSE-only mechanics and required native semantic substitutes |
| `test/abr/simple_abr_manager_unit.js` | default estimate, insufficient bandwidth, switch interval, restrictions, dropped frames | EWMA startup/hysteresis and temporary stream ban |
| `test/text/vtt_text_parser_unit.js` | cue settings/regions/styles/offset/X-TIMESTAMP-MAP/rollover | normalized VTT behavior |
| `test/text/mp4_vtt_parser_unit.js` | init, samples, multiple payloads, missing duration, invalid boxes | `wvtt` extraction boundaries |
| `test/text/ttml_text_parser_unit.js` | nested timing, frames/ticks, regions/styles, images, clipping | TTML/IMSC cue semantics |
| `test/text/mp4_ttml_parser_unit.js` | multiple `mdat`, multiple samples, per-sample clip, IMSC image | `stpp` extraction and timing |
| `test/cea/mp4_cea_parser_unit.js` | H.264/H.265/AV1 SEI, raw 608, multiple `trun` offsets | embedded caption extraction |
| `test/dash/dash_parser_content_protection_unit.js` | inherited/overridden KIDs, PSSH/PRO, generic CENC/CBCS, incompatible systems | manifest protection normalization |
| `test/drm/drm_engine_unit.js` | system choice, duplicate/new init data, multiple sessions, statuses, expiration, renewal, in-band PSSH | generic session/key lifecycle (with EME adapter replaced) |
| `test/drm/drm_engine_integration.js` | audio/video with different keys | multi-key playback/session readiness |

Licensing note: Shaka Player is Apache-2.0, but a later Rust test port should preserve attribution and preferably express scenarios independently rather than mechanically copying large fixtures or source blocks.

## 15. Conceptual mapping to native Rust

| Shaka concept | Native candidate | Ownership/lifetime |
|---|---|---|
| `DashParser` + inheritance context | `DashManifestParser` | parse task; returns snapshot/delta |
| `Manifest` | `ManifestSnapshot` | immutable generation, session references current snapshot |
| Period-local Stream | `Representation` inside `AdaptationSet`/`Period` | manifest generation |
| flattened logical Stream | `Track` with Period spans | playback session |
| `Variant` | `Variant`/compatible A+V pairing | manifest/session selection view |
| `PresentationTimeline` | `PresentationTimeline` | playback session, synchronized clock input |
| `SegmentIndex` | `SegmentIndex` trait | representation/span; compact implementation by addressing mode |
| `TimelineSegmentIndex` | run-based `TimelineIndex` | mutable live index, stable absolute ordinal |
| `MetaSegmentIndex` | `TrackIndex` of Period spans | logical track |
| `SegmentReference` | `SegmentRef` | cheap value/lazy URL, presentation times |
| `InitSegmentReference` | `InitRef` + `CodecConfigGeneration` | representation/init generation |
| `StreamingEngine` | `SegmentScheduler` | playback session |
| `MediaState_` | `TrackRuntime` | selected audio/video/text track |
| `SegmentPrefetch` | `PrefetchQueue` | selected representation/track runtime |
| `NetworkingEngine` | `NetworkEngine` | application service; requests are session-scoped/cancellable |
| `PendingRequest` | `RequestHandle` | request attempt; abort + metrics |
| `SimpleAbrManager` | `AbrController` | playback session |
| `DrmInfo` | `DrmDescriptor` + `DrmInitData` | manifest/representation/Period span |
| generic `DrmEngine` state | `DrmSessionManager` | playback session; delegates to `DrmSystem` backend |
| EME | not ported | browser-only adapter model |
| `TextEngine` parsers + Cue | `SubtitlePipeline` + `Cue` IR | track runtime and renderer adapter |
| `MediaSourceEngine` | not ported | replace with MOV demux, packet queues, mpv adapter semantics |

Recommended state placement:

- `ManifestSnapshot`: protocol IDs, timing declarations, BaseURL/service-location graph, Period/AdaptationSet/Representation metadata, DRM descriptors, segment-addressing declarations.
- `PlaybackSession`: current snapshot generation, timeline/clock sync, selected tracks/variants, playhead/seek generation, scheduler, ABR, DRM manager.
- `Track`: language/roles/type and compatible Period spans; no request handles.
- `Representation`: codec/quality/init/index factory; no current iterator or bandwidth estimate.
- `TrackRuntime`: current representation/span, iterator ordinal, init/config generation, request/demux/decrypt/packet state, queued-range accounting.
- `RequestHandle`: URI attempt, range, headers, deadline, cancellation, progress, response metadata.
- `DrmSession`: backend/session id, init-data fingerprint, KIDs/statuses/expiration, active license operation.

Avoid global mutable stream maps, wall-clock offsets, or key maps. Cross-session shared services may hold HTTP pools, DNS/cache, and CDM factories, but presentation state belongs to the playback session.

## 16. Revisit of Phase A options

| Option | Shaka semantics that fit | Remaining mismatch after this research |
|---|---|---|
| A: one libmpv stream callback | network ownership and sequential segment choice for one already-valid container | cannot express independent track indexes, packet timestamps, codec generations, per-track starvation, or packet crypto metadata |
| B: custom mpv demuxer | logical tracks, presentation-time seek, per-type runtime, explicit packet/discontinuity/config transitions, queue feedback | mpv fork/ABI, decoder-reset semantics, dynamic track UI, packet backpressure |
| C1: Rust scheduler + FFmpeg MOV | Shaka parser/timeline/index/network/ABR above mature fMP4 sample extraction; clean access to CENC side data | multiple MOV contexts, init changes, cancellation, packet interleave, seeks, context lifetime |
| D: coordinated component callbacks | separate Shaka-like audio/video/text schedulers using public libmpv protocol and FFmpeg demux | byte-offset API, independent-demux rendezvous, live growing seek maps, no packet decrypt interception, weak atomic boundary reset |

Shaka strongly supports two Phase A conclusions. First, scheduling must operate on presentation-time segment references, not merely concatenate bytes. Second, representation choice must be separate from decoder/sink transition. These point away from A as a final architecture and toward a packet-aware B+C1 boundary.

## 17. B+C1 combined architecture

```text
ManifestSnapshot + PresentationTimeline + compact TrackIndex
                         |
                   SegmentScheduler
              / audio / video / text \
             NetworkEngine + ABR + DRM sessions
                         |
       representation/init-generation byte feeds
                         |
         FFmpeg MOV AVFormatContext per active feed
                         |
       AVPacket + codec parameters + CENC side data
                         |
          DrmSystem -> clear compressed AVPacket
                         |
              custom mpv demux adapter
                         |
            mpv decode / hwdec / A/V sync
```

Natural mappings:

- Shaka `Stream`/`SegmentIndex` -> Rust representation/track indexes;
- `MediaState_` -> per-track fetch/demux/decrypt/queue runtime;
- timestamp offset -> explicit AVPacket PTS/DTS rebasing;
- append window -> packet/sample Period clipping;
- init-reference equality -> MOV/codec-config generation equality;
- SourceBuffer operation queue -> per-track packet producer with bounded queues;
- buffered-ahead/run-ahead -> queued presentation ranges plus mpv consumption feedback;
- ABR switch proposal -> scheduler switch plan at independent segment boundary;
- DRM `newInitData` -> session acquisition before encrypted packets are released;
- MediaSource reset -> coordinated mpv demux/decoder generation reset.

Difficult semantics:

1. FFmpeg MOV contexts consume byte streams, while the scheduler wants discrete segments and cancellable seeks. The AVIO contract must distinguish temporary starvation, segment EOF, representation end, and fatal EOF.
2. Reusing one MOV context across a changed init/extradata is not automatically safe. Context replacement and timestamp continuity need fixtures.
3. mpv must receive codec parameter/extradata changes at an independent packet boundary and decide flush/reinit for software and hardware decoders.
4. Audio/video packet queues need a common presentation epoch and bounded run-ahead while mpv pulls asynchronously.
5. Live seek must cancel all layers atomically: request, AVIO read, MOV demux, DRM wait, packet queue, and mpv decoder state.
6. FFmpeg exposes encryption side data, but ownership and mutation across Rust/FFmpeg/mpv must be proven for all CENC schemes and key rotation.
7. Text may be better parsed in Rust than passed as FFmpeg subtitle packets, particularly for `stpp`/IMSC to ASS conversion.
8. mpv's demux API does not have a stable external plugin ABI, so packaging and upgrade cost remain substantial.

**Interpretation:** C1 reduces container work but does not remove the need for a real media-engine contract. B supplies that contract to mpv. Therefore B+C1 is coherent precisely as a combined architecture; C1 alone still needs an adapter capable of B-like semantics.

## 18. Recommended proof-of-concept boundaries

No production implementation should start until narrow experiments settle these questions.

### PoC 1: pure model, no playback

Build only a disposable parser/timeline/index test harness against independently described Shaka scenarios. Cover inheritance, Period calculation, all `<S>` cases, compact repeats, live availability/UTCTiming, identity-based full refresh, Patch additions, and Period disappearance. Demonstrate that a million repeated segments remain compact and lookup stays logarithmic in runs.

### PoC 2: D, clear and codec-stable

Use in-process libmpv only and expose `rustdash://video`, `rustdash://audio`, and optionally `rustdash://subtitle`. Limit scope to static or simple live CMAF, one codec configuration per component, no DRM, and aligned segments. Measure load, A/V sync, pause/starvation, seek rendezvous, and representation byte-continuity. Treat failure as evidence about the byte-callback ceiling, not a reason to add production workarounds.

### PoC 3: C1 packet laboratory without mpv integration

Feed init plus discrete fragments to one FFmpeg MOV context per component. Record emitted codec parameters, packet PTS/DTS/duration/keyframes, edit-list effects, PSSH, and `AV_PKT_DATA_ENCRYPTION_INFO`. Exercise seek by destroying/recreating contexts at target init+fragment, representation init changes, B-frames, gaps/overlaps, and KID rotation.

### PoC 4: minimal B adapter, clear packets

Patch one pinned mpv revision with a demuxer that exposes two stable tracks and clear FFmpeg-generated packets. Prove backpressure, cancellation, presentation seek, temporary live starvation versus EOF, decoder parameter changes, and hwdec behavior. Do not add DRM protocols.

### Decision gate

Choose B+C1 only if PoC 4 proves a small, maintainable adapter contract and PoC 3 proves deterministic MOV context/config transitions. Keep D only if it survives live seek and representation transitions without unstable virtual byte offsets; otherwise retain it as a test harness.

## 19. Unanswered questions

1. Can the selected FFmpeg version reliably resume one MOV context across arbitrary CMAF representation init changes, or must every config generation create a new context?
2. What exact mpv internal signal safely updates codec parameters/extradata and rebuilds hwdec without presenting a new user-visible track?
3. Can mpv expose reliable per-track consumed/queued presentation ranges to a custom demuxer, or must Rust approximate from packet pull position?
4. How should decode preroll before a Period append window be represented so dependent frames decode but are not presented?
5. What policy should reconcile audio/video Period boundaries that are not sample-aligned?
6. Should the native engine preserve Shaka's semantic Period flattening, or expose explicit Period spans and let track identity be more conservative?
7. Which codec/container/config transitions are seamless on VideoToolbox, D3D11VA, VA-API, and software decoders?
8. How will dynamic added/removed tracks map to mpv's mostly load-time track model and ynoTV's UI IDs?
9. Is a packet-level text path needed in mpv, or should all DASH text be normalized to cues and emitted as ASS/libass events?
10. Which TTML/IMSC styling features cannot be represented in ASS and need a native overlay renderer?
11. Does the product require a hardware-secure DRM path? If yes, clear compressed packets in ordinary Rust/mpv memory may be unacceptable regardless of session design.
12. What CDM API can legally and technically provide packet decryption, key status, renewal, and output restrictions on each target platform?
13. How should content steering health interact with ordinary URI retry so one failing CDN does not consume all segment deadlines?
14. Should MPD conditional requests and cache validation be enabled by default for live, given that Shaka does not currently model them?
15. What numeric representation avoids PTO/timescale precision loss for very large media times—rational/int128 ticks until the mpv boundary is preferable to early floating-point seconds.
16. How should negative repeat with an infinite last Period be represented? Shaka rejects/ignores it despite the spec allowance; a native engine needs an explicit compatibility decision.
17. Which Shaka scenario fixtures can be reused directly under Apache-2.0 and which should be independently regenerated for clearer ownership?

## 20. Final recommendation

Use Shaka as the behavioral oracle for normalized identity, presentation-time math, refresh/eviction, multi-period logical tracks, per-type scheduling, ABR proposal/commit separation, cue normalization, and generic DRM session state. Do not copy its expanded SegmentTimeline representation, browser networking transport, EME object model, or MSE buffer operations.

The native architecture should keep Rust authoritative for manifest/timeline/index/scheduling/network/ABR/text/DRM lifecycle; keep FFmpeg MOV authoritative for fragmented-container and CENC metadata parsing; and keep mpv authoritative for decode, hwdec, final A/V sync, output, and rendering. B+C1 best matches those boundaries, while D is the appropriate no-fork prototype for discovering whether a byte-oriented integration can satisfy a deliberately limited subset.

## 21. Research completion record

At completion:

```text
ynoTV git status --short --untracked-files=all:
?? docs/research/01-ynotv-mpv-architecture.md
?? docs/research/02-shaka-native-dash-architecture.md

Shaka git status --short:
(clean)
```

The only file created by this phase is `docs/research/02-shaka-native-dash-architecture.md`. The pre-existing Phase A report remains untracked and was not modified. The exact Shaka commit researched is `bf7ea8dc386991fd84963df8eb5e271b046082fa`.
