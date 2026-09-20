# ynoTV, mpv, MPEG-DASH, and DRM architecture research

Research snapshot: 2026-09-20 (Asia/Singapore)

ynoTV revision inspected: `9c05fe316de3b1ddd0bf60a450c5c1f2413e2481` (`custom_dev`)

mpv revision inspected: `cfd818bcaef262f82596f49444ee80073fa6d49a` (the revision named by ynoTV's pinned Windows libmpv build)

FFmpeg reference revision inspected: tag `n8.0`, commit `140fd653aed8cad774f991ba083e2d01e86420c7`

## 1. Executive summary

ynoTV has one TypeScript playback facade but more than one native mpv topology:

- The React UI calls `Bridge` methods in `packages/ui/src/services/tauri-bridge.ts`. Those methods use Tauri `invoke()` to call commands registered in `packages/app/src-tauri/src/lib.rs`.
- macOS main-window playback always uses an in-process `libmpv` instance owned by `MpvCoreState` in `packages/app/src-tauri/src/mpv_core.rs`. Rust uses the `libmpv2`/`libmpv2-sys` crates; those are ordinary Rust wrappers over mpv's C client/render APIs, not a Tauri libmpv plugin.
- Windows has two selectable engines. `playerEngine=libmpv` uses the same in-process `mpv_core`; `playerEngine=sidecar` (the default when the setting is absent) launches the bundled `mpv.exe`, embeds its child HWND with `--wid`, and controls it over mpv JSON IPC in `mpv_windows.rs`.
- The macOS in-process video surface is an `NSOpenGLView` inserted below the WKWebView. A libmpv `mpv_render_context` renders into it. The Windows in-process and sidecar paths both use an mpv-created child window under the Tauri HWND (`wid`); ynoTV resizes that child HWND for preview/multiview layouts.
- The main in-process instance is created by `libmpv2::Mpv::with_initializer`, which calls `mpv_create()`, applies pre-initialize properties, and calls `mpv_initialize()`. `Mpv::command()` calls `mpv_command_string()`. ynoTV directly calls `libmpv2_sys::mpv_command()` only for `sub-add`, because argv form safely preserves spaces.
- In-process state is mostly **polled**, not observed: every 250 ms `spawn_status_monitor()` calls `mpv_get_property` through `libmpv2` and emits `mpv-status`. A separate `EventContext` drains `mpv_wait_event()` for log messages, `FileLoaded`, and shutdown. The Windows sidecar instead sends JSON `observe_property` commands and maps JSON IPC events/responses into Tauri events.
- Loading an MPD does not invoke an mpv-native MPD parser. mpv opens the URL and selects `demux_lavf`; FFmpeg/libavformat's `ff_dash_demuxer` in `libavformat/dashdec.c` parses the XML MPD, expands URL templates, opens/downloads segments, owns one inner demuxer per representation, interleaves packets, refreshes dynamic manifests, and implements DASH seeking. mpv receives ordinary FFmpeg streams and packets.
- FFmpeg DASH exposes representations as tracks with `variant_bitrate`. mpv makes a static initial choice using `--hls-bitrate` and track selection. Neither layer implements a throughput/buffer-driven ABR controller that continually changes representation.
- FFmpeg 8.0 DASH has material constraints for the proposed engine: it selects only one Period (the longest-duration Period), rejects live seeks in `dash_read_seek()`, requires representation counts to remain unchanged across manifest refresh, refreshes subtitle lists but does not merge refreshed subtitle state back into the active list, and does linear work over `SegmentTimeline` entries/repeats in several calculations.
- The existing public stream-callback API is the lowest-friction experiment, but it provides a single seekable byte object, not logical tracks or packets. A serious multi-track/live/ABR design would need either (1) remuxing into a continuously valid container, (2) several coordinated virtual inputs plus mpv external tracks, or (3) a deeper packet/demux integration.
- A custom mpv demuxer is the cleanest semantic match for Rust-created tracks and packets, but mpv has no stable external demuxer plugin ABI. It means maintaining an mpv patch plus a Rust/C ABI, and it must faithfully provide timestamps, codec parameters/extradata, discontinuities, selection, seek, and backpressure.
- A promising additional architecture is to keep FFmpeg's ISO-BMFF/MOV demuxer while replacing only the MPD/timeline/network layer. Rust would expose per-representation virtual byte sources (init segment plus selected media fragments), and mpv/FFmpeg would continue turning fMP4 into compressed `AVPacket`s. This avoids reimplementing ISO-BMFF, but multi-track synchronization, seeks, and representation transitions still require an explicit coordinator.
- FFmpeg's MOV demuxer already parses `schm`, `tenc`, `senc`, `saiz`, `saio`, and `pssh`. Without a configured static decryption key it puts sample encryption data into `AV_PKT_DATA_ENCRYPTION_INFO` and PSSH into `AV_PKT_DATA_ENCRYPTION_INIT_INFO`. mpv's `demux_packet` retains the referenced `AVPacket` and passes its side data back into libavcodec. However, mpv has no CENC consumer: encrypted bytes would reach a normal codec decoder and fail. A future decrypt stage can therefore sit after MOV demux and before decoder input, provided mpv is modified or the samples are decrypted before mpv sees them.

No playback or DRM implementation was performed in this phase.

## 2. Scope and evidence rules

This report distinguishes four things that are easy to conflate:

1. the local ynoTV source revision;
2. the in-process libmpv loaded on each platform;
3. the separately bundled mpv executable used by the sidecar/popout paths; and
4. the Rust wrapper crate version, which is not the mpv core version.

ynoTV source references use `path:line` against commit `9c05fe3`. mpv references use paths and lines from commit `cfd818b`. FFmpeg references use paths and lines from FFmpeg `n8.0` commit `140fd653`. Permanent upstream links are included where useful:

- mpv tree: <https://github.com/mpv-player/mpv/tree/cfd818bcaef262f82596f49444ee80073fa6d49a>
- FFmpeg n8.0 tree: <https://github.com/FFmpeg/FFmpeg/tree/140fd653aed8cad774f991ba083e2d01e86420c7>

Claims about current runtime behavior are based on source paths that are actually selected by `cfg` and `get_player_engine()`. Candidate designs are explicitly labeled analysis rather than current behavior.

## 3. ynoTV playback architecture

### 3.1 Frontend ownership and the point at which playback begins

The central UI playback hook is `usePlayback()` in `packages/ui/src/hooks/usePlayback.ts`. It does not call Tauri directly for normal controls; it calls the `Bridge` facade:

- Live channel selection ultimately calls `handleLoadStream()` (`usePlayback.ts:1033-1160`). It resolves the provider URL via `resolvePlayUrl()`, then calls `tryLoadWithFallbacks()` (`usePlayback.ts:225-269`).
- `tryLoadWithFallbacks()` optionally sets mpv's `user-agent` property and calls `Bridge.loadVideo(primaryUrl, userAgent)` at `usePlayback.ts:233-242`. URL-shape fallbacks call the same method at lines 252-265.
- The successful live-load branch marks UI state playing and calls `Bridge.play()` at `usePlayback.ts:1113-1135` to clear a pause state left by an earlier stream.
- VOD, recordings, trailers, layout restore, multiview promotion, and the cast handoff also converge on `Bridge.loadVideo()` or directly invoke `mpv_load`; representative call sites are `usePlayback.ts:1540`, `usePlayback.ts:3055`, `useMultiview.ts:207`, and `useLayoutPersistence.ts:386`.
- Stop, seek, and pause/resume originate in `handleStop()` (`usePlayback.ts:3177-3185`), `handleSeek()` (`usePlayback.ts:3218-3231`), and `handleTogglePlay()` (`usePlayback.ts:3233-3247`).

Initialization is event-first so the ready notification cannot be missed. `useMpvListeners()` registers listeners and then calls `Bridge.initMpv()` once settings are loaded (`packages/ui/src/hooks/useMpvListeners.ts:133-149,257-263`). `Bridge.initMpv()` builds cache/volume arguments and invokes `init_mpv` (`tauri-bridge.ts:217-243`).

The frontend abstraction is `Bridge` at `packages/ui/src/services/tauri-bridge.ts:195`. Its relevant methods are:

| UI operation | Bridge method | Tauri command |
|---|---|---|
| initialize | `initMpv()` at 218 | `init_mpv` |
| load | `loadVideo()` at 255 | `mpv_load` |
| play/pause/resume/stop | 345/356/367/378 | `mpv_play`, `mpv_pause`, `mpv_resume`, `mpv_stop` |
| absolute seek | `seek()` at 412 | `mpv_seek` |
| track list | `getTrackList()` at 531 | `mpv_get_track_list` |
| audio/sub selection | `setAudioTrack()` / `setSubtitleTrack()` at 536/540 | `mpv_set_audio`, `mpv_set_subtitle` |
| external subtitle | `addSubtitleFile()` at 602 | `mpv_add_subtitle` |
| arbitrary property | `setProperty()` / `getProperty()` at 793/810 | `mpv_set_property`, `mpv_get_property` |

`Bridge.loadVideo()` has a separate Cast branch (`tauri-bridge.ts:255-335`). Native local playback is the final branch at lines 336-342: clear the remembered subtitle track, `invoke('mpv_load', { url, userAgent })`, and translate a rejected command to the UI result shape. This report follows that native branch, not Chromecast.

### 3.2 Tauri boundary and command registration

All mpv commands are ordinary Tauri commands in `packages/app/src-tauri/src/lib.rs`, registered in `tauri::generate_handler!` at `lib.rs:5583-5612`. There is no Tauri libmpv plugin. Tauri serializes the JavaScript arguments, dispatches the Rust async command, and serializes its `Result` back to the caller.

The Rust boundary also selects the native engine:

- `PlayerEngine` is declared at `lib.rs:264-268`.
- `get_player_engine()` at `lib.rs:270-289` always returns `LibMpv` on macOS. On other platforms it reads `playerEngine`; Windows defaults to `Sidecar` when the setting is missing.
- `init_mpv()` at `lib.rs:1244-1291` merges settings/frontend parameters, sanitizes them, and dispatches to `mpv_core::init_mpv_with_params()` or `mpv_windows::init_mpv_with_params()`.
- `mpv_load()` at `lib.rs:1423-1458` first probes extensionless URLs for HLS. It then calls `mpv_core::load_file()` for macOS, Linux-like builds, and Windows `LibMpv`, or `mpv_windows::load_file()` for Windows `Sidecar`.
- Every other public command repeats that engine dispatch. Examples are pause (`lib.rs:1481-1498`), stop (`1521-1538`), track-list (`1641-1658`), audio/subtitle selection (`1661-1698`), property access (`1814-1855`), and surface synchronization (`1858-1881`).

The app stores both states at startup: `.manage(MpvState::new())` and `.manage(MpvCoreState::new())` at `lib.rs:5321-5322`. Only the selected engine owns the active main player. `MpvState` is a platform-specific import (`lib.rs:257-260`); `MpvCoreState` is always the in-process state.

The repository's native topology can therefore be classified exactly:

| Possibility | Present? | Evidence |
|---|---|---|
| direct libmpv linkage | yes | `libmpv2`/`libmpv2-sys`, Windows `mpv.lib` link search, macOS `libmpv.dylib` search/rpath |
| Tauri libmpv plugin | no | mpv commands are local `#[tauri::command]` functions; no such plugin dependency/registration |
| custom wrapper DLL | no | `libmpv-2.dll` is upstream mpv's client library; `mpv.lib` is its import library, not a ynoTV wrapper |
| launched mpv process | yes | Windows default sidecar and popout paths use `app.shell().sidecar("mpv")` |
| combined approach | yes | packages both direct libmpv and an external mpv binary; engine selection decides the main Windows path |

### 3.3 In-process libmpv ownership and FFI

`MpvCoreState` (`packages/app/src-tauri/src/mpv_core.rs:118-140`) owns:

- `Arc<Mutex<Option<Arc<Mpv>>>>`, the `libmpv2::Mpv` instance;
- the current URL;
- a shutdown flag shared by monitor tasks;
- the main mpv child HWND on Windows; and
- a bounded log ring.

`init_mpv_with_params()` (`mpv_core.rs:233-348`) kills any old engine, obtains the parent HWND on Windows, and creates the wrapper with `Mpv::with_initializer()` at lines 272-288. `apply_common_options()` (`144-231`) sets `idle=yes`, `keep-open=yes`, disabled input/OSC, audio identity, and the platform video output before `mpv_initialize()`.

The exact wrapper layer is crates `libmpv2 4.1.0` and `libmpv2-sys 4.0.1` (`Cargo.toml:83-86`; `Cargo.lock:2727-2739`). The locally cached `libmpv2` source shows the concrete FFI:

```text
libmpv2::Mpv::with_initializer
  -> mpv_client_api_version()
  -> mpv_create()
  -> ynoTV initializer / mpv_set_property()
  -> mpv_initialize()

libmpv2::Mpv::command
  -> builds one command string
  -> mpv_command_string()

libmpv2::Mpv::{set_property,get_property}
  -> mpv_set_property()/mpv_get_property()
```

Those calls are visible in `libmpv2-4.1.0/src/mpv.rs:482-511,551-573`. The crate is a wrapper only; the mpv instance is still the native `mpv_handle` and the playback core is linked libmpv.

ynoTV directly uses `libmpv2_sys::mpv_command()` for external subtitle `sub-add` (`mpv_core.rs:867-932`) so filenames/titles containing spaces remain separate argv entries. All ordinary commands use `Mpv::command()` or typed property calls.

### 3.4 Sidecar mpv ownership and JSON IPC

The Windows sidecar state is `MpvState` in `packages/app/src-tauri/src/mpv_windows.rs:17-41`. It owns the spawned `CommandChild`, PID/HWND, a named-pipe writer, a request-ID map, and initialization state.

`try_spawn_mpv()` (`mpv_windows.rs:367-558`) obtains the Tauri window HWND and launches Tauri's external binary named `mpv` with, among other flags:

```text
--input-ipc-server=\\.\pipe\mpv-socket-<ynotv pid>
--wid=<Tauri HWND>
--title=YNOTV_MPV_MAIN
--force-window=immediate
--idle=yes
--keep-open=yes
```

The launch is `app.shell().sidecar("mpv")` at `mpv_windows.rs:455-458`; it is a child process, not a DLL wrapper. `connect_ipc()` (`560-795`) connects to the named pipe, reads newline-delimited mpv JSON messages, resolves request promises, updates `MpvStatus`, and emits Tauri events. Lines 782-792 register JSON IPC observations for pause, volume, mute, time, duration, cache state, core idle, selected video, video format, and EOF.

`send_command_internal()` (`mpv_windows.rs:798-837`) constructs `{"command":[...],"request_id":N}`, sends it to the pipe, and awaits the matching response. Sidecar `load_file()` (`890-907`) sends `loadfile`; pause/resume set the `pause` property (`914-922`); stop sends `stop` (`924-927`); seek sends `seek <seconds> absolute` (`934-937`); and tracks use `track-list`, `aid`, and `sid` (`954-977`).

The old `mpv_macos.rs` is also a sidecar implementation, and `mpv_popout.rs` launches a sidecar for popout playback. Neither is the current macOS main-player path: `get_player_engine()` hard-codes `LibMpv`, and main commands call `mpv_core` under `cfg(target_os="macos")`. They remain relevant to packaging and any future popout feature, but not to the main call graph.

### 3.5 How the video surface is embedded

#### macOS in-process path

`apply_common_options()` sets `vo=libmpv` and `force-window=no` (`mpv_core.rs:170-176,213-217`). After initialization, `mpv_core::init_mpv_with_params()` retrieves the Tauri `NSWindow` and invokes `mpv_render_mac::install()` on the AppKit main thread (`mpv_core.rs:290-317`).

`packages/app/src-tauri/src/mpv_render_mac.rs` performs the embedding:

1. `install()` (`67-233`) creates an `NSOpenGLView` with a 3.2 core pixel format.
2. It inserts the native view below the first content subview—the WKWebView—at lines 159-169.
3. It makes the WebView/layer non-opaque at lines 192-203 so HTML can overlay the video.
4. It creates `libmpv2::render::RenderContext` with OpenGL parameters at lines 205-215. That is the wrapper for `mpv_render_context_create()`.
5. The render update callback schedules work on the main dispatch queue (`217-219,401-414`).
6. `render_now()` (`310-357`) makes the GL context current, computes backing-pixel dimensions, invokes `RenderContext::render()`, and flushes the buffer.
7. `resize_to()` (`270-308`) maps CSS geometry to native coordinates and resizes the `NSOpenGLView`. `mpv_set_geometry` reaches it through `mpv_core::set_geometry()` (`mpv_core.rs:1081-1111`).

This is true libmpv render-API embedding; it is not an overlaid mpv application window.

#### Windows in-process path

The initializer sets `gpu-api=d3d11`, `vo=gpu-next`, and `wid=<Tauri HWND>` (`mpv_core.rs:178-189,219-227`). mpv creates its own child window below that parent. `mpv_core::set_geometry()` locates/caches the child HWND and calls `SetWindowPos` (`mpv_core.rs:1112-1169`).

#### Windows sidecar path

The sidecar receives the same parent HWND as `--wid` (`mpv_windows.rs:407-413`). ynoTV finds the resulting child by PID/title/class (`find_mpv_hwnd_by_pid()` and `find_mpv_hwnd_by_title()` at `mpv_windows.rs:136-340`) and resizes it with `SetWindowPos` in `mpv_set_geometry()` (`1073-1158`).

### 3.6 Events and properties from mpv back to TypeScript

#### In-process

There are two paths:

- `spawn_status_monitor()` (`mpv_core.rs:350-434`) polls typed properties every 250 ms: `pause`, `volume`, `mute`, `time-pos`, `duration`, `paused-for-cache`, `core-idle`, `eof-reached`, `video-format`, and `vid`. It synthesizes seek/restart/EOF/timeshift events and emits `mpv-status` with `AppHandle::emit()`.
- `spawn_log_capture()` (`mpv_core.rs:441-491`) creates a `libmpv2::events::EventContext`, requests logs with `mpv_request_log_messages()`, and polls `mpv_wait_event()` through `EventContext::wait_event(0.0)`. It records `LogMessage`; on real `Event::FileLoaded` it sets `sid=no` and emits `mpv-file-loaded`; it exits on `Shutdown`.

This means the in-process implementation does **not** expose all mpv events and does not use `mpv_observe_property()` for status. Some events are inferred: `mpv-playback-restart` is an idle-to-active transition; `mpv-seek` is a position jump greater than two seconds; EOF is an `eof-reached` transition.

#### Sidecar

The JSON IPC reader handles mpv's real `property-change`, `file-loaded`, `seek`, `playback-restart`, and `end-file` events in `mpv_windows.rs:560-779`. It emits equivalent Tauri event names and resolves command responses by request ID. This path therefore has somewhat different event fidelity from `mpv_core` despite sharing the frontend event contract.

#### Frontend

`useMpvListeners()` registers `mpv-ready`, `mpv-status`, error, HTTP error, end-file-error, and end-file listeners (`packages/ui/src/hooks/useMpvListeners.ts:148-250`). It maps `MpvStatus` fields to React state at lines 158-213. `usePlayback()` separately listens for stream failure/recovery (`usePlayback.ts:1556-1641`) and subtitle lifecycle events (`2331-2411`).

### 3.7 Present command semantics

#### Loadfile

`Bridge.loadVideo()` -> Tauri `mpv_load()` -> engine `load_file()`.

- In-process: `mpv_core::load_file()` (`mpv_core.rs:540-576`) lazily initializes if necessary and calls `Mpv::command("loadfile", &[url])`. Extensionless content identified as HLS adds the per-file option `demuxer-lavf-format=hls`.
- Sidecar: `mpv_windows::load_file()` (`mpv_windows.rs:890-907`) sends the same command as JSON IPC.

The `userAgent` argument itself is used by the HLS content probe in Rust; playback's user-agent is set separately by `tryLoadWithFallbacks()` through `Bridge.setProperty('user-agent', ...)` (`usePlayback.ts:231-239`).

#### Pause/play/stop/seek

- Play/resume are `pause=false`; pause is `pause=true` (`mpv_core.rs:578-606`; sidecar `mpv_windows.rs:909-922`).
- Stop is mpv command `stop` (`mpv_core.rs:608-619`; sidecar `924-927`).
- Seek is mpv command `seek <seconds> absolute` (`mpv_core.rs:621-632`; sidecar `934-937`). The UI optimistically sets position before sending it (`usePlayback.ts:3218-3226`).

#### Track selection

- Track discovery reads the mpv `track-list` property (`mpv_core.rs:686-693`; sidecar `mpv_windows.rs:954-957`).
- Audio selection sets `aid=<id>` or `aid=no`; subtitle selection sets `sid=<id>` or `sid=no` (`mpv_core.rs:695-726`; sidecar `959-977`).
- The UI has substantial auto-selection logic in `usePlayback.ts:2030-2319,2443-2461`. On `FileLoaded`, native code first disables mpv's automatically selected subtitles; frontend logic then restores a manual choice or selects one desired track (`usePlayback.ts:2373-2402`).
- External subtitles use mpv `sub-add`; removals find the external track and call `sub-remove` (`mpv_core.rs:867-967`). Jellyfin HTTP subtitle URLs may first be downloaded to a temporary local file (`mpv_core.rs:729-802`).
- Subtitle appearance/delay is implemented as ordinary mpv properties in `tauri-bridge.ts:540-681`.

## 4. Exact TypeScript -> Rust -> libmpv/mpv call paths

### 4.1 In-process main player

```text
React view / user action
  -> usePlayback.handleLoadStream()                    packages/ui/src/hooks/usePlayback.ts:1033
  -> tryLoadWithFallbacks()                            packages/ui/src/hooks/usePlayback.ts:225
  -> Bridge.loadVideo()                                packages/ui/src/services/tauri-bridge.ts:255
  -> invoke("mpv_load")                                tauri-bridge.ts:338
  -> #[tauri::command] mpv_load()                      packages/app/src-tauri/src/lib.rs:1423
  -> mpv_core::load_file()                             packages/app/src-tauri/src/mpv_core.rs:540
  -> libmpv2::Mpv::command("loadfile", ...)
  -> libmpv2 -> mpv_command_string()
  -> mpv player/client.c::mpv_command_string()
  -> run_client_command() / run_command()
  -> player/command.c::cmd_loadfile()
  -> playlist entry + mp_set_playlist_entry()
  -> player/loadfile.c::play_current_file()
  -> open_demux_reentrant() / open_demux_thread()
  -> demux/demux.c::demux_open_url()
  -> stream/stream.c::stream_create()
  -> demux/demux.c::demux_open()
  -> demux/demux_lavf.c::demux_open_lavf()
  -> FFmpeg avformat_open_input()/avformat_find_stream_info()
  -> FFmpeg input demuxer (dash for MPD; mov for fMP4 components)
  -> AVPacket
  -> demux_lavf_read_packet()
  -> mpv demux_packet + demux queues
  -> filters/f_demux_in.c::demux_process()
  -> mp_decoder_wrapper / vd_lavc or ad_lavc
  -> libavcodec
  -> player/video.c -> VO -> libmpv render context / GPU
     player/audio.c -> AO
```

Initialization is:

```text
useMpvListeners()
  -> Bridge.initMpv()
  -> invoke("init_mpv")
  -> lib.rs::init_mpv()
  -> mpv_core::init_mpv_with_params()
  -> libmpv2::Mpv::with_initializer()
  -> mpv_create() -> options -> mpv_initialize()
  -> macOS: mpv_render_mac::install() -> mpv_render_context
```

### 4.2 Windows default sidecar

```text
same UI and Tauri boundary
  -> lib.rs::mpv_load()
  -> get_player_engine() == Sidecar
  -> mpv_windows::load_file()
  -> send_command_internal()
  -> JSON {command:["loadfile", url], request_id:N}
  -> Windows named pipe
  -> external mpv.exe JSON IPC
  -> mpv command/load/demux/decode/output core
```

Initialization is `app.shell().sidecar("mpv") -> mpv.exe --wid=<Tauri HWND> --input-ipc-server=<pipe>`. The process's native video child window is embedded, not a render API texture.

### 4.3 Control/property return path

```text
in-process mpv core
  -> mpv_get_property() polling and selected mpv_wait_event() events
  -> mpv_core::{spawn_status_monitor,spawn_log_capture}
  -> AppHandle.emit("mpv-*")
  -> @tauri-apps/api/event listen()
  -> useMpvListeners/usePlayback
  -> React state/UI

sidecar mpv core
  -> JSON IPC property-change/event/response
  -> mpv_windows::connect_ipc reader
  -> AppHandle.emit("mpv-*") or request oneshot
  -> frontend listener or invoke() promise
```

## 5. Binary acquisition, packaging, and exact versions

### 5.1 Rust bindings versus mpv core

`libmpv2 4.1.0` and `libmpv2-sys 4.0.1` are wrapper crate releases, not mpv 4.x. The checked-in `client.h` says client API `2.5` (`packages/app/src-tauri/libmpv/include/mpv/client.h:250-251`). ABI compatibility is checked at wrapper initialization.

### 5.2 Windows libmpv

`packages/app/src-tauri/setup-libmpv.ps1:10-18` defines the source order and expected SHA-256:

- expected DLL SHA-256: `E9C87D19055BC5A82771B2B48E9FBAE047BD5180603F5A1AAAE10C90CA690467`;
- primary opaque mirror: ynoTV `v-assets/libmpv-2.dll`;
- named source build: Shinchiro `mpv-dev-x86_64-v3-20260505-git-cfd818b.7z`;
- legacy harbor mirror.

Every accepted endpoint must produce the expected hash (`setup-libmpv.ps1:28-65`). `build.rs:7-12` adds `src-tauri/libmpv` to the Windows link search when `mpv.lib` exists. `tauri.windows.conf.json:3-8` packages `libmpv/libmpv-2.dll` as `libmpv-2.dll` beside the application.

The build name's revision resolves in the local upstream mpv repository to:

```text
cfd818bcaef262f82596f49444ee80073fa6d49a
2026-05-04
ra_gl: fix memory leak
describe: v0.41.0-604-gcfd818bcae
```

This is the exact mpv source revision used for the mpv analysis below. One provenance limitation remains: the primary `v-assets` file is an opaque mirror, and no `libmpv-2.dll` is present in this macOS checkout to independently query its compiled version. The source provides a hash equality check and a hash-targeted fallback whose filename names `cfd818b`; it does not include a signed build manifest mapping that hash to all dependency revisions. Therefore mpv commit identity is well-supported by the build configuration, while the complete Shinchiro toolchain/FFmpeg revision is not proven by this repository alone.

### 5.3 Windows sidecar

`scripts/download-mpv-tauri.sh:17-66` queries the **latest** Shinchiro release at build time and places `mpv-<target>.exe` under `src-tauri/bin`. `tauri.conf.json:54-58` packages it as an external binary. This sidecar is not version-pinned and can differ from the pinned libmpv DLL. A release cannot be mapped to one sidecar revision without the release build log/artifact.

The current GitHub release workflow runs on `windows-latest`, downloads the latest sidecar, then runs `setup-libmpv.ps1` (`.github/workflows/release-tauri.yml:18,42-64`). Thus a Windows package deliberately contains both an mpv executable and libmpv DLL, possibly from different revisions.

### 5.4 macOS

For in-process playback, `build.rs:20-49` searches Homebrew/MacPorts library paths and adds runtime paths. README setup requires `brew install mpv` (`README.md:99`). There is no checked-in or downloaded `libmpv.dylib` packaging step in `scripts/download-mpv-tauri.sh`; `tauri.macos.conf.json` packages only the standalone sidecar's `lib` directory under `MacOS/lib`.

On the inspected machine:

```text
/opt/homebrew/lib/libmpv.2.dylib
mpv 0.40.0_4 (Homebrew formula source v0.40.0 plus Homebrew revisions/patches)
mpv source release commit e48ac7ce08462f5e33af6ef9deeac6fa87eef01e
linked FFmpeg 8.0 libraries
```

That is the local development libmpv, not a repository-pinned dependency. Reproducible/release macOS packaging of the in-process dylib and its dependency closure is an open issue for follow-up.

The locally downloaded standalone sidecar contains the string `mpv 0.39.0` and FFmpeg 6-era dylibs (`libavformat.60`, `libavcodec.60`). It is a separate executable used by sidecar/popout code, not the main macOS in-process instance. The repository download URL is a moving `mpv-latest.tar.gz` (`download-mpv-tauri.sh:69-110`), so its exact source revision is not recoverable from the script.

### 5.5 Linux-like builds

Non-macOS/non-Windows main commands select `mpv_core` in `lib.rs`, which implies link-time system libmpv. The download script creates an external sidecar wrapper around `/usr/bin/mpv` (`download-mpv-tauri.sh:124-149`) for external-binary use. The repository does not pin either system package.

## 6. mpv source revision and internal playback graph

### 6.1 Revision choice

The principal mpv analysis uses `cfd818bcaef262f82596f49444ee80073fa6d49a`, because it is the revision explicitly named by ynoTV's pinned Windows development package. Its generated version base is `0.41.0-UNKNOWN` and Git describes it as 604 commits after v0.41.0.

This revision is newer than the inspected machine's Homebrew mpv 0.40.0 and the moving macOS sidecar observed as 0.39.0. Where an API/behavior is version-sensitive, this report says so. The architectural functions discussed here exist in the corresponding 0.40-era pipeline as well, but line references are specifically for `cfd818b`.

FFmpeg dependency identity cannot be extracted exactly from the ynoTV Windows DLL configuration. For FFmpeg-owned DASH/CENC details, the report uses FFmpeg 8.0 commit `140fd653`, matching the inspected Homebrew libmpv's reported FFmpeg major and providing a reproducible reference. Shinchiro's `cfd818b` build may contain a newer FFmpeg snapshot; that is listed as an unknown rather than silently treated as identical.

### 6.2 Client API to playlist/load state

`player/client.c:1107-1149` implements synchronous client commands. `mpv_command()` parses argv; `mpv_command_string()` at `1169-1173` parses a command string. Both call `run_client_command()`, which locks the core, invokes `run_command()`, and waits for completion when necessary.

`loadfile` is registered in `player/command.c:7687-7703` and implemented by `cmd_loadfile()` at `6376-6412`. It creates a playlist entry, copies file-local options, installs the entry with `mp_set_playlist_entry()`, notifies the playlist change, and wakes the core.

`player/loadfile.c::play_current_file()` (`1720-2100`) is the main file lifecycle:

1. emit `MPV_EVENT_START_FILE` (`1731-1738`);
2. apply per-file options/hooks;
3. call `open_demux_reentrant()` (`1825-1833`);
4. enable the demux thread and add streams as player tracks (`1857-1862`);
5. select default tracks (`1876-1921`);
6. initialize video, audio, and subtitle chains (`1927-1929`);
7. emit `MPV_EVENT_FILE_LOADED` (`1954-1961`);
8. enter normal play-loop processing until stop/EOF, then emit an end-file event (`2097` in this revision).

The opener thread is `open_demux_thread()` at `player/loadfile.c:1213-1257`. It calls `demux_open_url()` with top-level parameters.

### 6.3 Stream and demux selection

`demux/demux.c::demux_open_url()` (`3568-3601`) creates an mpv `stream` unless an external stream was supplied, then calls `demux_open()`.

`stream/stream.c::stream_create_with_args()` (`426-468`) walks `stream_list` and invokes the matching `stream_info_t` protocol handler. `stream_create_instance()` (`320-424`) matches protocol names, constructs `stream_t`, calls the handler's `open`/`open2`, and installs read/seek behavior. HTTP(S) is normally handled by mpv's lavf stream implementation (`stream/stream_lavf.c`), while client protocols use `stream/stream_cb.c`.

`demux/demux.c::demux_open()` (`3481-3544`) tests registered `demuxer_desc` objects. `open_given_type()` invokes each descriptor's `open` and constructs the threaded/user-side demux pair and queues. For ordinary media/MPD, selection reaches `demux/demux_lavf.c::demux_open_lavf()` (`1248-1435`).

`demux_open_lavf()`:

- probes/forces an `AVInputFormat` in `lavf_check_file()` (`421-...`);
- creates a custom `AVIOContext` whose reads/seeks call back into the mpv `stream` (`demux_lavf.c:293-367,1307-1321`);
- wraps libavformat's nested `io_open` so child URLs inherit mpv lavf options (`924-958,1343-1351`);
- calls `avformat_open_input()` and usually `avformat_find_stream_info()` (`1374-1399`);
- converts `AVStream`s into mpv `sh_stream`s in `handle_new_stream()`/`add_new_streams()` (`685-896,1409`); and
- records variant bitrate as `sh_stream.hls_bitrate` from FFmpeg `variant_bitrate` metadata (`demux_lavf.c:860`).

### 6.4 Packets, queues, and decoder input

`demux_lavf_read_packet()` (`demux/demux_lavf.c:1496-1599`) calls `av_read_frame()`, maps timestamps/flags, and creates an mpv `demux_packet` with `new_demux_packet_from_avpacket()` at line 1538.

Important data structures are:

- `struct sh_stream` in `demux/stheader.h:33-72`: logical stream type, codec parameters, IDs/metadata, and its queue-side `demux_stream`;
- `struct demux_packet` in `demux/packet.h`: compressed payload, PTS/DTS/duration, flags, segment metadata, and retained `AVPacket`;
- `struct demux_stream` in `demux/demux.c:368-440`: selected/eager state plus queue reader pointers; and
- `struct demux_internal` in `demux/demux.c:159-326`: demux thread state, streams, cache ranges, aggregate limits, seek state, and synchronization.

The demux thread adds packets to per-stream queues. Consumers call `demux_read_packet_async()` / `demux_read_packet_async_until()` (`demux/demux.c:2852-...`). `filters/f_demux_in.c::demux_process()` (`20-46`) converts a returned `demux_packet` into an `MP_FRAME_PACKET` and pushes it into mpv's filter graph.

`mp_decoder_wrapper_create()` and `mp_decoder_wrapper` in `filters/f_decoder_wrapper.c` connect the demux-input filter to a selected decoder. The normal FFmpeg decoders are:

- video: `video/decode/vd_lavc.c::vd_lavc_process()` -> `lavc_process()` -> `avcodec_send_packet()` / `avcodec_receive_frame()` (`1207,1250,1417-1421`);
- audio: `audio/decode/ad_lavc.c::ad_lavc_process()` -> the same wrapper -> FFmpeg send/receive (`188,199,277-281`).

Decoded video is scheduled/synchronized in `player/video.c`; `write_video()` at `1031-1275` ultimately calls `vo_queue_frame()` (`video/out/vo.c:875`). Decoded audio is synchronized/filtered in `player/audio.c` and supplied to an AO; pull AOs use `audio/out/buffer.c::ao_read_data()`. The main loop calls the audio/video update functions from `player/playloop.c` (for example `write_video()` at line 1277).

### 6.5 Tracks and representation choice

`demux_lavf::handle_new_stream()` converts FFmpeg codec parameters into mpv audio/video/subtitle `sh_stream`s (`demux_lavf.c:685-866`). `player/loadfile.c::add_demuxer_tracks()` (`493-497`) wraps each in a player `struct track`.

`select_default_track()` and `compare_track()` (`player/loadfile.c:499-650`) choose initial tracks by explicit ID, external/default/forced status, language, program, and bitrate. `--hls-bitrate` is `no|min|max|integer`, with default `max` (`options/options.c:651-652,1042`). This is a static choice. Track changes set `aid`/`vid`/`sid`, reselect demux streams, and rebuild the relevant decoder chain; they are not an ABR loop.

### 6.6 Seek and timeline

The `seek` command is `player/command.c::cmd_seek()` (`5882-5931`). It normalizes relative/absolute/percent modes and calls player `queue_seek()`.

`player/playloop.c::mp_seek()` (`290-452`) computes target time and high-resolution/keyframe flags, calls `demux_seek()` at line 378, seeks selected external tracks, clears audio output, resets the filter/decoder/subtitle playback state, and emits `MPV_EVENT_SEEK` (`444`). `demux_seek()` (`demux/demux.c:3881-3963`) first attempts a seek inside cached ranges; otherwise it queues/executes the demuxer's seek callback. For lavf that callback ultimately reaches `avformat_seek_file()`/`av_seek_frame()` and therefore the FFmpeg input format's seek implementation.

mpv's own `demux_timeline` (`demux/demux_timeline.c`) is a generic source/timeline wrapper used for EDL, ordered chapters, and similar mpv concepts. It is not the DASH `SegmentTimeline`; FFmpeg's DASH demuxer owns that model.

### 6.7 Subtitle packet and render path

Selected subtitle tracks use `player/sub.c::reinit_sub()` (`218-252`) and `sub/dec_sub.c::sub_create()` (`195-224`). `sub_read_packets()` (`sub/dec_sub.c:345-405`) reads directly from the demux queue and invokes the selected subtitle driver's `decode` callback.

- Text/ASS-compatible paths go through `sub/sd_ass.c`; conversions may use `sub/lavc_conv.c`, including WebVTT handling.
- Bitmap subtitles use `sub/sd_lavc.c`, which calls `avcodec_decode_subtitle2()` (`352`).
- `sub_get_bitmaps()` (`sub/dec_sub.c:422`) feeds `sub/osd.c`, and the VO composites the resulting OSD/subtitle bitmaps.

FFmpeg 8.0 has a WebVTT demuxer/decoder (`libavformat/webvttdec.c`, `libavcodec/webvttdec.c`), and mpv explicitly maps `webvtt` as a text subtitle (`demux/demux_lavf.c:205`). FFmpeg 8.0 defines TTML and can demux `stpp` from MOV, but the inspected tree contains a TTML encoder rather than a general TTML decoder; mpv has no explicit `ttml` mapping in the searched subtitle sources. TTML-in-fMP4 should therefore be treated as unsupported/format-dependent until verified with exact artifacts, not assumed to render.

### 6.8 Events and properties inside mpv

Core code calls `mp_notify()` at lifecycle points: load (`player/loadfile.c:1738,1960,2097`), seek/restart (`player/playloop.c:444,1188`), and audio/video reconfiguration (`player/audio.c`, `player/video.c`). `player/command.c:4807-4835` maps those events to property invalidations.

`player/client.c` maintains per-client queues and implements `mpv_wait_event()`, property observation, log messages, and event-name mapping (`client.c:675-923,1821,1925,1966-2053,2100-2118`). ynoTV consumes only the subset described in section 3.6.

## 7. Current MPD/DASH call graph

### 7.1 Entry and division of labor

For a normal MPD URL, the relevant path is:

```text
ynoTV mpv_load(url.mpd)
  -> mpv loadfile
  -> mpv stream_create(url.mpd)
     -> mpv stream_lavf opens/reads the top-level HTTP resource
  -> mpv demux_open()
  -> mpv demux_open_lavf()
     -> FFmpeg avformat_open_input(custom AVIO over mpv top-level stream)
     -> FFmpeg ff_dash_demuxer / dash_read_header()
        -> parse_manifest() using libxml2
        -> parse Period/AdaptationSet/Representation
        -> parse SegmentTemplate/SegmentList/SegmentTimeline
        -> open_demux_for_component() for each representation
           -> update_init_section()
           -> custom per-representation AVIO read_data()
           -> nested ISO-BMFF/MOV, WebM, MPEG-TS, WebVTT, etc. demuxer
     -> dash_read_packet()
        -> choose active representation with smallest current timestamp
        -> av_read_frame(inner representation demuxer)
        -> return one AVPacket with outer stream index
  -> mpv demux_lavf_read_packet()
  -> mpv queues/decoders/VO/AO/subtitles
```

mpv does not contain an MPD parser. A source search of the pinned mpv tree has no DASH manifest structures; the MPD path is delegated through `demux_lavf` to libavformat. mpv still provides the top-level `stream`, cancellation, network options, cache/packet queues, track selection, and downstream playback.

### 7.2 FFmpeg DASH structures and parsing

The FFmpeg entry is `ff_dash_demuxer` in `libavformat/dashdec.c:2368-2380`; its callbacks are `dash_probe`, `dash_read_header`, `dash_read_packet`, `dash_read_seek`, and `dash_close`.

The main data objects are:

- `DASHContext` (`dashdec.c:124-174`): MPD URL/options, video/audio/subtitle representation arrays, live timing attributes, selected Period timing, and refresh state;
- `struct representation` (`79-122`): URL template, nested `AVIOContext`/`AVFormatContext`, init data, sequence/timeline state, language/bandwidth/framerate, and the associated outer `AVStream`;
- `struct timeline` (`48-72`): `S@t`, `S@r`, and `S@d`; and
- `struct fragment` (`37-41`): URL/range information.

`dash_read_header()` (`2024-2137`) calls `parse_manifest()`, then opens every video, audio, and subtitle representation. `parse_manifest()` (`1211-1382`) reads the XML with libxml2, parses MPD live attributes, chooses a Period, and walks its AdaptationSets. `parse_manifest_representation()` (`834-1110`) applies MPD/Period/AdaptationSet/Representation inheritance for BaseURL, SegmentTemplate, SegmentList, initialization, media, presentationTimeOffset, duration, timescale, startNumber, and SegmentTimeline.

`parse_manifest_segmenttimeline()` (`665-704`) stores one `timeline` object per `<S>`. A repeated run remains compressed as `repeat`; it is not expanded into one object per segment.

### 7.3 Segment URL creation and downloading

`get_current_fragment()` (`dashdec.c:1594-1674`) selects a SegmentList fragment or fills `SegmentTemplate` fields with `ff_dash_fill_tmpl_params()`. `open_input()` (`1693-1723`) resolves the URL against BaseURL and opens it via libavformat `io_open`, optionally with byte-range offsets. `update_init_section()` (`1725-1768`) downloads and caches at most 1 MiB of initialization data.

`read_data()` (`1781-1842`) presents an inner demuxer with a virtual sequence: initialization bytes first, then current segment bytes. At segment EOF it advances `cur_seq_no`, reopens as needed, and continues. `reopen_demux_for_component()` (`1863-1936`) creates that custom AVIO and lets libavformat probe/open the component container. If a `cenc_decryption_key` option is set, it passes the key as the inner MOV demuxer's `decryption_key` at lines 1914-1918.

Although mpv wraps the outer `AVFormatContext.io_open` (`demux_lavf.c:924-958`), the actual segment transfer is still initiated and sequenced by FFmpeg DASH. mpv's wrapper propagates configured libavformat/network options and tracks nested handles; it does not choose the segment.

### 7.4 Packet interleaving and A/V synchronization

`dash_read_packet()` (`dashdec.c:2165-2225`) checks which representations are selected using `AVStream.discard`, closes unneeded component demuxers, and catches newly selected ones up to the greatest peer sequence number (`2140-2163`). It then chooses the active video/audio/subtitle representation with the smallest `cur_timestamp`, calls `av_read_frame()` on its inner demuxer, rewrites the packet's `stream_index`, and returns it.

FFmpeg therefore does coarse component interleaving and timestamp normalization. mpv's demux queues, decoder chains, playback clock, audio resampling/output, video scheduling, and VO/AO implement final A/V synchronization. The DASH engine does not render or schedule decoded frames.

### 7.5 Seeking and dynamic MPD refresh

Static MPD seek is `dash_read_seek()` -> `dash_seek()` (`dashdec.c:2239-2333`). It maps the requested timestamp through each representation's SegmentTimeline or fixed duration, resets component state, and reopens component demuxers. It seeks every video/audio/subtitle representation so their sequence positions stay aligned.

For live MPDs, `dash_read_seek()` explicitly returns `AVERROR(ENOSYS)` (`dashdec.c:2317-2319`). `timeShiftBufferDepth` is parsed and used in `calc_min_seg_no()` to reject/advance expired segments (`1299-1301,1423-1434,1623-1635`); it does not make FFmpeg's live DASH input seekable.

Live refresh occurs on demand in `get_current_fragment()` when the current list is exhausted or timeline/fragment data needs updating (`1617-1629`). `refresh_manifest()` (`1495-1592`) reparses the entire MPD, requires video/audio/subtitle representation counts to remain identical, maps video/audio sequence positions by time, swaps their timeline/fragment arrays, then restores the old active arrays.

### 7.6 Current MPD responsibility matrix

| Responsibility | Current owner | Evidence / qualification |
|---|---|---|
| top-level URL and client command | ynoTV + mpv | ynoTV `mpv_load`; mpv `loadfile` |
| top-level stream abstraction | mpv | `stream_create`, custom AVIO in `demux_lavf` |
| MPD XML parsing | FFmpeg | `dashdec.c::parse_manifest()` using libxml2 |
| SegmentTemplate expansion | FFmpeg | `parse_manifest_representation`, `ff_dash_fill_tmpl_params` |
| SegmentTimeline model | FFmpeg | `struct timeline`, timeline calculation functions |
| segment selection/download | FFmpeg | `get_current_fragment`, `open_input`, `read_data` |
| representation exposure | FFmpeg | one outer `AVStream` per component representation |
| initial representation/track selection | mpv | `variant_bitrate` -> `hls_bitrate`, `select_default_track` |
| ongoing ABR | neither | no throughput/buffer-driven switching loop in inspected code |
| A/V/sub packet interleave | FFmpeg DASH | `dash_read_packet()` chooses lowest component timestamp |
| demux packet queue/cache | mpv | `demux_internal`, `demux_stream` |
| decode/hardware decode | mpv + libavcodec/hardware APIs | decoder wrappers and vd/ad_lavc |
| final A/V sync | mpv | player audio/video/play loop |
| static DASH seek | FFmpeg, orchestrated by mpv seek | `dash_read_seek`/`dash_seek` |
| live MPD refresh | FFmpeg | `refresh_manifest` |
| live DVR seek | not supported in FFmpeg DASH path | live `dash_read_seek` returns `ENOSYS` |
| subtitle decode/render | FFmpeg/mpv/libass depending codec | DASH exposes track; mpv subtitle pipeline renders |

## 8. DASH behavior and limitations

### 8.1 Large SegmentTimeline

The MPD is parsed as a full libxml2 DOM (`xmlReadMemory`/document traversal in `parse_manifest`), and each `<S>` allocates a separate `struct timeline` (`dashdec.c:665-700`). Memory is therefore proportional to XML size plus the number of `<S>` elements, although positive `r` repeats are stored compactly.

Several calculations are linear in the number of timeline entries and may also loop over each positive repeat:

- `get_segment_start_time_based_on_timeline()` (`255-288`);
- `calc_next_seg_no_from_timelines()` (`290-318`); and
- `calc_max_seg_no()` (`1437-1460`).

A huge timeline with many `<S>` entries increases parse, memory, refresh, and lookup costs. A huge positive `r` can make the nested repeat loop expensive even without expanded storage. Live refresh reparses and replaces whole arrays rather than applying a compact incremental diff.

### 8.2 Dynamic MPDs and live refresh

FFmpeg parses `availabilityStartTime`, `publishTime`, `minimumUpdatePeriod`, `timeShiftBufferDepth`, `minBufferTime`, and `suggestedPresentationDelay` (`dashdec.c:1280-1310`). It calculates current/min/max sequence numbers from wall-clock fields and refreshes the MPD when needed.

Limitations visible in source:

- `refresh_manifest()` rejects any change in counts of video, audio, or subtitle representations (`1519-1536`). Dynamic addition/removal is therefore fatal to refresh.
- Refresh state matching is positional (`videos[i]`, `audios[i]`), not by stable Representation/AdaptationSet identity.
- Video and audio timelines/fragments are moved into active representations; subtitle refresh objects are freed without an equivalent merge loop (`1538-1569,1578-1590`). This is a concrete concern for dynamic subtitle timelines.
- Refresh is demand-driven and reparses the whole MPD; `minimumUpdatePeriod` is parsed but there is no independent scheduler shown in the inspected code that continuously refreshes precisely on that interval.

### 8.3 `timeShiftBufferDepth` and DVR

`timeShiftBufferDepth` contributes to minimum live sequence calculation (`calc_min_seg_no()`), so FFmpeg can avoid a segment that has fallen out of the advertised window. It does not expose a seekable live DVR timeline: `dash_read_header()` marks live I/O non-seekable (`2043-2047`) and `dash_read_seek()` refuses live seeks.

mpv's `demuxer-max-back-bytes` packet cache can allow seeks within packets mpv itself still retains. ynoTV labels those cache properties as timeshift (`mpv_core.rs:400-415`; `useMpvListeners.ts:125-131`), but this is mpv cache rewind, not standards-aware DASH DVR. It cannot reliably jump to an arbitrary still-advertised MPD segment that mpv never cached.

### 8.4 Multi-period

`parse_manifest()` states, "at now we can handle only one period, with the longest duration" (`dashdec.c:1323`). It iterates Periods and selects the one whose duration is greatest (`1326-1346`). This is not a presentation-spanning multi-period timeline. Period transitions, discontinuities, ad periods, changing codecs, and period-specific DRM are therefore not modeled as continuous playback by this demuxer.

### 8.5 Separate video/audio representations

FFmpeg has separate `videos` and `audios` arrays and one inner component demuxer per representation. It exposes all as outer streams, uses discard flags to keep selected ones active, catches a newly selected representation up to peer sequence numbers, and interleaves by timestamps. This supports common separate-video/separate-audio MPDs.

It does not prove seamless switching. Selection changes can close/reopen inner demuxers, sequence catch-up is by max sequence number rather than a full cross-AdaptationSet presentation timeline, and codec/extradata changes are constrained by mpv decoder reinitialization and segment boundary alignment.

### 8.6 Representation switching and ABR

FFmpeg marks `variant_bitrate`; mpv copies it to `hls_bitrate` and initially prefers the highest representation not above `--hls-bitrate` (`player/loadfile.c:552-561`). The default is max. This mechanism is static preference/track selection, despite the option's historical HLS name.

There is no measured bandwidth estimator, buffer-occupancy policy, safety factor, switch request planner, or continuous quality controller in the inspected DASH/mpv path. A user/property-driven video-track switch is possible, but it is not adaptive bitrate streaming in the Shaka sense.

### 8.7 Subtitle representations, WebVTT, and TTML

`get_content_type()` recognizes a representation as subtitle only when inherited `contentType`/`mimeType` contains `text` (`dashdec.c:555-578`). Subtitle representations are opened/interleaved like audio/video.

- Plain or segmented WebVTT can work when the inner input is recognizable: FFmpeg has `webvttdec`, mpv maps WebVTT to its text subtitle path, and mpv/libass can render the resulting cues.
- fMP4 WebVTT (`wvtt`) support depends on FFmpeg MOV codec mapping and mpv's WebVTT conversion path; this should be fixture-tested against the exact binary.
- fMP4 TTML (`stpp`) is recognized by FFmpeg MOV as `AV_CODEC_ID_TTML`, but FFmpeg 8.0 has no general TTML decoder in the inspected decoder registry and mpv has no explicit TTML converter mapping. Do not assume render support.
- DASH's default `allowed_extensions` is `aac,m4a,m4s,m4v,mov,mp4,webm,ts` (`dashdec.c:2352-2359`), excluding `.vtt`/`.webvtt`. Plain WebVTT segment URLs may require an option change and still depend on probing/content type.
- The live-refresh subtitle merge issue above can make dynamic subtitle updates stale.

### 8.8 Encrypted CENC fMP4 and key rotation

FFmpeg DASH accepts only one `cenc_decryption_key` string option (`dashdec.c:2352-2359`) and forwards it as the MOV `decryption_key` for each component (`1914-1918`). This provides a static clear-key convenience, not a DRM/CDM abstraction.

MOV parses per-stream defaults and per-sample overrides, so rotated KIDs can be represented in packet side data. But the built-in DASH option supplies one key, and `MOVContext` stores one `decryption_key` (`libavformat/isom.h:366-367`). There is no license acquisition, KID-to-key map, key-status callback, renewal, secure decode, or per-key rotation controller. Widevine/PlayReady workflows are outside this path.

## 9. Candidate integration points for a Rust DASH engine

The proposed Rust engine owns MPD/timeline/index/scheduling/live/ABR/DRM while mpv should retain compressed-media decode, hardware acceleration, A/V sync, output, rendering, and playback state. No candidate satisfies all of that through an existing stable public API. The choices trade integration depth against semantic control.

### 9.1 A. libmpv stream callback / custom protocol

#### Concrete insertion point

Register a protocol with `mpv_stream_cb_add_ro()` before loading it, then `loadfile rustdash://...`. mpv implements this in `player/client.c:2193-2249` and `stream/stream_cb.c`. The callback supplies `read_fn`, optional byte `seek_fn`, optional `size_fn`, `close_fn`, and optional `cancel_fn` (`include/mpv/stream_cb.h`). `stream_cb.c:23-99` turns those into one mpv `stream_t`.

`libmpv2` enables its `protocols` feature by default, but ynoTV does not currently register any protocol. The checked-in `libmpv/stream_cb.h` and linked client API expose the C function.

#### What Rust must present

The public abstraction is one byte sequence. Viable forms include:

1. concatenate init + selected media segments into a virtual fMP4 stream;
2. remux audio/video/subtitle into one MPEG-TS, Matroska, or fragmented MP4 stream; or
3. expose separate custom URLs and add audio/subtitle as mpv external files.

It cannot directly say "here are three tracks and these timestamped compressed packets."

#### Seeking

mpv and the selected demuxer seek by byte offset. Rust must provide a stable mapping from byte positions to segment data. A live window whose virtual byte layout changes is hazardous: already-issued offsets must remain meaningful, or seeks/cache reads become inconsistent. Returning no `seek_fn` makes the stream non-seekable except for mpv's retained cache.

Container demuxers may ask for size, indexes, or arbitrary backward reads. A growing fMP4 stream needs fragment boundaries and timestamps that the MOV demuxer accepts without a final index.

#### Independent tracks and synchronization

A single callback naturally describes one muxed container. Separate A/V representations therefore require remuxing or multiple coordinated callback URLs. Multiple files are possible with `audio-add`/`sub-add` or EDL, but mpv treats them as independent demuxers and seeks them separately; Rust must guarantee a common presentation epoch, offsets, discontinuities, cancellation, and live-edge state.

#### ABR and live

Rust can choose which next segment bytes it supplies. Seamless switching works only when the byte stream remains valid for the downstream demuxer: compatible codec configuration, aligned decode boundaries, correct timestamps, and new init/extradata where required. Switching across incompatible representations may require a remuxer that rewrites container continuity or a controlled reload/track reinit.

#### Subtitles

Muxed supported subtitles can be carried through the container. Plain text tracks are easier as separate `sub-add` custom URLs/files, but live incremental subtitle input and seek behavior must be tested. TTML still needs conversion (for example to ASS/WebVTT) because mpv's renderer cannot be assumed to decode it.

#### DRM/CENC

The callback can decrypt media before returning bytes. That is conceptually simple and keeps encrypted samples away from mpv, but byte-level CENC decryption requires parsing enough ISO-BMFF to locate samples, IVs, and subsamples, and then presenting a structurally consistent clear container. Alternatively Rust can remux decrypted compressed samples. Secure-path DRM cannot be guaranteed when clear bytes live in ordinary Rust memory and mpv buffers.

#### Pros

- Uses a stable public libmpv client API; no mpv fork for the first prototype.
- Fits ynoTV's in-process `MpvCoreState` naturally.
- Rust owns fetch, cancellation, caching, and segment choice.
- Retains existing `demux_lavf`, decoder, hardware decode, sync, subtitle, and render code.

#### Cons

- Wrong semantic level for independent tracks/packets.
- Byte seeking and mutable live windows are difficult.
- Remuxing is likely for robust A/V/subtitle multiplexing and ABR.
- The Windows sidecar engine cannot use an in-process callback; native DASH would have to force/use `LibMpv` or expose an HTTP/pipe endpoint.
- Encrypted sample metadata is not passed separately through this API.

#### Assessment

Best for a disposable single-track or already-muxed ClearKey prototype; high risk as the final multi-track live/DRM architecture unless paired with a real remuxer or the hybrid in section 9.4.

### 9.2 B. Custom mpv demuxer

#### Concrete insertion point

Add a `demuxer_desc` to mpv's `demuxer_list` in `demux/demux.c`, modeled after existing descriptors. Its `open` creates `sh_stream`s with `demux_alloc_sh_stream()`/`demux_add_sh_stream()`, `read_packet` returns `demux_packet`s, `seek` updates Rust state, and `switched_tracks` reacts to selection. `demux_lavf.c:1734-1747` demonstrates the descriptor callbacks.

Rust could own a handle behind the C demuxer private state and expose an ABI such as create/open, enumerate tracks, read next packet, select tracks, seek, cancel, and destroy.

#### Required packet contract

For every track Rust must provide:

- stable stream identity/type/language/default/forced flags;
- codec name/ID and codec parameters;
- codec extradata/init changes;
- compressed access-unit bytes;
- PTS, DTS, duration, keyframe, discontinuity/segment boundaries;
- EOF versus temporary starvation/live wait;
- attachment/color/HDR metadata as needed; and
- queue backpressure/cancellation.

mpv can then feed the normal `f_demux_in` and decoder wrappers. Hardware decoding remains available because compressed codec packets enter before `vd_lavc`/`ad_lavc`.

#### Seeking and live

This is the first option whose API can express presentation-time seek directly. mpv's `demux_seek()` invokes the custom callback; Rust can map the target into its `PresentationTimeline`/`SegmentIndex`, flush outstanding downloads, choose aligned audio/video/subtitle segments, and resume packet production. It can also expose a changing seekable range through demux properties/events, though mpv integration work is required.

#### Track/ABR behavior

Logical audio/subtitle switching maps cleanly to `switched_tracks`. Video ABR can remain one logical video track while Rust changes representations and supplies new extradata/segment boundary metadata. Decoder reconfiguration rules must be explicit: same-codec compatible changes may be seamless; resolution/codec/profile/extradata transitions must trigger a decoder reinit at a random-access point.

#### DRM

Rust can preserve an internal `EncryptedPacket` and submit only decrypted compressed bytes as the `demux_packet`. Or the mpv patch can carry encryption side data to a new decrypt filter. The former minimizes mpv DRM awareness; the latter preserves a better separation between demux and decrypt but enlarges the patch.

#### Pros

- Correct semantic level: tracks, packets, timestamps, selection, seek, and live starvation.
- No remux required.
- Rust owns the whole DASH/ABR/DRM model while mpv starts at compressed decoder input.
- Natural place to coordinate audio/video/subtitle segments and discontinuities.

#### Cons

- mpv has no stable loadable demuxer plugin ABI; this is a maintained mpv fork.
- The internal demux API, filter API, and struct layouts can change.
- A cross-language callback on the demux thread needs careful lifetime, blocking, cancellation, and panic isolation.
- Correct packet timestamps/extradata and decoder transitions are a substantial media-engine responsibility.
- Custom binaries are required on every platform, complicating ynoTV's already-divergent packaging.

#### Assessment

Architecturally strong and likely the cleanest long-term semantics, but the highest mpv maintenance commitment. It should not be selected until packet/extradata/seek fixtures prove that the Rust engine can meet mpv's demux contract.

### 9.3 C. Extend `demux_lavf` / FFmpeg pipeline

There are three variants under this label.

#### C1. Replace FFmpeg DASH, keep FFmpeg MOV via custom per-representation AVIO

Rust parses/schedules the MPD and feeds init + fMP4 media fragments to one FFmpeg MOV `AVFormatContext` per active logical representation. FFmpeg continues to parse `moov/moof/traf/trun`, discover sample tables, emit codec parameters, and create `AVPacket`s. An mpv integration layer interleaves those packets or makes them mpv streams.

This closely resembles the useful half of `dashdec.c`: `struct representation`, `read_data()`, inner component demuxers, and `dash_read_packet()`, but replaces FFmpeg's MPD/timeline/network logic with Rust. It is practical in principle and avoids reimplementing fragmented MP4. The hard parts are:

- wiring Rust AVIO safely into the FFmpeg instance used by mpv;
- coordinating multiple component contexts and selection;
- translating live seek/cancel/backpressure;
- handling init changes and representation switches; and
- preserving encryption side data before decryption.

Implementing it directly in `demux_lavf.c` couples the project to both mpv and FFmpeg internals. Implementing a custom FFmpeg `AVInputFormat` makes the mpv patch smaller but creates a custom FFmpeg build/plugin problem; FFmpeg input formats are also normally compiled/registered, not loaded through a stable plugin ABI.

#### C2. Patch FFmpeg `dashdec.c`

Replace calls to `parse_manifest`, `get_current_fragment`, `open_input`, and refresh/seek calculations with Rust callbacks while preserving FFmpeg's outer stream/component machinery. This is the shortest route from existing code but inherits `dashdec`'s representation model and ties Rust to a private FFmpeg demuxer implementation. It also creates a three-project fork chain: ynoTV + mpv + FFmpeg.

#### C3. Use existing `demux_lavf` with a Rust-generated local MPD/HTTP origin

Rust can expose a loopback HTTP origin and synthesize an MPD/segments, letting unmodified FFmpeg DASH consume it. This is valuable as a research harness but does not actually replace FFmpeg scheduling/ABR, and encrypted-license metadata still has to cross a URL/container boundary. It is not the desired final ownership split.

#### Pros

- Retains mature ISO-BMFF and codec parameter parsing.
- FFmpeg already exposes CENC sample/PSSH side data.
- Less packet construction than a fully custom mpv demuxer.

#### Cons

- No stable FFmpeg demuxer plugin ABI.
- Potential mpv and FFmpeg forks/builds.
- Multi-context interleave and seek logic still must exist somewhere.
- Directly extending current `dashdec.c` inherits structural limitations unless largely rewritten.

#### Assessment

Technically practical, especially C1, and worthy of a focused prototype. Prefer a narrow adapter around unmodified MOV demux contexts over embedding the new engine deep inside the current FFmpeg DASH demuxer.

### 9.4 D. Hybrid virtual component sources (additional architecture)

This is a composition of public libmpv protocols and existing mpv external-track support:

1. Rust owns MPD/timeline/segment scheduling.
2. Register `rustdash://session/video`, `/audio/<id>`, and possibly `/subtitle/<id>` stream callbacks.
3. Load video as the main file and attach audio/subtitles as external tracks (`audio-add`/`sub-add` or an EDL-style source).
4. Each source exposes a virtual fragmented container assembled from init plus chosen media segments. FFmpeg MOV remains the sample demuxer.
5. A shared Rust session coordinates presentation time, selected representation, live window, and cancellation across the independent callback cookies.

This avoids an mpv fork for early experiments and avoids A/V remuxing into one stream. It is significantly cleaner than treating all media as one byte callback, but it is still constrained by mpv's independent-demuxer model:

- seeks arrive independently and must rendezvous without deadlock;
- mpv applies per-external-track seek offsets, so presentation epoch must be exact;
- dynamic audio/subtitle track discovery requires explicit frontend/native management;
- ABR init changes must remain valid within each virtual container; and
- live duration/seekable-range properties may not naturally reflect a shared MPD window.

It also works only in-process. A sidecar could consume the same concept only if Rust exposed it over loopback HTTP/named pipes rather than libmpv callbacks.

#### Assessment

The best no-fork research path for validating Rust timeline/scheduler/decrypt concepts with real mpv decoding. It is not yet proven as the production architecture. Use it to learn whether coordinated virtual fMP4 sources survive seek, discontinuity, and representation switches before committing to B or C1.

### 9.5 Comparison

| Criterion | A: one stream callback | B: custom mpv demuxer | C1: Rust scheduler + FFmpeg MOV | D: coordinated component callbacks |
|---|---|---|---|---|
| mpv fork | no | yes | likely, unless wrapped indirectly | no for prototype |
| FFmpeg fork | no | no | not necessarily for C1; yes for patched demuxer | no |
| remux needed | usually for multi-track | no | no | no |
| logical tracks | poor | native | native via adapter | external mpv tracks |
| time-based seek | awkward byte map | native | native in adapter | coordinated byte maps |
| live/DVR | difficult | strong | strong | possible, awkward |
| ABR | byte continuity problem | explicit packets | explicit component input | per-component continuity problem |
| DRM metadata | hidden unless Rust parses/decrypts | explicit/custom | FFmpeg side data available | Rust parses/decrypts or MOV side data not externally intercepted |
| maintenance | low API, high media workaround | mpv fork | adapter + FFmpeg API | medium orchestration |
| sidecar compatibility | no | custom sidecar build only | custom build only | needs HTTP/IPC bridge |

No winner is selected in this research phase. The recommended sequence is to prototype D/A for evidence, prototype the decrypt boundary described below, and only then decide whether the production contract justifies B or C1.

## 10. DRM/CENC insertion-point analysis

### 10.1 Metadata FFmpeg exposes

FFmpeg `libavutil/encryption_info.h` defines:

- `AVEncryptionInfo`: fourcc scheme, `crypt_byte_block`, `skip_byte_block`, KID, IV, and an array of clear/protected subsamples (`lines 25-81`);
- `AVEncryptionInitInfo`: system ID, one or more KIDs, system-specific initialization bytes, and a linked list for multiple systems (`88-123`).

The serialized packet side-data types are declared in `libavcodec/packet.h:241-252`:

- `AV_PKT_DATA_ENCRYPTION_INIT_INFO`;
- `AV_PKT_DATA_ENCRYPTION_INFO`.

This covers the future pipeline requirements as follows:

| Requirement | FFmpeg representation |
|---|---|
| `cenc`, `cens`, `cbc1`, `cbcs` | `AVEncryptionInfo.scheme`; MOV dispatches all four in `cenc_decrypt()` |
| pattern encryption | `crypt_byte_block`, `skip_byte_block` |
| KID | `key_id` per sample/default; init info can list KIDs |
| IV | `iv`, including constant/per-sample IV handling |
| subsamples | `AVSubsampleEncryptionInfo` clear/protected byte counts |
| PSSH | `AVEncryptionInitInfo.system_id`, KIDs, and opaque data |
| key rotation | per-sample encryption info can carry a changed KID; application still needs KID-to-key/CDM logic |

### 10.2 MOV/fMP4 parsing behavior

FFmpeg MOV parses:

- `pssh` in `libavformat/mov.c::mov_read_pssh()` (`7801-7919`) and attaches initialization side data to `AVCodecParameters.coded_side_data`;
- `schm` in `mov_read_schm()` (`7922-7951`);
- `tenc` in `mov_read_tenc()` (`7953-8021`), including pattern, default KID, per-sample IV size, and constant IV;
- `senc`, `saiz`, and `saio` in `mov_read_senc`, `mov_read_saiz`, `mov_read_saio` (`7504-7795`); and
- `cenc`, `cens`, `cbc1`, and `cbcs` decryption helpers (`8064-8321`).

At packet output, `cenc_filter()` (`8349-8416`) finds the applicable default/per-sample encryption record. If a static `decryption_key` was configured, it decrypts in place. Otherwise it serializes the record as `AV_PKT_DATA_ENCRYPTION_INFO` and attaches it to the `AVPacket` (`8402-8412`). `mov_read_packet()` calls this filter immediately before returning (`11218-11233`).

This source evidence answers an important question: **yes, FFmpeg can expose rather than discard encrypted-sample metadata.** It is not limited to its one-key convenience decrypt mode.

### 10.3 What mpv preserves and what it does not do

mpv's `new_demux_packet_from_avpacket()` uses `av_packet_ref()` (`demux/packet.c:106-129`), retaining packet side data. mpv's demux cache explicitly serializes/deserializes all `AVPacket` side data (`demux/cache.c:223-265,318`). Before libavcodec input, `mp_set_av_packet()` copies the retained side-data pointer/count into the decoder packet (`common/av_common.c:175-203`).

A search of pinned mpv source finds no `AV_PKT_DATA_ENCRYPTION_INFO` consumer and no CENC decrypt filter. Preserving side data is therefore necessary but insufficient: a normal codec does not decrypt ISO CENC simply because the side data is attached.

`AV_PKT_DATA_ENCRYPTION_INIT_INFO` is stream-level coded side data. `demux_lavf::handle_new_stream()` copies the full `AVCodecParameters` into `sh->codec->lav_codecpar` at `demux_lavf.c:824-828`, so it is potentially available to a custom decrypt/CDM stage even though existing mpv does not interpret it.

### 10.4 Candidate decrypt boundaries

#### Before mpv byte input

Rust parses fMP4 encryption boxes and decrypts samples, then remuxes or reconstructs a clear byte stream. Decrypted compressed samples re-enter mpv at its normal stream/demux path.

- Advantage: no mpv fork and no encrypted packets reach decoder code.
- Cost: Rust must parse/rewrite enough ISO-BMFF or use FFmpeg as a library; byte offsets, box sizes, auxiliary info, and CBCS patterns must remain correct.

#### After FFmpeg MOV demux, before mpv decoder input

Let MOV emit `AVPacket` plus encryption side data. Add a decrypt transform before `vd_lavc`/`ad_lavc`, either:

- in/adjacent to `demux_lavf_read_packet()` before conversion to `demux_packet`;
- as a new mpv packet filter between `f_demux_in` and `mp_decoder_wrapper`; or
- inside a custom demux adapter that receives FFmpeg packets, calls Rust `DrmSystem`, and returns clear `demux_packet`s.

This is the most information-rich boundary. The transform can parse `AVEncryptionInfo`, ask `DrmSystem` for the KID's usable key/session, decrypt only protected spans, remove encryption side data, and forward the same compressed codec packet/timestamps. It also permits asynchronous key waiting—but mpv filter/demux backpressure and cancellation must be designed carefully.

For maintainability, a custom demux adapter (B/C1) is preferable to adding DRM policy directly inside generic `demux_lavf`. Generic mpv code should see a narrow callback such as "decrypt this encrypted access unit" rather than Widevine/PlayReady concepts.

#### FFmpeg static-key option

For ClearKey-only diagnostics, `--demuxer-lavf-o=cenc_decryption_key=<hex>` can reach FFmpeg DASH/MOV. mpv's own interface changelog points to the MOV `decryption_key` option. This handles one key and is useful only as a baseline. It is not suitable for KID maps, rotation, licenses, or CDMs.

### 10.5 Proposed future abstraction boundary (not implementation)

A future design should keep manifest protection data and sample crypto data separate:

```text
DrmSystem
  create_session(init_data_type, pssh/system_id data)
  update_session(license_response)
  key_status(kid) -> pending | usable | expired | error
  decrypt(EncryptedPacket) -> ClearCompressedPacket

EncryptedPacket
  track_id
  pts / dts / duration / keyframe
  codec/extradata generation
  scheme (cenc/cens/cbc1/cbcs)
  kid
  iv
  crypt/skip pattern
  clear/protected subsamples
  compressed bytes
```

ClearKey can return software keys by KID. Widevine and PlayReady may require CDM-specific session threading, license messages, output restrictions, robustness policies, and possibly a secure decoder/output path. The current libmpv software packet/decode path cannot promise secure video memory. That product/security requirement must be settled before claiming Widevine/PlayReady feasibility.

### 10.6 Key rotation implications

Do not cache one key per track. The applicable KID can change per sample/fragment through sample-group/default overrides. The scheduler/decrypt stage must:

- retain PSSH/init-data sets and associate them with periods/representations;
- inspect every packet's effective KID;
- stall only affected tracks while acquiring a key;
- preserve A/V queue bounds while stalled;
- handle a new init segment/default KID at representation or Period change; and
- flush/retry deterministically on seek into a differently keyed interval.

## 11. Files/functions likely to need modification in a future implementation

This is a map, not a change proposal for the present phase.

### 11.1 ynoTV, common to all native approaches

- `packages/ui/src/services/tauri-bridge.ts`
  - add a future native-DASH session API without leaking raw mpv properties into UI;
  - expose presentation seekable/live range and track/quality state.
- `packages/ui/src/hooks/usePlayback.ts`
  - choose native DASH only for supported MPDs;
  - reconcile engine tracks, live edge/DVR, buffering, fatal errors, and quality selection.
- `packages/ui/src/hooks/useMpvListeners.ts`
  - consume explicit native-DASH state/events rather than infer DASH state from `duration` and mpv cache.
- `packages/app/src-tauri/src/lib.rs`
  - register commands/state and select the in-process engine for native DASH;
  - keep sidecar/native behavior explicit rather than silently diverging.
- `packages/app/src-tauri/src/mpv_core.rs`
  - own the Rust DASH session and register callbacks/adapter before `loadfile`;
  - improve event forwarding if the custom pipeline needs real seek/restart/end reasons;
  - potentially expose a safe `mpv_command` argv helper.
- `packages/app/src-tauri/Cargo.toml`, `build.rs`, platform Tauri configs, release workflow, and binary scripts
  - add the Rust DASH/DRM libraries and make the exact libmpv/FFmpeg build reproducible.

### 11.2 Approach A/D

- Use `libmpv2` protocol support or `libmpv2_sys::mpv_stream_cb_add_ro` from `mpv_core.rs`.
- Add Rust callback/session modules for open/read/seek/size/close/cancel and coordinated virtual sources.
- Extend command plumbing for `audio-add` or external logical tracks if using D.
- No mpv source modification should be required for the first prototype.

### 11.3 Approach B

Pinned mpv fork:

- `demux/demux.c`: register the new `demuxer_desc`;
- new `demux/demux_rustdash.c` (or equivalent): Rust ABI, stream creation, packet reads, seek, track switches, control/events;
- `demux/stheader.h`, `demux/packet.h` only if existing metadata is insufficient;
- `player/loadfile.c` / `player/command.c` only if changing dynamic-track/quality semantics;
- `filters/f_demux_in.c` or new packet filter if decryption occurs after demux;
- build definitions in `meson.build` and exported headers if the ABI is public.

Rust/ynoTV must build and package this fork instead of an unpinned system/latest binary.

### 11.4 Approach C1

- ynoTV/Rust module that creates per-representation FFmpeg MOV contexts and AVIO callbacks;
- a narrow mpv adapter, most likely a custom demuxer as above or a carefully scoped extension to `demux/demux_lavf.c`;
- FFmpeg public APIs `avio_alloc_context`, `avformat_open_input`, `av_read_frame`, `avformat_seek_file`, encryption-info accessors;
- no need to modify `libavformat/dashdec.c` if Rust fully replaces manifest/network scheduling.

If C2 is chosen instead, likely FFmpeg modifications are `libavformat/dashdec.c`, its build registration, and a Rust callback ABI. That variant has the greatest upstream-coupling risk.

### 11.5 DRM packet transform

Likely mpv fork locations:

- `demux/demux_lavf.c::demux_lavf_read_packet()` to hand off encrypted `AVPacket`s;
- `demux/packet.c` / `common/av_common.c` only if ownership/side-data mutation requires it;
- `filters/f_demux_in.c` and `filters/f_decoder_wrapper.c` if implemented as a packet filter;
- audio/video decoder entry (`ad_lavc`, `vd_lavc`) should ideally remain unchanged and receive clear compressed packets.

Likely FFmpeg code to rely on, not rewrite: `libavformat/mov.c` CENC box parsing and `libavutil/encryption_info.*` serialization.

## 12. Unknowns requiring further research

1. **Artifact attestation.** Obtain the exact ynoTV `v-assets/libmpv-2.dll`, verify the configured SHA-256, run/query its mpv and FFmpeg build configuration, and preserve a signed SBOM. Confirm whether it is byte-identical to the named Shinchiro `cfd818b` archive.
2. **Exact Shinchiro FFmpeg revision/config.** The mpv commit is named; the FFmpeg commit and enabled libraries/options are not recorded in ynoTV.
3. **macOS release viability.** Confirm how `libmpv.2.dylib` and its dependency closure enter a distributable app. The current config demonstrably packages sidecar dylibs, not libmpv itself.
4. **Platform target correctness.** The inspected local file named `mpv-aarch64-apple-darwin` is an x86_64 Mach-O. Establish whether this is a local stale/download issue and make architecture verification part of packaging research.
5. **Linux compilation/support.** Validate how the platform-specific `MpvState` alias and system libmpv linkage are intended to compile/package outside Windows/macOS.
6. **Event parity.** In-process ynoTV synthesizes seek/restart/EOF while sidecar uses real mpv events. Determine which semantics the DASH engine needs and whether to forward native events directly.
7. **Thread safety.** Verify `libmpv2` wrapper concurrency assumptions for the polling task, event context, render callback, and future Rust protocol callbacks. Review shutdown races and callback lifetime.
8. **Virtual fragmented MP4 behavior.** Test init+fragment concatenation, representation init changes, B-frames, `tfdt`, edit lists, discontinuities, and open-ended live reads against the exact FFmpeg builds.
9. **Multi-source synchronization.** Test approach D with separately callback-fed video/audio across seek, pause, cache starvation, live catch-up, and unequal segment durations.
10. **Dynamic track changes.** Determine whether mpv reliably surfaces added/removed streams from a long-lived custom demuxer and how UI IDs remain stable.
11. **WebVTT/TTML fixtures.** Test plain segmented WebVTT, `wvtt` in fMP4, `stpp` TTML/IMSC, styles/regions, and seek. Source inspection shows caveats but fixture coverage is needed.
12. **CENC fixtures.** Verify FFmpeg side data for `cenc`, `cens`, `cbc1`, and `cbcs`; 8/16-byte IVs; constant IV; subsample patterns; `senc` versus `saiz/saio`; and sample-group key rotation.
13. **Side-data survival at runtime.** Source preserves it, but create a diagnostic build/test to verify PSSH and per-packet encryption metadata through the exact mpv/FFmpeg binary boundary.
14. **Hardware decoder reconfiguration.** Determine which same-codec ABR changes can remain on one decoder and which require flush/reinit on D3D11VA, VideoToolbox, and Linux hardware APIs.
15. **Secure playback requirements.** Establish whether Widevine/PlayReady targets require hardware-secure decode/output. If yes, ordinary libmpv software-decrypted packets may be categorically insufficient.
16. **Licensing/distribution.** Review LGPL/GPL configuration, CDM redistribution rules, and DRM provider agreements before committing to custom mpv/FFmpeg binaries.
17. **Protocol/network requirements.** Headers, cookies, redirects, signed URL renewal, HTTP/2/3, range requests, retries, CDN steering, UTC timing, and content steering are not yet specified for the Rust scheduler.
18. **DASH profile coverage.** SegmentBase/index ranges, `sidx`, negative repeats, availabilityTimeOffset/chunked CMAF/low latency, xlink, EventStream/emsg, ProducerReferenceTime, and ad periods require separate investigation.

## 13. Recommended questions for the Shaka Player research phase

Shaka is useful here as a behavior/reference design, not as code to transplant blindly. The next research should answer:

1. How does Shaka normalize MPD, Period, AdaptationSet, and Representation inheritance into one presentation timeline?
2. Which `SegmentIndex` structures keep very large/repeated `SegmentTimeline`s compact, and how are indexes evicted/updated for dynamic MPDs?
3. How does Shaka merge manifest refreshes by stable identity when representations or periods appear/disappear?
4. How are availability windows, `timeShiftBufferDepth`, presentation delay, live edge, clock offset/UTCTiming, and DVR seek range calculated?
5. How are multi-period transitions, gaps, overlaps, codec changes, and period-specific DRM represented?
6. How does the scheduler coordinate separate audio/video/text streams and prevent one type from running too far ahead?
7. Which ABR inputs are used (throughput estimate, buffer, dropped frames, viewport, restrictions), and when is a safe switch committed?
8. How are representation switches aligned to segment independence/SAP points and decoder configuration changes?
9. How are retries, alternate BaseURLs, request cancellation, prioritization, prefetch, and signed URL/header hooks modeled?
10. How are WebVTT, `wvtt`, TTML/IMSC, and embedded captions converted into cues, and which styling features are deliberately unsupported?
11. How are `ContentProtection`, default KID, PSSH, key-system selection, session reuse, persistent sessions, and key rotation modeled independently of MSE?
12. At what stage does Shaka associate encrypted sample metadata with queued media, and which parts are delegated to browser EME/MSE rather than implemented by Shaka?
13. Which Shaka assumptions depend on MSE SourceBuffer behavior (timestamp offsets, append windows, coded-frame eviction, changeType) and need a native mpv equivalent?
14. What is Shaka's state/error/event contract to UI, and which pieces should become ynoTV Tauri events versus mpv properties?
15. Which conformance fixtures and DASH-IF test vectors cover live refresh, huge timelines, multi-period, separate components, subtitles, CENC/CBCS, and rotation?

## 14. Research conclusions and next decision gates

The current ynoTV host is suitable for a disposable proof of concept specifically because it already has an in-process libmpv engine, native embedded surfaces, track/property controls, and a place (`MpvCoreState`) to own a Rust session. The Windows default-sidecar setting is not suitable for an in-process custom protocol or demux callback; a native DASH experiment must explicitly use the `LibMpv` engine.

Before choosing an architecture, the minimum evidence gates are:

1. Prove a Rust callback-fed fMP4 VOD can load, seek, and decode on Windows/macOS.
2. Prove coordinated separate video/audio callback sources remain synchronized across seek and starvation.
3. Prove same-codec representation changes and init/extradata transitions on software and hardware decoders.
4. Extract FFmpeg CENC/PSSH side data from representative fixtures and decrypt ClearKey compressed packets before decoder input.
5. Measure the patch surface for a minimal custom demux adapter versus an FFmpeg-MOV adapter.
6. Decide secure-decode requirements for future commercial DRM.

Only after those gates should the project choose between the public-protocol hybrid (lower maintenance, more container/orchestration constraints) and a packet-level custom adapter (higher maintenance, correct media semantics).
