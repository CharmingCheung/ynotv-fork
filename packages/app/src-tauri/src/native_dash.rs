//! Experimental C5 native DASH snapshot session.
//!
//! Rust owns manifest/segment networking and cancellation. The deliberately
//! download-first handoff is an RDPKT001 packet source consumed by the C3
//! `demux_rustdash` patch; it is not represented as live streaming.

use crate::dash_timeline::{CompactTimeline, ExactTime, TimelineEntry};
use once_cell::sync::Lazy;
use quick_xml::de::from_str;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tempfile::TempDir;
use tokio::{fs, process::Command};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_STATIC_SEGMENTS: u128 = 20_000;
const DYNAMIC_COMPLETE_WINDOW: usize = 2;
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDashPlaybackConfig {
    pub manifest_url: String,
    pub drm: NativeDashDrm,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum NativeDashDrm {
    ClearKey { kid: String, key: String },
}

#[derive(Default)]
struct ActiveSession {
    generation: u64,
    cancellation: Option<CancellationToken>,
    files: Option<TempDir>,
    dynamic_snapshot: bool,
}

static ACTIVE: Lazy<parking_lot::Mutex<ActiveSession>> =
    Lazy::new(|| parking_lot::Mutex::new(ActiveSession::default()));
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn cancel_active() {
    let mut active = ACTIVE.lock();
    if let Some(token) = &active.cancellation {
        token.cancel();
    }
    active.files = None;
    active.dynamic_snapshot = false;
}

pub(crate) fn note_eof() {
    let mut active = ACTIVE.lock();
    if active.dynamic_snapshot && active.files.is_some() {
        log::info!("native DASH snapshot exhausted");
        active.dynamic_snapshot = false;
    }
}

pub(crate) async fn prepare(config: NativeDashPlaybackConfig) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "macos"))]
    return Err("Native DASH requires macOS in-process libmpv in C5".into());

    if std::env::var("YNOTV_NATIVE_DASH_MPV_PATCHED").as_deref() != Ok("1") {
        return Err("Native DASH custom demux adapter is unavailable in this playback mode".into());
    }
    let (kid, key) = match &config.drm {
        NativeDashDrm::ClearKey { kid, key } => (decode_hex_16(kid)?, decode_hex_16(key)?),
    };
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let cancellation = CancellationToken::new();
    {
        let mut active = ACTIVE.lock();
        if let Some(old) = active.cancellation.take() {
            old.cancel();
        }
        active.files = None;
        active.dynamic_snapshot = false;
        active.generation = generation;
        active.cancellation = Some(cancellation.clone());
    }

    let result = build_snapshot(&config.manifest_url, kid, key, &cancellation).await;
    match result {
        Ok((dir, packet_path, dynamic)) => {
            let mut active = ACTIVE.lock();
            if active.generation != generation || cancellation.is_cancelled() {
                return Err("Native DASH session cancelled".into());
            }
            active.files = Some(dir);
            active.dynamic_snapshot = dynamic;
            Ok(packet_path)
        }
        Err(error) => Err(error),
    }
}

fn decode_hex_16(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid ClearKey property".into());
    }
    let mut result = [0; 16];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Invalid ClearKey property")?;
    }
    Ok(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename = "MPD")]
struct Mpd {
    #[serde(rename = "@type", default)]
    kind: String,
    #[serde(rename = "@mediaPresentationDuration")]
    duration: Option<String>,
    #[serde(rename = "BaseURL", default)]
    base_urls: Vec<TextNode>,
    #[serde(rename = "Period", default)]
    periods: Vec<Period>,
}

#[derive(Debug, Deserialize)]
struct Period {
    #[serde(rename = "@start")]
    start: Option<String>,
    #[serde(rename = "@duration")]
    duration: Option<String>,
    #[serde(rename = "BaseURL", default)]
    base_urls: Vec<TextNode>,
    #[serde(rename = "AdaptationSet", default)]
    adaptations: Vec<Adaptation>,
}

#[derive(Debug, Deserialize)]
struct Adaptation {
    #[serde(rename = "@contentType")]
    content_type: Option<String>,
    #[serde(rename = "@mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "@codecs")]
    codecs: Option<String>,
    #[serde(rename = "BaseURL", default)]
    base_urls: Vec<TextNode>,
    #[serde(rename = "SegmentTemplate")]
    template: Option<SegmentTemplate>,
    #[serde(rename = "ContentProtection", default)]
    protections: Vec<ContentProtection>,
    #[serde(rename = "EssentialProperty", default)]
    essential_properties: Vec<Descriptor>,
    #[serde(rename = "Representation", default)]
    representations: Vec<Representation>,
}

#[derive(Debug, Deserialize)]
struct Representation {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@bandwidth", default)]
    bandwidth: u64,
    #[serde(rename = "@mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "@codecs")]
    codecs: Option<String>,
    #[serde(rename = "BaseURL", default)]
    base_urls: Vec<TextNode>,
    #[serde(rename = "SegmentTemplate")]
    template: Option<SegmentTemplate>,
    #[serde(rename = "ContentProtection", default)]
    protections: Vec<ContentProtection>,
}

#[derive(Debug, Deserialize)]
struct ContentProtection {
    #[serde(rename = "@schemeIdUri", default)]
    scheme_id_uri: String,
    #[serde(rename = "@value")]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Descriptor {
    #[serde(rename = "@schemeIdUri", default)]
    scheme_id_uri: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SegmentTemplate {
    #[serde(rename = "@timescale")]
    timescale: Option<u64>,
    #[serde(rename = "@presentationTimeOffset")]
    pto: Option<i128>,
    #[serde(rename = "@startNumber")]
    start_number: Option<u64>,
    #[serde(rename = "@initialization")]
    initialization: Option<String>,
    #[serde(rename = "@media")]
    media: Option<String>,
    #[serde(rename = "SegmentTimeline")]
    timeline: Option<SegmentTimeline>,
}

#[derive(Clone, Debug, Deserialize)]
struct SegmentTimeline {
    #[serde(rename = "S", default)]
    entries: Vec<S>,
}

#[derive(Clone, Debug, Deserialize)]
struct S {
    #[serde(rename = "@t")]
    t: Option<i128>,
    #[serde(rename = "@d")]
    d: i128,
    #[serde(rename = "@r", default)]
    r: i64,
}

#[derive(Debug, Deserialize)]
struct TextNode {
    #[serde(rename = "$text", default)]
    value: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MediaKind {
    Video,
    Audio,
}

struct Selection<'a> {
    adaptation: &'a Adaptation,
    representation: &'a Representation,
    kind: MediaKind,
}

async fn build_snapshot(
    manifest_url: &str,
    kid: [u8; 16],
    key: [u8; 16],
    cancellation: &CancellationToken,
) -> Result<(TempDir, PathBuf, bool), String> {
    let base = Url::parse(manifest_url).map_err(|_| "Manifest fetch failed: invalid URL")?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "Manifest fetch failed")?;
    let (manifest, final_manifest_url) =
        fetch_with_final_url(&client, base, cancellation, "Manifest fetch failed").await?;
    let xml = std::str::from_utf8(&manifest).map_err(|_| "Unsupported DASH manifest shape")?;
    let mpd: Mpd = from_str(xml).map_err(|_| "Unsupported DASH manifest shape")?;
    let period = mpd
        .periods
        .first()
        .ok_or("Unsupported DASH manifest shape: MPD has no Period")?;
    if mpd.periods.len() != 1 {
        return Err("Unsupported DASH manifest shape: multiple Periods".into());
    }
    let dynamic = mpd.kind.eq_ignore_ascii_case("dynamic");
    let period_start = parse_duration(period.start.as_deref().unwrap_or("PT0S"))?;
    let period_duration = period
        .duration
        .as_deref()
        .or(mpd.duration.as_deref())
        .map(parse_duration)
        .transpose()?;
    // Relative MPD/Period/representation URLs are resolved against the final
    // manifest response URL, not the original URL before HTTP redirects.
    let mpd_base = inherit_base(final_manifest_url, &mpd.base_urls)?;
    let period_base = inherit_base(mpd_base, &period.base_urls)?;

    let video = select(period, MediaKind::Video)?;
    let audio = select(period, MediaKind::Audio)?;
    validate_cenc(&video)?;
    validate_cenc(&audio)?;
    log_selection(&video);
    log_selection(&audio);
    let manifest_kids = default_kids(xml);
    if !manifest_kids.is_empty() {
        let agrees = manifest_kids.iter().any(|candidate| candidate == &kid);
        log::info!(
            "[native-dash] manifest default_KID agrees with configured KID: {}",
            agrees
        );
    }

    let dir = tempfile::Builder::new()
        .prefix("ynotv-native-dash-")
        .tempdir()
        .map_err(|_| "Native DASH temporary storage failed")?;
    let video_path = dir.path().join("video.mp4");
    let audio_path = dir.path().join("audio.mp4");
    download_representation(
        &client,
        period_base.clone(),
        &video,
        period_start,
        period_duration,
        dynamic,
        &video_path,
        cancellation,
    )
    .await?;
    download_representation(
        &client,
        period_base,
        &audio,
        period_start,
        period_duration,
        dynamic,
        &audio_path,
        cancellation,
    )
    .await?;
    let output = dir.path().join("snapshot.rdp");
    run_packet_producer(&video_path, &audio_path, &output, kid, key, cancellation).await?;
    Ok((dir, output, dynamic))
}

fn select(period: &Period, kind: MediaKind) -> Result<Selection<'_>, String> {
    let mut choices = Vec::new();
    for adaptation in &period.adaptations {
        if adaptation.essential_properties.iter().any(|property| {
            property
                .scheme_id_uri
                .eq_ignore_ascii_case("http://dashif.org/guidelines/trickmode")
        }) {
            continue;
        }
        for representation in &adaptation.representations {
            let mime = representation
                .mime_type
                .as_ref()
                .or(adaptation.mime_type.as_ref());
            let content = adaptation.content_type.as_deref();
            let matches = match kind {
                MediaKind::Video => {
                    content == Some("video") || mime.is_some_and(|m| m.starts_with("video/"))
                }
                MediaKind::Audio => {
                    content == Some("audio") || mime.is_some_and(|m| m.starts_with("audio/"))
                }
            };
            if matches && mime.is_none_or(|m| m.ends_with("/mp4")) {
                choices.push(Selection {
                    adaptation,
                    representation,
                    kind,
                });
            }
        }
    }
    choices
        .into_iter()
        .min_by_key(|choice| (choice.representation.bandwidth, &choice.representation.id))
        .ok_or_else(|| {
            format!(
                "Unsupported DASH manifest shape: no supported {:?} representation",
                kind
            )
        })
}

fn log_selection(selection: &Selection<'_>) {
    let codecs = selection
        .representation
        .codecs
        .as_ref()
        .or(selection.adaptation.codecs.as_ref())
        .map(String::as_str)
        .unwrap_or("unknown");
    log::info!(
        "[native-dash] selected {:?} representation id={} codecs={} bandwidth={}",
        selection.kind,
        selection.representation.id,
        codecs,
        selection.representation.bandwidth
    );
}

fn validate_cenc(selection: &Selection<'_>) -> Result<(), String> {
    for protection in selection
        .adaptation
        .protections
        .iter()
        .chain(&selection.representation.protections)
    {
        if protection
            .scheme_id_uri
            .eq_ignore_ascii_case("urn:mpeg:dash:mp4protection:2011")
            && protection
                .value
                .as_deref()
                .is_some_and(|value| !value.eq_ignore_ascii_case("cenc"))
        {
            return Err("Unsupported DASH manifest shape: only CENC is supported".into());
        }
    }
    Ok(())
}

fn merged_template(
    adaptation: &Adaptation,
    representation: &Representation,
) -> Result<SegmentTemplate, String> {
    let parent = adaptation.template.clone().unwrap_or_default();
    let child = representation.template.clone().unwrap_or_default();
    let result = SegmentTemplate {
        timescale: child.timescale.or(parent.timescale),
        pto: child.pto.or(parent.pto),
        start_number: child.start_number.or(parent.start_number),
        initialization: child.initialization.or(parent.initialization),
        media: child.media.or(parent.media),
        timeline: child.timeline.or(parent.timeline),
    };
    if result.initialization.is_none() || result.media.is_none() || result.timeline.is_none() {
        return Err(
            "Unsupported DASH manifest shape: SegmentTemplate/SegmentTimeline required".into(),
        );
    }
    Ok(result)
}

async fn download_representation(
    client: &reqwest::Client,
    period_base: Url,
    selection: &Selection<'_>,
    period_start: ExactTime,
    period_duration: Option<ExactTime>,
    dynamic: bool,
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let base = inherit_base(
        inherit_base(period_base, &selection.adaptation.base_urls)?,
        &selection.representation.base_urls,
    )?;
    let template = merged_template(selection.adaptation, selection.representation)?;
    let entries: Vec<_> = template
        .timeline
        .as_ref()
        .unwrap()
        .entries
        .iter()
        .map(|s| TimelineEntry {
            t: s.t,
            d: s.d,
            r: s.r,
        })
        .collect();
    let timeline = CompactTimeline::new(
        &entries,
        template.timescale.unwrap_or(1),
        template.pto.unwrap_or(0),
        template.start_number.unwrap_or(1),
        period_start,
        period_duration,
    )
    .map_err(|_| "Unsupported DASH manifest shape: invalid SegmentTimeline")?;
    if !dynamic && timeline.represented_segment_count() > MAX_STATIC_SEGMENTS {
        return Err("Unsupported DASH manifest shape: segment list too large".into());
    }
    let mut refs = Vec::new();
    if let (Some(first), Some(last)) = (timeline.first_position(), timeline.last_position()) {
        for position in first..=last {
            if let Some(reference) = timeline
                .get(position)
                .map_err(|_| "Unsupported DASH manifest shape")?
            {
                refs.push(reference);
            }
        }
    }
    if dynamic {
        refs.pop(); // the newest advertised fragment may still be incomplete
        if refs.len() > DYNAMIC_COMPLETE_WINDOW {
            refs.drain(..refs.len() - DYNAMIC_COMPLETE_WINDOW);
        }
    }
    if refs.is_empty() {
        return Err("Unsupported DASH manifest shape: no complete segments".into());
    }
    let mut bytes = Vec::new();
    let init = expand(
        template.initialization.as_deref().unwrap(),
        selection.representation,
        None,
        None,
    )?;
    bytes.extend(
        fetch(
            client,
            base.join(&init).map_err(|_| "Segment fetch failed")?,
            cancellation,
            "Segment fetch failed",
        )
        .await?,
    );
    for reference in refs {
        let media = expand(
            template.media.as_deref().unwrap(),
            selection.representation,
            Some(reference.position),
            Some(reference.media_time),
        )?;
        bytes.extend(
            fetch(
                client,
                base.join(&media).map_err(|_| "Segment fetch failed")?,
                cancellation,
                "Segment fetch failed",
            )
            .await?,
        );
    }
    fs::write(path, bytes)
        .await
        .map_err(|_| "Segment fetch failed: temporary write".into())
}

async fn fetch(
    client: &reqwest::Client,
    url: Url,
    cancellation: &CancellationToken,
    label: &str,
) -> Result<Vec<u8>, String> {
    fetch_with_final_url(client, url, cancellation, label)
        .await
        .map(|(body, _)| body)
}

async fn fetch_with_final_url(
    client: &reqwest::Client,
    url: Url,
    cancellation: &CancellationToken,
    label: &str,
) -> Result<(Vec<u8>, Url), String> {
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Err("Native DASH session cancelled".into()),
        result = client.get(url).send() => result.map_err(|_| label.to_string())?,
    };
    if !response.status().is_success() {
        return Err(format!("{}: HTTP {}", label, response.status().as_u16()));
    }
    let final_url = response.url().clone();
    let body = tokio::select! {
        _ = cancellation.cancelled() => return Err("Native DASH session cancelled".into()),
        result = response.bytes() => result.map_err(|_| label.to_string())?,
    };
    Ok((body.to_vec(), final_url))
}

fn expand(
    template: &str,
    representation: &Representation,
    number: Option<u64>,
    time: Option<i128>,
) -> Result<String, String> {
    let value = template
        .replace("$RepresentationID$", &representation.id)
        .replace(
            "$Number$",
            &number.map(|v| v.to_string()).unwrap_or_default(),
        )
        .replace("$Time$", &time.map(|v| v.to_string()).unwrap_or_default())
        .replace("$$", "\0");
    if value.contains('$') {
        return Err("Unsupported DASH manifest shape: unsupported URL template".into());
    }
    Ok(value.replace('\0', "$"))
}

fn inherit_base(mut base: Url, nodes: &[TextNode]) -> Result<Url, String> {
    if let Some(node) = nodes.first() {
        base = base
            .join(node.value.trim())
            .map_err(|_| "Unsupported DASH manifest shape: invalid BaseURL")?;
    }
    Ok(base)
}

fn parse_duration(text: &str) -> Result<ExactTime, String> {
    let value = text
        .strip_prefix("PT")
        .ok_or("Unsupported DASH manifest shape: duration")?;
    let mut seconds = 0_f64;
    let mut number = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            number.push(ch);
            continue;
        }
        let part: f64 = number
            .parse()
            .map_err(|_| "Unsupported DASH manifest shape: duration")?;
        number.clear();
        seconds += match ch {
            'H' => part * 3600.0,
            'M' => part * 60.0,
            'S' => part,
            _ => return Err("Unsupported DASH manifest shape: duration".into()),
        };
    }
    if !number.is_empty() || !seconds.is_finite() {
        return Err("Unsupported DASH manifest shape: duration".into());
    }
    ExactTime::new((seconds * 1_000_000.0).round() as i128, 1_000_000)
        .map_err(|_| "Unsupported DASH manifest shape: duration".into())
}

fn default_kids(xml: &str) -> Vec<[u8; 16]> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut values = Vec::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(event))
            | Ok(quick_xml::events::Event::Empty(event)) => {
                for attribute in event.attributes().flatten() {
                    if attribute
                        .key
                        .local_name()
                        .as_ref()
                        .eq_ignore_ascii_case(b"default_KID")
                    {
                        let normalized: String = String::from_utf8_lossy(attribute.value.as_ref())
                            .chars()
                            .filter(|ch| ch.is_ascii_hexdigit())
                            .collect();
                        if let Ok(kid) = decode_hex_16(&normalized) {
                            values.push(kid);
                        }
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    values
}

async fn run_packet_producer(
    video: &Path,
    audio: &Path,
    output: &Path,
    kid: [u8; 16],
    key: [u8; 16],
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let default = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../experiments/clearkey-cenc-packet-transform/cenc_component_producer");
    let producer = std::env::var_os("YNOTV_NATIVE_DASH_PACKET_PRODUCER")
        .map(PathBuf::from)
        .unwrap_or(default);
    if !producer.is_file() {
        return Err("Native DASH FFmpeg/ClearKey packet producer is unavailable".into());
    }
    let hex = |bytes: [u8; 16]| {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    log::info!("[native-dash] starting FFmpeg MOV + ClearKey packet transform");
    let mut command = Command::new(producer);
    command
        .arg(video)
        .arg(audio)
        .arg(output)
        .env("RUSTDASH_TEST_KID", hex(kid))
        .env("RUSTDASH_TEST_KEY", hex(key))
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let transform = tokio::select! {
        _ = cancellation.cancelled() => return Err("Native DASH session cancelled".into()),
        result = command.output() => result.map_err(|_| "Native DASH FFmpeg/ClearKey packet producer is unavailable")?,
    };
    if !transform.status.success() {
        let diagnostic = String::from_utf8_lossy(&transform.stderr);
        let safe_error = if diagnostic.contains("component demux failed before EOF") {
            "FFmpeg MOV demux failed"
        } else if diagnostic.contains("encrypted component packet has no encryption info") {
            "CENC encryption metadata unavailable"
        } else if diagnostic.contains("could not open component input") {
            "FFmpeg MOV input failed"
        } else if diagnostic.contains("UnsupportedScheme") {
            "Unsupported CENC scheme"
        } else if transform.status.code() == Some(3) {
            "ClearKey KID unavailable"
        } else {
            "CENC decrypt failed"
        };
        log::error!("[native-dash] packet transform failed: {}", safe_error);
        return Err(safe_error.into());
    }
    log::info!("[native-dash] FFmpeg MOV + ClearKey packet transform complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_key_parser_never_echoes_input() {
        assert!(decode_hex_16("00112233445566778899AABBCCDDEEFF").is_ok());
        assert_eq!(
            decode_hex_16("not-a-key").unwrap_err(),
            "Invalid ClearKey property"
        );
    }

    #[test]
    fn selects_lowest_bandwidth_representation() {
        let xml = r#"<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="i-$RepresentationID$" media="m-$Time$"><SegmentTimeline><S t="0" d="2" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="high" bandwidth="2000"/><Representation id="low" bandwidth="1000"/></AdaptationSet><AdaptationSet contentType="video" mimeType="video/mp4"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode"/><Representation id="trick" bandwidth="1"/></AdaptationSet><AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a" bandwidth="128"/></AdaptationSet></Period></MPD>"#;
        let mpd: Mpd = from_str(xml).unwrap();
        assert_eq!(
            select(&mpd.periods[0], MediaKind::Video)
                .unwrap()
                .representation
                .id,
            "low"
        );
    }

    #[tokio::test]
    async fn manifest_fetch_returns_final_redirect_url() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for request_number in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 1024];
                let _ = socket.read(&mut request).await.unwrap();
                let response = if request_number == 0 {
                    "HTTP/1.1 302 Found\r\nLocation: /cdn/manifest.mpd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<MPD/>"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = reqwest::Client::new();
        let (_, final_url) = fetch_with_final_url(
            &client,
            Url::parse(&format!("http://{address}/entry")).unwrap(),
            &CancellationToken::new(),
            "Manifest fetch failed",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(final_url.path(), "/cdn/manifest.mpd");
    }

    #[test]
    fn template_expansion_is_exact() {
        let representation = Representation {
            id: "v1".into(),
            bandwidth: 1,
            mime_type: None,
            codecs: None,
            base_urls: vec![],
            template: None,
            protections: vec![],
        };
        assert_eq!(
            expand(
                "x/$RepresentationID$/$Number$-$Time$",
                &representation,
                Some(7),
                Some(99)
            )
            .unwrap(),
            "x/v1/7-99"
        );
        assert!(expand("x/$Bandwidth$", &representation, None, None).is_err());
    }
}
