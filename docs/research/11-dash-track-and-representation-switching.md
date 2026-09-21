# C8 DASH track and Representation switching

Research/implementation snapshot: 2026-09-21 (Asia/Singapore)

## Result and scope

C8 implements DASH video-Representation discovery, a manual quality catalog,
same-codec in-session video switching, logical audio-track discovery, and
in-session audio switching. It does not implement ABR, throughput estimation,
automatic quality choice, Widevine, or PlayReady.

The deterministic packet/mpv acceptance is positive. One pinned-mpv session
decoded `320x180 -> 640x360 -> 320x180` on one user-visible video stream. The
same session exposed two logical audio streams, and `aid=1 -> aid=2 -> aid=1`
reopened AAC without restarting video. Independent PCM inspection measured
440.8 Hz and 879.7 Hz for the two packet sources.

The normal ynoTV UI was not launched against an authorized real live stream in
this phase. No real URL or credentials were available in the process
environment. The final answer is therefore **PARTIAL**, despite passing model,
protocol, decoder, audio-source, frontend, ClearKey, subtitle, refresh, and
pinned-mpv regressions.

## Manifest track model

The native parser no longer reduces the current Period to one video and one
audio Representation while parsing. For its supported one-Period,
SegmentTemplate/SegmentTimeline subset it retains:

- every ordinary video AdaptationSet and all of its supported MP4
  Representations;
- every audio AdaptationSet as one logical audio track, with all supported MP4
  Representations;
- every supported TTML/STPP text AdaptationSet, preserving the C7 track model.

Adaptation metadata includes stable/fallback identity, content type, MIME type,
codecs, language, Label, Role, Accessibility, `selectionPriority`, and audio
channel configuration. Representation metadata includes ID, bandwidth,
resolution, frame rate, codecs, MIME type, audio sampling rate, the effective
SegmentTemplate, CompactTimeline, BaseURL, and initialization identity.

Identity remains semantic:

```text
(Period identity, AdaptationSet identity, Representation identity, media kind)
```

Segments remain identified by that Representation identity plus unscaled
`media_time`. Neither tracks nor segments use vector position as identity.

The pre-existing limitation remains: the application parser supports exactly
one Period. C8 preserves the complete hierarchy inside that Period; it does
not claim multi-Period playback.

## Logical track versus Representation model

The native model now separates:

```text
LogicalVideoTrack
  adaptation_set_id
  AdaptationSet metadata
  representations[]

LogicalAudioTrack
  adaptation_set_id
  language / label / roles / accessibility
  channel configuration / selectionPriority
  representations[]
  deterministic selected Representation
  stable mpv audio-track ID
```

A video bitrate/resolution Representation is not published as another mpv
track. All compatible video Representations feed one stable `sh_stream`.
Distinct audio AdaptationSets are published as distinct `STREAM_AUDIO`
objects. Multiple bitrate Representations inside one audio AdaptationSet are
not exposed as separate audio tracks.

## Video quality catalog and UI

Two Tauri commands expose and control the active catalog:

```text
native_dash_get_track_catalog
native_dash_select_video_representation
```

Each video option contains Representation ID, width, height, bandwidth, codec,
frame rate, a `WIDTH×HEIGHT` display label, and compatibility state. There is
no Auto option. Bitrate is secondary UI text.

The normal and alternate player control rows expose a dedicated `Q` button that
opens the manual `Video Quality` modal. This reuses the existing control/modal
styling and does not redesign the player. Incompatible choices are visible but
disabled. The catalog and commands are also available through the existing
TypeScript `Bridge` facade.

Startup follows active selection rather than catalog breadth. Init/config
requests for initially visible audio and subtitle tracks run concurrently so
mpv can publish their track-list entries, but only the current video and
initial audio track download a media segment. Subtitle media starts only after
`sid` selects that logical track. Unselected audio, subtitle, and video
Representations do not download media. The initial live window is one latest
complete segment.

## Initial selection policy

Video startup remains conservative and fixed: the active logical video
AdaptationSet is chosen deterministically by `selectionPriority`, main role,
and stable AdaptationSet ID; its lowest-bandwidth Representation wins, with
Representation ID as the tie-breaker. This is not ABR.

Audio AdaptationSets are ordered by `selectionPriority`, main role, then stable
AdaptationSet ID. Their language and default metadata are published to mpv, so
existing mpv/ynoTV language selection can select among the visible streams.
Before that selection occurs, the first ordered logical audio track is used.

Inside each logical audio AdaptationSet C8 deterministically chooses the
highest advertised bandwidth, with Representation ID as a stable tie-breaker.
There is no audio ABR and no later automatic bitrate change.

## Video switch state machine

The Rust session records these explicit states:

```text
Stable
  -> SwitchRequested
  -> TargetPreparing
  -> WaitingForBoundary
  -> Committing
  -> Stable
```

Every user selection increments a switch generation carried through a Tokio
watch channel. A newer choice wakes the scheduler. If a request arrives while
the prior target is downloading/demuxing, its child cancellation token is
cancelled, the future is dropped, segment lifecycle state is reset, and no
codec-generation record is committed. A request that becomes stale after
preparation is likewise discarded. This prevents an older 720p request from
committing after a newer 1080p request.

The player is never reloaded. The loopback session, mpv demuxer, video
`sh_stream`, subtitle streams, and playback session remain alive.

## Segment-alignment strategy

Alignment is based on exact C0 presentation intervals, not vector indexes or
segment numbers. Every Representation owns its own CompactTimeline with its
own timescale, PTO, Period start, startNumber, `$Time$`, and `$Number$`
semantics.

For a proposed target, C8 first requires at least one exact matching
presentation interval and the same tested codec family. At commit time the
target must have a segment beginning at the scheduler's exact presentation
frontier. Audio and subtitle segments are located by the half-open interval
that covers that video boundary.

After FFmpeg MOV demux, the first target video packet must be a keyframe. If
the timeline boundary or random-access packet cannot be established, the
switch fails explicitly instead of splicing dependent compressed video.

Only one future video segment is prepared per scheduler iteration. Previously
committed old packets therefore define the boundary; no old Representation
packet is produced beyond it. The C3 bounded queue and cancellation contract
remain active. Already presented frames are untouched.

The live adapter treats 128 KiB as its ordinary FIFO byte budget, not as a
media-packet validity limit. A single larger video or IMSC bitmap packet may
enter only when the FIFO is empty and remains bounded by the 64 MiB hard packet
limit. This prevents large valid subtitle-image packets from being rejected as
an invalid live header while preserving bounded producer memory.

## Codec/config generations

`RDPKT005` extends the live packet protocol with a `CFG1` runtime codec
generation record. A new Representation is opened with its init plus the
aligned media segment in a fresh FFmpeg MOV context. Rust remaps the resulting
configuration and packets onto stable video track 1 and assigns an immutable
generation number.

The pinned adapter registers the new generation, marks v5 packets segmented,
and attaches the generation-specific `mp_codec_params`. mpv's unchanged
decoder wrapper drains/reinitializes at the boundary. Configuration objects
remain alive for the demuxer lifetime, matching C3 ownership.

Same-Representation refresh changes to init identity, codec, MIME type, or
resolution also allocate a new generation. Audio configuration changes use
the same generation mechanism on the stable logical audio stream.

H.264 resolution/config switching is accepted. Codec-family changes such as
H.264 to HEVC are catalogued as incompatible because this phase did not prove
that transition in the pinned build. The UI disables them and the command also
returns an explicit unsupported-switch error. There is no silent player reload.

## Audio catalog and switching

Each initial audio AdaptationSet maps to one mpv `sh_stream`:

```text
DASH logical audio AdaptationSet
  <-> stable RDP track ID
  <-> one mpv STREAM_AUDIO / track-list entry
```

The RDP header carries the actual language, composed label/role/channel title,
codec parameters, default flag, and stable ID. Existing ynoTV `getTrackList`,
audio modal, `aid`, cycling, and language preference behavior remain in use.

Successful `mpv_set_audio` calls also notify the native DASH scheduler. Future
batches then fetch/demux the chosen logical AdaptationSet at the current exact
video boundary. The old logical audio track stops being scheduled. Video and
subtitle selection are not changed, and mpv rebuilds only the audio decoder
chain.

The deterministic fixture uses clearly distinguishable sources:

```text
aid=1  lang=en  English 440 Hz
aid=2  lang=zh  中文 880 Hz
```

## Dynamic refresh interaction

Every refresh parses a complete candidate containing all video and audio
Representations, then merges every Representation's exact segment identities.

- A surviving selected video Representation and audio AdaptationSet stay
  selected.
- New video Representations enter the quality catalog.
- Removed unselected video Representations disappear from it.
- If selected video disappears, the conservative compatible fallback is
  selected and logged.
- Audio mpv IDs are reconciled by stable AdaptationSet identity rather than
  reassigned by vector position.
- If selected audio disappears, the deterministic metadata-ordered fallback is
  selected and logged.
- Changed selected init/config identity creates a fresh codec generation.

One limitation remains: a brand-new audio AdaptationSet appearing after demux
open is retained in the refreshed manifest model but is not dynamically
published as a new mpv `sh_stream`; the pinned dynamic-stream behavior was not
proven. Initial audio tracks and surviving refresh identities are fully
supported.

## Subtitle regression

C7 subtitle AdaptationSets, stable IDs, TTML conversion, IMSC bitmap bridge,
cue deduplication, packet selection, and mpv `sid` controls were not replaced.
Video quality commands do not call `sid`, recreate subtitle streams, clear cue
sets, or alter subtitle selection. Audio changes use only `aid` plus the native
audio scheduler selection.

The full Rust library suite, including C7 TTML/IMSC, duplicate-cue tests, and
the C8 manifest fixture, passed 101/101. C2/C3/C4 and delayed-live regressions
remained green.
A full normal-UI subtitle-on switch sequence was not run, so visual UI
acceptance remains open.

## Deterministic fixture results

Tracked manifest:

```text
experiments/mpv-packet-demux-adapter/fixtures/c8-manual-switch.mpd
```

It declares aligned 320x180 and 640x360 H.264 Representations and two mono AAC
logical audio tracks. The generator uses only `testsrc2` and sine sources.

`run-track-switch-tests.sh` creates an `RDPKT005` stream with A, B, then A
video segments and performs two live `aid` changes. Pinned-mpv evidence:

```text
track list: one video + two audio streams
video decoder formats, in order:
  320x180 yuv420p
  640x360 yuv420p
  320x180 yuv420p
H.264 decoder opens: 3
runtime codec generations registered: 1
AAC decoder opens across aid=1 -> 2 -> 1: 3
PCM source frequencies: 440.8 Hz, 879.7 Hz
final result: finished playback, success
```

The adapter logged `rustdash-live-v5`; mpv was not reloaded and retained one
video stream throughout.

## Real UI test result

The normal Tauri application launched against the C8 patched libmpv and played
the authorized Astro dynamic stream across multiple refresh generations. Its
catalog contained five H.264 qualities, four logical audio AdaptationSets, and
three IMSC subtitle tracks. Startup/request traces exposed and then corrected
an eager-fetch problem: only active media is now requested, while track init
configs are fetched concurrently. Low/high repetition, pause/resume, seek,
stop/replay, and subtitle continuity after manual quality changes still require
the final UI acceptance pass.

## Files changed

- `packages/app/src-tauri/src/native_dash.rs`
- `packages/app/src-tauri/src/lib.rs`
- `packages/ui/src/services/native-dash.ts`
- `packages/ui/src/services/tauri-bridge.ts`
- `packages/ui/src/components/TrackSelectionModal.tsx`
- `packages/ui/src/components/TrackSelectionModal.css`
- `packages/ui/src/components/DashQualityModal.tsx`
- `packages/ui/src/components/ChannelPanel.tsx`
- `packages/ui/src/App.tsx`
- `experiments/clearkey-cenc-packet-transform/cenc_component_producer.c`
- `experiments/mpv-packet-demux-adapter/rustdash_packet_abi.h`
- `experiments/mpv-packet-demux-adapter/.gitignore`
- `experiments/mpv-packet-demux-adapter/mpv-patch/demux_rustdash.c`
- `experiments/mpv-packet-demux-adapter/make-track-switch-fixture.py`
- `experiments/mpv-packet-demux-adapter/audio-switch-test.py`
- `experiments/mpv-packet-demux-adapter/run-track-switch-tests.sh`
- `experiments/mpv-packet-demux-adapter/fixtures/c8-manual-switch.mpd`
- `experiments/mpv-packet-demux-adapter/README.md`
- `scripts/dev-native-dash.mjs`
- `docs/research/11-dash-track-and-representation-switching.md`

## Exact tests run

```text
cd packages/app/src-tauri
cargo check --lib
cargo test --lib native_dash::tests -- --nocapture
cargo test --lib native_dash::tests::deterministic_c8_manifest_has_two_aligned_qualities_and_two_audio_tracks -- --nocapture
cargo test --lib

pnpm --filter @ynotv/ui exec tsc --noEmit
pnpm --filter @ynotv/ui test -- --run src/services/__tests__/nativeDash.test.ts
pnpm --filter @ynotv/local-adapter test -- --run src/__tests__/m3u-kodiprop.test.ts
node scripts/dev-native-dash.mjs --print-libmpv
pnpm dev

cd experiments/mpv-packet-demux-adapter
./run-track-switch-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib
./run-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib
./run-live-generation-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib /tmp/ynotv-c8-mpv.06PcSB
python3 live_stream_test.py /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv

cd experiments/clearkey-cenc-packet-transform
./run-local-tests.sh
./run-playback-tests.sh /tmp/ynotv-c8-mpv.06PcSB/build-c8/mpv /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib

cd /tmp/ynotv-c8-mpv.06PcSB
PKG_CONFIG_PATH=/private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib/pkgconfig \
DYLD_LIBRARY_PATH=/private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib \
meson test -C build-c8 --print-errorlogs

git diff --check
```

Observed results: native DASH focused tests 15/15, deterministic C8 manifest
1/1, full Rust library 101/101, C0 22/22, UI routing 10/10, M3U KODIPROP 1/1,
C2 PASS, C3 PASS, C4 local/playback PASS, C6 delayed live PASS, C8 video/audio
switch PASS, pinned mpv 39/39, TypeScript check PASS, patched-libmpv Tauri
startup smoke PASS, and `git diff --check` PASS.

Can a running UI-selected DASH session manually switch video Representations
and logical audio tracks without restarting the player or breaking subtitles?

PARTIAL

Evidence:
The native UI route, manual catalog, generation-safe scheduler, aligned RAP
mapping, stable mpv video stream, logical mpv audio streams, and RDPKT005 codec
generations are implemented. Pinned mpv decoded 320x180 -> 640x360 -> 320x180
in one session and performed aid=1 -> aid=2 -> aid=1 without restarting video;
PCM measured the expected 440.8/879.7-Hz sources, and all C0-C7 plus pinned-mpv
regressions passed. A real normal-UI live session with subtitles was not run in
this environment, and audio AdaptationSets first appearing after demux open are
not dynamically published to mpv, so YES would overstate the accepted scope.
