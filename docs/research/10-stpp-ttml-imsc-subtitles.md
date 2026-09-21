# C7 STPP, TTML, and IMSC subtitles

Research/implementation snapshot: 2026-09-21 (Asia/Singapore)

## Result

C7 is **PARTIAL**. The native manifest model now discovers multiple DASH TTML
subtitle AdaptationSets, retains their stable identities and metadata, schedules
them through the same C6 `CompactTimeline`/`SegmentIndex`, demuxes `stpp` with
FFmpeg MOV, and publishes ordinary mpv `STREAM_SUB` tracks. The tested pinned
FFmpeg/mpv stack cannot decode TTML directly, so text TTML is semantically
parsed with `quick-xml`, normalized, converted to timed ASS events, and rendered
through mpv's existing libass subtitle path.

The implementation detects embedded and MP4-subsample IMSC image cues, keeps
them out of the text converter, and sends normalized timed bitmap packets to a
private mpv adapter. The adapter decodes PNG, applies cue opacity, and presents
premultiplied BGRA at the TTML region through mpv's normal subtitle compositor.
Live seeking, pixel-level styled text rendering, and a multi-refresh real-session
run were not completed. C7 as a whole therefore remains partial.

No SRT/WebVTT work, ABR, Widevine, PlayReady, player UI redesign, video decoder
change, or video-output change was made.

## MPD subtitle discovery

`native_dash.rs` recognizes a representation as DASH TTML when the inherited
metadata establishes one of these supported shapes:

- `contentType="text"` with `application/mp4` and a codec token beginning with
  `stpp`;
- inherited or representation-level `mimeType="application/ttml+xml"`;
- `application/mp4` plus `stpp`, including profile-bearing codec strings such
  as `stpp.ttml.im1t`.

The parser does not use array position as language or identity. Each subtitle
track retains Period, AdaptationSet, and Representation identity; language;
Label; Role values; Accessibility values; MIME type; codec string; bandwidth;
and default/forced role semantics. One deterministic lowest-bandwidth
representation is selected per subtitle AdaptationSet. This is track discovery,
not ABR.

The supplied live MPD exposed two subtitle AdaptationSets:

```text
id=5  contentType=text mimeType=application/mp4 lang=zh  role=subtitle
      representation=s10000_chi bandwidth=10000 codecs=stpp
id=6  contentType=text mimeType=application/mp4 lang=chs role=subtitle
      representation=s10000_chs bandwidth=10000 codecs=stpp
```

Both use `SegmentTemplate`/`SegmentTimeline` at timescale 1000. The live-v4
packet header carries language, title/label, default, and forced fields into
`sh_stream`, so mpv's existing track list and `sid` selection controls remain
the user-visible selector. A standalone pinned-mpv probe showed:

```text
Subs --sid=1 --slang=zh 'Traditional Chinese' (ttml) [default]
```

The existing ynoTV `getTrackList` / `setSubtitleTrack` / `sid=no` code therefore
needs no second subtitle selector. Selection/off and switching were not run in
the full UI.

## C6 scheduling and dynamic refresh

Subtitle `RepresentationSnapshot`s contain the same `SegmentTemplate` and C0
`CompactTimeline` used by video/audio. Subtitle descriptors use the unchanged
presentation formula and identity:

```text
(Period identity, AdaptationSet identity, Representation identity,
 media kind=Subtitle, unscaled media_time)
```

They consequently inherit Period start, timescale, presentationTimeOffset,
`t/d/r/r=-1`, `$Number$`/`$Time$`, window eviction, advertised/unadvertised
state, fetched/demuxed identity sets, refresh generations, and C3 cancellation.
`SegmentIndex::merge` now iterates video, audio, and every selected subtitle
representation. A focused refresh test proves a fetched subtitle identity is
retained and not scheduled again after a sliding timeline update.

The runtime downloads subtitle init/media through the same cancellation-aware
HTTP client, batches each subtitle component beside video/audio, preserves its
track number across generations, and leaves the live connection open while the
next text segment is absent. It emits final EOF only where the pre-existing C6
contract does. The C6 delayed `RDPKT003` starvation regression still passes.

The implementation currently waits for at least one new segment for every
selected component before appending the next batch. Unequal component segment
durations need a longer real-stream soak test. No real UI session was observed
across multiple refresh generations in this phase.

## FFmpeg MOV STPP behavior

The tested stack was pinned mpv commit
`cfd818bcaef262f82596f49444ee80073fa6d49a` linked to FFmpeg 8.0
(`libavformat 62.3.100`, `libavcodec 62.11.100`, `libavutil 60.8.100`).
FFmpeg's DASH demuxer was not used.

For the supplied stream, init plus one `.cmft` media segment produced:

| Field | Observed value |
|---|---|
| codec ID/name | `AV_CODEC_ID_TTML` / `ttml` |
| codec type | subtitle |
| codec tag | `stpp` / `0x70707473` |
| extradata | 28 bytes: `http://www.w3.org/ns/ttml` plus NUL padding |
| time base | `1/1000` |
| packet PTS | `1789964088000` |
| packet DTS | `1789964088000` |
| packet duration | `8000` |
| packet size | 1237 bytes |
| payload | one complete UTF-8 TTML XML document |

The observed document used `ttp:timeBase="media"`; its cue clock expressions
were absolute media-clock times such as `497212:14:48.237`. This is why the
bridge subtracts the subtitle segment's unscaled media start exactly before it
adds the C6 presentation placement. The helper's packet PTS/DTS/duration and
time base remain integers/rationals until the final mpv packet boundary.

The revised component producer accepts video, audio, and up to six subtitle
component files. It finds subtitle streams with `AVMEDIA_TYPE_SUBTITLE`, copies
TTML codec/extradata/timing, and interleaves packets with `av_compare_ts`. A
three-track local probe emitted H.264, AAC, and TTML configurations. A/V were
CENC-decrypted; the clear TTML packet passed through unchanged.

## Direct mpv subtitle-path result

The direct probe was deliberately performed before conversion. Opening the
real init+segment with the pinned mpv produced a normal TTML subtitle track but
failed with:

```text
Could not open libavcodec subtitle converter
Could not find subtitle decoder for format 'ttml'.
```

FFmpeg 8.0 identifies and demuxes TTML but does not supply the subtitle decoder
mpv's `sd_ass` conversion path requires. Direct TTML packets therefore cannot
render in this pinned stack.

## Text TTML bridge

`ttml.rs` is the smallest text bridge used after that negative probe:

```text
FFmpeg TTML AVPacket
  -> quick-xml document parser
  -> TextCue / StyledSpan / Region
  -> timed ASS packet
  -> STREAM_SUB(codec=ttml, ASS bridge marker in codec-private data)
  -> mpv sd_ass
  -> libass
```

It uses `quick-xml` for XML structure, entity handling, attributes, text, and
CDATA. It does not strip tags or implement XML tokenization. Style references
and ancestor inheritance are resolved before rendering. The renderer-neutral
cue retains exact start/end, nested styled spans, region, origin, extent,
display alignment, text alignment, writing mode, font properties, colors,
opacity, decoration, line height, and ruby metadata. Unknown paragraph
attributes are retained as unsupported feature names and logged once for the
converted packet rather than silently discarded.

ASS packets use libass codec-private data and timed chunk syntax, while the
public track codec remains `ttml`. A small `sd_ass` guard recognizes only TTML
tracks whose codec-private data begins with the bridge's `[Script Info]` header;
ordinary raw TTML still takes the normal decoder/converter path. Region origin
is mapped into a 100x100 ASS play space; bold, italic, underline, foreground
color, line breaks, and nested style resets are emitted as ASS overrides. A
pinned-mpv live-v4 probe selected the resulting track and initialized libass
successfully. It did not produce a pixel/screenshot oracle and is therefore not
claimed as complete visual conformance.

## Timing and segment-relative placement

TTML time remains `ExactTime`, a reduced signed rational. Supported forms are:

- clock time with hours/minutes/seconds and fractional seconds;
- clock time with frames and subframes;
- offset hours, minutes, seconds, and milliseconds;
- frame offsets;
- tick offsets;
- `frameRate`, `frameRateMultiplier`, `subFrameRate`, and `tickRate`.

For a subtitle track, the bridge computes:

```text
cue relative to first demux batch
  = TTML cue media time - first subtitle segment media_time/timescale

final presentation time
  = cue relative to first demux batch
    + first subtitle segment presentation start
    - session presentation origin
```

Only the final ASS/mpv packet conversion rounds to milliseconds. A cue beginning
before the containing packet is clipped to that packet's start. A cue ending
after the containing segment is kept whole so it remains visible across the
boundary. A per-session logical-cue set uses track, exact original start/end,
and normalized payload, preventing the same carry-over cue from being emitted
again by an adjacent segment or MPD refresh. The set is owned by the C6 session
and is discarded with its epoch.

Regression coverage includes a cue beginning before the current segment, a cue
ending after it, and identical documents appended twice. The result was one
visual event per logical cue with the leading start clipped and no refresh
duplicate.

## Text style/region support matrix

| TTML property | Normalized | ASS output | Status |
|---|---:|---:|---|
| nested spans | yes | yes | tested |
| region reference | yes | partial | tested |
| origin | yes | `pos` | tested, percentage form |
| extent | yes | retained | not yet used for wrapping/clipping |
| displayAlign | yes | retained | incomplete ASS mapping |
| textAlign | yes | retained | incomplete ASS mapping |
| writingMode | yes | retained | unsupported renderer mapping, diagnostic required |
| fontFamily | yes | retained | not emitted yet |
| fontSize | yes | retained | not emitted yet |
| fontWeight | yes | bold override | tested |
| fontStyle | yes | italic override | tested |
| color | yes | BGR ASS color | tested |
| backgroundColor | yes | retained | global translucent ASS box only |
| opacity | yes | retained | not emitted yet |
| textDecoration | yes | underline | tested for underline |
| lineHeight | yes | retained | not emitted yet |
| ruby | yes | retained | no ASS/libass ruby mapping |
| EBU linePadding/wrapOption | detected as unsupported | no | diagnostic |

This is a functional subset, not Shaka-equivalent styling.

## Shaka compatibility oracle

The exact Phase-B checkout remains at
`bf7ea8dc386991fd84963df8eb5e271b046082fa`. Its TTML tests confirm the expected
segment-start clipping behavior and its MP4 TTML suite includes an open IMSC
image CMAF fixture. The native normalized unit fixtures cover corresponding
exact timing, region/origin/extent, inherited styles, nested spans, colors,
line breaks, and embedded image classification.

The requested executable normalized Shaka-versus-native comparison was not
completed. Running:

```text
python3 build/test.py --filter TtmlTextParser --quick
```

failed before tests because the checked-out Closure compiler requires Java
class version 65 (Java 21), while the installed runtime supports class version
61 (Java 17). Node also reported package engine warnings. Expectations were not
copied from Shaka into production code and compatibility is not claimed from
source inspection alone.

## IMSC image behavior

The parser recognizes SMPTE/IMSC `backgroundImage`/`image` references on `p`
and image-bearing `div` cues. It supports embedded Base64 PNG, PNG data URIs,
and `urn:mpeg:14496-30:subs:N` references to image subsamples appended to an
FFmpeg `stpp` packet. Exact nested timing follows Shaka's parent-relative rule.
Percent, pixel (with root extent), and cell region geometry are normalized to
an integer viewport before entering the renderer.

Bitmap packets carry timing, viewport, opacity, and PNG bytes. The opt-in mpv
TTML bridge queues them, decodes PNG with mpv's image loader, premultiplies
alpha, packs all simultaneously active cues into a reference-counted BGRA
atlas, and returns `SUBBITMAP_BGRA`; text packets on the same track continue
through libass. Unsupported external image URLs and non-PNG image types fail
explicitly. No mpv video decoder or video-output code was modified.

The bridge publishes converted text/bitmap packets and their track config at
the same `1/1000` time base. This is required for sources whose original STPP
track uses another scale (the bitmap Astro sample uses `1/90000`); retaining the
source scale while emitting millisecond packets makes the strict live demuxer
reject the first subtitle packet as an invalid header.

## Track selection, refresh, and seek

The live-v4 adapter publishes stable `STREAM_SUB` tracks once at demux open.
It supplies codec identity/extradata plus language, title, default, and forced
metadata. mpv selection filters packets through `demux_stream_is_selected`, so
disabled/unselected subtitle packets do not enter the subtitle decoder. This
uses normal mpv track controls and does not reload playback.

Subtitle identities and fetched/demuxed sets survive MPD generations. An
unchanged track is not recreated and an overlapping media-time identity is not
redownloaded. New identities are appended; vanished known identities expire.

The current C6 live adapter is deliberately non-seekable, so forward/backward
DVR seek and pending-fetch seek cancellation were not accepted for subtitles.
The C3 finite-source blocked-seek/epoch regressions remain green, but they do
not prove live C7 seek behavior. UI off/A/B language switching also remains a
manual acceptance item.

## CENC subtitle result

The component producer now applies the existing C4 transform only when FFmpeg
provides `AV_PKT_DATA_ENCRYPTION_INFO`; otherwise it copies a clear packet. This
is payload-agnostic and covers the intended encrypted-STPP architecture without
a subtitle-specific decryptor. The supplied stream's subtitle packet was clear,
while its A/V components were CENC-encrypted. A local combined probe proved
encrypted H.264/AAC plus clear TTML in one helper run. Encrypted STPP was not
available and remains explicitly untested.

## Fixtures and real probe

- Existing synthetic C0/C2/C3/C4 H.264/AAC fixtures were retained.
- New in-code deterministic TTML fixtures cover styles, region/origin/extent,
  nested spans, exact timing expressions, leading/trailing boundary crossings,
  duplicate adjacent documents, two subtitle metadata shapes/languages, and an
  embedded base64 image cue.
- The supplied live stream was used for MPD discovery and one clear STPP sample
  from each of its two languages. No URL token or content key is stored in this
  report or repository.
- The pinned Shaka repository's open IMSC CMAF fixture was inspected but not
  copied into production or rendered natively.

The live probe was not launched through the normal ynoTV UI. It did not cross a
measured sequence of application refresh generations.

## Files changed

- `packages/app/src-tauri/src/native_dash.rs`
- `packages/app/src-tauri/src/ttml.rs`
- `packages/app/src-tauri/src/lib.rs`
- `experiments/clearkey-cenc-packet-transform/cenc_component_producer.c`
- `experiments/mpv-packet-demux-adapter/rustdash_packet_abi.h`
- `experiments/mpv-packet-demux-adapter/mpv-patch/demux_rustdash.c`
- `experiments/mpv-packet-demux-adapter/mpv-patch/ttml-ass-bridge.patch`
- `experiments/mpv-packet-demux-adapter/mpv-patch/ttml-bitmap-bridge.patch`
- `experiments/mpv-packet-demux-adapter/apply-to-mpv.sh`
- `scripts/dev-native-dash.mjs`
- `docs/research/10-stpp-ttml-imsc-subtitles.md`

## mpv patch changes

The C7 delta adds `RDP_TRACK_SUBTITLE`, accepts more than two tracks, maps it to
`STREAM_SUB`, and introduces `RDPKT004` live headers with bounded language/title
strings and default/forced flags. A narrow `sd_ass` condition accepts
semantically converted TTML packets while preserving their public `ttml` codec
identity. It does not modify libass, the OSD compositor, video decoders, or
video output. The full
experimental demux source is now 812 lines; the C7 delta in that file is 44
insertions and 12 deletions, plus five ABI-header lines. The older v1/v2/v3
formats remain accepted and their regressions pass.

The development launcher now requires the `RDPKT004` marker when selecting a
UI libmpv. An earlier C7 manual launch exposed that checking only for the C6
`RDPKT003` marker could select an old library: that demuxer rejected the v4
header and immediately closed the loopback bridge after all initial downloads.
The launcher now fails early rather than presenting this ABI mismatch as
`Native DASH packet bridge disconnected`.

## Exact tests run

```text
cd packages/app/src-tauri
cargo check --lib
cargo test --lib native_dash::tests -- --nocapture
cargo test --lib ttml::tests -- --nocapture
cargo test --lib

cd experiments/clearkey-cenc-packet-transform
./build.sh
./run-local-tests.sh
./run-playback-tests.sh /tmp/ynotv-c7-mpv2.69ZFxQ/build-c7/mpv \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib

cd experiments/mpv-packet-demux-adapter
./run-tests.sh /tmp/ynotv-c7-mpv2.69ZFxQ/build-c7/mpv \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib
./run-live-generation-tests.sh /tmp/ynotv-c7-mpv2.69ZFxQ/build-c7/mpv \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib \
  /tmp/ynotv-c7-mpv2.69ZFxQ
python3 live_stream_test.py /tmp/ynotv-c7-mpv2.69ZFxQ/build-c7/mpv

cd /tmp/ynotv-c7-mpv2.69ZFxQ
PKG_CONFIG_PATH=/private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib/pkgconfig \
DYLD_LIBRARY_PATH=/private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib \
meson test -C build-c7 --print-errorlogs

pnpm --filter @ynotv/ui test -- --run src/services/__tests__/nativeDash.test.ts
pnpm --filter @ynotv/local-adapter test -- --run src/__tests__/m3u-kodiprop.test.ts
git diff --check
node scripts/dev-native-dash.mjs --print-libmpv
```

Original C7 results: Rust 94/94; native DASH focused 12/12; TTML 3/3; UI routing
6/6; M3U KODIPROP 1/1; C2 playback PASS; C3 generation/cancellation PASS;
C4 local equivalence/error and software/VideoToolbox playback PASS; C6 delayed
live starvation PASS; pinned mpv 39/39; `git diff --check` PASS. The live-v4
subtitle-only probe created the expected `STREAM_SUB`, language/title/default
metadata, public TTML codec identity, and libass initialization. `cargo fmt --check` is not a
usable repository gate because it reports large pre-existing formatting diffs
throughout unrelated files; no bulk formatting was applied.

## Known unsupported or unaccepted behavior

- Shaka-normalized automated equivalence output;
- ruby rendering, vertical writing, complete region extent/clipping,
  displayAlign/textAlign mapping, font family/size, per-span background/opacity,
  line height, EBU line padding, and wrap behavior;
- external-URL and non-PNG IMSC image resources;
- encrypted STPP fixture coverage;
- live DVR seek and pending subtitle fetch cancellation;
- full UI subtitle off/A/B switching and real multi-generation acceptance;
- a pixel/screenshot oracle for positioned/styled text;
- subtitle track addition/removal after demux open (the tested MPD kept stable
  AdaptationSets).

Can a UI-selected live DASH session expose and continuously render both text
STPP/TTML and IMSC image subtitle tracks through the native pipeline?

PARTIAL

Evidence:
The supplied MPD's STPP tracks are discovered with stable identities and
metadata; FFmpeg MOV emits `AV_CODEC_ID_TTML` packets; the negative direct mpv
probe is documented; the semantic text bridge produces deduplicated,
presentation-timeline ASS events; and IMSC PNG cues now traverse the same track
into mpv's BGRA subtitle compositor. Shaka's public auxiliary-image CMAF sample
parses with the expected time and pixel-normalized region, all 98 Rust library
tests pass, and the patched `sd_ass.c` compiles. Normal-UI live
refresh/seek/track-switch and screenshot acceptance are still not completed.
