//! Channel stream probe and IPTV Checker engine
//!
//! Provides fast HTTP stream validation and FFmpeg verbose stream probing to detect
//! liveness, resolution, frame rate, audio channels/layout, codecs, and stream latency.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use log::info;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

// Static compiled regexes for parsing FFmpeg stderr
static VIDEO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Stream #\d+:\d+.*?: Video: (\w+)").unwrap());
static RESOLUTION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d{2,5})x(\d{2,5})").unwrap());
static FPS_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d+(?:\.\d+)?)\s+fps").unwrap());
static TBR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d+(?:\.\d+)?)\s+tbr").unwrap());
static AUDIO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Stream #\d+:\d+.*?: Audio: (\w+)").unwrap());
static AUDIO_LAYOUT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Audio: .*?,\s*\d+\s*Hz,\s*([^,]+)").unwrap());
static FORMAT_BR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"bitrate:\s*(\d+)\s*kb/s").unwrap());
static STATS_BYTES_READ_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Statistics:\s*(\d+)\s+bytes read").unwrap());

const GEOBLOCK_STATUSES: &[u16] = &[403, 451, 426, 423];
const PLACEHOLDER_PATHS: &[&str] = &[
    "/video/black.ts",
    "/black.ts",
    "/blank.ts",
    "/video/blank.ts",
    "/placeholder.ts",
    "/video/placeholder.ts",
    "/null.ts",
    "/video/null.ts",
];

// ============================================================================
// Types & Models
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeChannelInput {
    pub stream_id: String,
    pub source_id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub category_name: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeOptions {
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default = "default_timeout")]
    pub timeout_secs: f64,
    #[serde(default)]
    pub max_retries: usize,
    #[serde(default)]
    pub capture_screenshots: bool,
    #[serde(default)]
    pub screenshots_dir: Option<String>,
    #[serde(default)]
    pub measure_bitrate: bool,
    #[serde(default = "default_bitrate_sample_secs")]
    pub bitrate_sample_secs: f64,
    #[serde(default = "default_true")]
    pub auto_save_badges: bool,
}

fn default_concurrency() -> usize { 6 }
fn default_timeout() -> f64 { 8.0 }
fn default_bitrate_sample_secs() -> f64 { 8.0 }
fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeChannelResult {
    pub stream_id: String,
    pub source_id: String,
    pub name: String,
    pub url: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub status: String, // "alive", "dead", "geoblocked", "drm", "placeholder"
    pub http_status: Option<u16>,
    pub latency_ms: Option<u64>,
    pub resolution: Option<String>, // "4K", "1080p", "720p", "SD"
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub hdr_format: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_channels: Option<String>,
    pub quality_label: Option<String>,
    pub bitrate_kbps: Option<u32>,
    pub video_bitrate_kbps: Option<u32>,
    pub audio_bitrate_kbps: Option<u32>,
    pub screenshot_path: Option<String>,
    pub error_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeProgress {
    pub current: usize,
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    pub geoblocked: usize,
    pub drm: usize,
    pub placeholder: usize,
    pub channels_per_sec: f64,
    pub elapsed_ms: u64,
    pub eta_secs: Option<u64>,
    pub active_stream_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeSummary {
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    pub geoblocked: usize,
    pub drm: usize,
    pub placeholder: usize,
    pub quality_4k: usize,
    pub quality_1080p: usize,
    pub quality_720p: usize,
    pub quality_sd: usize,
    pub avg_latency_ms: Option<u64>,
    pub elapsed_ms: u64,
    pub health_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FfmpegStatus {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

// Session state to support pause/resume/cancellation
struct ActiveProbeSession {
    cancel_token: CancellationToken,
    is_paused: Arc<AtomicBool>,
}

static ACTIVE_SESSION: Lazy<Mutex<Option<ActiveProbeSession>>> = Lazy::new(|| Mutex::new(None));

// ============================================================================
// FFmpeg Binary Resolver
// ============================================================================

pub fn find_ffmpeg() -> Option<PathBuf> {
    // 1. Check sidecar / current exe directory
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            #[cfg(target_os = "windows")]
            let names = ["ffmpeg.exe", "ffmpeg-x86_64-pc-windows-msvc.exe"];
            #[cfg(target_os = "macos")]
            let names = ["ffmpeg", "ffmpeg-x86_64-apple-darwin", "ffmpeg-aarch64-apple-darwin"];
            #[cfg(target_os = "linux")]
            let names = ["ffmpeg", "ffmpeg-x86_64-unknown-linux-gnu", "ffmpeg-aarch64-unknown-linux-gnu"];

            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // 2. Check development and project binaries directories
    let dev_paths = [
        "./bin/ffmpeg.exe",
        "./bin/ffmpeg",
        "./src-tauri/bin/ffmpeg.exe",
        "./src-tauri/bin/ffmpeg",
        "./src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe",
        "../src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe",
        "../../src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe",
        "packages/app/src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe",
    ];

    for path in &dev_paths {
        let p = Path::new(path);
        if p.is_file() {
            if let Ok(abs) = p.canonicalize() {
                return Some(abs);
            }
            return Some(p.to_path_buf());
        }
    }

    // 3. Check system PATH
    #[cfg(target_os = "windows")]
    let sys_name = "ffmpeg.exe";
    #[cfg(not(target_os = "windows"))]
    let sys_name = "ffmpeg";

    if let Ok(path) = which::which(sys_name) {
        return Some(path);
    }

    None
}

/// Measure the audio stream bitrate with ffmpeg alone (no ffprobe required).
///
/// ffprobe is not bundled with the app, and live/HLS streams typically don't
/// report a `bit_rate` anyway. Instead we demux only the first audio stream
/// (`-map 0:a:0 -c copy -f data`) and count the payload bytes written to
/// stdout over the sample window, then compute kbps = bytes*8/1000/sample.
async fn probe_audio_bitrate(
    ffmpeg_bin: &Path,
    url: &str,
    user_agent: Option<&str>,
    timeout_duration: Duration,
    sample_secs: f64,
) -> Option<u32> {
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.arg("-v").arg("error");

    let ua = user_agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("VLC/3.0.18 LibVLC/3.0.18");
    cmd.arg("-user_agent").arg(ua);
    cmd.arg("-analyzeduration").arg("3000000");
    cmd.arg("-probesize").arg("3000000");
    cmd.arg("-rw_timeout").arg(format!("{}", timeout_duration.as_micros()));
    cmd.arg("-i").arg(url);
    cmd.arg("-map").arg("0:a:0");
    cmd.arg("-t").arg(format!("{}", sample_secs));
    cmd.arg("-c").arg("copy");
    cmd.arg("-f").arg("data");
    cmd.arg("-");

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return None,
    };

    let stdout_pipe = child.stdout.take();
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut total: u64 = 0;
        let mut buf = [0u8; 65536];
        if let Some(mut pipe) = stdout_pipe {
            loop {
                match pipe.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => total += n as u64,
                }
            }
        }
        total
    });

    // Give the demuxer the sample window plus headroom for startup/buffering
    let (_, _) = tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs_f64(sample_secs + 3.0)) => {
            let _ = child.kill().await;
            ((), ())
        }
        _ = child.wait() => {
            ((), ())
        }
    };

    let total_bytes = reader.await.unwrap_or(0);
    if total_bytes > 0 && sample_secs > 0.0 {
        Some(((total_bytes as f64 * 8.0) / 1000.0 / sample_secs).round() as u32)
    } else {
        None
    }
}

#[tauri::command]
pub async fn check_probe_ffmpeg_status() -> FfmpegStatus {
    let binary_path = find_ffmpeg();
    let Some(path) = binary_path else {
        return FfmpegStatus {
            available: false,
            binary_path: None,
            version: None,
        };
    };

    let path_str = path.to_string_lossy().to_string();
    let mut cmd = Command::new(&path);
    cmd.arg("-version");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = match tokio::time::timeout(Duration::from_secs(4), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let first_line = stdout.lines().next().unwrap_or("FFmpeg").to_string();
            Some(first_line)
        }
        _ => None,
    };

    FfmpegStatus {
        available: output.is_some(),
        binary_path: Some(path_str),
        version: output,
    }
}

// ============================================================================
// Fast HTTP Liveness, DRM, and Header Verification
// ============================================================================

struct HttpCheckResult {
    status: String,
    http_status: Option<u16>,
    latency_ms: Option<u64>,
    error_reason: Option<String>,
    playable_url: String,
    manifest_metadata: Option<StreamMetadata>,
}

fn is_placeholder(url: &str) -> bool {
    let lower = url.to_lowercase();
    PLACEHOLDER_PATHS.iter().any(|p| lower.contains(p))
}

fn detect_hls_drm(body: &str) -> Option<String> {
    let lower = body.to_lowercase();
    if !lower.contains("#ext-x-key") && !lower.contains("#ext-x-session-key") {
        return None;
    }
    if lower.contains("com.widevine.alpha") || lower.contains("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed") {
        return Some("Widevine".to_string());
    }
    if lower.contains("com.apple.streamingkeydelivery") || lower.contains("skd://") {
        return Some("FairPlay".to_string());
    }
    if lower.contains("playready") || lower.contains("9a04f079-9840-4286-ab92-e65be0885f95") {
        return Some("PlayReady".to_string());
    }
    if lower.contains("sample-aes") {
        return Some("Sample-AES".to_string());
    }
    None
}

async fn check_http_stream(
    client: &reqwest::Client,
    url: &str,
    user_agent: Option<&str>,
    timeout_duration: Duration,
) -> HttpCheckResult {
    if is_placeholder(url) {
        return HttpCheckResult {
            status: "placeholder".to_string(),
            http_status: Some(200),
            latency_ms: None,
            error_reason: Some("Known placeholder stream".to_string()),
            playable_url: url.to_string(),
            manifest_metadata: None,
        };
    }

    let start_time = Instant::now();
    let effective_ua = user_agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("VLC/3.0.18 LibVLC/3.0.18");

    let req = client
        .get(url)
        .header(reqwest::header::USER_AGENT, effective_ua)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::CONNECTION, "close")
        .timeout(timeout_duration);

    let response = match req.send().await {
        Ok(res) => res,
        Err(err) => {
            let elapsed = start_time.elapsed().as_millis() as u64;
            let reason = if err.is_timeout() {
                "Request timed out".to_string()
            } else if err.is_connect() {
                "Connection refused or unreachable".to_string()
            } else {
                err.to_string()
            };
            return HttpCheckResult {
                status: "dead".to_string(),
                http_status: err.status().map(|s| s.as_u16()),
                latency_ms: Some(elapsed),
                error_reason: Some(reason),
                playable_url: url.to_string(),
                manifest_metadata: None,
            };
        }
    };

    let latency_ms = start_time.elapsed().as_millis() as u64;
    let status_code = response.status().as_u16();

    if GEOBLOCK_STATUSES.contains(&status_code) {
        return HttpCheckResult {
            status: "geoblocked".to_string(),
            http_status: Some(status_code),
            latency_ms: Some(latency_ms),
            error_reason: Some(format!("HTTP {} Geoblocked/Forbidden", status_code)),
            playable_url: url.to_string(),
            manifest_metadata: None,
        };
    }

    if !response.status().is_success() && status_code != 206 && status_code != 302 {
        return HttpCheckResult {
            status: "dead".to_string(),
            http_status: Some(status_code),
            latency_ms: Some(latency_ms),
            error_reason: Some(format!("HTTP Error {}", status_code)),
            playable_url: url.to_string(),
            manifest_metadata: None,
        };
    }

    // Check content-type or inspect body for manifest / DRM
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let is_hls = content_type.contains("mpegurl") || url.to_lowercase().ends_with(".m3u8");
    let is_dash = content_type.contains("dash+xml")
        || url::Url::parse(url)
            .ok()
            .map(|parsed| parsed.path().to_lowercase().ends_with(".mpd"))
            .unwrap_or_else(|| url.to_lowercase().contains(".mpd"));

    let mut manifest_metadata = None;

    if is_hls || is_dash {
        // Read text snippet for DRM check (limit to 128KB)
        if let Ok(bytes) = response.bytes().await {
            let body = String::from_utf8_lossy(&bytes);
            if is_hls {
                if let Some(drm) = detect_hls_drm(&body) {
                    return HttpCheckResult {
                        status: "drm".to_string(),
                        http_status: Some(status_code),
                        latency_ms: Some(latency_ms),
                        error_reason: Some(format!("DRM Protected ({})", drm)),
                        playable_url: url.to_string(),
                        manifest_metadata: None,
                    };
                }
            } else {
                manifest_metadata = parse_dash_manifest_metadata(&body);
            }
        }
    }

    HttpCheckResult {
        status: "alive".to_string(),
        http_status: Some(status_code),
        latency_ms: Some(latency_ms),
        error_reason: None,
        playable_url: url.to_string(),
        manifest_metadata,
    }
}

// ============================================================================
// FFmpeg Verbose Diagnostics & Metadata Extraction
// ============================================================================

#[derive(Debug, Clone, Default)]
struct StreamMetadata {
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    resolution: Option<String>,
    quality_label: Option<String>,
    video_codec: Option<String>,
    hdr_format: Option<String>,
    audio_codec: Option<String>,
    audio_channels: Option<String>,
    bitrate_kbps: Option<u32>,
    video_bitrate_kbps: Option<u32>,
    audio_bitrate_kbps: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename = "MPD")]
struct ProbeDashMpd {
    #[serde(rename = "Period", default)]
    periods: Vec<ProbeDashPeriod>,
}

#[derive(Debug, Deserialize)]
struct ProbeDashPeriod {
    #[serde(rename = "AdaptationSet", default)]
    adaptations: Vec<ProbeDashAdaptation>,
}

#[derive(Debug, Deserialize)]
struct ProbeDashAdaptation {
    #[serde(rename = "@contentType")]
    content_type: Option<String>,
    #[serde(rename = "@mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "@codecs")]
    codecs: Option<String>,
    #[serde(rename = "@width")]
    width: Option<u32>,
    #[serde(rename = "@height")]
    height: Option<u32>,
    #[serde(rename = "@maxWidth")]
    max_width: Option<u32>,
    #[serde(rename = "@maxHeight")]
    max_height: Option<u32>,
    #[serde(rename = "@frameRate")]
    frame_rate: Option<String>,
    #[serde(rename = "Representation", default)]
    representations: Vec<ProbeDashRepresentation>,
}

#[derive(Debug, Deserialize)]
struct ProbeDashRepresentation {
    #[serde(rename = "@mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "@codecs")]
    codecs: Option<String>,
    #[serde(rename = "@width")]
    width: Option<u32>,
    #[serde(rename = "@height")]
    height: Option<u32>,
    #[serde(rename = "@frameRate")]
    frame_rate: Option<String>,
}

fn parse_dash_frame_rate(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    let fps = if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        value.parse::<f64>().ok()?
    };
    (fps > 0.0 && fps <= 240.0).then_some((fps * 10.0).round() / 10.0)
}

fn normalize_dash_video_codec(value: &str) -> String {
    let codec = value.split(',').next().unwrap_or(value).trim();
    let lower = codec.to_lowercase();
    if lower.starts_with("avc1") || lower.starts_with("avc3") {
        "H264".to_string()
    } else if lower.starts_with("hev1") || lower.starts_with("hvc1") {
        "HEVC".to_string()
    } else if lower.starts_with("av01") {
        "AV1".to_string()
    } else if lower.starts_with("vp09") || lower.starts_with("vp9") {
        "VP9".to_string()
    } else {
        codec.to_uppercase()
    }
}

fn parse_dash_manifest_metadata(xml: &str) -> Option<StreamMetadata> {
    let mpd: ProbeDashMpd = quick_xml::de::from_str(xml).ok()?;
    let mut metadata = StreamMetadata::default();
    let mut best_video_pixels = 0_u64;

    for adaptation in mpd.periods.iter().flat_map(|period| &period.adaptations) {
        for representation in &adaptation.representations {
            let mime_type = representation
                .mime_type
                .as_deref()
                .or(adaptation.mime_type.as_deref());
            let is_video = adaptation.content_type.as_deref() == Some("video")
                || mime_type.map(|value| value.starts_with("video/")).unwrap_or(false);
            if !is_video {
                continue;
            }

            let width = representation.width.or(adaptation.width).or(adaptation.max_width);
            let height = representation.height.or(adaptation.height).or(adaptation.max_height);
            let (Some(width), Some(height)) = (width, height) else {
                continue;
            };
            let pixels = u64::from(width) * u64::from(height);
            if metadata.width.is_none() || pixels > best_video_pixels {
                best_video_pixels = pixels;
                metadata.width = Some(width);
                metadata.height = Some(height);
                metadata.quality_label = quality_from_resolution(Some(width), Some(height));
                metadata.resolution = metadata.quality_label.clone();
                metadata.fps = parse_dash_frame_rate(
                    representation
                        .frame_rate
                        .as_deref()
                        .or(adaptation.frame_rate.as_deref()),
                );
                metadata.video_codec = representation
                    .codecs
                    .as_deref()
                    .or(adaptation.codecs.as_deref())
                    .map(normalize_dash_video_codec);
            }
        }

        // Some single-representation manifests put dimensions directly on the
        // AdaptationSet and omit Representation dimensions.
        if adaptation.representations.is_empty()
            && (adaptation.content_type.as_deref() == Some("video")
                || adaptation
                    .mime_type
                    .as_deref()
                    .map(|value| value.starts_with("video/"))
                    .unwrap_or(false))
        {
            if let (Some(width), Some(height)) = (adaptation.width, adaptation.height) {
                let pixels = u64::from(width) * u64::from(height);
                if metadata.width.is_none() || pixels > best_video_pixels {
                    best_video_pixels = pixels;
                    metadata.width = Some(width);
                    metadata.height = Some(height);
                    metadata.quality_label = quality_from_resolution(Some(width), Some(height));
                    metadata.resolution = metadata.quality_label.clone();
                    metadata.fps = parse_dash_frame_rate(adaptation.frame_rate.as_deref());
                    metadata.video_codec = adaptation
                        .codecs
                        .as_deref()
                        .map(normalize_dash_video_codec);
                }
            }
        }
    }

    metadata.width.map(|_| metadata)
}

fn apply_manifest_metadata(meta: &mut StreamMetadata, manifest: Option<&StreamMetadata>) {
    let Some(manifest) = manifest else {
        return;
    };
    if manifest.width.is_some() && manifest.height.is_some() {
        meta.width = manifest.width;
        meta.height = manifest.height;
        meta.resolution = manifest.resolution.clone();
        meta.quality_label = manifest.quality_label.clone();
        meta.fps = manifest.fps.or(meta.fps);
        meta.video_codec = manifest.video_codec.clone().or_else(|| meta.video_codec.clone());
    }
}

fn quality_from_resolution(width: Option<u32>, height: Option<u32>) -> Option<String> {
    match (width, height) {
        (Some(w), Some(h)) if w >= 3840 || h >= 2160 => Some("4K".to_string()),
        (Some(w), Some(h)) if w >= 1920 || h >= 1080 => Some("1080p".to_string()),
        (Some(w), Some(h)) if w >= 1280 || h >= 720 => Some("720p".to_string()),
        (Some(_), Some(_)) => Some("SD".to_string()),
        _ => None,
    }
}

fn normalize_audio_channels(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    if lower.contains("5.1") || lower.contains("6 ch") || lower.contains("6.0") {
        "5.1".to_string()
    } else if lower.contains("7.1") || lower.contains("8 ch") {
        "7.1".to_string()
    } else if lower.contains("stereo") || lower.contains("2.0") || lower.contains("2 ch") {
        "Stereo".to_string()
    } else if lower.contains("mono") || lower.contains("1.0") || lower.contains("1 ch") {
        "Mono".to_string()
    } else {
        raw.trim().to_string()
    }
}

fn parse_ffmpeg_stderr(stderr: &str, sample_secs: f64) -> StreamMetadata {
    let mut meta = StreamMetadata::default();
    let mut best_video_pixels = 0_u64;

    for line in stderr.lines() {
        // DASH manifests expose each Representation as a separate video stream.
        // The lowest-bitrate Representation is commonly listed first, so keep
        // the largest video stream instead of locking onto the first one.
        if let Some(video_caps) = VIDEO_RE.captures(line) {
            let codec = video_caps[1].to_uppercase();
            if meta.video_codec.is_none() {
                meta.video_codec = Some(codec.clone());
            }

            if let Some(resolution_caps) = RESOLUTION_RE.captures(line) {
                let width = resolution_caps[1].parse::<u32>().ok();
                let height = resolution_caps[2].parse::<u32>().ok();
                if let (Some(width), Some(height)) = (width, height) {
                    let pixels = u64::from(width) * u64::from(height);
                    if meta.width.is_none() || pixels > best_video_pixels {
                        best_video_pixels = pixels;
                        meta.width = Some(width);
                        meta.height = Some(height);
                        meta.quality_label = quality_from_resolution(Some(width), Some(height));
                        meta.resolution = meta.quality_label.clone();
                        meta.video_codec = Some(codec);
                        meta.fps = FPS_RE
                            .captures(line)
                            .or_else(|| TBR_RE.captures(line))
                            .and_then(|c| c[1].parse::<f64>().ok())
                            .filter(|&f| f > 0.0 && f <= 240.0)
                            .map(|f| (f * 10.0).round() / 10.0);
                    }
                }
            }
        }

        // Fallback for formats that report frame rate away from the video line.
        if meta.fps.is_none() {
            let fps_val = FPS_RE
                .captures(line)
                .or_else(|| TBR_RE.captures(line))
                .and_then(|c| c[1].parse::<f64>().ok())
                .filter(|&f| f > 0.0 && f <= 240.0);
            if let Some(f) = fps_val {
                meta.fps = Some((f * 10.0).round() / 10.0);
            }
        }

        // HDR Format detection
        if meta.hdr_format.is_none() {
            let lower = line.to_lowercase();
            if lower.contains("dovi") || lower.contains("dolby vision") {
                meta.hdr_format = Some("Dolby Vision".to_string());
            } else if lower.contains("arib-std-b67") || lower.contains("hlg") {
                meta.hdr_format = Some("HLG".to_string());
            } else if lower.contains("smpte2084") || lower.contains("hdr10") {
                meta.hdr_format = Some("HDR10".to_string());
            }
        }

        // Audio stream line
        if meta.audio_codec.is_none() {
            if let Some(caps) = AUDIO_RE.captures(line) {
                meta.audio_codec = Some(caps[1].to_uppercase());
            }
        }

        // Audio layout
        if meta.audio_channels.is_none() {
            if let Some(caps) = AUDIO_LAYOUT_RE.captures(line) {
                if let Some(layout) = caps.get(1) {
                    meta.audio_channels = Some(normalize_audio_channels(layout.as_str()));
                }
            }
        }

        // Format Bitrate
        if meta.bitrate_kbps.is_none() && line.contains("Duration:") {
            if let Some(caps) = FORMAT_BR_RE.captures(line) {
                meta.bitrate_kbps = caps[1].parse::<u32>().ok();
            }
        }

        // Measured Video Bitrate (bytes read over the sample window)
        if meta.video_bitrate_kbps.is_none() {
            if let Some(caps) = STATS_BYTES_READ_RE.captures(line) {
                if let Ok(bytes) = caps[1].parse::<u64>() {
                    if sample_secs > 0.0 {
                        meta.video_bitrate_kbps =
                            Some((bytes as f64 * 8.0 / 1000.0 / sample_secs).round() as u32);
                    }
                }
            }
        }
    }

    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dash_probe_uses_highest_resolution_representation() {
        let stderr = r#"
  Stream #0:0: Video: h264 (Main), yuv420p, 640x360, 25 fps, 25 tbr
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp
  Stream #0:2: Video: hevc (Main), yuv420p, 1920x1080, 50 fps, 50 tbr
  Stream #0:3: Video: h264 (High), yuv420p, 1280x720, 30 fps, 30 tbr
"#;

        let metadata = parse_ffmpeg_stderr(stderr, 1.0);

        assert_eq!(metadata.width, Some(1920));
        assert_eq!(metadata.height, Some(1080));
        assert_eq!(metadata.quality_label.as_deref(), Some("1080p"));
        assert_eq!(metadata.video_codec.as_deref(), Some("HEVC"));
        assert_eq!(metadata.fps, Some(50.0));
    }

    #[test]
    fn dash_manifest_metadata_does_not_depend_on_ffmpeg_dash_support() {
        let manifest = r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" frameRate="30000/1001">
      <Representation id="low" bandwidth="500000" width="640" height="360" codecs="avc1.4d401e" />
      <Representation id="high" bandwidth="5000000" width="1920" height="1080" codecs="hvc1.1.6.L120" />
      <Representation id="mid" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f" />
    </AdaptationSet>
  </Period>
</MPD>"#;

        let metadata = parse_dash_manifest_metadata(manifest).expect("DASH metadata");

        assert_eq!(metadata.width, Some(1920));
        assert_eq!(metadata.height, Some(1080));
        assert_eq!(metadata.quality_label.as_deref(), Some("1080p"));
        assert_eq!(metadata.video_codec.as_deref(), Some("HEVC"));
        assert_eq!(metadata.fps, Some(30.0));
    }

    #[test]
    fn dash_manifest_uses_adaptation_max_dimensions_for_uhd() {
        let manifest = r#"<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" maxWidth="3840" maxHeight="2160" codecs="av01.0.12M.08" frameRate="60">
      <Representation id="video" bandwidth="12000000" />
    </AdaptationSet>
  </Period>
</MPD>"#;

        let metadata = parse_dash_manifest_metadata(manifest).expect("DASH metadata");

        assert_eq!(metadata.quality_label.as_deref(), Some("4K"));
        assert_eq!(metadata.video_codec.as_deref(), Some("AV1"));
        assert_eq!(metadata.fps, Some(60.0));
    }

    #[test]
    fn video_resolution_is_not_taken_from_unrelated_diagnostic_lines() {
        let stderr = r#"
Opening 'https://example.test/image-1920x1080.mpd' for reading
  Stream #0:0: Video: h264 (Main), yuv420p, 854x480, 29.97 fps, 29.97 tbr
"#;

        let metadata = parse_ffmpeg_stderr(stderr, 1.0);

        assert_eq!(metadata.width, Some(854));
        assert_eq!(metadata.height, Some(480));
        assert_eq!(metadata.quality_label.as_deref(), Some("SD"));
        assert_eq!(metadata.fps, Some(30.0));
    }
}

async fn run_ffmpeg_probe(
    ffmpeg_bin: &Path,
    url: &str,
    user_agent: Option<&str>,
    timeout_duration: Duration,
    capture_screenshot: bool,
    screenshot_dest: Option<PathBuf>,
    sample_secs: f64,
) -> (StreamMetadata, Option<String>, Option<String>) {
    let mut cmd = Command::new(ffmpeg_bin);
    if sample_secs > 1.0 {
        cmd.arg("-v").arg("debug");
    } else {
        cmd.arg("-v").arg("verbose");
    }

    let ua = user_agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("VLC/3.0.18 LibVLC/3.0.18");
    cmd.arg("-user_agent").arg(ua);
    cmd.arg("-analyzeduration").arg("3000000");
    cmd.arg("-probesize").arg("3000000");
    cmd.arg("-rw_timeout").arg(format!("{}", timeout_duration.as_micros()));
    cmd.arg("-i").arg(url);
    cmd.arg("-t").arg(format!("{}", sample_secs));

    let mut saved_screenshot_path = None;

    let count_video_payload: bool;
    if capture_screenshot && screenshot_dest.is_some() {
        let dest = screenshot_dest.unwrap();
        let dest_str = dest.to_string_lossy().to_string();
        cmd.arg("-frames:v").arg("1").arg("-update").arg("1").arg("-y").arg(&dest_str);
        saved_screenshot_path = Some(dest_str);
        count_video_payload = false;
    } else {
        // Demux only the first video stream's payload to stdout so the video
        // bitrate is measured from pure compressed video data instead of the
        // total input byte count (which also includes ffmpeg's initial probing
        // reads and container overhead). Mirrors the audio measurement path.
        cmd.arg("-map").arg("0:v:0");
        cmd.arg("-c").arg("copy");
        cmd.arg("-f").arg("data");
        cmd.arg("-");
        count_video_payload = true;
    }

    cmd.stdout(if count_video_payload {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    });
    cmd.stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return (StreamMetadata::default(), None, Some(format!("Failed to spawn FFmpeg: {}", e)));
        }
    };

    let stderr_pipe = child.stderr.take();
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });

    let stdout_pipe = if count_video_payload { child.stdout.take() } else { None };
    let video_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut total: u64 = 0;
        let mut buf = [0u8; 65536];
        if let Some(mut pipe) = stdout_pipe {
            loop {
                match pipe.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => total += n as u64,
                }
            }
        }
        total
    });

    let (timed_out, _) = tokio::select! {
        _ = tokio::time::sleep(timeout_duration.max(Duration::from_secs_f64(sample_secs + 2.0))) => {
            let _ = child.kill().await;
            (true, None)
        }
        status = child.wait() => {
            (false, status.ok().and_then(|s| s.code()))
        }
    };

    let stderr_buf = reader.await.unwrap_or_default();
    let _ = child.kill().await;
    let _ = child.wait().await;
    let stderr_str = String::from_utf8_lossy(&stderr_buf);

    let mut meta = parse_ffmpeg_stderr(&stderr_str, sample_secs);

    // Prefer the pure demuxed video payload byte count over the input
    // `Statistics:` figure, which includes probing reads and container overhead.
    if count_video_payload {
        let video_bytes = video_reader.await.unwrap_or(0);
        meta.video_bitrate_kbps = if video_bytes > 0 && sample_secs > 0.0 {
            Some(((video_bytes as f64 * 8.0) / 1000.0 / sample_secs).round() as u32)
        } else {
            None
        };
    }

    let err_msg = if timed_out && meta.width.is_none() {
        Some("FFmpeg probe timed out".to_string())
    } else {
        None
    };

    (meta, saved_screenshot_path, err_msg)
}

// ============================================================================
// Single Stream Probe Command
// ============================================================================

#[tauri::command]
pub async fn probe_single_stream(
    url: String,
    user_agent: Option<String>,
    timeout_secs: Option<f64>,
    measure_bitrate: Option<bool>,
) -> Result<ProbeChannelResult, String> {
    let timeout = Duration::from_secs_f64(timeout_secs.unwrap_or(8.0).clamp(2.0, 30.0));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .pool_max_idle_per_host(0)
        .pool_idle_timeout(Duration::from_secs(0))
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1: HTTP check
    let http_res = check_http_stream(&client, &url, user_agent.as_deref(), timeout).await;

    if http_res.status != "alive" {
        return Ok(ProbeChannelResult {
            stream_id: String::new(),
            source_id: String::new(),
            name: String::new(),
            url: url.clone(),
            category_id: None,
            category_name: None,
            status: http_res.status,
            http_status: http_res.http_status,
            latency_ms: http_res.latency_ms,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            video_codec: None,
            hdr_format: None,
            audio_codec: None,
            audio_channels: None,
            quality_label: None,
            bitrate_kbps: None,
            video_bitrate_kbps: None,
            audio_bitrate_kbps: None,
            screenshot_path: None,
            error_reason: http_res.error_reason,
        });
    }

    // Step 2: FFmpeg probe
    let ffmpeg_path = find_ffmpeg();
    // Only report measured bitrates when bitrate measurement was explicitly enabled,
    // otherwise quick probes would store 1-second spot samples in the avg columns.
    let measure = measure_bitrate.unwrap_or(false);
    let sample_secs = if measure { 8.0 } else { 1.0 };
    let (mut meta, _, mut ffmpeg_err) = if let Some(ref bin) = ffmpeg_path {
        run_ffmpeg_probe(bin, &url, user_agent.as_deref(), timeout, false, None, sample_secs).await
    } else {
        (StreamMetadata::default(), None, Some("FFmpeg not found".to_string()))
    };
    apply_manifest_metadata(&mut meta, http_res.manifest_metadata.as_ref());
    if http_res.manifest_metadata.is_some() {
        ffmpeg_err = None;
    }

    // Audio bitrate measured from the same ffmpeg binary when requested
    let audio_bitrate_kbps = if measure {
        if let Some(ref bin) = ffmpeg_path {
            probe_audio_bitrate(bin, &url, user_agent.as_deref(), timeout, sample_secs).await
        } else {
            None
        }
    } else {
        meta.audio_bitrate_kbps
    };

    Ok(ProbeChannelResult {
        stream_id: String::new(),
        source_id: String::new(),
        name: String::new(),
        url,
        category_id: None,
        category_name: None,
        status: "alive".to_string(),
        http_status: http_res.http_status,
        latency_ms: http_res.latency_ms,
        resolution: meta.resolution,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        video_codec: meta.video_codec,
        hdr_format: meta.hdr_format,
        audio_codec: meta.audio_codec,
        audio_channels: meta.audio_channels,
        quality_label: meta.quality_label,
        bitrate_kbps: meta.bitrate_kbps,
        video_bitrate_kbps: if measure { meta.video_bitrate_kbps } else { None },
        audio_bitrate_kbps,
        screenshot_path: None,
        error_reason: ffmpeg_err.or(http_res.error_reason),
    })
}

// ============================================================================
// Multi-Threaded Batch Channel Probe
// ============================================================================

#[tauri::command]
pub async fn start_channel_probe(
    app: AppHandle,
    channels: Vec<ProbeChannelInput>,
    options: ProbeOptions,
) -> Result<String, String> {
    if channels.is_empty() {
        return Err("No channels provided to probe".to_string());
    }

    // Cancel any currently running probe
    {
        let mut session_guard = ACTIVE_SESSION.lock().await;
        if let Some(session) = session_guard.take() {
            session.cancel_token.cancel();
        }
    }

    let cancel_token = CancellationToken::new();
    let is_paused = Arc::new(AtomicBool::new(false));

    {
        let mut session_guard = ACTIVE_SESSION.lock().await;
        *session_guard = Some(ActiveProbeSession {
            cancel_token: cancel_token.clone(),
            is_paused: is_paused.clone(),
        });
    }

    let total = channels.len();
    let concurrency = options.concurrency.clamp(1, 32);
    let timeout_duration = Duration::from_secs_f64(options.timeout_secs.clamp(2.0, 30.0));
    let max_retries = options.max_retries.min(10);
    let measure_bitrate = options.measure_bitrate;
    let bitrate_sample_secs = options.bitrate_sample_secs.clamp(3.0, 15.0);
    let ffmpeg_bin = find_ffmpeg();

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .pool_max_idle_per_host(0)
        .pool_idle_timeout(Duration::from_secs(0))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    info!(
        "[StreamProbe] Starting probe for {} channels with concurrency={}, timeout={:.1}s, max_retries={}, ffmpeg={:?}",
        total, concurrency, options.timeout_secs, max_retries, ffmpeg_bin
    );

    // Spawn the background worker task
    let app_handle = app.clone();
    let token = cancel_token.clone();

    tokio::spawn(async move {
        let start_time = Instant::now();

        let counter_completed = Arc::new(AtomicUsize::new(0));
        let counter_alive = Arc::new(AtomicUsize::new(0));
        let counter_dead = Arc::new(AtomicUsize::new(0));
        let counter_geoblocked = Arc::new(AtomicUsize::new(0));
        let counter_drm = Arc::new(AtomicUsize::new(0));
        let counter_placeholder = Arc::new(AtomicUsize::new(0));

        let quality_4k = Arc::new(AtomicUsize::new(0));
        let quality_1080p = Arc::new(AtomicUsize::new(0));
        let quality_720p = Arc::new(AtomicUsize::new(0));
        let quality_sd = Arc::new(AtomicUsize::new(0));
        let total_latency_ms = Arc::new(AtomicUsize::new(0));
        let latency_sample_count = Arc::new(AtomicUsize::new(0));

        let (batch_tx, mut batch_rx) = tokio::sync::mpsc::channel::<ProbeChannelResult>(64);

        // Batch collector task that streams result batches to frontend
        let app_events = app_handle.clone();
        let batch_collector = tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut last_emit = Instant::now();

            while let Some(item) = batch_rx.recv().await {
                buffer.push(item);
                if buffer.len() >= 5 || last_emit.elapsed() >= Duration::from_millis(150) {
                    let to_send: Vec<ProbeChannelResult> = buffer.drain(..).collect();
                    let _ = app_events.emit("probe:batch", to_send);
                    last_emit = Instant::now();
                }
            }

            if !buffer.is_empty() {
                let _ = app_events.emit("probe:batch", buffer);
            }
        });

        let (work_tx, work_rx) = tokio::sync::mpsc::channel::<ProbeChannelInput>(total);
        for ch in channels {
            let _ = work_tx.send(ch).await;
        }
        drop(work_tx);

        let work_rx = Arc::new(tokio::sync::Mutex::new(work_rx));
        let mut worker_handles = Vec::with_capacity(concurrency);

        for _ in 0..concurrency {
            let rx = work_rx.clone();
            let tok = token.clone();
            let paused_flag = is_paused.clone();
            let cli = client.clone();
            let ff = ffmpeg_bin.clone();
            let b_tx = batch_tx.clone();
            let app_prog = app_handle.clone();

            let c_comp = counter_completed.clone();
            let c_alive = counter_alive.clone();
            let c_dead = counter_dead.clone();
            let c_geoblocked = counter_geoblocked.clone();
            let c_drm = counter_drm.clone();
            let c_ph = counter_placeholder.clone();

            let q_4k = quality_4k.clone();
            let q_1080 = quality_1080p.clone();
            let q_720 = quality_720p.clone();
            let q_sd = quality_sd.clone();
            let lat_sum = total_latency_ms.clone();
            let lat_count = latency_sample_count.clone();

            let handle = tokio::spawn(async move {
                loop {
                    if tok.is_cancelled() {
                        break;
                    }

                    // Check pause before taking work
                    while paused_flag.load(Ordering::SeqCst) && !tok.is_cancelled() {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }

                    if tok.is_cancelled() {
                        break;
                    }

                    let maybe_channel = {
                        let mut lock = rx.lock().await;
                        lock.recv().await
                    };

                    let Some(channel) = maybe_channel else {
                        break;
                    };

                    // Check pause right before executing
                    while paused_flag.load(Ordering::SeqCst) && !tok.is_cancelled() {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }

                    if tok.is_cancelled() {
                        break;
                    }

                    let ch_name = channel.name.clone();
                    let url = channel.url.clone();
                    let ua = channel.user_agent.clone();

                    // Step 1: HTTP stream check (with optional retries if dead/failed)
                    let mut http_res = check_http_stream(&cli, &url, ua.as_deref(), timeout_duration).await;
                    let mut retry_count = 0;
                    while http_res.status == "dead" && retry_count < max_retries && !tok.is_cancelled() {
                        retry_count += 1;
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        while paused_flag.load(Ordering::SeqCst) && !tok.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        if tok.is_cancelled() {
                            break;
                        }
                        http_res = check_http_stream(&cli, &url, ua.as_deref(), timeout_duration).await;
                    }

                    let mut result = ProbeChannelResult {
                        stream_id: channel.stream_id.clone(),
                        source_id: channel.source_id.clone(),
                        name: channel.name.clone(),
                        url: channel.url.clone(),
                        category_id: channel.category_id.clone(),
                        category_name: channel.category_name.clone(),
                        status: http_res.status.clone(),
                        http_status: http_res.http_status,
                        latency_ms: http_res.latency_ms,
                        resolution: None,
                        width: None,
                        height: None,
                        fps: None,
                        video_codec: None,
                        hdr_format: None,
                        audio_codec: None,
                        audio_channels: None,
                        quality_label: None,
                        bitrate_kbps: None,
                        video_bitrate_kbps: None,
                        audio_bitrate_kbps: None,
                        screenshot_path: None,
                        error_reason: http_res.error_reason.clone(),
                    };

                    if http_res.status == "alive" {
                        c_alive.fetch_add(1, Ordering::Relaxed);
                        if let Some(lat) = http_res.latency_ms {
                            lat_sum.fetch_add(lat as usize, Ordering::Relaxed);
                            lat_count.fetch_add(1, Ordering::Relaxed);
                        }

                        // Check pause before FFmpeg probe
                        while paused_flag.load(Ordering::SeqCst) && !tok.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }

                        // Step 2: FFmpeg probe for metadata. DASH manifest
                        // metadata remains available even when the bundled or
                        // system FFmpeg was built without a DASH demuxer.
                        let probe_timeout = if measure_bitrate {
                            timeout_duration.max(Duration::from_secs_f64(bitrate_sample_secs + 2.0))
                        } else {
                            timeout_duration
                        };
                        let (mut meta, ffmpeg_err) = if let Some(ref bin) = ff {
                            let (meta, _, error) = run_ffmpeg_probe(
                                bin,
                                &url,
                                ua.as_deref(),
                                probe_timeout,
                                false,
                                None,
                                if measure_bitrate { bitrate_sample_secs } else { 1.0 },
                            )
                            .await;
                            (meta, error)
                        } else {
                            (StreamMetadata::default(), None)
                        };
                        apply_manifest_metadata(&mut meta, http_res.manifest_metadata.as_ref());
                        result.resolution = meta.resolution.clone();
                        result.width = meta.width;
                        result.height = meta.height;
                        result.fps = meta.fps;
                        result.video_codec = meta.video_codec;
                        result.hdr_format = meta.hdr_format;
                        result.audio_codec = meta.audio_codec;
                        result.audio_channels = meta.audio_channels;
                        result.quality_label = meta.quality_label.clone();
                        result.bitrate_kbps = meta.bitrate_kbps;
                        if measure_bitrate {
                            result.video_bitrate_kbps = meta.video_bitrate_kbps;
                            if let Some(ref bin) = ff {
                                result.audio_bitrate_kbps = probe_audio_bitrate(
                                    bin,
                                    &url,
                                    ua.as_deref(),
                                    probe_timeout,
                                    bitrate_sample_secs,
                                )
                                .await;
                            }
                        }
                        if ffmpeg_err.is_some()
                            && http_res.manifest_metadata.is_none()
                            && result.error_reason.is_none()
                        {
                            result.error_reason = ffmpeg_err;
                        }

                        if let Some(ref q) = meta.quality_label {
                            match q.as_str() {
                                "4K" => { q_4k.fetch_add(1, Ordering::Relaxed); }
                                "1080p" => { q_1080.fetch_add(1, Ordering::Relaxed); }
                                "720p" => { q_720.fetch_add(1, Ordering::Relaxed); }
                                _ => { q_sd.fetch_add(1, Ordering::Relaxed); }
                            }
                        }
                    } else if http_res.status == "dead" {
                        c_dead.fetch_add(1, Ordering::Relaxed);
                    } else if http_res.status == "geoblocked" {
                        c_geoblocked.fetch_add(1, Ordering::Relaxed);
                    } else if http_res.status == "drm" {
                        c_drm.fetch_add(1, Ordering::Relaxed);
                    } else {
                        c_ph.fetch_add(1, Ordering::Relaxed);
                    }

                    let done = c_comp.fetch_add(1, Ordering::Relaxed) + 1;
                    let elapsed_ms = start_time.elapsed().as_millis() as u64;
                    let ch_per_sec = if elapsed_ms > 0 {
                        (done as f64) / (elapsed_ms as f64 / 1000.0)
                    } else {
                        0.0
                    };
                    let remaining = total.saturating_sub(done);
                    let eta_secs = if ch_per_sec > 0.1 {
                        Some((remaining as f64 / ch_per_sec).ceil() as u64)
                    } else {
                        None
                    };

                    let _ = b_tx.send(result).await;

                    // Emit progress event
                    let progress = ProbeProgress {
                        current: done,
                        total,
                        alive: c_alive.load(Ordering::Relaxed),
                        dead: c_dead.load(Ordering::Relaxed),
                        geoblocked: c_geoblocked.load(Ordering::Relaxed),
                        drm: c_drm.load(Ordering::Relaxed),
                        placeholder: c_ph.load(Ordering::Relaxed),
                        channels_per_sec: (ch_per_sec * 10.0).round() / 10.0,
                        elapsed_ms,
                        eta_secs,
                        active_stream_name: Some(ch_name),
                    };
                    let _ = app_prog.emit("probe:progress", progress);
                }
            });

            worker_handles.push(handle);
        }

        // Wait for all worker handles
        for h in worker_handles {
            let _ = h.await;
        }

        // Close batch sender and wait for collector
        drop(batch_tx);
        let _ = batch_collector.await;

        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        let alive_cnt = counter_alive.load(Ordering::Relaxed);
        let dead_cnt = counter_dead.load(Ordering::Relaxed);
        let geo_cnt = counter_geoblocked.load(Ordering::Relaxed);
        let drm_cnt = counter_drm.load(Ordering::Relaxed);
        let ph_cnt = counter_placeholder.load(Ordering::Relaxed);

        let q4k_cnt = quality_4k.load(Ordering::Relaxed);
        let q1080_cnt = quality_1080p.load(Ordering::Relaxed);
        let q720_cnt = quality_720p.load(Ordering::Relaxed);
        let qsd_cnt = quality_sd.load(Ordering::Relaxed);

        let lat_cnt = latency_sample_count.load(Ordering::Relaxed);
        let avg_lat = if lat_cnt > 0 {
            Some((total_latency_ms.load(Ordering::Relaxed) / lat_cnt) as u64)
        } else {
            None
        };

        // Compute overall health score out of 10
        let liveness_ratio = if total > 0 { alive_cnt as f64 / total as f64 } else { 0.0 };
        let quality_ratio = if alive_cnt > 0 {
            (q4k_cnt as f64 * 1.0 + q1080_cnt as f64 * 0.9 + q720_cnt as f64 * 0.75 + qsd_cnt as f64 * 0.5) / alive_cnt as f64
        } else {
            0.0
        };
        let ping_score = match avg_lat {
            Some(ms) => (1200.0 - (ms as f64).min(1200.0)) / 1200.0,
            None => 0.5,
        };

        let health_score = ((liveness_ratio * 0.5 + quality_ratio * 0.3 + ping_score * 0.2) * 10.0).clamp(0.0, 10.0);
        let health_score = (health_score * 10.0).round() / 10.0;

        let summary = ProbeSummary {
            total,
            alive: alive_cnt,
            dead: dead_cnt,
            geoblocked: geo_cnt,
            drm: drm_cnt,
            placeholder: ph_cnt,
            quality_4k: q4k_cnt,
            quality_1080p: q1080_cnt,
            quality_720p: q720_cnt,
            quality_sd: qsd_cnt,
            avg_latency_ms: avg_lat,
            elapsed_ms,
            health_score,
        };

        info!(
            "[StreamProbe] Scan finished in {}ms: {} alive, {} dead, {} geoblocked, {} drm, score: {}",
            elapsed_ms, alive_cnt, dead_cnt, geo_cnt, drm_cnt, health_score
        );

        let _ = app_handle.emit("probe:finished", summary);
    });

    Ok("Probe started".to_string())
}

#[tauri::command]
pub async fn pause_channel_probe() -> Result<(), String> {
    let session_guard = ACTIVE_SESSION.lock().await;
    if let Some(ref session) = *session_guard {
        session.is_paused.store(true, Ordering::SeqCst);
        info!("[StreamProbe] Scan paused");
        Ok(())
    } else {
        Err("No active scan to pause".to_string())
    }
}

#[tauri::command]
pub async fn resume_channel_probe() -> Result<(), String> {
    let session_guard = ACTIVE_SESSION.lock().await;
    if let Some(ref session) = *session_guard {
        session.is_paused.store(false, Ordering::SeqCst);
        info!("[StreamProbe] Scan resumed");
        Ok(())
    } else {
        Err("No active scan to resume".to_string())
    }
}

#[tauri::command]
pub async fn cancel_channel_probe() -> Result<(), String> {
    let mut session_guard = ACTIVE_SESSION.lock().await;
    if let Some(session) = session_guard.take() {
        session.cancel_token.cancel();
        info!("[StreamProbe] Scan cancelled");
        Ok(())
    } else {
        Ok(())
    }
}
