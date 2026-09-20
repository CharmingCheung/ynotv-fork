# C5 UI native DASH session

Research/implementation snapshot: 2026-09-20 (Asia/Singapore)

## Result and scope

C5 now has an end-to-end application route from imported M3U metadata to an
experimental Rust-owned DASH snapshot session. The implementation is deliberately
narrow: ClearKey plus CENC, one video representation, one audio representation,
one MPD snapshot, and a prebuilt `RDPKT001` packet source for the existing
`demux_rustdash` adapter. Ordinary playback still calls the previous `mpv_load`
path unchanged.

The route and its component pipeline are covered by automated tests, but the
normal bundled macOS libmpv in this checkout does not contain `demux_rustdash`.
The earlier C2/C3 patched libmpv does contain it and passed all adapter/playback
regressions. Because the patched library was not installed into a ynoTV UI build,
the requested real-stream UI acceptance and UI negative matrix were not run.
The final status is therefore **PARTIAL**, not YES.

No Widevine, PlayReady, CBCS, ABR, MPD refresh, live-edge tracking, subtitles,
or UI redesign was added.

## M3U and media-item changes

Both the TypeScript `parseM3U` file-import parser and the Rust remote-M3U sync
parser now associate every `#KODIPROP:key=value` after an `#EXTINF` with that
item until its URL. Keys are normalized to lowercase and unknown properties are
retained. A new `Channel.kodi_props` map carries this metadata; the channels
table persists it as JSON in the new schema-v28 `kodi_props` column. Both direct
file import and remote bulk sync preserve the field, and SQLite row normalization
converts the stored JSON back to an object.

The three C5 properties are consumed as:

- `inputstream.adaptive.manifest_type`
- `inputstream.adaptive.license_type`
- `inputstream.adaptive.license_key`

`inputstream=inputstream.adaptive` is not required.

## ClearKey parsing and secrecy

The frontend routing helper accepts exactly 32 hexadecimal KID characters, a
colon, and 32 hexadecimal key characters. It accepts either case and normalizes
both halves to lowercase. Rust independently validates both 16-byte values
before network or playback work. Malformed input returns `Invalid ClearKey
property` without echoing the input.

Neither the Rust session nor its errors log the content key. The FFmpeg/CENC
helper receives KID and key only through its child environment; stdout and stderr
are not forwarded to app logs. MPD `default_KID` values are normalized and the
app logs only the agreement boolean, not key material.

## Playback routing

On normal channel selection, `usePlayback` examines the selected channel's
persisted KODIPROP map after resolving its URL. It creates this structured IPC
value only for the exact C5 combination:

```text
NativeDashPlaybackConfig {
    manifest_url,
    drm: ClearKey { kid, key }
}
```

An MPD with any missing or unsupported DRM type fails explicitly. A malformed
ClearKey value fails before `mpv_load`. A native-DASH error does not enter the
ordinary URL fallback loop. Items that do not declare MPD retain the existing
load behavior and receive no native-DASH configuration.

## Rust session ownership and cancellation

`native_dash.rs` owns a generation, cancellation token, temporary snapshot
directory, HTTP requests, segment assembly, FFmpeg/CENC helper process, and final
packet-source lifetime. Starting any new load cancels the old generation. Stop
and application exit cancel it as well. Fetch waits and child-process waits use
the token; the child is killed on cancellation and also has `kill_on_drop` set.
The temporary files stay alive while mpv uses the packet source and are discarded
when a new generation replaces them.

The session uses `reqwest`; it does not invoke curl.

## Supported MPD subset

The parser supports one `Period`, inherited `BaseURL`, `AdaptationSet`,
`Representation`, inherited/overridden `SegmentTemplate`, `SegmentTimeline`,
`timescale`, `presentationTimeOffset`, `startNumber`, `initialization`, `media`,
`$RepresentationID$`, `$Number$`, `$Time$`, `ContentProtection`, and
`default_KID`. Unsupported URL-template substitutions, multiple Periods,
non-timeline addressing, absent supported A/V representations, invalid
timelines, non-CENC `mp4protection`, and excessive static timelines return an
explicit unsupported-manifest error.

Manifest HTTP redirects are followed and relative DASH URLs are resolved from
the final response URL. DASH-IF trick-mode AdaptationSets are excluded from
ordinary video selection.

Timeline expansion uses C0's `CompactTimeline` and `ExactTime`; the session does
not reimplement repeat or clipping rules, and `f64` is not the authoritative
DASH timeline representation. ISO-8601 Period durations are converted once to
microsecond rational time; segment indexing and media timestamps remain integer.

## Representation selection

Exactly one non-trick-mode MP4 video representation and one MP4 audio
representation are selected. The deterministic development policy is lowest
advertised bandwidth, then representation ID. This favors a conservative stream
and is not ABR.
Selected kind, ID, codec, and bandwidth are written to debug logs.

## Static and dynamic snapshots

Static MPDs use their finite C0 timeline, with a defensive 20,000-segment limit.
Dynamic MPDs are never refreshed. The newest advertised segment is excluded as
potentially incomplete, and the preceding two complete advertised segments are
downloaded. EOF from a dynamic packet source logs exactly:

```text
native DASH snapshot exhausted
```

It is emitted at actual mpv EOF, not as a network error.

## FFmpeg MOV and ClearKey integration

For each selected representation Rust writes one temporary input containing its
init segment followed by the selected media fragments. The C1/C4
`cenc_component_producer` opens a fresh FFmpeg MOV context for each component.
It copies codec parameters/extradata and packet PTS, DTS, duration, time base,
and keyframe state. It reads `AV_PKT_DATA_ENCRYPTION_INFO`, uses the packet KID
for store lookup, and applies the C4 OpenSSL EVP AES-128-CTR/subsample transform.
The configured KID is never inferred from track identity. Missing packet KIDs
map to `ClearKey KID unavailable`; other transform/helper failures map to `CENC
decrypt failed`.

The current helper is the already proven C executable, supervised by Rust. It is
not yet compiled and packaged as an in-process app library.

## mpv handoff

The UI path is a **prebuilt snapshot packet source**, not a concurrent live
producer. After all selected fragments are fetched and transformed, Rust calls
in-process libmpv with `demuxer=rustdash` and the generated `RDPKT001` file.
mpv decoders are unchanged. The format remains compatible with the bounded C3
source design, but C5 does not claim streaming startup.

The route is macOS-only in C5. Windows sidecar mode returns an explicit error.
The development gate `YNOTV_NATIVE_DASH_MPV_PATCHED=1` must be set deliberately;
without it the session returns `Native DASH custom demux adapter is unavailable
in this playback mode`. `YNOTV_NATIVE_DASH_LIBMPV_DIR` makes the macOS link step
prefer a patched, OpenGL-enabled libmpv directory and records its rpath;
`YNOTV_NATIVE_DASH_PACKET_PRODUCER` may point to the C4 helper, otherwise the
development-tree helper path is used.

## Manual UI procedure

The intended procedure, once ynoTV is launched against the patched in-process
libmpv, is:

1. Put the authorized manifest URL, KID, and key in local environment variables.
2. Generate a playlist outside the repository (or in a gitignored path), using
   the exact `EXTINF` plus three KODIPROP lines from the acceptance fixture.
3. Build the C4 helper with `experiments/clearkey-cenc-packet-transform/build.sh`.
4. Launch ynoTV with the patched libmpv, the development gate, and optionally the
   helper path override.
5. Import the local M3U in Sources, select the normal channel tile, then verify
   start, pause/resume, stop, switch, and replay.
6. Confirm selection diagnostics, packet-KID lookup, clean snapshot EOF, and the
   absence of raw key material in renderer and Rust logs.

This procedure was not completed in the UI in this phase because the app's
bundled `target/Frameworks/libmpv.2.dylib` has no `rustdash` strings. The prior
experimental `build-probe/libmpv.2.dylib` does contain `rustdash`, `RDPKT001`,
and the C3 live/generation marker strings, and its standalone mpv passed the
regression suite.

## Negative and normal-playback results

- Malformed `license_key`: frontend unit test passed; returns a fixed redacted
  error before IPC.
- Unknown/mismatched KID: C4 missing-KID test passed and returns the distinct
  key-unavailable state.
- Correct KID plus wrong key: C4 negative fixture test passed (failure detected
  by its independent clear-packet comparison).
- Unsupported `license_type`: frontend unit test passed with explicit rejection.
- MPD/segment fetch failure: typed Rust paths exist, but were not exercised via UI.
- Stop during producer/network work: C3 stop/quit/queued-stop/destroy tests passed;
  the new Rust token path compiled and is wired to stop/new load/exit, but was
  not exercised via UI.
- Normal channel playback after each failure: not run in the UI.

## Files changed

- `packages/core/src/types.ts`
- `packages/local-adapter/src/m3u-parser.ts`
- `packages/local-adapter/src/__tests__/m3u-kodiprop.test.ts`
- `packages/ui/src/db/index.ts`
- `packages/ui/src/db/sqlite-adapter.ts`
- `packages/ui/src/db/sync.ts`
- `packages/ui/src/hooks/usePlayback.ts`
- `packages/ui/src/services/bulk-ops.ts`
- `packages/ui/src/services/native-dash.ts`
- `packages/ui/src/services/tauri-bridge.ts`
- `packages/ui/src/services/__tests__/nativeDash.test.ts`
- `packages/app/src-tauri/Cargo.toml`
- `packages/app/src-tauri/build.rs`
- `packages/app/src-tauri/src/db_bulk_ops.rs`
- `packages/app/src-tauri/src/lib.rs`
- `packages/app/src-tauri/src/mpv_core.rs`
- `packages/app/src-tauri/src/native_dash.rs`
- `packages/app/src-tauri/src/sync_provider.rs`
- `docs/research/08-ui-native-dash-session.md`

## Commands and tests run

```text
pnpm --filter @ynotv/local-adapter test -- --run src/__tests__/m3u-kodiprop.test.ts
pnpm --filter @ynotv/local-adapter test
pnpm --filter @ynotv/local-adapter typecheck
pnpm --filter @ynotv/ui test -- --run src/services/__tests__/nativeDash.test.ts
pnpm --filter @ynotv/ui exec tsc --noEmit
cd packages/app/src-tauri && cargo check --lib
cd packages/app/src-tauri && cargo test --lib native_dash::tests -- --nocapture
cd packages/app/src-tauri && cargo test --lib dash_timeline::tests
cd packages/app/src-tauri && cargo test --lib
cd experiments/mpv-packet-demux-adapter && ./run-tests.sh /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv
cd experiments/mpv-packet-demux-adapter && ./run-live-generation-tests.sh /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv '' /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv
cd experiments/clearkey-cenc-packet-transform && ./run-local-tests.sh
cd experiments/clearkey-cenc-packet-transform && ./run-playback-tests.sh /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv
git diff --check
```

Results: local-adapter 26/26 passed; route/key tests 6/6 passed; Rust library
81/81 passed (including native session 3/3 and C0 22/22); C2 passed; C3 passed; C4 unit/equivalence/error
and software/VideoToolbox playback passed; Rust check passed with pre-existing
warnings; relevant TypeScript checks passed; `git diff --check` passed.

## Current limitations

- No completed UI run with the authorized stream, so the manual acceptance and
  UI recovery matrix remain open.
- The app bundle does not yet package the patched in-process libmpv.
- The FFmpeg/CENC helper is an external development executable.
- Startup is download-first and snapshot-oriented.
- Dynamic playback ends after two complete segments and never refreshes.
- One Period, one video track, and one audio track only; no subtitle path.
- `$Number$`/`$Time$` formatting modifiers are unsupported.
- Wrong AES-CTR key material is not intrinsically authenticated; corruption is
  generally observed by independent comparison or downstream decode failure.

Can a user select a ClearKey DASH entry from the normal ynoTV UI and play it
through the integrated native DASH → FFmpeg MOV → ClearKey → mpv pipeline?

PARTIAL

Evidence:
The normal UI now preserves KODIPROP metadata and routes the exact ClearKey MPD
shape into the Rust snapshot session; C0–C4 and the new parser/routing/session
tests pass. However, no UI playback was completed because the app's bundled
in-process libmpv lacks `demux_rustdash`; only the separate patched experimental
libmpv has the adapter and passed standalone playback tests.

For macOS UI testing the patched mpv build must have both `libmpv=true` and
`gl=enabled`; the earlier headless C2/C3 `gl=disabled` build cannot create
ynoTV's OpenGL render context. Set `YNOTV_NATIVE_DASH_LIBMPV_DIR` to that UI
build directory before `pnpm dev` so `build.rs` links and rpaths it explicitly.
