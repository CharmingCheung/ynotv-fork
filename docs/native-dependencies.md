# Native dependencies and reproducible builds

ynoTV is not a browser-only pnpm project. The UI dependencies come from pnpm,
but the Tauri process also links to libmpv and launches mpv, FFmpeg, and yt-dlp
sidecars. A build is reproducible only when those native inputs are supplied as
versioned artifacts; `pnpm install` by itself cannot create them.

## Clean-clone development

After installing the platform prerequisites from the root README, the supported
development entry point is:

```sh
pnpm install
pnpm dev
```

`pnpm dev` now prepares missing sidecars before starting Tauri:

| Platform | Prepared automatically | Still required from the machine |
| --- | --- | --- |
| Apple Silicon macOS | versioned Native DASH libmpv/libplacebo runtime, mpv sidecar, yt-dlp; copies FFmpeg into ignored caches; builds the packet producer | Xcode CLI tools and Homebrew `mpv`, `ffmpeg`, `pkg-config` |
| Windows x64 | versioned Native DASH libmpv runtime and packet producer, mpv, FFmpeg, yt-dlp, Vulkan loader | Visual Studio C++ tools, Windows SDK, WebView2, Git Bash, 7-Zip |
| Linux x64 | wrapper around `/usr/bin/mpv`, FFmpeg and yt-dlp | Experimental only; the desktop playback backend is not implemented for Linux |

The preparation step needs network access to GitHub and the other download
hosts listed below. Generated binaries are gitignored. `pnpm dev` downloads the
pinned `ynotv-native` release, verifies its published SHA-256, and reuses the
cache afterward. It does not scan `/tmp`, `/private/tmp`, or old experiment
directories, and it requires no path environment variable.

The `Compile and test` GitHub Actions workflow type-checks the pnpm workspace
and runs `cargo check --locked` on both macOS and Windows. Tagged release builds
remain a separate workflow.

Intel macOS is not currently a clean-clone target: the mpv downloader has no
x86_64 artifact implementation. Windows ARM64 is also not supported.

## Downloaded build inputs

These are external build inputs and must be mirrored or pinned before builds
can be called hermetic:

| Input | Current source | Reproducibility status |
| --- | --- | --- |
| Native DASH runtime | `CharmingCheung/ynotv-native` release `v0.2.0` | Platform asset and release URL pinned; SHA-256 verified on download |
| Windows/macOS mpv sidecar | shinchiro GitHub releases / laboratory.stolendata.net | Uses a moving `latest` artifact |
| FFmpeg | BtbN GitHub release on Windows; Homebrew binary copied on macOS | Moving/latest or local Homebrew build |
| yt-dlp | official GitHub `latest` release | Moving artifact |
| Vulkan loader | LunarG latest runtime components | Moving artifact |
| Rust crates | crates.io via `Cargo.lock` | Version locked, registry/network still required |
| JavaScript packages | npm registry via `pnpm-lock.yaml` | Version locked, registry/network still required |

The remaining moving native downloads are suitable for local development, but not for a
bit-for-bit reproducible release. Release CI should migrate them to a dedicated
native-assets repository/release with immutable versioned URLs, SHA-256 files,
license files, and one manifest recording the mpv, FFmpeg, and toolchain commits.

## Native DASH development

The `RDPKT001` through `RDPKT006` strings are historical protocol revisions in
one experimental mpv patch, not six installed libraries. Production ynoTV emits
the current live/DVR revision (`RDPKT006`). `RDPKT001` is also used internally
as the segment producer's input envelope before Rust remaps it into the current
live stream. Older revisions remain only as regression fixtures in
`experiments/`.

Normal development—including Native DASH—uses the same command:

```sh
pnpm dev
```

The setup validates both the current `RDPKT006` demux contract and the
`YNOIMSC1` bitmap-subtitle bridge, builds the repository-local ClearKey packet
producer when missing, and injects the cached runtime into both the Rust linker
and the launched process. `pnpm setup:native-runtime -- --force` refreshes a
damaged cache.

The pinned source, patch, regression fixtures, platform build scripts, and release
workflow live in `CharmingCheung/ynotv-native`. Application developers consume
its release artifact and do not compile mpv locally.

Maintainers changing that patch can keep `ynotv-native` beside this checkout and
run `pnpm native:dev`. It uses a persistent Meson build directory for incremental
compilation, runs native tests, and installs the result into the same gitignored
cache used by `pnpm dev`. Restart with `pnpm dev:clean`. No push or Release is
needed during the edit/compile/test loop. On Windows this command expects MSYS2
at `C:\msys64` with the UCRT64 compiler, Meson, FFmpeg, OpenSSL, libplacebo,
LLVM, and MinGW tools installed. The native repository CI uses the same package
set and is the reference setup.

Windows keeps the sidecar backend for ordinary playback. A Native DASH session
automatically initializes the bundled in-process patched libmpv, routes playback
commands to it for the life of that session, then restores sidecar playback when
a normal stream is loaded.

## DMG and EXE portability

The Windows configuration bundles the patched `libmpv-2.dll`, its discovered
UCRT64 DLL closure, the ClearKey packet producer, the mpv/FFmpeg/yt-dlp
sidecars, and the Vulkan loader. GitHub Actions fails when a native download
or ABI marker check fails. A clean Windows VM playback smoke test is still
required before treating the first Windows artifact as production-proven.

The current macOS bundle is **not yet portable**. Inspection of the generated
app shows absolute `/opt/homebrew/...` references from the main executable and
the copied FFmpeg binary; a bundled libmpv build would also need its full dylib
closure relocated. The Native DASH packet producer is not bundled. Therefore a
DMG built by the current pipeline can depend on the builder's Homebrew
installation and must not be treated as a distributable release.

Run the guard after any macOS bundle build:

```sh
pnpm audit:macos-bundle
```

`pnpm build:macos` runs this guard automatically. The explicitly named
`pnpm build:macos:local` command skips the guard for local testing only.

It fails on Homebrew, MacPorts, temporary-directory, or workspace dylib paths.
A production DMG needs a relocatable native artifact set, all transitive dylibs
copied into the app, install names rewritten to `@rpath`/`@loader_path`, and the
complete bundle signed after rewriting. No network or Homebrew dependency
should remain at end-user runtime.
