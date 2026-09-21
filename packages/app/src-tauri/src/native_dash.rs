//! Native ClearKey DASH session with immutable manifest generations and C8 switching.

use crate::dash_timeline::{CompactTimeline, ExactTime, TimelineEntry};
use crate::dash_abr::{
    AbrController, AbrDecision, AbrEvaluation, AbrPolicy, AbrReason, AbrRepresentation, AbrStatistics,
    DownloadMeasurement, VideoQualityMode,
};
use futures_util::stream::{self, StreamExt, TryStreamExt};
use once_cell::sync::Lazy;
use quick_xml::de::from_str;
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, hash::{DefaultHasher, Hash, Hasher}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant, SystemTime}};
use tempfile::TempDir;
use tokio::{fs, io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, process::Command};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_STATIC_SEGMENTS: u128 = 20_000;
// Start one complete segment behind the live edge. We still fetch only one
// segment before exposing the packet source, so startup stays fast, while the
// newest complete segment can be prepared during playback of the first one.
const DYNAMIC_STARTUP_LAG_SEGMENTS: usize = 1;
const FALLBACK_MUP: Duration = Duration::from_secs(2);
const MIN_MUP: Duration = Duration::from_millis(250);
const MAX_INFERRED_MUP: Duration = Duration::from_secs(4);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDashPlaybackConfig {
    pub manifest_url: String,
    #[serde(default)] pub request_headers: HashMap<String, String>,
    #[serde(default)] pub preferred_subtitle_language: Option<String>,
    pub drm: NativeDashDrm,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum NativeDashDrm { ClearKey { kid: String, key: String } }

#[derive(Clone, Debug, Default)]
struct SwitchSelection {
    generation: u64,
    video_representation: String,
    video_quality_mode: VideoQualityMode,
    abr_reason: Option<AbrReason>,
    audio_track: String,
    subtitle_track: Option<String>,
}
#[derive(Clone,Copy,Debug,Eq,PartialEq)]enum SwitchState{Stable,SwitchRequested,TargetPreparing,WaitingForBoundary,Committing}

#[derive(Default)]
struct ActiveSession {
    generation: u64,
    cancellation: Option<CancellationToken>,
    files: Option<TempDir>,
    dynamic: bool,
    catalog: Option<DashTrackCatalog>,
    switch_tx: Option<tokio::sync::watch::Sender<SwitchSelection>>,
    seek_tx: Option<tokio::sync::mpsc::Sender<SeekCommand>>,
    timeline: Option<PresentationTimeline>,
}
static ACTIVE: Lazy<parking_lot::Mutex<ActiveSession>> = Lazy::new(|| parking_lot::Mutex::new(ActiveSession::default()));
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static BUFFERED_SECONDS_BITS: AtomicU64 = AtomicU64::new(f64::NAN.to_bits());

pub(crate) fn observe_buffered_seconds(value: Option<f64>) {
    BUFFERED_SECONDS_BITS.store(value.filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(f64::NAN).to_bits(), Ordering::Relaxed);
}

fn buffered_seconds() -> Option<f64> {
    let value = f64::from_bits(BUFFERED_SECONDS_BITS.load(Ordering::Relaxed));
    value.is_finite().then_some(value)
}

pub(crate) fn cancel_active() {
    let mut active = ACTIVE.lock();
    if let Some(token) = active.cancellation.take() { token.cancel(); }
    active.files = None;
    active.dynamic = false;
    active.catalog = None;
    active.switch_tx = None;
    active.seek_tx = None;
    active.timeline = None;
    observe_buffered_seconds(None);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_active() -> bool {
    ACTIVE.lock().files.is_some()
}

const LIVE_EDGE_TOLERANCE_SECONDS: f64 = 3.0;

#[derive(Clone, Debug)]
struct PresentationTimeline {
    seek_range_start: ExactTime,
    seek_range_end: ExactTime,
    current_time: ExactTime,
    live_edge: ExactTime,
    origin: ExactTime,
    is_live: bool,
    generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationTimelineState {
    pub(crate) seek_range_start: f64,
    pub(crate) seek_range_end: f64,
    pub(crate) current_time: f64,
    pub(crate) live_edge: f64,
    pub(crate) is_live: bool,
    pub(crate) is_at_live_edge: bool,
    pub(crate) window_duration: f64,
    pub(crate) generation: u64,
}

fn seconds(value: ExactTime) -> f64 {
    value.numerator() as f64 / value.denominator() as f64
}

impl PresentationTimeline {
    fn state(&self) -> PresentationTimelineState {
        let seek_range_start = seconds(self.seek_range_start);
        let seek_range_end = seconds(self.seek_range_end);
        let current_time = seconds(self.current_time);
        let live_edge = seconds(self.live_edge);
        PresentationTimelineState {
            seek_range_start,
            seek_range_end,
            current_time,
            live_edge,
            is_live: self.is_live,
            is_at_live_edge: self.is_live
                && live_edge - current_time <= LIVE_EDGE_TOLERANCE_SECONDS,
            window_duration: (seek_range_end - seek_range_start).max(0.0),
            generation: self.generation,
        }
    }
}

pub(crate) fn presentation_timeline_state(
    relative_player_time: Option<f64>,
) -> Option<PresentationTimelineState> {
    let mut active = ACTIVE.lock();
    let timeline = active.timeline.as_mut()?;
    if let Some(relative) = relative_player_time.filter(|value| value.is_finite()) {
        if let Ok(relative) = ExactTime::new((relative * 1_000_000.0).round() as i128, 1_000_000) {
            if let Ok(current) = timeline.origin.checked_add(relative) {
                // The native seek coordinator moves current_time to the
                // requested target before asking mpv to flush. Outside that
                // path, reject transient multi-minute clock discontinuities
                // (notably a temporary time-pos=0 during decoder/cache
                // reconfiguration) instead of moving the DVR thumb to the
                // beginning of the window.
                let discontinuity = current.checked_sub(timeline.current_time).ok().map(seconds).unwrap_or(f64::INFINITY).abs();
                if discontinuity <= 30.0 {
                    timeline.current_time = current;
                }
            }
        }
    }
    Some(timeline.state())
}
pub(crate) fn note_eof() {
    let active = ACTIVE.lock();
    if active.dynamic && active.files.is_some() { log::warn!("[native-dash] dynamic packet source ended unexpectedly"); }
}

pub(crate) async fn prepare(config: NativeDashPlaybackConfig) -> Result<String, String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Native DASH requires the in-process libmpv backend on macOS or Windows".into());
    let (kid, key) = match &config.drm { NativeDashDrm::ClearKey { kid, key } => (decode_hex_16(kid)?, decode_hex_16(key)?) };
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let cancellation = CancellationToken::new();
    {
        let mut active = ACTIVE.lock();
        if let Some(old) = active.cancellation.take() { old.cancel(); }
        active.files = None; active.dynamic = false; active.catalog = None;
        active.switch_tx = None; active.seek_tx = None; active.timeline = None; active.generation = generation;
        active.cancellation = Some(cancellation.clone());
    }
    let result = build_live(&config.manifest_url, &config.request_headers, config.preferred_subtitle_language.as_deref(), kid, key, &cancellation).await;
    match result {
        Ok((dir, source, dynamic, catalog, switch_tx, seek_tx, timeline)) => {
            let mut active = ACTIVE.lock();
            if active.generation != generation || cancellation.is_cancelled() { return Err("Native DASH session cancelled".into()); }
            active.files = Some(dir); active.dynamic = dynamic;
            active.catalog = Some(catalog); active.switch_tx = Some(switch_tx);
            active.seek_tx = Some(seek_tx);
            active.timeline = Some(timeline); Ok(source)
        }
        Err(error) => Err(error),
    }
}

struct SeekCommand {
    target: f64,
    epoch: u64,
    completion: tokio::sync::oneshot::Sender<Result<f64, String>>,
}

fn seek_epoch_marker(epoch: u64, target_ms: i64) -> Vec<u8> {
    let mut marker = 0x314b4553u32.to_le_bytes().to_vec();
    marker.extend(epoch.to_le_bytes());
    marker.extend(target_ms.to_le_bytes());
    marker
}

pub(crate) async fn request_seek(target: f64) -> Result<Option<f64>, String> {
    if !target.is_finite() {
        return Err("Invalid DASH seek target".into());
    }
    let (sender, current, epoch) = {
        let active = ACTIVE.lock();
        let Some(sender) = active.seek_tx.clone() else { return Ok(None) };
        let current = active.timeline.as_ref().map(|timeline| seconds(timeline.current_time)).unwrap_or(0.0);
        (sender, current, NEXT_GENERATION.fetch_add(1, Ordering::Relaxed))
    };
    log::info!("DASH seek requested: target={target:.3} current={current:.3} epoch={epoch}");
    let (completion, receive) = tokio::sync::oneshot::channel();
    sender.send(SeekCommand { target, epoch, completion }).await.map_err(|_| "Native DASH seek session ended")?;
    receive.await.map_err(|_| "Native DASH seek session ended")?.map(Some)
}

pub(crate) async fn clamp_expired_position_on_resume() -> Result<Option<f64>, String> {
    let target = {
        let active = ACTIVE.lock();
        active.timeline.as_ref().and_then(|timeline| {
            (timeline.current_time < timeline.seek_range_start).then_some(seconds(timeline.seek_range_start))
        })
    };
    if let Some(target) = target {
        log::warn!("DASH DVR paused position expired; clamping resume to seek_start={target:.3}");
        request_seek(target).await
    } else {
        Ok(None)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashVideoRepresentation {
    pub representation_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bandwidth: u64,
    pub codec: String,
    pub frame_rate: Option<String>,
    pub label: String,
    pub compatible: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashAudioTrack {
    pub adaptation_set_id: String,
    pub mpv_track_id: i64,
    pub language: String,
    pub label: String,
    pub role: Vec<String>,
    pub codec: String,
    pub channels: Option<String>,
    pub sample_rate: Option<u32>,
    pub representation_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashTrackCatalog {
    pub active: bool,
    pub video_adaptation_set_id: String,
    pub selected_video_representation_id: String,
    pub video_quality_mode: VideoQualityMode,
    pub pending_video_representation_id: Option<String>,
    pub abr_statistics: AbrStatistics,
    pub selected_audio_adaptation_set_id: String,
    pub video_representations: Vec<DashVideoRepresentation>,
    pub audio_tracks: Vec<DashAudioTrack>,
    #[serde(skip)]
    subtitle_tracks: Vec<String>,
}

pub(crate) fn track_catalog() -> Option<DashTrackCatalog> {
    ACTIVE.lock().catalog.clone()
}

pub(crate) fn selected_subtitle_mpv_track_id() -> Option<i64> {
    let active = ACTIVE.lock();
    let selected = active.switch_tx.as_ref()?.borrow().subtitle_track.clone()?;
    active.catalog.as_ref()?.subtitle_tracks.iter().position(|track| track == &selected).map(|index| index as i64 + 1)
}

pub(crate) fn request_video_representation(representation_id: &str) -> Result<(), String> {
    let mut active = ACTIVE.lock();
    let tx = active.switch_tx.as_ref().ok_or("No active native DASH session")?.clone();
    let catalog = active.catalog.as_mut().ok_or("No active native DASH session")?;
    let option = catalog.video_representations.iter().find(|r| r.representation_id == representation_id)
        .ok_or("Unknown DASH video representation")?;
    if !option.compatible {
        return Err("Unsupported DASH representation switch: codec family or segment alignment is incompatible".into());
    }
    switch_video_representation(&tx, representation_id, VideoQualityMode::Manual(representation_id.to_string()), None);
    catalog.video_quality_mode = VideoQualityMode::Manual(representation_id.to_string());
    catalog.pending_video_representation_id = Some(representation_id.to_string());
    Ok(())
}

pub(crate) fn request_auto_video_quality() -> Result<(), String> {
    let mut active = ACTIVE.lock();
    let tx = active.switch_tx.as_ref().ok_or("No active native DASH session")?.clone();
    let catalog = active.catalog.as_mut().ok_or("No active native DASH session")?;
    let current = catalog.selected_video_representation_id.clone();
    // Incrementing the shared C8 generation immediately supersedes a pending
    // manual/ABR target without reloading or duplicating switch-boundary logic.
    switch_video_representation(&tx, &current, VideoQualityMode::Auto, None);
    catalog.video_quality_mode = VideoQualityMode::Auto;
    catalog.pending_video_representation_id = None;
    Ok(())
}

fn switch_video_representation(
    tx: &tokio::sync::watch::Sender<SwitchSelection>,
    representation_id: &str,
    mode: VideoQualityMode,
    abr_reason: Option<AbrReason>,
) {
    let next = tx.borrow().generation.saturating_add(1);
    tx.send_modify(|selection| {
        selection.generation = next;
        selection.video_representation = representation_id.to_string();
        selection.video_quality_mode = mode.clone();
        selection.abr_reason = abr_reason;
    });
}

pub(crate) fn note_audio_track_selection(mpv_track_id: i64) {
    if mpv_track_id <= 0 { return; }
    let mut active = ACTIVE.lock();
    let Some(tx) = active.switch_tx.as_ref().cloned() else { return };
    let Some(catalog) = active.catalog.as_mut() else { return };
    let Some(track) = catalog.audio_tracks.iter().find(|track| track.mpv_track_id == mpv_track_id) else { return };
    let adaptation = track.adaptation_set_id.clone();
    let next = tx.borrow().generation.saturating_add(1);
    tx.send_modify(|selection| {
        selection.generation = next;
        selection.audio_track = adaptation.clone();
    });
    catalog.selected_audio_adaptation_set_id = adaptation;
}

pub(crate) fn note_subtitle_track_selection(mpv_track_id: i64) {
    let active = ACTIVE.lock();
    let Some(tx) = active.switch_tx.as_ref().cloned() else { return };
    let subtitle_track = if mpv_track_id > 0 {
        active.catalog.as_ref().and_then(|catalog| catalog.subtitle_tracks.get((mpv_track_id - 1) as usize).cloned())
    } else { None };
    drop(active);
    if tx.borrow().subtitle_track == subtitle_track {
        log::debug!("DASH subtitle selection already active: {:?}", subtitle_track);
        return;
    }
    let next = tx.borrow().generation.saturating_add(1);
    tx.send_modify(|selection| {
        selection.generation = next;
        selection.subtitle_track = subtitle_track.clone();
    });
}

fn decode_hex_16(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32 || !value.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid ClearKey property".into()); }
    let mut result = [0; 16];
    for (i, byte) in result.iter_mut().enumerate() { *byte = u8::from_str_radix(&value[i*2..i*2+2], 16).map_err(|_| "Invalid ClearKey property")?; }
    Ok(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename = "MPD")]
struct Mpd {
    #[serde(rename="@type", default)] kind: String,
    #[serde(rename="@mediaPresentationDuration")] duration: Option<String>,
    #[serde(rename="@availabilityStartTime")] availability_start_time: Option<String>,
    #[serde(rename="@timeShiftBufferDepth")] time_shift_buffer_depth: Option<String>,
    #[serde(rename="@suggestedPresentationDelay")] suggested_presentation_delay: Option<String>,
    #[serde(rename="@minimumUpdatePeriod")] minimum_update_period: Option<String>,
    #[serde(rename="@publishTime")] publish_time: Option<String>,
    #[serde(rename="BaseURL", default)] base_urls: Vec<TextNode>,
    #[serde(rename="Period", default)] periods: Vec<Period>,
}
#[derive(Debug, Deserialize)]
struct Period {
    #[serde(rename="@id")] id: Option<String>, #[serde(rename="@start")] start: Option<String>, #[serde(rename="@duration")] duration: Option<String>,
    #[serde(rename="BaseURL", default)] base_urls: Vec<TextNode>, #[serde(rename="AdaptationSet", default)] adaptations: Vec<Adaptation>,
}
#[derive(Debug, Deserialize)]
struct Adaptation {
    #[serde(rename="@id")] id: Option<String>, #[serde(rename="@contentType")] content_type: Option<String>, #[serde(rename="@mimeType")] mime_type: Option<String>, #[serde(rename="@codecs")] codecs: Option<String>,
    #[serde(rename="@width")] width: Option<u32>, #[serde(rename="@height")] height: Option<u32>, #[serde(rename="@frameRate")] frame_rate: Option<String>, #[serde(rename="@audioSamplingRate")] audio_sampling_rate: Option<u32>,
    #[serde(rename="@lang")] language: Option<String>, #[serde(rename="@selectionPriority")] selection_priority: Option<u32>,
    #[serde(rename="BaseURL", default)] base_urls: Vec<TextNode>, #[serde(rename="SegmentTemplate")] template: Option<SegmentTemplate>,
    #[serde(rename="ContentProtection", default)] protections: Vec<ContentProtection>, #[serde(rename="EssentialProperty", default)] essential: Vec<Descriptor>,
    #[serde(rename="Role", default)] roles: Vec<Descriptor>, #[serde(rename="Accessibility", default)] accessibility: Vec<Descriptor>,
    #[serde(rename="AudioChannelConfiguration")] audio_channel_configuration: Option<Descriptor>,
    #[serde(rename="Label")] label: Option<TextNode>,
    #[serde(rename="Representation", default)] representations: Vec<Representation>,
}
#[derive(Debug, Deserialize)]
struct Representation {
    #[serde(rename="@id")] id: String, #[serde(rename="@bandwidth", default)] bandwidth: u64, #[serde(rename="@mimeType")] mime_type: Option<String>, #[serde(rename="@codecs")] codecs: Option<String>,
    #[serde(rename="@width")] width: Option<u32>, #[serde(rename="@height")] height: Option<u32>, #[serde(rename="@frameRate")] frame_rate: Option<String>, #[serde(rename="@audioSamplingRate")] audio_sampling_rate: Option<u32>,
    #[serde(rename="BaseURL", default)] base_urls: Vec<TextNode>, #[serde(rename="SegmentTemplate")] template: Option<SegmentTemplate>, #[serde(rename="ContentProtection", default)] protections: Vec<ContentProtection>,
}
#[derive(Debug, Deserialize)] struct ContentProtection { #[serde(rename="@schemeIdUri", default)] scheme: String, #[serde(rename="@value")] value: Option<String> }
#[derive(Debug, Deserialize)] struct Descriptor { #[serde(rename="@schemeIdUri", default)] scheme: String, #[serde(rename="@value")] value: Option<String> }
#[derive(Clone, Debug, Default, Deserialize)]
struct SegmentTemplate { #[serde(rename="@timescale")] timescale: Option<u64>, #[serde(rename="@presentationTimeOffset")] pto: Option<i128>, #[serde(rename="@startNumber")] start_number: Option<u64>, #[serde(rename="@initialization")] initialization: Option<String>, #[serde(rename="@media")] media: Option<String>, #[serde(rename="SegmentTimeline")] timeline: Option<SegmentTimeline> }
#[derive(Clone, Debug, Deserialize)] struct SegmentTimeline { #[serde(rename="S", default)] entries: Vec<S> }
#[derive(Clone, Debug, Deserialize)] struct S { #[serde(rename="@t")] t: Option<i128>, #[serde(rename="@d")] d: i128, #[serde(rename="@r", default)] r: i64 }
#[derive(Debug, Deserialize)] struct TextNode { #[serde(rename="$text", default)] value: String }

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)] enum MediaKind { Video, Audio, Subtitle }
struct Selection<'a> { adaptation: &'a Adaptation, representation: &'a Representation, kind: MediaKind }
#[derive(Clone, Debug, Eq, Hash, PartialEq)] struct RepresentationIdentity { period: String, adaptation: String, representation: String, kind: MediaKind }
#[derive(Clone, Debug, Eq, PartialEq)] struct SubtitleMetadata { language:String, label:String, roles:Vec<String>, accessibility:Vec<String>, selection_priority:Option<u32>, default_track:bool, forced_track:bool }
#[derive(Clone)] struct RepresentationSnapshot { identity: RepresentationIdentity, base: Url, template: SegmentTemplate, index: CompactTimeline, mime_type:String, codecs: String, bandwidth: u64, width:Option<u32>, height:Option<u32>, frame_rate:Option<String>, audio_sampling_rate:Option<u32>, subtitle:Option<SubtitleMetadata> }
#[derive(Clone)] struct LogicalVideoTrack { adaptation_set_id:String, content_type:Option<String>, mime_type:Option<String>, codecs:Option<String>, language:Option<String>, label:Option<String>, roles:Vec<String>, accessibility:Vec<String>, selection_priority:Option<u32>, representations:Vec<RepresentationSnapshot> }
#[derive(Clone)] struct LogicalAudioTrack { adaptation_set_id:String, content_type:Option<String>, mime_type:Option<String>, codecs:Option<String>, language:String, label:String, roles:Vec<String>, accessibility:Vec<String>, selection_priority:Option<u32>, channel_configuration:Option<String>, representations:Vec<RepresentationSnapshot>, selected:RepresentationSnapshot, mpv_track_id:i64 }
#[derive(Clone)] struct ManifestSnapshot {
    generation: u64, fetched_at: SystemTime, published_at: Instant, publish_time: Option<chrono::DateTime<chrono::Utc>>, minimum_update_period: Duration, dynamic: bool,
    availability_start_time: Option<chrono::DateTime<chrono::Utc>>, time_shift_buffer_depth: Option<ExactTime>, suggested_presentation_delay: Option<ExactTime>,
    periods: Vec<String>, video_tracks:Vec<LogicalVideoTrack>, audio_tracks:Vec<LogicalAudioTrack>, video: RepresentationSnapshot, audio: RepresentationSnapshot, subtitles:Vec<RepresentationSnapshot>,
}
#[derive(Clone, Debug, Eq, Hash, PartialEq)] struct SegmentIdentity { representation: RepresentationIdentity, media_time: i128 }
#[derive(Clone)] struct SegmentDescriptor { identity: SegmentIdentity, number: u64, start: ExactTime, end: ExactTime, url: Url }
#[derive(Clone, Copy, Debug, Eq, PartialEq)] enum SegmentState { Known, Scheduled, Fetching, Fetched, Demuxed, Expired }
#[derive(Clone)] struct SegmentRecord { descriptor: SegmentDescriptor, state: SegmentState, advertised: bool, first_generation: u64, last_generation: u64 }
#[derive(Default)] struct SegmentIndex { records: HashMap<SegmentIdentity, SegmentRecord>, fetched: HashSet<SegmentIdentity>, demuxed: HashSet<SegmentIdentity> }
#[derive(Debug, Default, Eq, PartialEq)] struct MergeStats { added: usize, retained: usize, expired: usize }

impl SegmentIndex {
    fn merge(&mut self, snapshot: &ManifestSnapshot) -> Result<MergeStats, String> {
        for record in self.records.values_mut() { record.advertised = false; }
        let mut stats = MergeStats::default();
        let video_reps=snapshot.video_tracks.iter().flat_map(|track|track.representations.iter());
        let audio_reps=snapshot.audio_tracks.iter().flat_map(|track|track.representations.iter());
        for rep in video_reps.chain(audio_reps).chain(snapshot.subtitles.iter()) {
            for descriptor in descriptors(rep, snapshot.dynamic)? {
                if let Some(record) = self.records.get_mut(&descriptor.identity) {
                    record.descriptor = descriptor; record.advertised = true; record.last_generation = snapshot.generation;
                    stats.retained += 1;
                } else {
                    self.records.insert(descriptor.identity.clone(), SegmentRecord { descriptor, state: SegmentState::Known, advertised: true, first_generation: snapshot.generation, last_generation: snapshot.generation }); stats.added += 1;
                }
            }
        }
        for record in self.records.values_mut() {
            if !record.advertised && record.last_generation < snapshot.generation { if record.state == SegmentState::Known { record.state = SegmentState::Expired; } stats.expired += 1; }
        }
        Ok(stats)
    }
    fn mark(&mut self, id: &SegmentIdentity, state: SegmentState) {
        if let Some(record) = self.records.get_mut(id) { record.state = state; }
        if state == SegmentState::Fetched { self.fetched.insert(id.clone()); }
        if state == SegmentState::Demuxed { self.demuxed.insert(id.clone()); }
    }
    fn next(&self, kind: MediaKind) -> Option<SegmentDescriptor> {
        self.records.values().filter(|r| r.advertised && r.state == SegmentState::Known && r.descriptor.identity.representation.kind == kind && !self.fetched.contains(&r.descriptor.identity)).min_by_key(|r| r.descriptor.start).map(|r| r.descriptor.clone())
    }
}

fn parse_snapshot(bytes: &[u8], final_url: Url, generation: u64, selected: Option<&SwitchSelection>) -> Result<ManifestSnapshot,String> {
    let xml = std::str::from_utf8(bytes).map_err(|_| "Unsupported DASH manifest shape")?;
    let mpd: Mpd = from_str(xml).map_err(|_| "Unsupported DASH manifest shape")?;
    if mpd.periods.len() != 1 { return Err("Unsupported DASH manifest shape: exactly one Period is required".into()); }
    let period=&mpd.periods[0]; let start=parse_duration(period.start.as_deref().unwrap_or("PT0S"))?;
    let duration=period.duration.as_deref().or(mpd.duration.as_deref()).map(parse_duration).transpose()?;
    let period_id=period.id.clone().unwrap_or_else(|| format!("start:{}/{}",start.numerator(),start.denominator()));
    let base=inherit_base(inherit_base(final_url,&mpd.base_urls)?,&period.base_urls)?;
    let dynamic=mpd.kind.eq_ignore_ascii_case("dynamic");
    let video_tracks=build_video_tracks(period,&base,&period_id,start,duration)?;
    let video_choices=video_tracks.first().ok_or("Unsupported DASH manifest shape: no supported Video representation")?;
    let video=selected.and_then(|s|video_choices.representations.iter().find(|r|r.identity.representation==s.video_representation)).cloned()
        .or_else(||startup_video_representation(&video_choices.representations,dynamic))
        .ok_or("Unsupported DASH manifest shape: no supported Video representation")?;
    let audio_tracks=build_audio_tracks(period,&base,&period_id,start,duration)?;
    let audio_track=selected.and_then(|s|audio_tracks.iter().find(|t|t.adaptation_set_id==s.audio_track))
        .or_else(||audio_tracks.first()).ok_or("Unsupported DASH manifest shape: no supported Audio representation")?;
    let audio=audio_track.selected.clone();
    let subtitles=select_subtitles(period,None)?.into_iter().map(|choice|make_rep(base.clone(),period_id.clone(),choice,start,duration)).collect::<Result<Vec<_>,_>>()?;
    let publish_time=mpd.publish_time.as_deref().map(|v|chrono::DateTime::parse_from_rfc3339(v).map(|v|v.with_timezone(&chrono::Utc)).map_err(|_|"Unsupported DASH manifest shape: publishTime")).transpose()?;
    let declared_mup=mpd.minimum_update_period.as_deref().map(parse_std_duration).transpose()?.filter(|v|!v.is_zero());
    let minimum_update_period=declared_mup.unwrap_or_else(||inferred_update_period(&video)).max(MIN_MUP);
    let availability_start_time=mpd.availability_start_time.as_deref().map(|v|chrono::DateTime::parse_from_rfc3339(v).map(|v|v.with_timezone(&chrono::Utc)).map_err(|_|"Unsupported DASH manifest shape: availabilityStartTime")).transpose()?;
    let time_shift_buffer_depth=mpd.time_shift_buffer_depth.as_deref().map(parse_duration).transpose()?;
    let suggested_presentation_delay=mpd.suggested_presentation_delay.as_deref().map(parse_duration).transpose()?;
    Ok(ManifestSnapshot { generation,fetched_at:SystemTime::now(),published_at:Instant::now(),publish_time,minimum_update_period,dynamic,availability_start_time,time_shift_buffer_depth,suggested_presentation_delay,periods:vec![period_id],video_tracks,audio_tracks,video,audio,subtitles })
}

fn startup_video_representation(representations:&[RepresentationSnapshot],dynamic:bool)->Option<RepresentationSnapshot>{
    let mut ladder=representations.to_vec();
    ladder.sort_by_key(|r|(r.bandwidth,r.identity.representation.clone()));
    let family=ladder.first().map(|r|codec_family(&r.codecs).to_string())?;
    let anchor=ladder.first()?.clone();
    ladder.retain(|r|codec_family(&r.codecs)==family&&aligned_with(&anchor,r,dynamic));
    ladder.get(ladder.len().saturating_sub(1)/2).cloned()
}

fn build_video_tracks<'a>(period:&'a Period,base:&Url,period_id:&str,start:ExactTime,duration:Option<ExactTime>)->Result<Vec<LogicalVideoTrack>,String>{
    let mut tracks=Vec::new();
    for adaptation in &period.adaptations{
        if adaptation.essential.iter().any(|e|e.scheme.eq_ignore_ascii_case("http://dashif.org/guidelines/trickmode")){continue}
        let mut representations=Vec::new();
        for representation in &adaptation.representations{
            let mime=representation.mime_type.as_ref().or(adaptation.mime_type.as_ref());
            if (adaptation.content_type.as_deref()==Some("video")||mime.is_some_and(|m|m.starts_with("video/")))&&mime.is_none_or(|m|m.ends_with("/mp4")){
                representations.push(make_rep(base.clone(),period_id.to_string(),Selection{adaptation,representation,kind:MediaKind::Video},start,duration)?);
            }
        }
        representations.sort_by_key(|r|(r.bandwidth,r.identity.representation.clone()));
        if !representations.is_empty(){tracks.push(LogicalVideoTrack{adaptation_set_id:adaptation_id(adaptation,MediaKind::Video),content_type:adaptation.content_type.clone(),mime_type:adaptation.mime_type.clone(),codecs:adaptation.codecs.clone(),language:adaptation.language.clone(),label:adaptation.label.as_ref().map(|v|v.value.trim().to_string()),roles:adaptation.roles.iter().filter_map(|d|d.value.clone()).collect(),accessibility:adaptation.accessibility.iter().filter_map(|d|d.value.clone()).collect(),selection_priority:adaptation.selection_priority,representations})}
    }
    tracks.sort_by_key(|t|(std::cmp::Reverse(t.selection_priority.unwrap_or(0)),!t.roles.iter().any(|r|r.eq_ignore_ascii_case("main")),t.adaptation_set_id.clone()));Ok(tracks)
}

fn build_audio_tracks<'a>(period:&'a Period,base:&Url,period_id:&str,start:ExactTime,duration:Option<ExactTime>)->Result<Vec<LogicalAudioTrack>,String>{
    let mut tracks=Vec::new();
    for adaptation in &period.adaptations{
        let mut representations=Vec::new();
        for representation in &adaptation.representations{
            let mime=representation.mime_type.as_ref().or(adaptation.mime_type.as_ref());
            if (adaptation.content_type.as_deref()==Some("audio")||mime.is_some_and(|m|m.starts_with("audio/")))&&mime.is_none_or(|m|m.ends_with("/mp4")){
                representations.push(make_rep(base.clone(),period_id.to_string(),Selection{adaptation,representation,kind:MediaKind::Audio},start,duration)?);
            }
        }
        if representations.is_empty(){continue}
        representations.sort_by_key(|r|(r.bandwidth,r.identity.representation.clone()));
        // C8 audio policy: deterministic highest-bandwidth representation, with no audio ABR.
        let selected=representations.last().cloned().unwrap();
        let roles=adaptation.roles.iter().filter_map(|d|d.value.clone()).collect::<Vec<_>>();
        let language=adaptation.language.clone().unwrap_or_else(||"und".into());
        let label=adaptation.label.as_ref().map(|l|l.value.trim().to_string()).filter(|s|!s.is_empty()).unwrap_or_else(||language.clone());
        tracks.push(LogicalAudioTrack{adaptation_set_id:adaptation_id(adaptation,MediaKind::Audio),content_type:adaptation.content_type.clone(),mime_type:adaptation.mime_type.clone(),codecs:adaptation.codecs.clone(),language,label,roles,accessibility:adaptation.accessibility.iter().filter_map(|d|d.value.clone()).collect(),selection_priority:adaptation.selection_priority,channel_configuration:adaptation.audio_channel_configuration.as_ref().and_then(|d|d.value.clone()),representations,selected,mpv_track_id:0});
    }
    tracks.sort_by_key(|t|(std::cmp::Reverse(t.selection_priority.unwrap_or(0)),!t.roles.iter().any(|r|r.eq_ignore_ascii_case("main")),t.adaptation_set_id.clone()));
    for(index,track)in tracks.iter_mut().enumerate(){track.mpv_track_id=(index+1)as i64}
    Ok(tracks)
}

fn is_dash_subtitle(a:&Adaptation,r:&Representation)->bool{
    let content=a.content_type.as_deref().unwrap_or("");let mime=r.mime_type.as_ref().or(a.mime_type.as_ref()).map(String::as_str).unwrap_or("");let codecs=r.codecs.as_ref().or(a.codecs.as_ref()).map(String::as_str).unwrap_or("").to_ascii_lowercase();
    (content.eq_ignore_ascii_case("text")||mime.eq_ignore_ascii_case("application/ttml+xml")||mime.eq_ignore_ascii_case("application/mp4")&&codecs.split(',').any(|c|c.trim().starts_with("stpp")))
        && (mime.eq_ignore_ascii_case("application/ttml+xml")||mime.eq_ignore_ascii_case("application/mp4"))
}
fn select_subtitles<'a>(period:&'a Period,required:Option<&[RepresentationIdentity]>)->Result<Vec<Selection<'a>>,String>{
    let mut out=Vec::new();
    for a in &period.adaptations{
        let mut choices:Vec<_>=a.representations.iter().filter(|r|is_dash_subtitle(a,r)).filter(|r|required.is_none_or(|ids|ids.iter().any(|id|id.kind==MediaKind::Subtitle&&id.adaptation==adaptation_id(a,MediaKind::Subtitle)&&id.representation==r.id))).map(|r|Selection{adaptation:a,representation:r,kind:MediaKind::Subtitle}).collect();
        choices.sort_by_key(|c|(c.representation.bandwidth,&c.representation.id));if let Some(choice)=choices.into_iter().next(){out.push(choice)}
    }
    if let Some(ids)=required{let expected=ids.iter().filter(|id|id.kind==MediaKind::Subtitle).count();if out.len()!=expected{return Err("Unsupported DASH refresh: selected subtitle representation disappeared".into())}}
    Ok(out)
}
fn adaptation_id(a:&Adaptation,kind:MediaKind)->String{a.id.clone().unwrap_or_else(||format!("{:?}:{}:{}",kind,a.content_type.as_deref().unwrap_or(""),a.mime_type.as_deref().unwrap_or("")))}
fn make_rep(base:Url,period:String,s:Selection<'_>,start:ExactTime,duration:Option<ExactTime>)->Result<RepresentationSnapshot,String>{
    validate_cenc(&s)?; let template=merged_template(s.adaptation,s.representation)?;
    let entries:Vec<_>=template.timeline.as_ref().unwrap().entries.iter().map(|x|TimelineEntry{t:x.t,d:x.d,r:x.r}).collect();
    let index=CompactTimeline::new(&entries,template.timescale.unwrap_or(1),template.pto.unwrap_or(0),template.start_number.unwrap_or(1),start,duration).map_err(|_|"Unsupported DASH manifest shape: invalid SegmentTimeline")?;
    let base=inherit_base(inherit_base(base,&s.adaptation.base_urls)?,&s.representation.base_urls)?;
    let identity=RepresentationIdentity{period,adaptation:adaptation_id(s.adaptation,s.kind),representation:s.representation.id.clone(),kind:s.kind};
    let codecs=s.representation.codecs.as_ref().or(s.adaptation.codecs.as_ref()).cloned().unwrap_or_else(||"unknown".into());
    let mime_type=s.representation.mime_type.as_ref().or(s.adaptation.mime_type.as_ref()).cloned().unwrap_or_default();
    let subtitle=(s.kind==MediaKind::Subtitle).then(||{let roles=s.adaptation.roles.iter().filter_map(|d|d.value.clone()).collect::<Vec<_>>();let forced=roles.iter().any(|v|v.eq_ignore_ascii_case("forced-subtitle")||v.eq_ignore_ascii_case("forced"));let default_track=roles.iter().any(|v|v.eq_ignore_ascii_case("main"));SubtitleMetadata{language:s.adaptation.language.clone().unwrap_or_else(||"und".into()),label:s.adaptation.label.as_ref().map(|l|l.value.trim().to_string()).filter(|s|!s.is_empty()).unwrap_or_else(||s.adaptation.language.clone().unwrap_or_else(||s.representation.id.clone())),roles,accessibility:s.adaptation.accessibility.iter().filter_map(|d|d.value.clone()).collect(),selection_priority:s.adaptation.selection_priority,default_track,forced_track:forced}});
    Ok(RepresentationSnapshot{identity,base,template,index,mime_type,codecs,bandwidth:s.representation.bandwidth,width:s.representation.width.or(s.adaptation.width),height:s.representation.height.or(s.adaptation.height),frame_rate:s.representation.frame_rate.clone().or_else(||s.adaptation.frame_rate.clone()),audio_sampling_rate:s.representation.audio_sampling_rate.or(s.adaptation.audio_sampling_rate),subtitle})
}
fn descriptors(rep:&RepresentationSnapshot,dynamic:bool)->Result<Vec<SegmentDescriptor>,String>{
    if !dynamic&&rep.index.represented_segment_count()>MAX_STATIC_SEGMENTS{return Err("Unsupported DASH manifest shape: segment list too large".into())}
    let mut refs=Vec::new(); if let(Some(first),Some(last))=(rep.index.first_position(),rep.index.last_position()){for pos in first..=last{if let Some(r)=rep.index.get(pos).map_err(|_|"Unsupported DASH manifest shape")?{refs.push(r)}}}
    if dynamic{refs.pop();}
    refs.into_iter().map(|r|{let media=expand(rep.template.media.as_deref().unwrap(),&rep.identity.representation,Some(r.position),Some(r.media_time))?;Ok(SegmentDescriptor{identity:SegmentIdentity{representation:rep.identity.clone(),media_time:r.media_time},number:r.position,start:r.presentation_start,end:r.presentation_end,url:rep.base.join(&media).map_err(|_|"Segment fetch failed")?})}).collect()
}

fn representation_seek_bounds(rep: &RepresentationSnapshot, dynamic: bool) -> Result<(ExactTime, ExactTime), String> {
    let first = rep.index.first_position().ok_or("Unsupported DASH manifest shape: no media")?;
    let mut last = rep.index.last_position().ok_or("Unsupported DASH manifest shape: no media")?;
    if dynamic {
        last = last.checked_sub(1).ok_or("Unsupported DASH manifest shape: no complete segments")?;
    }
    let first = rep.index.get(first).map_err(|_| "Unsupported DASH manifest shape")?.ok_or("Unsupported DASH manifest shape: no media")?;
    let last = rep.index.get(last).map_err(|_| "Unsupported DASH manifest shape")?.ok_or("Unsupported DASH manifest shape: no complete segments")?;
    Ok((first.presentation_start, last.presentation_end))
}

fn descriptor_at(rep: &RepresentationSnapshot, dynamic: bool, target: ExactTime) -> Result<SegmentDescriptor, String> {
    let (start, end) = representation_seek_bounds(rep, dynamic)?;
    let target = target.max(start).min(end);
    let position = if target == end {
        rep.index.last_position().and_then(|position| if dynamic { position.checked_sub(1) } else { Some(position) })
    } else {
        rep.index.find(target).map_err(|_| "DASH seek lookup failed")?
    }.ok_or("DASH seek target has no media")?;
    let reference = rep.index.get(position).map_err(|_| "DASH seek lookup failed")?.ok_or("DASH seek target has no media")?;
    let media = expand(rep.template.media.as_deref().unwrap(), &rep.identity.representation, Some(reference.position), Some(reference.media_time))?;
    Ok(SegmentDescriptor {
        identity: SegmentIdentity { representation: rep.identity.clone(), media_time: reference.media_time },
        number: reference.position,
        start: reference.presentation_start,
        end: reference.presentation_end,
        url: rep.base.join(&media).map_err(|_| "Segment fetch failed")?,
    })
}

fn presentation_timeline(snapshot: &ManifestSnapshot, origin: ExactTime, current: ExactTime) -> Result<PresentationTimeline, String> {
    let (video_start, video_end) = representation_seek_bounds(&snapshot.video, snapshot.dynamic)?;
    let (audio_start, audio_end) = representation_seek_bounds(&snapshot.audio, snapshot.dynamic)?;
    let mut seek_range_start = video_start.max(audio_start);
    let seek_range_end = video_end.min(audio_end);
    if let Some(depth) = snapshot.time_shift_buffer_depth {
        let depth_start = seek_range_end.checked_sub(depth).map_err(|_| "DASH timeline overflow")?;
        seek_range_start = seek_range_start.max(depth_start);
    }
    if seek_range_end <= seek_range_start {
        return Err("Unsupported DASH manifest shape: empty seekable range".into());
    }
    Ok(PresentationTimeline {
        seek_range_start,
        seek_range_end,
        current_time: current,
        live_edge: seek_range_end,
        origin,
        is_live: snapshot.dynamic,
        generation: snapshot.generation,
    })
}
fn codec_family(codec:&str)->&str{codec.split('.').next().unwrap_or(codec).split(',').next().unwrap_or(codec)}
fn aligned_with(active:&RepresentationSnapshot,target:&RepresentationSnapshot,dynamic:bool)->bool{
    if codec_family(&active.codecs)!=codec_family(&target.codecs){return false}
    let Ok(a)=descriptors(active,dynamic)else{return false};let Ok(b)=descriptors(target,dynamic)else{return false};
    a.iter().any(|left|b.iter().any(|right|left.start==right.start&&left.end==right.end))
}
fn build_catalog(snapshot:&ManifestSnapshot)->DashTrackCatalog{
    let active_track=snapshot.video_tracks.iter().find(|t|t.adaptation_set_id==snapshot.video.identity.adaptation).unwrap_or(&snapshot.video_tracks[0]);
    let video_representations=active_track.representations.iter().map(|r|DashVideoRepresentation{representation_id:r.identity.representation.clone(),width:r.width,height:r.height,bandwidth:r.bandwidth,codec:r.codecs.clone(),frame_rate:r.frame_rate.clone(),label:match(r.width,r.height){(Some(w),Some(h))=>format!("{w}×{h}"),_=>r.identity.representation.clone()},compatible:aligned_with(&snapshot.video,r,snapshot.dynamic)}).collect();
    let audio_tracks=snapshot.audio_tracks.iter().map(|track|DashAudioTrack{adaptation_set_id:track.adaptation_set_id.clone(),mpv_track_id:track.mpv_track_id,language:track.language.clone(),label:track.label.clone(),role:track.roles.clone(),codec:track.selected.codecs.clone(),channels:track.channel_configuration.clone(),sample_rate:track.selected.audio_sampling_rate,representation_id:track.selected.identity.representation.clone()}).collect();
    DashTrackCatalog{active:true,video_adaptation_set_id:active_track.adaptation_set_id.clone(),selected_video_representation_id:snapshot.video.identity.representation.clone(),video_quality_mode:VideoQualityMode::Auto,pending_video_representation_id:None,abr_statistics:AbrStatistics{current_representation:snapshot.video.identity.representation.clone(),..AbrStatistics::default()},selected_audio_adaptation_set_id:snapshot.audio.identity.adaptation.clone(),video_representations,audio_tracks,subtitle_tracks:snapshot.subtitles.iter().map(|rep|rep.identity.adaptation.clone()).collect()}
}
fn merged_template(a:&Adaptation,r:&Representation)->Result<SegmentTemplate,String>{let p=a.template.clone().unwrap_or_default();let c=r.template.clone().unwrap_or_default();let x=SegmentTemplate{timescale:c.timescale.or(p.timescale),pto:c.pto.or(p.pto),start_number:c.start_number.or(p.start_number),initialization:c.initialization.or(p.initialization),media:c.media.or(p.media),timeline:c.timeline.or(p.timeline)};if x.initialization.is_none()||x.media.is_none()||x.timeline.is_none(){Err("Unsupported DASH manifest shape: SegmentTemplate/SegmentTimeline required".into())}else{Ok(x)}}
fn validate_cenc(s:&Selection<'_>)->Result<(),String>{for p in s.adaptation.protections.iter().chain(&s.representation.protections){if p.scheme.eq_ignore_ascii_case("urn:mpeg:dash:mp4protection:2011")&&p.value.as_deref().is_some_and(|v|!v.eq_ignore_ascii_case("cenc")){return Err("Unsupported DASH manifest shape: only CENC is supported".into())}}Ok(())}
fn expand(t:&str,id:&str,n:Option<u64>,time:Option<i128>)->Result<String,String>{let v=t.replace("$RepresentationID$",id).replace("$Number$",&n.map(|v|v.to_string()).unwrap_or_default()).replace("$Time$",&time.map(|v|v.to_string()).unwrap_or_default()).replace("$$","\0");if v.contains('$'){Err("Unsupported DASH manifest shape: unsupported URL template".into())}else{Ok(v.replace('\0',"$"))}}
fn inherit_base(mut base:Url,nodes:&[TextNode])->Result<Url,String>{if let Some(n)=nodes.first(){base=base.join(n.value.trim()).map_err(|_|"Unsupported DASH manifest shape: invalid BaseURL")?}Ok(base)}
fn parse_duration(value:&str)->Result<ExactTime,String>{
    fn decimal(value:&str)->Result<ExactTime,String>{
        if value.is_empty(){return Err("Unsupported DASH manifest shape: duration".into())}
        let mut parts=value.split('.');let whole=parts.next().unwrap();let fraction=parts.next();if parts.next().is_some()||whole.is_empty()||!whole.bytes().all(|b|b.is_ascii_digit()){return Err("Unsupported DASH manifest shape: duration".into())}
        let whole=whole.parse::<i128>().map_err(|_|"Unsupported DASH manifest shape: duration")?;
        if let Some(fraction)=fraction{if fraction.is_empty()||!fraction.bytes().all(|b|b.is_ascii_digit())||fraction.len()>18{return Err("Unsupported DASH manifest shape: duration".into())}let denominator=10u64.checked_pow(fraction.len()as u32).ok_or("Unsupported DASH manifest shape: duration")?;let numerator=whole.checked_mul(denominator as i128).and_then(|v|v.checked_add(fraction.parse::<i128>().ok()?)).ok_or("Unsupported DASH manifest shape: duration")?;ExactTime::new(numerator,denominator).map_err(|_|"Unsupported DASH manifest shape: duration".into())}else{ExactTime::new(whole,1).map_err(|_|"Unsupported DASH manifest shape: duration".into())}
    }
    let rest=value.strip_prefix('P').ok_or("Unsupported DASH manifest shape: duration")?;if rest.is_empty(){return Err("Unsupported DASH manifest shape: duration".into())}
    let mut total=ExactTime::new(0,1).unwrap();let mut number=String::new();let mut in_time=false;let mut saw_component=false;let mut last_rank=0u8;
    for ch in rest.chars(){
        if ch=='T'{if in_time||!number.is_empty(){return Err("Unsupported DASH manifest shape: duration".into())}in_time=true;last_rank=0;continue}
        if ch.is_ascii_digit()||ch=='.'{number.push(ch);continue}
        let(rank,multiplier)=match(ch,in_time){('D',false)=>(1,86_400),('H',true)=>(1,3_600),('M',true)=>(2,60),('S',true)=>(3,1),_=>return Err("Unsupported DASH manifest shape: duration".into())};
        if number.is_empty()||rank<=last_rank{return Err("Unsupported DASH manifest shape: duration".into())}last_rank=rank;saw_component=true;let component=decimal(&number)?;number.clear();let scaled=ExactTime::new(component.numerator().checked_mul(multiplier).ok_or("Unsupported DASH manifest shape: duration")?,component.denominator()).map_err(|_|"Unsupported DASH manifest shape: duration")?;total=total.checked_add(scaled).map_err(|_|"Unsupported DASH manifest shape: duration")?;
    }
    if !number.is_empty()||!saw_component{return Err("Unsupported DASH manifest shape: duration".into())}Ok(total)
}
fn parse_std_duration(v:&str)->Result<Duration,String>{let t=parse_duration(v)?;let micros=t.rescale(1_000_000,crate::dash_timeline::Rounding::Ceil).map_err(|_|"Unsupported DASH manifest shape: duration")?;Ok(Duration::from_micros(u64::try_from(micros).map_err(|_|"Unsupported DASH manifest shape: duration")?))}

struct LiveRuntime {
    client:reqwest::Client, manifest_url:Url, snapshot:ManifestSnapshot,
    index:SegmentIndex, kid:[u8;16], key:[u8;16], directory:PathBuf,
    video_inits:HashMap<String,Vec<u8>>, audio_inits:HashMap<String,Vec<u8>>, subtitle_inits:HashMap<String,Vec<u8>>,
    configs:HashMap<(u32,u32),Vec<u8>>, video_generations:HashMap<String,u32>, next_video_generation:u32, audio_generations:HashMap<String,u32>, next_audio_generation:u32,
    selection:SwitchSelection, stable_selection:SwitchSelection, switch_state:SwitchState, seen_cues:HashSet<String>, origin:ExactTime, frontier:ExactTime, batch:u64,
    abr:AbrController, switch_from_bandwidth:Option<u64>,
}

fn normalized_language(value: &str) -> String {
    let language = value.trim().to_ascii_lowercase().replace('_', "-");
    let base = language.split('-').next().unwrap_or(&language);
    match base {
        "eng" => "en", "spa" => "es", "fra" | "fre" => "fr", "deu" | "ger" => "de",
        "ita" => "it", "por" => "pt", "zho" | "chi" => "zh", "jpn" => "ja",
        "kor" => "ko", "rus" => "ru", "ara" => "ar", "hin" => "hi",
        _ => base,
    }.to_string()
}

fn preferred_subtitle_track(snapshot: &ManifestSnapshot, preferred: Option<&str>) -> Option<String> {
    let preferred = preferred.map(str::trim).filter(|value| !value.is_empty())?;
    if preferred.eq_ignore_ascii_case("off") || preferred.eq_ignore_ascii_case("none") {
        return None;
    }
    let preferred = normalized_language(preferred);
    let matching = snapshot.subtitles.iter().find(|rep| {
        rep.subtitle.as_ref().is_some_and(|metadata| normalized_language(&metadata.language) == preferred)
    });
    let fallback = snapshot.subtitles.iter().find(|rep| rep.subtitle.as_ref().is_some_and(|metadata| metadata.default_track))
        .or_else(|| (snapshot.subtitles.len() == 1).then(|| &snapshot.subtitles[0]));
    matching.or(fallback).map(|rep| rep.identity.adaptation.clone())
}

async fn build_live(url:&str,request_headers:&HashMap<String,String>,preferred_subtitle_language:Option<&str>,kid:[u8;16],key:[u8;16],cancel:&CancellationToken)->Result<(TempDir,String,bool,DashTrackCatalog,tokio::sync::watch::Sender<SwitchSelection>,tokio::sync::mpsc::Sender<SeekCommand>,PresentationTimeline),String>{
    let manifest_url=Url::parse(url).map_err(|_|"Manifest fetch failed: invalid URL")?;
    let mut headers=reqwest::header::HeaderMap::new();
    for(name,value)in request_headers{
        let name=reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_|"Manifest fetch failed: invalid header name")?;
        let value=reqwest::header::HeaderValue::from_str(value).map_err(|_|"Manifest fetch failed: invalid header value")?;
        headers.insert(name,value);
    }
    let client=reqwest::Client::builder().default_headers(headers).connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(20)).build().map_err(|_|"Manifest fetch failed")?;
    let(body,final_url)=fetch_final(&client,manifest_url.clone(),cancel,"Manifest fetch failed").await?;
    let snapshot=parse_snapshot(&body,final_url,1,None)?;log_snapshot(&snapshot);
    let catalog=build_catalog(&snapshot);
    let preferred_subtitle=preferred_subtitle_track(&snapshot,preferred_subtitle_language);
    log::info!("DASH startup subtitle selection: preference={} selected={}",preferred_subtitle_language.unwrap_or("off"),preferred_subtitle.as_deref().unwrap_or("off"));
    let selection=SwitchSelection{generation:0,video_representation:snapshot.video.identity.representation.clone(),video_quality_mode:VideoQualityMode::Auto,abr_reason:None,audio_track:snapshot.audio.identity.adaptation.clone(),subtitle_track:preferred_subtitle.clone()};
    let(switch_tx,switch_rx)=tokio::sync::watch::channel(selection.clone());
    let(seek_tx,seek_rx)=tokio::sync::mpsc::channel(8);
    let mut index=SegmentIndex::default();let stats=index.merge(&snapshot)?;log_merge(&snapshot,&stats);
    let video_segments=initial_segments(&snapshot.video,snapshot.dynamic)?;
    let audio_segments=snapshot.audio_tracks.iter().map(|track|if track.adaptation_set_id==snapshot.audio.identity.adaptation{initial_segments(&track.selected,snapshot.dynamic).map(|segments|(track.clone(),segments))}else{Ok((track.clone(),Vec::new()))}).collect::<Result<Vec<_>,_>>()?;
    let subtitle_segments=snapshot.subtitles.iter().map(|rep|if preferred_subtitle.as_deref()==Some(rep.identity.adaptation.as_str()){initial_segments(rep,snapshot.dynamic)}else{Ok(Vec::new())}).collect::<Result<Vec<_>,_>>()?;
    let startup_origin=subtitle_segments.iter().flatten().chain(audio_segments.iter().flat_map(|(_,s)|s)).fold(video_segments[0].start,|o,s|o.min(s.start));
    let dir=tempfile::Builder::new().prefix("ynotv-native-dash-").tempdir().map_err(|_|"Native DASH temporary storage failed")?;
    // Some IPTV origins cap per-client concurrency very aggressively. Init
    // objects are small and needed only once, so fetch them serially instead of
    // opening video + every audio + every subtitle request simultaneously.
    let video_init=fetch_init(&client,&snapshot.video,cancel).await?;
    let mut audio_init_pairs=Vec::with_capacity(snapshot.audio_tracks.len());
    for track in &snapshot.audio_tracks { audio_init_pairs.push((track.adaptation_set_id.clone(),fetch_init(&client,&track.selected,cancel).await?)); }
    let mut subtitle_init_pairs=Vec::with_capacity(snapshot.subtitles.len());
    for rep in &snapshot.subtitles { subtitle_init_pairs.push((rep.identity.adaptation.clone(),fetch_init(&client,rep,cancel).await?)); }
    let mut video_inits=HashMap::new();video_inits.insert(snapshot.video.identity.representation.clone(),video_init);
    let audio_inits=audio_init_pairs.into_iter().collect();
    let subtitle_inits=subtitle_init_pairs.into_iter().collect();
    let frontier=video_segments.last().unwrap().end;
    let mut timeline=presentation_timeline(&snapshot,startup_origin,frontier)?;
    // Keep every DVR target non-negative on mpv's player timeline.  The DASH
    // presentation timestamps remain absolute in Rust/UI state.
    let origin=timeline.seek_range_start;
    timeline.origin=origin;
    let timeline_state=timeline.state();
    log::info!("DASH DVR: seek_start={:.3} seek_end={:.3} live_edge={:.3} window={:.3}s",timeline_state.seek_range_start,timeline_state.seek_range_end,timeline_state.live_edge,timeline_state.window_duration);
    let mut generations=HashMap::new();generations.insert(snapshot.video.identity.representation.clone(),1);
    let audio_generations=snapshot.audio_tracks.iter().map(|track|(track.adaptation_set_id.clone(),1)).collect();
    let abr=AbrController::new(AbrPolicy::default(),VideoQualityMode::Auto,snapshot.video.identity.representation.clone());
    let mut runtime=LiveRuntime{client,manifest_url,snapshot,index,kid,key,directory:dir.path().to_path_buf(),video_inits,audio_inits,subtitle_inits,configs:HashMap::new(),video_generations:generations,next_video_generation:2,audio_generations,next_audio_generation:2,stable_selection:selection.clone(),selection,switch_state:SwitchState::Stable,seen_cues:HashSet::new(),origin,frontier,batch:0,abr,switch_from_bandwidth:None};
    let first=runtime.make_batch(&video_segments,&audio_segments,&subtitle_segments,cancel).await?;
    runtime.commit_batch(&video_segments,&audio_segments,&subtitle_segments);
    let listener=TcpListener::bind("127.0.0.1:0").await.map_err(|_|"Native DASH packet bridge failed")?;
    let address=listener.local_addr().map_err(|_|"Native DASH packet bridge failed")?;
    let dynamic=runtime.snapshot.dynamic;let token=cancel.clone();
    let abr_switch_tx=switch_tx.clone();tokio::spawn(async move{if let Err(error)=serve_live(listener,runtime,first,abr_switch_tx,switch_rx,seek_rx,token.clone()).await{if !token.is_cancelled(){log::error!("[native-dash] live session failed: {}",error);}}});
    Ok((dir,format!("http://{address}/native-dash.rdp"),dynamic,catalog,switch_tx,seek_tx,timeline))
}
fn initial_segments(rep:&RepresentationSnapshot,dynamic:bool)->Result<Vec<SegmentDescriptor>,String>{
    let mut segments=descriptors(rep,dynamic)?;
    if dynamic{
        let start=segments.len().saturating_sub(DYNAMIC_STARTUP_LAG_SEGMENTS+1);
        segments.drain(..start);
        segments.truncate(1);
    }
    if !dynamic&&segments.len()>1{segments.truncate(1);}
    if segments.is_empty(){return Err("Unsupported DASH manifest shape: no complete segments".into())}
    Ok(segments)
}
fn inferred_update_period(rep:&RepresentationSnapshot)->Duration{
    let segment_duration=rep.index.last_position().and_then(|last|rep.index.first_position().map(|first|if last>first{last-1}else{last})).and_then(|position|rep.index.get(position).ok().flatten()).and_then(|segment|segment.presentation_end.checked_sub(segment.presentation_start).ok()).and_then(|duration|duration.rescale(1_000_000,crate::dash_timeline::Rounding::Ceil).ok()).and_then(|micros|u64::try_from(micros).ok()).filter(|micros|*micros>0).map(Duration::from_micros);
    segment_duration.map(|duration|duration.div_f64(2.0).clamp(MIN_MUP,MAX_INFERRED_MUP)).unwrap_or(FALLBACK_MUP)
}
async fn fetch_init(client:&reqwest::Client,rep:&RepresentationSnapshot,cancel:&CancellationToken)->Result<Vec<u8>,String>{
    let init=expand(rep.template.initialization.as_deref().unwrap(),&rep.identity.representation,None,None)?;
    fetch(client,rep.base.join(&init).map_err(|_|"Segment fetch failed")?,cancel,"Segment fetch failed").await
}
struct ComponentDownload { kind:MediaKind, metrics:Vec<DownloadMeasurement> }
async fn download_component(client:&reqwest::Client,init:&[u8],segments:&[SegmentDescriptor],path:&Path,cancel:&CancellationToken,kind:MediaKind)->Result<ComponentDownload,(MediaKind,String)>{
    let mut bytes=init.to_vec();
    let mut metrics=Vec::new();
    for segment in segments{
        if kind==MediaKind::Video {
            let(data,measurement)=fetch_media_segment(client,segment.url.clone(),cancel,&segment.identity.representation.representation).await.map_err(|e|(kind,e))?;
            bytes.extend(data);metrics.push(measurement);
        }else{
            bytes.extend(fetch(client,segment.url.clone(),cancel,"Segment fetch failed").await.map_err(|e|(kind,e))?);
        }
    }
    fs::write(path,bytes).await.map_err(|_|(kind,"Segment fetch failed: temporary write".into()))?;
    Ok(ComponentDownload{kind,metrics})
}
async fn download_component_owned(client:reqwest::Client,init:Vec<u8>,segments:Vec<SegmentDescriptor>,path:PathBuf,cancel:CancellationToken,kind:MediaKind)->Result<ComponentDownload,(MediaKind,String)>{download_component(&client,&init,&segments,&path,&cancel,kind).await}

impl LiveRuntime {
    async fn prepare_seek(&mut self, command: SeekCommand, socket: &mut TcpStream, cancel: &CancellationToken) {
        let epoch = command.epoch;
        let requested_target = command.target;
        let mut completion = Some(command.completion);
        let result = async {
            let timeline = presentation_timeline(&self.snapshot, self.origin, self.frontier)?;
            let requested = ExactTime::new((requested_target * 1_000_000.0).round() as i128, 1_000_000).map_err(|_| "Invalid DASH seek target")?;
            let target = requested.max(timeline.seek_range_start).min(timeline.seek_range_end);
            let video = descriptor_at(&self.snapshot.video, self.snapshot.dynamic, target)?;
            log::info!("DASH seek preparing: epoch={} requested={:.3} clamped={:.3} video_segment={}",epoch,requested_target,seconds(target),video.number);
            let audio_track = self.snapshot.audio_tracks.iter().find(|track| track.adaptation_set_id == self.selection.audio_track).cloned().ok_or("DASH selected audio track disappeared")?;
            let audio = descriptor_at(&audio_track.selected, self.snapshot.dynamic, target)?;
            let subtitles = self.snapshot.subtitles.iter().map(|rep| {
                if self.selection.subtitle_track.as_deref() == Some(rep.identity.adaptation.as_str()) {
                    descriptor_at(rep, self.snapshot.dynamic, target).map(|segment| vec![segment])
                } else { Ok(Vec::new()) }
            }).collect::<Result<Vec<_>, String>>()?;
            for record in self.index.records.values_mut() {
                if record.advertised { record.state = SegmentState::Known; }
            }
            self.index.fetched.clear();
            self.index.demuxed.clear();
            self.seen_cues.clear();
            self.frontier = video.start;
            self.abr.on_seek();
            let videos = vec![video.clone()];
            let audios = vec![(audio_track, vec![audio])];
            let batch = self.make_batch(&videos, &audios, &subtitles, cancel).await?;
            log::info!("DASH seek batch ready: epoch={} bytes={}",epoch,batch.records.len());
            let relative = target.checked_sub(self.origin).map_err(|_| "DASH timestamp overflow")?;
            let target_ms = relative.rescale(1000, crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_| "DASH timestamp overflow")?;
            let marker = seek_epoch_marker(
                epoch,
                i64::try_from(target_ms).map_err(|_| "DASH timestamp overflow")?,
            );
            write_live(socket, &marker, cancel).await?;

            // Complete the prepare phase as soon as demux_rustdash can observe
            // the seek epoch.  The caller must now submit mpv's seek command,
            // which flushes the old decoder/cache state and releases the
            // adapter's seek gate.  Waiting for the complete target batch here
            // deadlocks on real multi-megabyte segments: the adapter deliberately
            // stops consuming while seek_ready is set, the socket fills, and the
            // caller never gets a chance to issue that mpv command.
            if let Some(completion) = completion.take() {
                let _ = completion.send(Ok(seconds(relative)));
            }
            log::info!("DASH seek epoch announced: epoch={} target_relative={:.3}",epoch,seconds(relative));

            // It is safe for this write to apply backpressure now.  request_seek
            // has already returned, so mpv can commit the epoch concurrently and
            // unblock the adapter while the target packets arrive.
            write_live(socket, &batch.wire_records(), cancel).await?;
            log::info!("DASH seek batch written: epoch={} bytes={}",epoch,batch.records.len());
            self.commit_batch(&videos, &audios, &subtitles);
            if let Some(active_timeline) = ACTIVE.lock().timeline.as_mut() {
                active_timeline.current_time = target;
            }
            log::info!("DASH video seek: rep={} segment={} segment_start={:.3} RAP=segment-start",video.identity.representation.representation,video.number,seconds(video.start));
            log::info!("DASH seek committed: requested={:.3} actual={:.3} delta={:.3}",requested_target,seconds(target),requested_target-seconds(target));
            Ok(())
        }.await;
        if let Err(error)=&result{log::warn!("DASH seek failed: epoch={} error={}",epoch,error);}
        if let Err(error) = result {
            // If preparation failed before the epoch was announced, wake the
            // command caller with the actual error.  After announcement the
            // receiver is already gone; a write failure is still logged and the
            // surrounding session cancellation/reconnect path owns recovery.
            if let Some(completion) = completion.take() {
                let _ = completion.send(Err(error));
            }
        }
    }
    async fn apply_selection(&mut self,selection:SwitchSelection,cancel:&CancellationToken)->Result<(),String>{
        self.switch_state=SwitchState::TargetPreparing;log::info!("DASH track switch state=TargetPreparing generation={}",selection.generation);
        self.abr.set_mode(selection.video_quality_mode.clone());
        if selection.video_representation!=self.selection.video_representation{
            let track=self.snapshot.video_tracks.iter().find(|track|track.adaptation_set_id==self.snapshot.video.identity.adaptation).ok_or("DASH logical video track disappeared")?;
            let target=track.representations.iter().find(|rep|rep.identity.representation==selection.video_representation).cloned().ok_or("DASH video representation disappeared")?;
            if !aligned_with(&self.snapshot.video,&target,self.snapshot.dynamic){return Err("Unsupported DASH representation switch: no aligned random-access segment boundary".into())}
            if !self.video_inits.contains_key(&selection.video_representation){let init=fetch_init(&self.client,&target,cancel).await?;self.video_inits.insert(selection.video_representation.clone(),init);let generation=self.next_video_generation;self.next_video_generation+=1;self.video_generations.insert(selection.video_representation.clone(),generation);}
            self.switch_from_bandwidth=Some(self.snapshot.video.bandwidth);log::info!("DASH {} video switch: {} -> {} boundary={}/{} generation={}",if selection.abr_reason.is_some(){"ABR"}else{"manual"},self.snapshot.video.identity.representation,selection.video_representation,self.frontier.numerator(),self.frontier.denominator(),self.video_generations[&selection.video_representation]);self.snapshot.video=target;
        }
        if selection.audio_track!=self.selection.audio_track{
            let target=self.snapshot.audio_tracks.iter().find(|track|track.adaptation_set_id==selection.audio_track).ok_or("DASH audio track disappeared")?;
            log::info!("DASH audio switch: {} -> {}",self.snapshot.audio.identity.adaptation,target.adaptation_set_id);self.snapshot.audio=target.selected.clone();
        }
        if selection.subtitle_track!=self.selection.subtitle_track{log::info!("DASH subtitle switch: {:?} -> {:?}",self.selection.subtitle_track,selection.subtitle_track);}
        self.selection=selection;self.switch_state=SwitchState::WaitingForBoundary;log::info!("DASH track switch state=WaitingForBoundary generation={}",self.selection.generation);Ok(())
    }
    fn next_video_segment(&self)->Option<SegmentDescriptor>{self.index.records.values().filter(|r|r.advertised&&r.state==SegmentState::Known&&r.descriptor.identity.representation==self.snapshot.video.identity&&r.descriptor.start==self.frontier).min_by_key(|r|r.descriptor.start).map(|r|r.descriptor.clone())}
    fn next_overlapping(&self,identity:&RepresentationIdentity,start:ExactTime,end:ExactTime)->Option<SegmentDescriptor>{self.index.records.values().filter(|r|r.advertised&&r.state==SegmentState::Known&&r.descriptor.identity.representation==*identity&&r.descriptor.start<end&&start<r.descriptor.end).min_by_key(|r|r.descriptor.start).map(|r|r.descriptor.clone())}
    fn demuxed_overlaps(&self,identity:&RepresentationIdentity,start:ExactTime,end:ExactTime)->bool{self.index.records.values().any(|r|r.state==SegmentState::Demuxed&&r.descriptor.identity.representation==*identity&&r.descriptor.start<end&&start<r.descriptor.end)}
    fn abr_ladder(&self)->Vec<AbrRepresentation>{
        self.snapshot.video_tracks.iter().find(|track|track.adaptation_set_id==self.snapshot.video.identity.adaptation).into_iter().flat_map(|track|track.representations.iter()).filter(|rep|aligned_with(&self.snapshot.video,rep,self.snapshot.dynamic)).map(|rep|AbrRepresentation{id:rep.identity.representation.clone(),bandwidth:rep.bandwidth}).collect()
    }
    fn sync_catalog(&self,pending:Option<String>){
        let mut active=ACTIVE.lock();if let Some(catalog)=active.catalog.as_mut(){catalog.selected_video_representation_id=self.snapshot.video.identity.representation.clone();catalog.video_quality_mode=self.selection.video_quality_mode.clone();catalog.pending_video_representation_id=pending;catalog.abr_statistics=self.abr.statistics();catalog.selected_audio_adaptation_set_id=self.selection.audio_track.clone();}
    }
    async fn make_batch(&mut self,video:&[SegmentDescriptor],audio:&[(LogicalAudioTrack,Vec<SegmentDescriptor>)],subtitles:&[Vec<SegmentDescriptor>],cancel:&CancellationToken)->Result<RdpBatch,String>{
        for segment in video.iter().chain(audio.iter().flat_map(|(_,s)|s)).chain(subtitles.iter().flatten()){self.index.mark(&segment.identity,SegmentState::Scheduled);self.index.mark(&segment.identity,SegmentState::Fetching);}
        self.batch+=1;let vp=self.directory.join(format!("video-{}.mp4",self.batch));let ap=self.directory.join(format!("audio-{}.mp4",self.batch));let out=self.directory.join(format!("packets-{}.rdp",self.batch));
        let video_rep=video.first().ok_or("DASH video switch has no aligned segment")?.identity.representation.representation.clone();
        let video_init=self.video_inits.get(&video_rep).ok_or("DASH video init unavailable")?;
        let mut component_paths=vec![vp.clone()];let mut mappings=vec![(1,self.video_generations[&video_rep],MediaKind::Video,TrackMetadata::default())];let mut downloads=vec![download_component_owned(self.client.clone(),video_init.clone(),video.to_vec(),vp,cancel.clone(),MediaKind::Video)];
        for(n,(track,segments))in audio.iter().enumerate(){let path=if n==0{ap.clone()}else{self.directory.join(format!("audio-{n}-{}.mp4",self.batch))};let init=self.audio_inits.get(&track.adaptation_set_id).ok_or("DASH audio init unavailable")?;downloads.push(download_component_owned(self.client.clone(),init.clone(),segments.clone(),path.clone(),cancel.clone(),MediaKind::Audio));component_paths.push(path);mappings.push((1+track.mpv_track_id as u32,self.audio_generations[&track.adaptation_set_id],MediaKind::Audio,TrackMetadata{language:track.language.clone(),title:audio_title(track),default_track:track.adaptation_set_id==self.selection.audio_track,forced_track:false}))}
        let subtitle_track_base=2+self.snapshot.audio_tracks.len()as u32;
        for(n,segments)in subtitles.iter().enumerate(){let p=self.directory.join(format!("subtitle-{n}-{}.mp4",self.batch));let rep=&self.snapshot.subtitles[n];downloads.push(download_component_owned(self.client.clone(),self.subtitle_inits.get(&rep.identity.adaptation).ok_or("DASH subtitle init unavailable")?.clone(),segments.clone(),p.clone(),cancel.clone(),MediaKind::Subtitle));component_paths.push(p);let meta=rep.subtitle.as_ref().unwrap();let selected=self.selection.subtitle_track.as_deref()==Some(rep.identity.adaptation.as_str());let default_track=if self.selection.subtitle_track.is_some(){selected}else{meta.default_track};mappings.push((subtitle_track_base+n as u32,1,MediaKind::Subtitle,TrackMetadata{language:meta.language.clone(),title:meta.label.clone(),default_track,forced_track:meta.forced_track}))}
        // Keep origin concurrency bounded. Several IPTV CDNs reject a third
        // simultaneous media request with 403/429; two slots cover A/V, while
        // the selected subtitle waits for the next available slot.
        let downloads=match stream::iter(downloads).buffer_unordered(2).try_collect::<Vec<_>>().await{Ok(value)=>value,Err((kind,error))=>{if kind==MediaKind::Video&&error!="Native DASH session cancelled"{self.abr.observe_failed_download();}return Err(error)}};
        let download_metrics=downloads.into_iter().filter(|download|download.kind==MediaKind::Video).flat_map(|download|download.metrics).collect::<Vec<_>>();
        for measurement in download_metrics{
            let representation=measurement.representation_id.clone();let bytes=measurement.bytes;let duration=measurement.request_end.saturating_duration_since(measurement.request_start);let ttfb=measurement.first_byte_time.map(|at|at.saturating_duration_since(measurement.request_start));let transfer=measurement.first_byte_time.map(|at|measurement.request_end.saturating_duration_since(at));
            if self.abr.observe_download(measurement){log::info!("ABR sample: rep={} bytes={} request_duration={:.3}s ttfb={} transfer_duration={} request_throughput={:.3}Mbps transfer_throughput={}",representation,bytes,duration.as_secs_f64(),ttfb.map(|v|format!("{:.3}s",v.as_secs_f64())).unwrap_or_else(||"unknown".into()),transfer.map(|v|format!("{:.3}s",v.as_secs_f64())).unwrap_or_else(||"unknown".into()),bytes as f64*8.0/duration.as_secs_f64()/1_000_000.0,transfer.filter(|v|!v.is_zero()).map(|v|format!("{:.3}Mbps",bytes as f64*8.0/v.as_secs_f64()/1_000_000.0)).unwrap_or_else(||"unknown".into()));}
        }
        for segment in video.iter().chain(audio.iter().flat_map(|(_,s)|s)).chain(subtitles.iter().flatten()){if self.index.fetched.contains(&segment.identity){return Err("Duplicate DASH segment fetch prevented".into())}}
        run_packet_producer(&component_paths,audio.len(),&out,self.kid,self.key,cancel).await?;let bytes=fs::read(out).await.map_err(|_|"Native DASH packet output failed")?;let mut batch=RdpBatch::parse(&bytes)?;batch.remap(&mappings)?;if !batch.first_packet_is_keyframe(1)?{return Err("Unsupported DASH representation switch: target segment does not begin with a random access packet".into())}let bases=subtitles.iter().enumerate().filter_map(|(n,s)|s.first().map(|first|(subtitle_track_base+n as u32,first.identity.media_time,self.snapshot.subtitles[n].template.timescale.unwrap_or(1)))).collect::<Vec<_>>();batch.bridge_ttml(&bases,&mut self.seen_cues)?;
        let first_batch=self.configs.is_empty();for config in &batch.configs{let key=(u32_at(config,0)?,u32_at(config,4)?);if let Some(old)=self.configs.get(&key){if old!=config{return Err("Unsupported native DASH codec/init generation mutation".into())}}else{self.configs.insert(key,config.clone());if !first_batch{batch.config_updates.push(config.clone())}}}
        batch.offset(1,video[0].start.checked_sub(self.origin).map_err(|_|"DASH timestamp overflow")?)?;
        for(track,segments)in audio{if let Some(first)=segments.first(){batch.offset(1+track.mpv_track_id as u32,first.start.checked_sub(self.origin).map_err(|_|"DASH timestamp overflow")?)?}}
        for(n,segments)in subtitles.iter().enumerate(){if let Some(first)=segments.first(){batch.offset(subtitle_track_base+n as u32,first.start.checked_sub(self.origin).map_err(|_|"DASH timestamp overflow")?)?}}
        Ok(batch)
    }
    fn reset_batch(&mut self,video:&[SegmentDescriptor],audio:&[(LogicalAudioTrack,Vec<SegmentDescriptor>)],subtitles:&[Vec<SegmentDescriptor>]){for segment in video.iter().chain(audio.iter().flat_map(|(_,s)|s)).chain(subtitles.iter().flatten()){if let Some(record)=self.index.records.get_mut(&segment.identity){if matches!(record.state,SegmentState::Scheduled|SegmentState::Fetching){record.state=SegmentState::Known}}}}
    fn rollback_configs(&mut self,batch:&RdpBatch){for config in &batch.config_updates{if let(Ok(track),Ok(generation))=(u32_at(config,0),u32_at(config,4)){self.configs.remove(&(track,generation));}}}
    fn commit_batch(&mut self,video:&[SegmentDescriptor],audio:&[(LogicalAudioTrack,Vec<SegmentDescriptor>)],subtitles:&[Vec<SegmentDescriptor>]){for segment in video.iter().chain(audio.iter().flat_map(|(_,s)|s)).chain(subtitles.iter().flatten()){self.index.mark(&segment.identity,SegmentState::Fetched);self.index.mark(&segment.identity,SegmentState::Demuxed);log::info!("DASH segment committed kind={:?} representation={} media_time={}",segment.identity.representation.kind,segment.identity.representation.representation,segment.identity.media_time);}self.frontier=video.last().unwrap().end;}
    async fn reject_switch(&mut self,generation:u64,cancel:&CancellationToken)->Result<(),String>{let mut rollback=self.stable_selection.clone();rollback.generation=generation;self.apply_selection(rollback,cancel).await?;self.stable_selection=self.selection.clone();self.switch_state=SwitchState::Stable;let mut active=ACTIVE.lock();if let Some(catalog)=active.catalog.as_mut(){catalog.selected_video_representation_id=self.selection.video_representation.clone();catalog.selected_audio_adaptation_set_id=self.selection.audio_track.clone();}Ok(())}
    async fn refresh(&mut self,cancel:&CancellationToken)->Result<(),String>{
        let(body,final_url)=fetch_final(&self.client,self.manifest_url.clone(),cancel,"Manifest refresh failed").await?;
        let mut candidate=parse_snapshot(&body,final_url,self.snapshot.generation+1,Some(&self.selection))?;
        let mut next_audio_id=self.snapshot.audio_tracks.iter().map(|track|track.mpv_track_id).max().unwrap_or(0)+1;
        for track in &mut candidate.audio_tracks{if let Some(old)=self.snapshot.audio_tracks.iter().find(|old|old.adaptation_set_id==track.adaptation_set_id){track.mpv_track_id=old.mpv_track_id}else{track.mpv_track_id=next_audio_id;next_audio_id+=1}}
        if candidate.video.identity.representation!=self.selection.video_representation{log::warn!("DASH selected video representation disappeared; fallback {} -> {}",self.selection.video_representation,candidate.video.identity.representation);self.selection.video_representation=candidate.video.identity.representation.clone();if matches!(self.selection.video_quality_mode,VideoQualityMode::Manual(_)){self.selection.video_quality_mode=VideoQualityMode::Manual(candidate.video.identity.representation.clone())}self.selection.abr_reason=None;self.abr.set_mode(self.selection.video_quality_mode.clone());self.abr.note_current_representation(&candidate.video.identity.representation);self.stable_selection=self.selection.clone();if let Some(tx)=ACTIVE.lock().switch_tx.as_ref().cloned(){let replacement=self.selection.clone();tx.send_modify(|current|*current=replacement.clone());}}
        if candidate.audio.identity.adaptation!=self.selection.audio_track{log::warn!("DASH selected audio AdaptationSet disappeared; fallback {} -> {}",self.selection.audio_track,candidate.audio.identity.adaptation);self.selection.audio_track=candidate.audio.identity.adaptation.clone();}
        let video_config_changed=self.snapshot.video.identity==candidate.video.identity&&(self.snapshot.video.template.initialization!=candidate.video.template.initialization||self.snapshot.video.codecs!=candidate.video.codecs||self.snapshot.video.mime_type!=candidate.video.mime_type||self.snapshot.video.width!=candidate.video.width||self.snapshot.video.height!=candidate.video.height);
        if video_config_changed||!self.video_inits.contains_key(&candidate.video.identity.representation){let init=fetch_init(&self.client,&candidate.video,cancel).await?;self.video_inits.insert(candidate.video.identity.representation.clone(),init);let generation=self.next_video_generation;self.next_video_generation+=1;self.video_generations.insert(candidate.video.identity.representation.clone(),generation);}
        for track in &candidate.audio_tracks{let changed=self.snapshot.audio_tracks.iter().find(|old|old.adaptation_set_id==track.adaptation_set_id).is_some_and(|old|old.selected.template.initialization!=track.selected.template.initialization||old.selected.codecs!=track.selected.codecs||old.selected.audio_sampling_rate!=track.selected.audio_sampling_rate);if changed||!self.audio_inits.contains_key(&track.adaptation_set_id){self.audio_inits.insert(track.adaptation_set_id.clone(),fetch_init(&self.client,&track.selected,cancel).await?);self.audio_generations.insert(track.adaptation_set_id.clone(),self.next_audio_generation);self.next_audio_generation+=1;}}
        let stats=self.index.merge(&candidate)?;if stats.added==0{log::info!("native DASH refresh produced no newer media");}log_snapshot(&candidate);log_merge(&candidate,&stats);self.snapshot=candidate;let mut catalog=build_catalog(&self.snapshot);catalog.video_quality_mode=self.selection.video_quality_mode.clone();catalog.abr_statistics=self.abr.statistics();let mut active=ACTIVE.lock();catalog.selected_audio_adaptation_set_id=self.selection.audio_track.clone();active.catalog=Some(catalog);if let Some(old)=active.timeline.as_ref(){let timeline=presentation_timeline(&self.snapshot,self.origin,old.current_time)?;let state=timeline.state();log::info!("DASH DVR: seek_start={:.3} seek_end={:.3} live_edge={:.3} window={:.3}s",state.seek_range_start,state.seek_range_end,state.live_edge,state.window_duration);active.timeline=Some(timeline);}Ok(())
    }
}
fn audio_title(track:&LogicalAudioTrack)->String{let mut parts=vec![track.label.clone()];for role in &track.roles{if !role.eq_ignore_ascii_case("main")&&!parts.iter().any(|p|p.eq_ignore_ascii_case(role)){parts.push(role.clone())}}if let Some(ch)=&track.channel_configuration{if !parts.iter().any(|p|p==ch){parts.push(ch.clone())}}parts.join(" - ")}

async fn serve_live(listener:TcpListener,mut runtime:LiveRuntime,first:RdpBatch,switch_tx:tokio::sync::watch::Sender<SwitchSelection>,mut switches:tokio::sync::watch::Receiver<SwitchSelection>,mut seeks:tokio::sync::mpsc::Receiver<SeekCommand>,cancel:CancellationToken)->Result<(),String>{
    let(mut socket,_)=tokio::select!{_=cancel.cancelled()=>return Ok(()),x=listener.accept()=>x.map_err(|_|"Native DASH packet bridge failed")?};
    let mut request=[0u8;2048];tokio::select!{_=cancel.cancelled()=>return Ok(()),x=socket.read(&mut request)=>x.map_err(|_|"Native DASH packet bridge failed")?};
    write_live(&mut socket,b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",&cancel).await?;
    write_live(&mut socket,&first.header(),&cancel).await?;write_live(&mut socket,&first.wire_records(),&cancel).await?;
    loop{
        if let Ok(mut seek)=seeks.try_recv(){while let Ok(newer)=seeks.try_recv(){let _=seek.completion.send(Err("DASH seek superseded by newer request".into()));seek=newer;}runtime.prepare_seek(seek,&mut socket,&cancel).await;continue}
        let latest=switches.borrow().clone();if latest.generation!=runtime.selection.generation{runtime.switch_state=SwitchState::SwitchRequested;log::info!("DASH track switch state=SwitchRequested generation={}",latest.generation);if let Err(error)=runtime.apply_selection(latest.clone(),&cancel).await{if latest.abr_reason.is_some(){log::info!("ABR stale proposal discarded target={} reason={}",latest.video_representation,error);runtime.selection.generation=latest.generation;runtime.switch_state=SwitchState::Stable;runtime.sync_catalog(None);continue}return Err(error)}}
        runtime.abr.observe_buffer(buffered_seconds());if runtime.switch_state==SwitchState::Stable{let ladder=runtime.abr_ladder();let current=runtime.snapshot.video.identity.representation.clone();if let Some(evaluation)=runtime.abr.evaluate(Instant::now(),&current,&ladder,None){log_abr_evaluation(&evaluation);match evaluation.decision{AbrDecision::Switch{target_id,reason,emergency:_}=>{switch_video_representation(&switch_tx,&target_id,VideoQualityMode::Auto,Some(reason));runtime.sync_catalog(Some(target_id));continue},AbrDecision::Hold(_)=>{}}}else{log::debug!("ABR evaluate current={} decision=hold reason=current_not_in_catalog",current)}}
        if runtime.snapshot.dynamic&&runtime.next_video_segment().is_none(){let deadline=runtime.snapshot.published_at+runtime.snapshot.minimum_update_period;let now=Instant::now();if deadline>now{tokio::select!{_=cancel.cancelled()=>return Ok(()),changed=switches.changed()=>{if changed.is_err(){return Ok(())}continue},seek=seeks.recv()=>{if let Some(mut seek)=seek{while let Ok(newer)=seeks.try_recv(){let _=seek.completion.send(Err("DASH seek superseded by newer request".into()));seek=newer;}runtime.prepare_seek(seek,&mut socket,&cancel).await;}continue},_=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>{}}}match runtime.refresh(&cancel).await{Ok(())=>{},Err(e)if e=="Native DASH session cancelled"=>return Ok(()),Err(e)=>{log::warn!("[native-dash] refresh failed; retaining snapshot: {}",e);tokio::select!{_=cancel.cancelled()=>return Ok(()),seek=seeks.recv()=>{if let Some(mut seek)=seek{while let Ok(newer)=seeks.try_recv(){let _=seek.completion.send(Err("DASH seek superseded by newer request".into()));seek=newer;}runtime.prepare_seek(seek,&mut socket,&cancel).await;}},_=tokio::time::sleep(Duration::from_secs(1))=>{}};continue}}}
        let Some(video)=runtime.next_video_segment()else{if runtime.snapshot.dynamic{log::info!("DASH waiting for newer media");continue}else{write_live(&mut socket,&0x31464f45u32.to_le_bytes(),&cancel).await?;return Ok(())}};
        let audio_track=runtime.snapshot.audio_tracks.iter().find(|track|track.adaptation_set_id==runtime.selection.audio_track).cloned().ok_or("DASH selected audio track disappeared")?;let audio_segments=if let Some(audio)=runtime.next_overlapping(&audio_track.selected.identity,video.start,video.end){vec![audio]}else{if runtime.demuxed_overlaps(&audio_track.selected.identity,video.start,video.end){log::debug!("DASH audio segment already covers video interval; no duplicate scheduling")}else{log::info!("DASH audio not yet available for video interval; continuing without premature EOF")}Vec::new()};
        let subtitles=runtime.snapshot.subtitles.iter().map(|rep|if runtime.selection.subtitle_track.as_deref()==Some(rep.identity.adaptation.as_str()){runtime.next_overlapping(&rep.identity,video.start,video.end).map(|s|vec![s]).unwrap_or_default()}else{Vec::new()}).collect::<Vec<_>>();let audios=vec![(audio_track,audio_segments)];let videos=vec![video];let selection_generation=runtime.selection.generation;let batch_cancel=cancel.child_token();
        enum BuildOutcome{Cancelled,Changed(bool),Seek(SeekCommand),Built(Result<RdpBatch,String>)}
        let outcome={let mut build=Box::pin(runtime.make_batch(&videos,&audios,&subtitles,&batch_cancel));tokio::select!{_=cancel.cancelled()=>BuildOutcome::Cancelled,changed=switches.changed()=>{batch_cancel.cancel();BuildOutcome::Changed(changed.is_ok())},seek=seeks.recv()=>{batch_cancel.cancel();match seek{Some(seek)=>BuildOutcome::Seek(seek),None=>BuildOutcome::Cancelled}},result=&mut build=>BuildOutcome::Built(result)}};
        let batch=match outcome{BuildOutcome::Cancelled=>return Ok(()),BuildOutcome::Changed(false)=>{runtime.reset_batch(&videos,&audios,&subtitles);return Ok(())},BuildOutcome::Changed(true)=>{runtime.reset_batch(&videos,&audios,&subtitles);log::info!("DASH switch generation {} superseded during target preparation",selection_generation);continue},BuildOutcome::Seek(mut seek)=>{runtime.reset_batch(&videos,&audios,&subtitles);while let Ok(newer)=seeks.try_recv(){let _=seek.completion.send(Err("DASH seek superseded by newer request".into()));seek=newer;}runtime.prepare_seek(seek,&mut socket,&cancel).await;continue},BuildOutcome::Built(Ok(batch))=>batch,BuildOutcome::Built(Err(error))if runtime.switch_state!=SwitchState::Stable=>{runtime.reset_batch(&videos,&audios,&subtitles);log::warn!("DASH video switch failed generation={}: {}",selection_generation,error);runtime.reject_switch(selection_generation,&cancel).await?;continue},BuildOutcome::Built(Err(error))if matches!(runtime.selection.video_quality_mode,VideoQualityMode::Auto)&&runtime.abr.consecutive_failures()<=2&&runtime.abr_ladder().iter().any(|rep|rep.bandwidth<runtime.snapshot.video.bandwidth)=>{runtime.reset_batch(&videos,&audios,&subtitles);log::warn!("ABR video fetch failed; retaining frontier for conservative retry: {}",error);continue},BuildOutcome::Built(Err(error))=>return Err(error)};
        if switches.borrow().generation!=selection_generation{runtime.rollback_configs(&batch);runtime.reset_batch(&videos,&audios,&subtitles);log::info!("DASH switch generation {} superseded before commit",selection_generation);continue}let switching=runtime.switch_state!=SwitchState::Stable;if switching{runtime.switch_state=SwitchState::Committing;log::info!("DASH track switch state=Committing generation={}",selection_generation);}write_live(&mut socket,&batch.wire_records(),&cancel).await?;runtime.commit_batch(&videos,&audios,&subtitles);if switching{if let Some(from)=runtime.switch_from_bandwidth.take(){let target=AbrRepresentation{id:runtime.snapshot.video.identity.representation.clone(),bandwidth:runtime.snapshot.video.bandwidth};if let Some(reason)=runtime.selection.abr_reason{runtime.abr.switch_completed(Instant::now(),from,&target,reason)}else{runtime.abr.external_switch_completed(Instant::now(),&target.id)}}runtime.stable_selection=runtime.selection.clone();runtime.switch_state=SwitchState::Stable;log::info!("DASH track switch state=Stable generation={}",selection_generation);}runtime.sync_catalog(None);
    }
}
fn log_abr_evaluation(e:&AbrEvaluation){
    let(candidate_id,candidate_bitrate)=e.candidate.as_ref().map(|candidate|(candidate.id.as_str(),candidate.bandwidth.to_string())).unwrap_or(("none","none".into()));
    let(decision,reason)=match &e.decision{AbrDecision::Hold(reason)=>("hold",*reason),AbrDecision::Switch{reason,..}=>("switch",reason.as_str())};
    log::debug!("ABR evaluate current={}({}bps) candidate={}({}bps) latest={} estimate={} safety_factor={:.2} safe={} buffer={} zone={} up_margin={:.2} required_estimate={} confidence={}/{} supporting_samples={}/{} cooldown_remaining={:.3}s decision={} reason={}",e.current.id,e.current.bandwidth,candidate_id,candidate_bitrate,format_mbps(e.latest_throughput_bps),format_mbps(e.estimate_bps),e.safety_factor,format_mbps(e.safe_bandwidth_bps),e.buffered_seconds.map(|v|format!("{v:.3}s")).unwrap_or_else(||"unknown".into()),e.buffer_zone.as_str(),e.upswitch_headroom,format_mbps(e.required_estimate_bps),e.sample_count,e.stable_sample_count,e.supporting_sample_count,e.required_supporting_sample_count,e.cooldown_remaining.as_secs_f64(),decision,reason);
}
fn format_mbps(value:Option<f64>)->String{value.map(|value|format!("{:.3}Mbps",value/1_000_000.0)).unwrap_or_else(||"unknown".into())}
async fn write_live(socket:&mut TcpStream,bytes:&[u8],cancel:&CancellationToken)->Result<(),String>{tokio::select!{_=cancel.cancelled()=>Err("Native DASH session cancelled".into()),x=socket.write_all(bytes)=>x.map_err(|_|"Native DASH packet bridge disconnected".into())}}
async fn fetch(client:&reqwest::Client,url:Url,c:&CancellationToken,label:&str)->Result<Vec<u8>,String>{fetch_final(client,url,c,label).await.map(|x|x.0)}
fn retryable_http_status(status:reqwest::StatusCode)->bool{status==reqwest::StatusCode::FORBIDDEN||status==reqwest::StatusCode::REQUEST_TIMEOUT||status==reqwest::StatusCode::TOO_MANY_REQUESTS||status.is_server_error()}
async fn retry_delay(c:&CancellationToken,attempt:usize)->Result<(),String>{let delay=Duration::from_millis(200*(attempt as u64+1));tokio::select!{_=c.cancelled()=>Err("Native DASH session cancelled".into()),_=tokio::time::sleep(delay)=>Ok(())}}
async fn fetch_media_segment(client:&reqwest::Client,url:Url,c:&CancellationToken,representation_id:&str)->Result<(Vec<u8>,DownloadMeasurement),String>{
    for attempt in 0..3 {
        let request_start=Instant::now();
        let response=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=client.get(url.clone()).send()=>x};
        let mut response=match response{Ok(response)=>response,Err(_)if attempt<2=>{log::warn!("DASH segment request failed; retrying attempt={}",attempt+2);retry_delay(c,attempt).await?;continue},Err(_)=>return Err("Segment fetch failed".into())};
        if !response.status().is_success(){let status=response.status();if attempt<2&&retryable_http_status(status){log::warn!("DASH segment HTTP {}; retrying attempt={}",status.as_u16(),attempt+2);retry_delay(c,attempt).await?;continue}return Err(format!("Segment fetch failed: HTTP {}",status.as_u16()))}
        let mut bytes=Vec::new();let mut first_byte_time=None;let mut body_failed=false;
        loop{
            let chunk=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=response.chunk()=>x};
            let chunk=match chunk{Ok(chunk)=>chunk,Err(_)=>{body_failed=true;break}};
            let Some(chunk)=chunk else{break};if chunk.is_empty(){continue}if first_byte_time.is_none(){first_byte_time=Some(Instant::now())}bytes.extend_from_slice(&chunk);
        }
        if (body_failed||bytes.is_empty())&&attempt<2{log::warn!("DASH segment body incomplete; retrying attempt={}",attempt+2);retry_delay(c,attempt).await?;continue}
        if body_failed{return Err("Segment fetch failed".into())}if bytes.is_empty(){return Err("Segment fetch failed: empty response".into())}
        let request_end=Instant::now();
        let measurement=DownloadMeasurement{representation_id:representation_id.to_string(),bytes:bytes.len(),request_start,first_byte_time,request_end};
        return Ok((bytes,measurement));
    }
    Err("Segment fetch failed".into())
}
async fn fetch_final(client:&reqwest::Client,url:Url,c:&CancellationToken,label:&str)->Result<(Vec<u8>,Url),String>{for attempt in 0..3{let response=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=client.get(url.clone()).send()=>x};let response=match response{Ok(response)=>response,Err(_)if attempt<2=>{log::warn!("{}; retrying attempt={}",label,attempt+2);retry_delay(c,attempt).await?;continue},Err(_)=>return Err(label.to_string())};let status=response.status();if !status.is_success(){if attempt<2&&retryable_http_status(status){log::warn!("{}: HTTP {}; retrying attempt={}",label,status.as_u16(),attempt+2);retry_delay(c,attempt).await?;continue}return Err(format!("{}: HTTP {}",label,status.as_u16()))}let final_url=response.url().clone();let bytes=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=response.bytes()=>x};match bytes{Ok(bytes)if!bytes.is_empty()=>return Ok((bytes.to_vec(),final_url)),Ok(_)|Err(_)if attempt<2=>{log::warn!("{}: incomplete body; retrying attempt={}",label,attempt+2);retry_delay(c,attempt).await?;continue},_=>return Err(label.to_string())}}Err(label.to_string())}
fn log_snapshot(s:&ManifestSnapshot){log::info!("DASH manifest generation={} type={} publishTime={} availabilityStartTime={} timeShiftBufferDepth={} suggestedPresentationDelay={}",s.generation,if s.dynamic{"dynamic"}else{"static"},s.publish_time.map(|x|x.to_rfc3339()).unwrap_or_else(||"none".into()),s.availability_start_time.map(|x|x.to_rfc3339()).unwrap_or_else(||"none".into()),s.time_shift_buffer_depth.map(seconds).map(|x|format!("{x:.3}s")).unwrap_or_else(||"none".into()),s.suggested_presentation_delay.map(seconds).map(|x|format!("{x:.3}s")).unwrap_or_else(||"none".into()));log::info!("DASH video representations:");for track in &s.video_tracks{for r in &track.representations{log::info!("  id={} {}x{} {} codec={} frame_rate={}",r.identity.representation,r.width.map(|v|v.to_string()).unwrap_or_else(||"?".into()),r.height.map(|v|v.to_string()).unwrap_or_else(||"?".into()),r.bandwidth,r.codecs,r.frame_rate.as_deref().unwrap_or("?"));}}log::info!("DASH audio tracks:");for track in &s.audio_tracks{log::info!("  id={} lang={} role={} representation={}",track.adaptation_set_id,track.language,track.roles.join(","),track.selected.identity.representation);}}
fn log_merge(s:&ManifestSnapshot,m:&MergeStats){log::info!("DASH refresh representation={} old_refs={} new_refs={} added={} retained={} expired={}",s.video.identity.representation,m.retained,m.added+m.retained,m.added,m.retained,m.expired)}

#[derive(Clone,Default,Eq,PartialEq)]struct TrackMetadata{language:String,title:String,default_track:bool,forced_track:bool}
struct RdpBatch{configs:Vec<Vec<u8>>,metadata:Vec<TrackMetadata>,config_updates:Vec<Vec<u8>>,records:Vec<u8>}
impl RdpBatch{
    fn parse(bytes:&[u8])->Result<Self,String>{
        let count=if bytes.len()>=16{u32_at(bytes,12)? as usize}else{0};if bytes.len()<16||&bytes[..8]!=b"RDPKT001"||u32_at(bytes,8)?!=1||!(1..=8).contains(&count){return Err("Native DASH packet output header invalid".into())}
        let mut pos=16;let mut configs=Vec::new();for _ in 0..count{let start=pos;let extra=u32_at(bytes,pos+68)? as usize;pos=pos.checked_add(72+extra).filter(|p|*p<=bytes.len()).ok_or("Native DASH packet output truncated")?;configs.push(bytes[start..pos].to_vec());}
        let start=pos;loop{let record=u32_at(bytes,pos)?;if record==0x31464f45{pos+=4;break}if record!=0x31544b50{return Err("Native DASH packet output record invalid".into())}let size=u32_at(bytes,pos+48)? as usize;pos=pos.checked_add(52+size).filter(|p|*p<=bytes.len()).ok_or("Native DASH packet output truncated")?;}
        if pos!=bytes.len(){return Err("Native DASH packet output has trailing bytes".into())}Ok(Self{metadata:vec![TrackMetadata::default();configs.len()],configs,config_updates:Vec::new(),records:bytes[start..pos-4].to_vec()})
    }
    fn header(&self)->Vec<u8>{let mut out=b"RDPKT006".to_vec();out.extend(6u32.to_le_bytes());out.extend((self.configs.len() as u32).to_le_bytes());for(config,meta)in self.configs.iter().zip(&self.metadata){out.extend(config);let flags=u32::from(meta.default_track)|u32::from(meta.forced_track)<<1;out.extend(flags.to_le_bytes());out.extend((meta.language.len()as u32).to_le_bytes());out.extend(meta.language.as_bytes());out.extend((meta.title.len()as u32).to_le_bytes());out.extend(meta.title.as_bytes())}out}
    fn wire_records(&self)->Vec<u8>{let mut out=Vec::new();for config in &self.config_updates{out.extend(0x31474643u32.to_le_bytes());out.extend(config)}out.extend(&self.records);out}
    fn first_packet_is_keyframe(&self,track:u32)->Result<bool,String>{let mut pos=0;while pos<self.records.len(){let size=u32_at(&self.records,pos+48)?as usize;if u32_at(&self.records,pos+4)?==track{return Ok(u32_at(&self.records,pos+44)?&1!=0)}pos+=52+size}Ok(false)}
    fn remap(&mut self,mappings:&[(u32,u32,MediaKind,TrackMetadata)])->Result<(),String>{if self.configs.len()!=mappings.len(){return Err("Native DASH component/config count mismatch".into())}for(config,(track,generation,kind,meta))in self.configs.iter_mut().zip(mappings){config[0..4].copy_from_slice(&track.to_le_bytes());config[4..8].copy_from_slice(&generation.to_le_bytes());let kind=match kind{MediaKind::Video=>1u32,MediaKind::Audio=>2,MediaKind::Subtitle=>3};config[8..12].copy_from_slice(&kind.to_le_bytes());self.metadata.push(meta.clone())}self.metadata.drain(..mappings.len());let mut pos=0;while pos<self.records.len(){let size=u32_at(&self.records,pos+48)?as usize;let source=u32_at(&self.records,pos+4)?as usize;let mapping=mappings.get(source.checked_sub(1).ok_or("Native DASH packet track invalid")?).ok_or("Native DASH packet track invalid")?;self.records[pos+4..pos+8].copy_from_slice(&mapping.0.to_le_bytes());self.records[pos+8..pos+12].copy_from_slice(&mapping.1.to_le_bytes());pos+=52+size}Ok(())}
    fn offset(&mut self,track:u32,offset:ExactTime)->Result<(),String>{let mut pos=0;while pos<self.records.len(){let size=u32_at(&self.records,pos+48)? as usize;if u32_at(&self.records,pos+4)?==track{let num=i32_at(&self.records,pos+36)?;let den=i32_at(&self.records,pos+40)?;if num<=0||den<=0{return Err("Native DASH packet time base invalid".into())}let ticks=offset.rescale(den as u64,crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_|"DASH timestamp overflow")?.checked_div(num as i128).and_then(|v|i64::try_from(v).ok()).ok_or("DASH timestamp overflow")?;for at in [pos+12,pos+20]{let value=i64_at(&self.records,at)?;if value!=i64::MIN{self.records[at..at+8].copy_from_slice(&value.checked_add(ticks).ok_or("DASH timestamp overflow")?.to_le_bytes())}}}pos+=52+size}Ok(())}
    fn bridge_ttml(&mut self,bases:&[(u32,i128,u64)],seen:&mut HashSet<String>)->Result<(),String>{
        let subtitle_ids=self.configs.iter().filter(|c|u32_at(c,8).ok()==Some(3)).map(|c|u32_at(c,0)).collect::<Result<HashSet<_>,_>>()?;if subtitle_ids.is_empty(){return Ok(())}
        for config in &mut self.configs{if u32_at(config,8)?!=3{continue}let mut replacement=config[..68].to_vec();replacement[12..16].copy_from_slice(&1i32.to_le_bytes());replacement[16..20].copy_from_slice(&1000i32.to_le_bytes());replacement.extend((crate::ttml::ASS_HEADER.len() as u32).to_le_bytes());replacement.extend(crate::ttml::ASS_HEADER.as_bytes());*config=replacement}
        let mut output=Vec::new();let mut pos=0;while pos<self.records.len(){let size=u32_at(&self.records,pos+48)? as usize;let end=pos+52+size;let track=u32_at(&self.records,pos+4)?;if !subtitle_ids.contains(&track){output.extend_from_slice(&self.records[pos..end]);pos=end;continue}let Some((_,base_media,timescale))=bases.iter().find(|b|b.0==track)else{output.extend_from_slice(&self.records[pos..end]);pos=end;continue};let tb_num=i32_at(&self.records,pos+36)?;let tb_den=i32_at(&self.records,pos+40)?;let packet_pts=i64_at(&self.records,pos+12)?;let packet_start=ExactTime::new((packet_pts as i128).checked_mul(tb_num as i128).ok_or("TTML time overflow")?,tb_den as u64).map_err(|_|"TTML time overflow")?;let media_base=ExactTime::new(*base_media,*timescale).map_err(|_|"DASH timestamp overflow")?;
            for parsed in crate::ttml::parse_document(&self.records[pos+52..end])?{let(start_time,end_time,payload)=match parsed{crate::ttml::ParsedCue::Text(cue)=>{if !cue.unsupported.is_empty(){log::warn!("[native-dash] unsupported TTML features track={} features={}",track,cue.unsupported.join(","))}(cue.start,cue.end,crate::ttml::ass_payload(&cue).into_bytes())},crate::ttml::ParsedCue::Bitmap(cue)=>(cue.start,cue.end,crate::ttml::bitmap_payload(&cue)?)};let original_start=start_time.checked_sub(media_base).map_err(|_|"TTML time overflow")?;let end_time=end_time.checked_sub(media_base).map_err(|_|"TTML time overflow")?;let mut hasher=DefaultHasher::new();payload.hash(&mut hasher);let key=format!("{track}:{}/{}:{}/{}:{:016x}",original_start.numerator(),original_start.denominator(),end_time.numerator(),end_time.denominator(),hasher.finish());if !seen.insert(key){continue}let start=original_start.max(packet_start);let pts=i64::try_from(start.rescale(1000,crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_|"TTML time overflow")?).map_err(|_|"TTML time overflow")?;let duration=i64::try_from(end_time.checked_sub(start).map_err(|_|"TTML time overflow")?.rescale(1000,crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_|"TTML time overflow")?).map_err(|_|"TTML time overflow")?;if duration>0{append_packet(&mut output,track,pts,duration,&payload)}}pos=end}self.records=output;Ok(())
    }
}
fn append_packet(out:&mut Vec<u8>,track:u32,pts:i64,duration:i64,payload:&[u8]){out.extend(0x31544b50u32.to_le_bytes());out.extend(track.to_le_bytes());out.extend(1u32.to_le_bytes());out.extend(pts.to_le_bytes());out.extend(pts.to_le_bytes());out.extend(duration.to_le_bytes());out.extend(1i32.to_le_bytes());out.extend(1000i32.to_le_bytes());out.extend(0u32.to_le_bytes());out.extend((payload.len()as u32).to_le_bytes());out.extend(payload)}
fn u32_at(bytes:&[u8],at:usize)->Result<u32,String>{Ok(u32::from_le_bytes(bytes.get(at..at+4).ok_or("Native DASH packet output truncated")?.try_into().unwrap()))}
fn i32_at(bytes:&[u8],at:usize)->Result<i32,String>{Ok(i32::from_le_bytes(bytes.get(at..at+4).ok_or("Native DASH packet output truncated")?.try_into().unwrap()))}
fn i64_at(bytes:&[u8],at:usize)->Result<i64,String>{Ok(i64::from_le_bytes(bytes.get(at..at+8).ok_or("Native DASH packet output truncated")?.try_into().unwrap()))}

fn default_packet_producer()->PathBuf{if cfg!(windows){return std::env::current_exe().ok().and_then(|p|p.parent().map(|p|p.join("cenc_component_producer.exe"))).unwrap_or_else(||PathBuf::from("cenc_component_producer.exe"))}if cfg!(target_os="macos"){if let Some(path)=std::env::current_exe().ok().and_then(|p|p.parent().and_then(Path::parent).map(|p|p.join("Resources/cenc_component_producer"))).filter(|p|p.is_file()){return path}}Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../experiments/clearkey-cenc-packet-transform/cenc_component_producer")}
async fn run_packet_producer(components:&[PathBuf],audio_components:usize,output:&Path,kid:[u8;16],key:[u8;16],c:&CancellationToken)->Result<(),String>{let producer=std::env::var_os("YNOTV_NATIVE_DASH_PACKET_PRODUCER").map(PathBuf::from).unwrap_or_else(default_packet_producer);if !producer.is_file(){return Err("Native DASH FFmpeg/ClearKey packet producer is unavailable".into())}let hex=|b:[u8;16]|b.iter().map(|x|format!("{x:02x}")).collect::<String>();let mut cmd=Command::new(producer);#[cfg(target_os="windows")]cmd.creation_flags(0x08000000);cmd.args(components).arg(output).env("RUSTDASH_AUDIO_COMPONENTS",audio_components.to_string()).env("RUSTDASH_TEST_KID",hex(kid)).env("RUSTDASH_TEST_KEY",hex(key)).kill_on_drop(true).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());let x=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=cmd.output()=>x.map_err(|_|"Native DASH FFmpeg/ClearKey packet producer is unavailable")?};if x.status.success(){Ok(())}else{let d=String::from_utf8_lossy(&x.stderr);Err(if d.contains("UnsupportedScheme"){"Unsupported CENC scheme"}else if d.contains("Unsupported IMSC"){"Unsupported IMSC image profile"}else if x.status.code()==Some(3){"ClearKey KID unavailable"}else{"CENC decrypt failed"}.into())}}

#[cfg(test)]
mod tests {
    use super::*;

    fn xml(timeline: &str, start_number: u64, duration: &str, publish: &str) -> Vec<u8> {
        format!(r#"<MPD type="dynamic" minimumUpdatePeriod="PT0.05S" publishTime="{publish}"><Period id="p" start="PT5S" duration="{duration}"><AdaptationSet id="v" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="10" presentationTimeOffset="20" startNumber="{start_number}" initialization="v-init" media="v-$Number$-$Time$"><SegmentTimeline>{timeline}</SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="100"/></AdaptationSet><AdaptationSet id="a" contentType="audio" mimeType="audio/mp4"><SegmentTemplate timescale="10" presentationTimeOffset="20" startNumber="{start_number}" initialization="a-init" media="a-$Number$-$Time$"><SegmentTimeline>{timeline}</SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="50"/></AdaptationSet></Period></MPD>"#).into_bytes()
    }
    fn snap(data: &[u8], generation: u64) -> ManifestSnapshot {
        parse_snapshot(data, Url::parse("http://127.0.0.1/live/manifest.mpd").unwrap(), generation, None).unwrap()
    }

    #[test]
    fn strict_key_parser_never_echoes_input() {
        assert!(decode_hex_16("00112233445566778899AABBCCDDEEFF").is_ok());
        assert_eq!(decode_hex_16("not-a-key").unwrap_err(), "Invalid ClearKey property");
    }

    #[test]
    fn parses_real_world_iso_8601_dash_durations_exactly() {
        assert_eq!(parse_duration("PT12H").unwrap(), ExactTime::new(43_200, 1).unwrap());
        assert_eq!(parse_duration("P0DT12H").unwrap(), ExactTime::new(43_200, 1).unwrap());
        assert_eq!(parse_duration("PT1H2M3.5S").unwrap(), ExactTime::new(7_447, 2).unwrap());
        assert_eq!(parse_duration("P1DT2H3M4.125S").unwrap(), ExactTime::new(750_273, 8).unwrap());
        assert_eq!(parse_duration("PT0S").unwrap(), ExactTime::new(0, 1).unwrap());
        for invalid in ["12H", "P", "PT", "PT1M2H", "P1M", "PT1.2.3S"] {
            assert!(parse_duration(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn seek_epoch_marker_is_a_small_prepare_barrier() {
        let marker = seek_epoch_marker(0x0102_0304_0506_0708, 43_198_000);
        assert_eq!(marker.len(), 20);
        assert_eq!(u32_at(&marker, 0).unwrap(), 0x314b4553);
        assert_eq!(u64::from_le_bytes(marker[4..12].try_into().unwrap()), 0x0102_0304_0506_0708);
        assert_eq!(i64::from_le_bytes(marker[12..20].try_into().unwrap()), 43_198_000);
    }

    #[test]
    fn append_and_positive_repeat_growth_preserve_identity() {
        let one=snap(&xml(r#"<S t="100" d="20" r="2"/>"#,100,"PT40S","2026-09-20T00:00:00Z"),1);
        let two=snap(&xml(r#"<S t="100" d="20" r="4"/>"#,100,"PT40S","2026-09-20T00:00:01Z"),2);
        let mut index=SegmentIndex::default(); assert_eq!(index.merge(&one).unwrap().added,4);
        let stats=index.merge(&two).unwrap(); assert_eq!(stats.retained,4); assert_eq!(stats.added,4); assert_eq!(stats.expired,0);
    }

    #[test]
    fn dynamic_initial_snapshot_starts_one_segment_behind_live_edge() {
        let snapshot=snap(&xml(r#"<S t="100" d="20" r="5"/>"#,100,"PT40S","2026-09-20T00:00:00Z"),1);
        let segments=initial_segments(&snapshot.video,true).unwrap();
        assert_eq!(segments.len(),1);
        assert_eq!(segments[0].identity.media_time,160);
        assert_eq!(segments[0].number,103);
    }

    #[test]
    fn dynamic_initial_snapshot_falls_back_to_only_complete_segment() {
        let snapshot=snap(&xml(r#"<S t="100" d="20" r="1"/>"#,100,"PT40S","2026-09-20T00:00:00Z"),1);
        let segments=initial_segments(&snapshot.video,true).unwrap();
        assert_eq!(segments.len(),1);
        assert_eq!(segments[0].identity.media_time,100);
        assert_eq!(segments[0].number,100);
    }

    #[test]
    fn absent_mup_is_inferred_from_segment_duration() {
        let two_second=String::from_utf8(xml(r#"<S t="100" d="20" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z")).unwrap().replace(" minimumUpdatePeriod=\"PT0.05S\"","");
        let eight_second=String::from_utf8(xml(r#"<S t="100" d="80" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z")).unwrap().replace(" minimumUpdatePeriod=\"PT0.05S\"","");
        assert_eq!(snap(two_second.as_bytes(),1).minimum_update_period,Duration::from_secs(1));
        assert_eq!(snap(eight_second.as_bytes(),1).minimum_update_period,Duration::from_secs(4));
    }

    #[test]
    fn declared_mup_remains_authoritative() {
        let manifest=String::from_utf8(xml(r#"<S t="100" d="20" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z")).unwrap().replace("PT0.05S","PT3S");
        assert_eq!(snap(manifest.as_bytes(),1).minimum_update_period,Duration::from_secs(3));
    }

    #[test]
    fn sliding_start_number_uses_media_time_identity() {
        let one=snap(&xml(r#"<S t="100" d="20" r="4"/>"#,100,"PT40S","2026-09-20T00:00:00Z"),1);
        let two=snap(&xml(r#"<S t="140" d="20" r="4"/>"#,900,"PT40S","2026-09-20T00:00:01Z"),2);
        let mut index=SegmentIndex::default();index.merge(&one).unwrap();let stats=index.merge(&two).unwrap();
        assert_eq!(stats.retained,4);assert_eq!(stats.added,4);assert_eq!(stats.expired,4);
        let id=SegmentIdentity{representation:two.video.identity.clone(),media_time:140};
        assert_eq!(index.records[&id].descriptor.number,900);assert!(index.records[&id].descriptor.url.path().contains("900-140"));
    }

    #[test]
    fn negative_repeat_next_t_and_refreshed_bound_stay_compact() {
        let one=snap(&xml(r#"<S t="100" d="20" r="-1"/><S t="180" d="20" r="0"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),1);
        let two=snap(&xml(r#"<S t="100" d="20" r="-1"/><S t="220" d="20" r="0"/>"#,1,"PT44S","2026-09-20T00:00:01Z"),2);
        assert_eq!(one.video.index.run_count(),2);assert_eq!(two.video.index.run_count(),2);
        let mut index=SegmentIndex::default();index.merge(&one).unwrap();let stats=index.merge(&two).unwrap();assert!(stats.added>0&&stats.retained>0);
        let terminal_one=snap(&xml(r#"<S t="100" d="20" r="-1"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),1);
        let terminal_two=snap(&xml(r#"<S t="100" d="20" r="-1"/>"#,1,"PT44S","2026-09-20T00:00:01Z"),2);
        assert!(terminal_two.video.index.represented_segment_count()>terminal_one.video.index.represented_segment_count());
    }

    #[test]
    fn pto_period_start_and_million_segment_compactness_regress() {
        let normal=snap(&xml(r#"<S t="100" d="20" r="2"/>"#,10,"PT40S","2026-09-20T00:00:00Z"),1);
        let first=normal.video.index.get(10).unwrap().unwrap();assert_eq!(first.presentation_start,ExactTime::new(13,1).unwrap());
        let million=snap(&xml(r#"<S t="20" d="1" r="999999"/>"#,1,"PT100000S","2026-09-20T00:00:00Z"),1);
        assert_eq!(million.video.index.run_count(),1);assert_eq!(million.video.index.represented_segment_count(),1_000_000);
    }

    #[test]
    fn deterministic_twelve_hour_dvr_range_and_exact_seek_selection() {
        let manifest = include_bytes!("../../../../experiments/mpv-packet-demux-adapter/fixtures/c10-12h-dvr.mpd");
        let snapshot = snap(manifest, 1);
        let timeline = presentation_timeline(&snapshot, ExactTime::new(1_360_000, 1).unwrap(), ExactTime::new(1_403_194, 1).unwrap()).unwrap();
        assert_eq!(timeline.seek_range_start, ExactTime::new(1_360_000, 1).unwrap());
        assert_eq!(timeline.seek_range_end, ExactTime::new(1_403_200, 1).unwrap());
        assert_eq!(timeline.live_edge, timeline.seek_range_end);
        assert_eq!(timeline.state().window_duration, 43_200.0);
        for behind in [0_i128, 30, 600, 3_600, 21_600, 43_194] {
            let target = timeline.seek_range_end.checked_sub(ExactTime::new(behind, 1).unwrap()).unwrap();
            let descriptor = descriptor_at(&snapshot.video, true, target).unwrap();
            let clamped = target.min(timeline.seek_range_end);
            assert!(descriptor.start <= clamped && clamped <= descriptor.end);
            assert_eq!((descriptor.identity.media_time - 1_000_000) % 6, 0);
        }
        assert_eq!(snapshot.video.index.run_count(), 1);
    }

    #[test]
    fn sliding_dvr_window_preserves_absolute_current_position() {
        let generation = |start: i128, generation| {
            let timeline = format!(r#"<S t="{start}" d="600" r="720"/>"#);
            snap(&xml(&timeline, 1, "PT50000S", "2026-09-21T12:00:00Z"), generation)
        };
        let g1 = generation(20, 1);
        let g2 = generation(620, 2);
        let current = ExactTime::new(28_800, 1).unwrap();
        let first = presentation_timeline(&g1, ExactTime::new(0, 1).unwrap(), current).unwrap();
        let second = presentation_timeline(&g2, ExactTime::new(0, 1).unwrap(), first.current_time).unwrap();
        assert_eq!(second.current_time, current);
        assert_eq!(second.seek_range_start.checked_sub(first.seek_range_start).unwrap(), ExactTime::new(60, 1).unwrap());
        assert_eq!(second.seek_range_end.checked_sub(first.seek_range_end).unwrap(), ExactTime::new(60, 1).unwrap());
    }

    #[test]
    fn stale_generation_does_not_reschedule_fetched_segment() {
        let one=snap(&xml(r#"<S t="100" d="20" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),1);
        let two=snap(&xml(r#"<S t="100" d="20" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),2);
        let mut index=SegmentIndex::default();index.merge(&one).unwrap();let used=index.next(MediaKind::Video).unwrap();index.mark(&used.identity,SegmentState::Fetched);index.mark(&used.identity,SegmentState::Demuxed);
        let stats=index.merge(&two).unwrap();assert_eq!(stats.added,0);assert!(index.next(MediaKind::Video).is_some_and(|s|s.identity!=used.identity));assert!(index.fetched.contains(&used.identity));
    }

    #[test]
    fn mup_is_clamped_and_snapshot_metadata_is_immutable() {
        let s=snap(&xml(r#"<S t="100" d="20" r="2"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),7);
        assert_eq!(s.minimum_update_period,MIN_MUP);assert_eq!(s.generation,7);assert_eq!(s.periods,vec!["p"]);assert_eq!(s.video_tracks[0].representations.len(),1);assert_eq!(s.audio_tracks.len(),1);assert!(s.fetched_at<=SystemTime::now());assert!(s.published_at<=Instant::now());
    }

    #[test]
    fn c4_packet_file_converts_to_live_framing_and_rebases_timestamps() {
        let path=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../experiments/clearkey-cenc-packet-transform/fixtures/decrypted-av.rdp");
        let bytes=std::fs::read(path).unwrap();let mut batch=RdpBatch::parse(&bytes).unwrap();
        assert_eq!(&batch.header()[..8],b"RDPKT006");assert!(!batch.records.is_empty());
        batch.offset(1,ExactTime::new(2,1).unwrap()).unwrap();
        assert_ne!(batch.records,bytes[bytes.len()-batch.records.len()-4..bytes.len()-4]);
    }

    #[test]
    fn discovers_stpp_and_ttml_subtitles_with_manifest_metadata() {
        let data=r#"<MPD type="dynamic"><Period id="p" duration="PT20S">
          <AdaptationSet id="v" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="v-init" media="v-$Time$"><SegmentTimeline><S t="0" d="5" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="2"/></AdaptationSet>
          <AdaptationSet id="a" contentType="audio" mimeType="audio/mp4"><SegmentTemplate timescale="1" initialization="a-init" media="a-$Time$"><SegmentTimeline><S t="0" d="5" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="1"/></AdaptationSet>
          <AdaptationSet id="s-zh" contentType="text" mimeType="application/mp4" lang="zh"><Label>Traditional Chinese</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Accessibility schemeIdUri="urn:test" value="caption"/><SegmentTemplate timescale="1000" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="0" d="5000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="stpp-zh" bandwidth="10000" codecs="stpp.ttml.im1t"/></AdaptationSet>
          <AdaptationSet id="s-en" mimeType="application/ttml+xml" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="forced-subtitle"/><SegmentTemplate timescale="1000" initialization="text-init" media="text-$Time$"><SegmentTimeline><S t="0" d="5000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="ttml-en" bandwidth="2"/></AdaptationSet>
        </Period></MPD>"#;
        let snapshot=snap(data.as_bytes(),1);assert_eq!(snapshot.subtitles.len(),2);assert_eq!(snapshot.video_tracks[0].representations.len(),1);assert_eq!(snapshot.audio_tracks.len(),1);
        let zh=snapshot.subtitles.iter().find(|s|s.identity.representation=="stpp-zh").unwrap();let meta=zh.subtitle.as_ref().unwrap();
        assert_eq!(zh.codecs,"stpp.ttml.im1t");assert_eq!(meta.language,"zh");assert_eq!(meta.label,"Traditional Chinese");assert!(meta.default_track);assert_eq!(meta.accessibility,vec!["caption"]);
        let en=snapshot.subtitles.iter().find(|s|s.identity.representation=="ttml-en").unwrap();assert!(en.subtitle.as_ref().unwrap().forced_track);
        assert_eq!(preferred_subtitle_track(&snapshot,Some("eng")).as_deref(),Some("s-en"));
        assert_eq!(preferred_subtitle_track(&snapshot,Some("zh-TW")).as_deref(),Some("s-zh"));
        assert_eq!(preferred_subtitle_track(&snapshot,Some("off")),None);
    }

    #[test]
    fn preserves_video_representations_and_logical_audio_tracks() {
        let data=r#"<MPD type="dynamic"><Period id="p" duration="PT20S">
          <AdaptationSet id="v" contentType="video" mimeType="video/mp4" codecs="avc1.64001f"><SegmentTemplate timescale="10" presentationTimeOffset="20" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="20" d="50" r="2"/></SegmentTimeline></SegmentTemplate>
            <Representation id="v-low" bandwidth="400000" width="320" height="180" frameRate="25"/><Representation id="v-high" bandwidth="1200000" width="640" height="360" frameRate="25"/></AdaptationSet>
          <AdaptationSet id="a-en" contentType="audio" mimeType="audio/mp4" lang="en" selectionPriority="2"><Label>English</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/><SegmentTemplate timescale="10" presentationTimeOffset="20" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="20" d="50" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="a-en-64" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000"/><Representation id="a-en-128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000"/></AdaptationSet>
          <AdaptationSet id="a-zh" contentType="audio" mimeType="audio/mp4" lang="zh"><Label>中文</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="commentary"/><SegmentTemplate timescale="10" presentationTimeOffset="20" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="20" d="50" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="a-zh-96" bandwidth="96000" codecs="mp4a.40.2"/></AdaptationSet>
        </Period></MPD>"#;
        let snapshot=snap(data.as_bytes(),1);let catalog=build_catalog(&snapshot);
        assert_eq!(snapshot.video_tracks.len(),1);assert_eq!(snapshot.video_tracks[0].representations.len(),2);
        assert_eq!(catalog.video_representations.iter().map(|r|r.label.as_str()).collect::<Vec<_>>(),vec!["320×180","640×360"]);
        assert!(catalog.video_representations.iter().all(|r|r.compatible));
        assert_eq!(snapshot.audio_tracks.len(),2);assert_eq!(snapshot.audio_tracks[0].adaptation_set_id,"a-en");assert_eq!(snapshot.audio_tracks[0].selected.identity.representation,"a-en-128");
        assert_eq!(catalog.audio_tracks[1].label,"中文");assert_eq!(catalog.audio_tracks[1].role,vec!["commentary"]);assert_eq!(catalog.audio_tracks[0].channels.as_deref(),Some("2"));
    }

    #[test]
    fn codec_family_and_unaligned_timelines_are_incompatible() {
        let data=br#"<MPD type="dynamic"><Period id="p" duration="PT20S"><AdaptationSet id="v" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="10" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="0" d="50" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="avc" bandwidth="1" codecs="avc1.64001f"/><Representation id="hevc" bandwidth="2" codecs="hev1.1.6.L93"/><Representation id="shifted" bandwidth="3" codecs="avc1.64001f"><SegmentTemplate timescale="10" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="10" d="50" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet><AdaptationSet id="a" contentType="audio" mimeType="audio/mp4"><SegmentTemplate timescale="10" initialization="a" media="a-$Time$"><SegmentTimeline><S t="0" d="50" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="a1"/></AdaptationSet></Period></MPD>"#;
        let catalog=build_catalog(&snap(data,1));
        assert!(catalog.video_representations.iter().find(|r|r.representation_id=="avc").unwrap().compatible);
        assert!(!catalog.video_representations.iter().find(|r|r.representation_id=="hevc").unwrap().compatible);
        assert!(!catalog.video_representations.iter().find(|r|r.representation_id=="shifted").unwrap().compatible);
    }

    #[test]
    fn deterministic_c8_manifest_has_two_aligned_qualities_and_two_audio_tracks() {
        let path=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../experiments/mpv-packet-demux-adapter/fixtures/c8-manual-switch.mpd");
        let data=std::fs::read(path).unwrap();let snapshot=parse_snapshot(&data,Url::parse("http://127.0.0.1/fixtures/c8-manual-switch.mpd").unwrap(),1,None).unwrap();let catalog=build_catalog(&snapshot);
        assert_eq!(catalog.video_representations.iter().map(|r|r.label.as_str()).collect::<Vec<_>>(),vec!["320×180","640×360"]);assert!(catalog.video_representations.iter().all(|r|r.compatible));
        assert_eq!(catalog.audio_tracks.iter().map(|a|a.language.as_str()).collect::<Vec<_>>(),vec!["en","zh"]);assert_eq!(catalog.audio_tracks[0].label,"English 440 Hz");assert_eq!(catalog.audio_tracks[1].label,"中文 880 Hz");
    }

    #[test]
    fn auto_startup_uses_lower_middle_compatible_representation() {
        let reps=(1..=5).map(|n|format!(r#"<Representation id="v{n}" bandwidth="{}" codecs="avc1.64001f"/>"#,n*500_000)).collect::<String>();
        let data=format!(r#"<MPD type="dynamic"><Period id="p" duration="PT20S"><AdaptationSet id="v" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="0" d="5" r="2"/></SegmentTimeline></SegmentTemplate>{reps}</AdaptationSet><AdaptationSet id="a" contentType="audio" mimeType="audio/mp4"><SegmentTemplate timescale="1" initialization="a" media="a-$Time$"><SegmentTimeline><S t="0" d="5" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="a1"/></AdaptationSet></Period></MPD>"#);
        let snapshot=snap(data.as_bytes(),1);assert_eq!(snapshot.video.identity.representation,"v3");assert!(matches!(build_catalog(&snapshot).video_quality_mode,VideoQualityMode::Auto));
    }

    #[tokio::test]
    async fn media_measurement_uses_complete_http_transfer_and_records_first_byte() {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        tokio::spawn(async move{let(mut socket,_)=listener.accept().await.unwrap();let mut request=[0u8;1024];let _=socket.read(&mut request).await.unwrap();socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2000\r\nConnection: close\r\n\r\n").await.unwrap();socket.write_all(&vec![1u8;1000]).await.unwrap();tokio::time::sleep(Duration::from_millis(40)).await;socket.write_all(&vec![2u8;1000]).await.unwrap();});
        let client=reqwest::Client::new();let(data,measurement)=fetch_media_segment(&client,Url::parse(&format!("http://{address}/segment.m4s")).unwrap(),&CancellationToken::new(),"v-test").await.unwrap();
        assert_eq!(data.len(),2000);assert_eq!(measurement.bytes,2000);assert_eq!(measurement.representation_id,"v-test");assert!(measurement.first_byte_time.is_some());assert!(measurement.request_end.duration_since(measurement.request_start)>=Duration::from_millis(35));
    }

    #[test]
    fn subtitle_identity_survives_dynamic_refresh_without_reschedule() {
        let make=|timeline:&str,publish:&str|format!(r#"<MPD type="dynamic" publishTime="{publish}"><Period id="p" duration="PT40S">
          <AdaptationSet id="v" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="v" media="v-$Time$"><SegmentTimeline><S t="0" d="5" r="4"/></SegmentTimeline></SegmentTemplate><Representation id="v1"/></AdaptationSet>
          <AdaptationSet id="a" contentType="audio" mimeType="audio/mp4"><SegmentTemplate timescale="1" initialization="a" media="a-$Time$"><SegmentTimeline><S t="0" d="5" r="4"/></SegmentTimeline></SegmentTemplate><Representation id="a1"/></AdaptationSet>
          <AdaptationSet id="s" contentType="text" mimeType="application/mp4" lang="en"><SegmentTemplate timescale="1" initialization="s" media="s-$Time$"><SegmentTimeline>{timeline}</SegmentTimeline></SegmentTemplate><Representation id="s1" codecs="stpp"/></AdaptationSet>
        </Period></MPD>"#).into_bytes();
        let one=snap(&make(r#"<S t="0" d="5" r="3"/>"#,"2026-09-20T00:00:00Z"),1);let two=snap(&make(r#"<S t="5" d="5" r="4"/>"#,"2026-09-20T00:00:01Z"),2);
        let mut index=SegmentIndex::default();index.merge(&one).unwrap();let used=index.next(MediaKind::Subtitle).unwrap();index.mark(&used.identity,SegmentState::Fetched);index.mark(&used.identity,SegmentState::Demuxed);let stats=index.merge(&two).unwrap();
        assert!(stats.retained>=3);assert!(index.fetched.contains(&used.identity));assert!(index.next(MediaKind::Subtitle).is_some_and(|s|s.identity!=used.identity));
    }

    #[test]
    fn ttml_bridge_clips_leading_time_and_deduplicates_adjacent_documents() {
        fn config()->Vec<u8>{let mut c=Vec::new();for v in [3u32,1,3]{c.extend(v.to_le_bytes())}for v in [1i32,90_000,0,0,0,0]{c.extend(v.to_le_bytes())}let mut codec=[0u8;32];codec[..4].copy_from_slice(b"ttml");c.extend(codec);c.extend(0u32.to_le_bytes());c}
        fn record(xml:&[u8])->Vec<u8>{let mut r=Vec::new();r.extend(0x31544b50u32.to_le_bytes());r.extend(3u32.to_le_bytes());r.extend(1u32.to_le_bytes());r.extend(0i64.to_le_bytes());r.extend(0i64.to_le_bytes());r.extend(720_000i64.to_le_bytes());r.extend(1i32.to_le_bytes());r.extend(90_000i32.to_le_bytes());r.extend(0u32.to_le_bytes());r.extend((xml.len()as u32).to_le_bytes());r.extend(xml);r}
        let xml=br#"<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="9.5s" end="10.5s">leading</p><p begin="17.5s" end="18.5s">trailing</p></div></body></tt>"#;let mut records=record(xml);records.extend(record(xml));let mut batch=RdpBatch{configs:vec![config()],metadata:vec![TrackMetadata::default()],config_updates:Vec::new(),records};let mut seen=HashSet::new();batch.bridge_ttml(&[(3,10_000,1000)],&mut seen).unwrap();
        assert_eq!(&batch.configs[0][36..40],b"ttml");assert_eq!(i32_at(&batch.configs[0],12).unwrap(),1);assert_eq!(i32_at(&batch.configs[0],16).unwrap(),1000);assert!(batch.configs[0][72..].starts_with(b"[Script Info]"));let mut pos=0;let mut pts=Vec::new();while pos<batch.records.len(){assert_eq!(i32_at(&batch.records,pos+36).unwrap(),1);assert_eq!(i32_at(&batch.records,pos+40).unwrap(),1000);pts.push(i64_at(&batch.records,pos+12).unwrap());pos+=52+u32_at(&batch.records,pos+48).unwrap()as usize}assert_eq!(pts,vec![0,7500]);assert_eq!(seen.len(),2);
    }
}
