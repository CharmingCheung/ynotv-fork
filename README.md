# ynoTV

[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-AGPL%20v3-green.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue)](./README.md)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/CharmingCheung/ynotv-fork/total)
[![Chat Server](https://img.shields.io/badge/chat-discord-7289da.svg)](https://discord.gg/e5eGa5QETB)

A feature-rich, open source IPTV player for Windows built on [Tauri v2](https://tauri.app) and [mpv](https://mpv.io). 

[![Watch the video](https://i.ibb.co/207znsrw/ynotv-go-Ckngt-Ezr.png)](https://i.ibb.co/207znsrw/ynotv-go-Ckngt-Ezr.png)

[Old Video Demonstration](https://streamable.com/jxjq9n)

---

## Screenshots:

| EPG with preview | VOD |
| :-------------------------------------: | :--------------------------------------: |
| ![EPG with preview](https://i.ibb.co/207znsrw/ynotv-go-Ckngt-Ezr.png) | ![VOD](https://i.ibb.co/FbsQg842/e-R2b3jb.jpg) |
| Playlist Editor | EPG Editor |
| ![Playlist Editor](https://i.ibb.co/pjh43VPL/o-Mc7ec-E.png) | ![EPG Editor](https://i.ibb.co/m3jbML0/SPsv-GGe.png) |
| Watchlist Option with autoswitch | Strem View |
| ![Watchlist Option with autoswitch](https://i.ibb.co/LXKnnMc6/7Pz-ZPz0.png) | ![Strem View](https://i.ibb.co/0RX8SFMP/2wo-HM6m.jpg) |
| Sports View | Themes |
| ![Sports View](https://i.ibb.co/NdgQKsbW/Hr6wti-Y.png) | ![Themes](https://i.ibb.co/3bd2L7F/WDj-MMSh.png) |
| Multiview Menu | PiP View |
| ![Multiview Menu](https://i.imgur.com/KOXyWBs.jpeg) | ![PiP View](https://i.imgur.com/LxweTiN.jpeg) |
| Multiview 2x2 | DVR Page |
| ![Multiview 2x2](https://i.imgur.com/V2v5DCy.jpeg) | ![DVR Page](https://i.imgur.com/Pwojil9.png) |


---
## Features

- **M3U, Xtream Codes & Stalker Support** - multiple EPG sources supported
- **Stremio Integration & Addons support** - Integrated optional stremio login to sync watchlist/addons or add addons directly
- **Nuvio Integration** - Integrated login for 2 way sync with watchlist, addons, plugins, collections, settings
- **Jellyfin Integration (Beta)** - Connect your personal Jellyfin server to browse and stream your libraries
- **Playlist Editor** - Create Custom playlist from your sources, move categories/channels from one into another
- **Grid-style EPG** - with an integrated preview window
- **Catchup & Cache Time Shift** - instant replays on supported channels
- **Automatic Stream Fallback** - detects and switches away from stalled or dead streams
- **Smart Auto-Group for Failover** - Auto-cluster duplicate channels into failover groups, with Always Play Primary
- **Controllers & Phone Remote** - Full gamepad support with spatial navigation, remappable buttons, and chord combos. Use your phone as a remote with QR pairing (guide browser, sports, and multiview tabs)
- **Channel Stream Probe & IPTV Checker** - Bulk stream health checks (alive/dead/geoblocked/DRM), auto-fill resolution/FPS/bitrate badges, one-click disable of dead channels, and sort groups by quality
- **Local Library** - Add local movie/series folders auto-matched with TMDB metadata, with watch progress and backup inclusion
- **Sports Team Channel Linking** - Link teams to channels for one-tap game watching, with auto-linking and backup streams with auto-swap
- **Simkl, Discord & OpenSubtitles Integration** - Scrobble to Simkl, show what you're watching on Discord, and download subtitles from OpenSubtitles
- **24 UI Languages** - Full localization support
- **Transparent EPG Guide, Category Folders & Logo Editor** - Translucent overlay guide, folder grouping of categories, and bulk logo customization
- **Sports Tab** - real-time scores and detailed game stats with instant search to find channel
- **Cast to TV** - Cast to any supported TV devices on your local network
- **Export Playlist to M3U** - Export any modifications you've done into an .m3u
- **Trakt integration** - Scrobble directly to your Trakt account
- **Widget System** - Display live sports score in overlay
- **VOD Support** - rich metadata via TMDB and RPDB with saved progress
- **Subtitle Integration** - Subsource support for VODs
- **Popout Player & External player** - play streams in a seperate MPV window or your choice in an external player
- **Backup DNS/URLs** - automatically swaps when the current source fails
- **Favorites & Custom Groups** - pull from any source
- **Channel Management** - rename, hide, and sort categories and channels freely
- **EPG Editor** - change tvg-id, logos, or auto-match to a different entry
- **Embedded MPV Playback** - with support for custom parameters
- **Multiview** - resizable PiP, also supporting up to four simultaneous streams in a 2x2 grid
- **Channel & EPG Search** - instant results with advanced filtering options
- **Watchlist & Reminders** - auto-swaps to a channel when a program goes live
- **Built-in DVR** - record any stream or schedule for later
- **TV Calendar** - powered by TVMaze for auto-setting reminders on upcoming shows
- **Reprogrammable Hotkeys** - Fast navigation with ease of access
- **40+ Built-in Themes** - something for every preference

---

<details>
<summary>Building from Source</summary>

## Building from Source

### Prerequisites

- **Node.js** 20.x or higher
- **pnpm** 9.x or higher — install with `npm install -g pnpm` (the project specifies `9.1.0` via the `packageManager` field; if you have [corepack](https://nodejs.org/api/corepack.html) enabled, the correct version is used automatically)
- **Rust** (latest stable) — required for the Tauri backend. Install via [rustup](https://rustup.rs/)
- **Git**

**Windows additional requirements:**
- [Microsoft Edge WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) — required for Tauri's rendering engine
- Visual Studio 2022 with C++ build tools
- Windows 10 SDK
- Git Bash and 7-Zip (used to prepare the native sidecars)

**macOS additional requirements:**
- Xcode Command Line Tools (`xcode-select --install`)
- Homebrew packages: `brew install mpv ffmpeg pkg-config`

### Instructions

**1. Clone the repository**

```bash
git clone https://github.com/CharmingCheung/ynotv-fork.git
cd ynotv-fork
```

**2. Install dependencies**

```bash
pnpm install
```

**3. Run in development mode**

```bash
pnpm dev
```

This downloads and verifies the versioned Native DASH runtime, prepares any
missing sidecars and packet producer, then starts the Vite UI server and Tauri
app. No local libmpv path or environment variable is required. The first run
needs network access and can take several minutes.
Apple Silicon macOS and Windows x64 are the supported clean-clone development
targets. See [Native dependencies and reproducible builds](docs/native-dependencies.md)
for every external input, platform limitation, and the separately maintained
Native DASH runtime.

If a previous development session was not stopped and still owns port 5173,
use `pnpm dev:clean` to replace it.

### Developing the mpv patch

Application changes continue to use the cached released runtime with ordinary
`pnpm dev`; they do not require pushing or rebuilding `ynotv-native`. When the
two repositories are sibling directories and you are actively changing the mpv
patch, use:

```bash
pnpm native:dev
pnpm dev:clean
```

The first command incrementally rebuilds the local `../ynotv-native` patch,
runs its native tests, and installs it into the gitignored ynoTV cache. The
second restarts the app with that native library. Iterate locally as often as needed;
only increment `ynotv-native/VERSION` and push after the patch and real playback
tests are stable.

**4. Build for production**

```bash
pnpm tauri build
```

On Apple Silicon macOS, the following command prepares all native sidecars,
builds a DMG, and rejects it if it still contains machine-local dylib links:

```bash
pnpm build:macos
```

> The current macOS output still contains Homebrew-linked native libraries, so
> `pnpm build:macos` intentionally fails its final portability audit. For a
> local-only package use `pnpm build:macos:local`; do not publish that DMG.
> Native DASH is supported on Apple Silicon macOS and Windows x64. Windows
> runtime builds use MSYS2 UCRT64; see the native-dependencies document above.

Build output is located at:

```
packages/app/src-tauri/target/release/bundle/
```

To build both desktop packages against current `ynotv-native` source, open
GitHub Actions, run **Build app with latest native source**, and optionally set
`native_ref` to a branch, tag, or commit. The macOS and Windows jobs compile the
selected native checkout inside the same run and upload DMG/NSIS artifacts plus
the exact application and native commit IDs. They do not consume a
`ynotv-native` Release artifact.

> **Recovery builds**: if a user's database is too large and the app fails to
> start, there is a one-off database recovery screen (export → rebuild →
> import) that ships disabled by default. See [docs/recovery-build.md](docs/recovery-build.md)
> for how to enable it.

</details>

---

<details>
<summary>Windows startup troubleshooting</summary>

## Windows startup troubleshooting

### App closes immediately after launch

ynoTV uses Microsoft Edge WebView2 for its interface. If the app closes as
soon as it is opened, first inspect the application log:

```powershell
Get-Content "$env:LOCALAPPDATA\com.ynotv.app\logs\ynotv.log" `
  -Tail 200 `
  -ErrorAction SilentlyContinue
```

An error similar to the following indicates that the installed WebView2
Runtime is too old or damaged:

```text
failed to create webview: WebView2 error: WindowsError(
  Error { code: HRESULT(0x80004002), message: "No such interface supported" }
)
```

`0x80004002` is `E_NOINTERFACE`. Check the installed WebView2 versions:

```powershell
$paths = @(
  "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application",
  "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application"
)

Get-ChildItem $paths -Directory -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object FullName, Name
```

Also make sure no environment variable forces the app to use another runtime:

```powershell
Get-ChildItem Env:WEBVIEW2* -ErrorAction SilentlyContinue
```

Install or repair the current Microsoft Evergreen WebView2 Runtime. The
following commands download Microsoft's architecture-detecting bootstrapper
and run it as administrator:

```powershell
$installer = "$env:TEMP\MicrosoftEdgeWebView2Setup.exe"

Invoke-WebRequest `
  -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" `
  -OutFile $installer

Start-Process `
  -FilePath $installer `
  -ArgumentList "/silent /install" `
  -Verb RunAs `
  -Wait
```

Restart Windows after installation and verify that the newest directory under
`Microsoft\EdgeWebView\Application` is no longer the old version. If the
bootstrapper cannot update the runtime, use **Installed apps > Microsoft Edge
WebView2 Runtime > Modify/Repair**, or download the x64 Evergreen Standalone
Installer from the [official WebView2 download page](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

</details>

---

<details>
<summary>Data & File Locations</summary>

## Data & File Locations

### Configuration

```
%APPDATA%\com.ynotv.app\
├── settings.json          # Sources, shortcuts, and preferences
└── .windows-state.json    # Window size and position
```

### Database (SQLite)

```
%LOCALAPPDATA%\com.ynotv.app\app.db
```

The database stores channels, categories, EPG programs (7-day window), VOD movies and series, watchlist entries, reminders, DVR schedules and recordings, channel metadata, and source sync timestamps.

### Logs

Debug logging can be enabled in Settings > Debug. Log output is written to:

```
%LOCALAPPDATA%\com.ynotv.app\logs\ynotv.log
```

### DVR Recordings

The recording directory is configurable in Settings > DVR. The default location is:

```
%USERPROFILE%\Videos\ynoTV Recordings\
```

</details>

---

<details>
<summary>Keyboard Shortcuts</summary>

## Keyboard Shortcuts

All shortcuts are fully customizable in Settings > Shortcuts.

### Playback

| Action | Default |
|---|---|
| Play / Pause | `Space` |
| Seek Forward | `Right Arrow` |
| Seek Backward | `Left Arrow` |
| Mute / Unmute | `M` |
| Select Subtitle (Modal) | `J` |
| Select Audio Track (Modal) | `A` |
| Toggle Fullscreen | `F` |
| Replay Last Stream | `Q` |

### Navigation

| Action | Default |
|---|---|
| Channel Up | `Up Arrow` |
| Channel Down | `Down Arrow` |

### Interface

| Action | Default |
|---|---|
| Toggle Live TV (Guide + Categories) | `L` |
| Toggle Guide | `G` |
| Toggle Categories | `C` |
| Toggle DVR | `R` |
| Toggle Sports | `U` |
| Toggle TV Calendar | `T` |
| Toggle Settings | `,` |
| Toggle Jellyfin | `K` |
| Show / Hide Stats | `I` |
| Focus Search | `S` |
| Toggle EPG View Layout | `E` |
| Close / Back | `Esc` |

### Layout

| Action | Default |
|---|---|
| Layout: Main View | `1` |
| Layout: Picture in Picture | `2` |
| Layout: Big + Bottom Bar | `3` |
| Layout: 2×2 Grid | `4` |

</details>

---

## Star History

<a href="https://www.star-history.com/?repos=CharmingCheung%2Fynotv-fork&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CharmingCheung/ynotv-fork&type=date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CharmingCheung/ynotv-fork&type=date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CharmingCheung/ynotv-fork&type=date" />
 </picture>
</a>

---

## Disclaimer

Built with the help of AI.

ynoTV is a media player only. It does not provide, host, distribute, or facilitate access to any streaming services, broadcast content, channel lists, or IPTV subscriptions of any kind.

All content, streams, and playlists are sourced, configured, and managed solely by the end user. The developers have no knowledge of, control over, or responsibility for any third-party content accessed through the application.

Users are solely responsible for ensuring that any content they access complies with the laws and regulations applicable in their jurisdiction. The developers do not condone or support the use of this application to access unlicensed or unauthorized content.

Metadata displayed within the application is sourced from publicly available third-party databases including TVMaze and TMDB. ynoTV does not claim ownership of this metadata.

---

## Credits

ynoTV builds on the following open source projects and services:


- [sbtlTV](https://github.com/thesubtleties/sbtlTV) — original foundation
- [Tauri](https://tauri.app) — desktop application framework
- [mpv](https://mpv.io) — video playback engine
- [FFmpeg](https://ffmpeg.org) — recording and thumbnail generation
- [TVMaze](https://www.tvmaze.com) — TV schedule and show metadata
- [TMDB](https://www.themoviedb.org) — movie and series metadata
- [Trakt.tv](https://app.trakt.tv/) - Scrobble support & catalogs
- [Stremio](https://www.stremio.com/) — for building an open addon ecosystem that makes third-party integration possible
- [Nuvio](https://nuvio.tv/) — for creating a fantastic open source media platform and making their codebase publicly available
- [Jellyfin](https://jellyfin.org/) — for their incredible open source media system and personal streaming platform
- [Harbor](https://github.com/harborstremio/harbor) — Stremio integration and various features
- [Simkl](https://simkl.com) — scrobbling support for movies and series
- [OpenSubtitles](https://www.opensubtitles.com) — subtitle downloads in the player
- [SubSource](https://www.subsource.net) — subtitle search for movies and series
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — YouTube trailer playback
- [RatingPosterDB](https://ratingposterdb.com) — rating badges on VOD posters


---

## License

[GNU Affero General Public License v3.0](./LICENSE)
