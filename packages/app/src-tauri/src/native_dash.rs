//! C6 native ClearKey DASH session with immutable manifest generations.

use crate::dash_timeline::{CompactTimeline, ExactTime, TimelineEntry};
use once_cell::sync::Lazy;
use quick_xml::de::from_str;
use serde::Deserialize;
use std::{collections::{HashMap, HashSet}, hash::{DefaultHasher, Hash, Hasher}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant, SystemTime}};
use tempfile::TempDir;
use tokio::{fs, io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, process::Command};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_STATIC_SEGMENTS: u128 = 20_000;
const DYNAMIC_COMPLETE_WINDOW: usize = 2;
const FALLBACK_MUP: Duration = Duration::from_secs(2);
const MIN_MUP: Duration = Duration::from_millis(250);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDashPlaybackConfig {
    pub manifest_url: String,
    #[serde(default)] pub request_headers: HashMap<String, String>,
    pub drm: NativeDashDrm,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum NativeDashDrm { ClearKey { kid: String, key: String } }

#[derive(Default)]
struct ActiveSession { generation: u64, cancellation: Option<CancellationToken>, files: Option<TempDir>, dynamic: bool }
static ACTIVE: Lazy<parking_lot::Mutex<ActiveSession>> = Lazy::new(|| parking_lot::Mutex::new(ActiveSession::default()));
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn cancel_active() {
    let mut active = ACTIVE.lock();
    if let Some(token) = active.cancellation.take() { token.cancel(); }
    active.files = None;
    active.dynamic = false;
}
pub(crate) fn note_eof() {
    let active = ACTIVE.lock();
    if active.dynamic && active.files.is_some() { log::warn!("[native-dash] dynamic packet source ended unexpectedly"); }
}

pub(crate) async fn prepare(config: NativeDashPlaybackConfig) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    return Err("Native DASH requires macOS in-process libmpv in C6".into());
    let (kid, key) = match &config.drm { NativeDashDrm::ClearKey { kid, key } => (decode_hex_16(kid)?, decode_hex_16(key)?) };
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let cancellation = CancellationToken::new();
    {
        let mut active = ACTIVE.lock();
        if let Some(old) = active.cancellation.take() { old.cancel(); }
        active.files = None; active.dynamic = false; active.generation = generation;
        active.cancellation = Some(cancellation.clone());
    }
    let result = build_live(&config.manifest_url, &config.request_headers, kid, key, &cancellation).await;
    match result {
        Ok((dir, source, dynamic)) => {
            let mut active = ACTIVE.lock();
            if active.generation != generation || cancellation.is_cancelled() { return Err("Native DASH session cancelled".into()); }
            active.files = Some(dir); active.dynamic = dynamic; Ok(source)
        }
        Err(error) => Err(error),
    }
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
    #[serde(rename="@lang")] language: Option<String>,
    #[serde(rename="BaseURL", default)] base_urls: Vec<TextNode>, #[serde(rename="SegmentTemplate")] template: Option<SegmentTemplate>,
    #[serde(rename="ContentProtection", default)] protections: Vec<ContentProtection>, #[serde(rename="EssentialProperty", default)] essential: Vec<Descriptor>,
    #[serde(rename="Role", default)] roles: Vec<Descriptor>, #[serde(rename="Accessibility", default)] accessibility: Vec<Descriptor>,
    #[serde(rename="Label")] label: Option<TextNode>,
    #[serde(rename="Representation", default)] representations: Vec<Representation>,
}
#[derive(Debug, Deserialize)]
struct Representation {
    #[serde(rename="@id")] id: String, #[serde(rename="@bandwidth", default)] bandwidth: u64, #[serde(rename="@mimeType")] mime_type: Option<String>, #[serde(rename="@codecs")] codecs: Option<String>,
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
#[derive(Clone, Debug, Eq, PartialEq)] struct SubtitleMetadata { language:String, label:String, roles:Vec<String>, accessibility:Vec<String>, default_track:bool, forced_track:bool }
#[derive(Clone)] struct RepresentationSnapshot { identity: RepresentationIdentity, base: Url, template: SegmentTemplate, index: CompactTimeline, mime_type:String, codecs: String, bandwidth: u64, subtitle:Option<SubtitleMetadata> }
#[derive(Clone)] struct ManifestSnapshot {
    generation: u64, fetched_at: SystemTime, published_at: Instant, publish_time: Option<chrono::DateTime<chrono::Utc>>, minimum_update_period: Duration, dynamic: bool,
    periods: Vec<String>, representations: Vec<RepresentationIdentity>, video: RepresentationSnapshot, audio: RepresentationSnapshot, subtitles:Vec<RepresentationSnapshot>,
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
        for rep in std::iter::once(&snapshot.video).chain(std::iter::once(&snapshot.audio)).chain(snapshot.subtitles.iter()) {
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

fn parse_snapshot(bytes: &[u8], final_url: Url, generation: u64, selected: Option<&[RepresentationIdentity]>) -> Result<ManifestSnapshot,String> {
    let xml = std::str::from_utf8(bytes).map_err(|_| "Unsupported DASH manifest shape")?;
    let mpd: Mpd = from_str(xml).map_err(|_| "Unsupported DASH manifest shape")?;
    if mpd.periods.len() != 1 { return Err("Unsupported DASH manifest shape: exactly one Period is required".into()); }
    let period=&mpd.periods[0]; let start=parse_duration(period.start.as_deref().unwrap_or("PT0S"))?;
    let duration=period.duration.as_deref().or(mpd.duration.as_deref()).map(parse_duration).transpose()?;
    let period_id=period.id.clone().unwrap_or_else(|| format!("start:{}/{}",start.numerator(),start.denominator()));
    let base=inherit_base(inherit_base(final_url,&mpd.base_urls)?,&period.base_urls)?;
    let required=|kind|selected.and_then(|ids|ids.iter().find(|id|id.kind==kind));
    let video=make_rep(base.clone(),period_id.clone(),select(period,MediaKind::Video,required(MediaKind::Video))?,start,duration)?;
    let audio=make_rep(base.clone(),period_id.clone(),select(period,MediaKind::Audio,required(MediaKind::Audio))?,start,duration)?;
    let subtitles=select_subtitles(period,selected)?.into_iter().map(|choice|make_rep(base.clone(),period_id.clone(),choice,start,duration)).collect::<Result<Vec<_>,_>>()?;
    let publish_time=mpd.publish_time.as_deref().map(|v|chrono::DateTime::parse_from_rfc3339(v).map(|v|v.with_timezone(&chrono::Utc)).map_err(|_|"Unsupported DASH manifest shape: publishTime")).transpose()?;
    let minimum_update_period=mpd.minimum_update_period.as_deref().map(parse_std_duration).transpose()?.filter(|v|!v.is_zero()).unwrap_or(FALLBACK_MUP).max(MIN_MUP);
    let dynamic=mpd.kind.eq_ignore_ascii_case("dynamic");
    let mut representations=vec![video.identity.clone(),audio.identity.clone()];representations.extend(subtitles.iter().map(|s|s.identity.clone()));
    Ok(ManifestSnapshot { generation,fetched_at:SystemTime::now(),published_at:Instant::now(),publish_time,minimum_update_period,dynamic,periods:vec![period_id],representations,video,audio,subtitles })
}

fn select<'a>(period:&'a Period,kind:MediaKind,required:Option<&RepresentationIdentity>)->Result<Selection<'a>,String>{
    let mut choices=Vec::new();
    for a in &period.adaptations { if a.essential.iter().any(|e|e.scheme.eq_ignore_ascii_case("http://dashif.org/guidelines/trickmode")){continue} for r in &a.representations {
        let mime=r.mime_type.as_ref().or(a.mime_type.as_ref()); let matches=match kind{MediaKind::Video=>a.content_type.as_deref()==Some("video")||mime.is_some_and(|m|m.starts_with("video/")),MediaKind::Audio=>a.content_type.as_deref()==Some("audio")||mime.is_some_and(|m|m.starts_with("audio/")),MediaKind::Subtitle=>is_dash_subtitle(a,r)};
        if matches&&mime.is_none_or(|m|m.ends_with("/mp4"))&&required.is_none_or(|need|r.id==need.representation&&adaptation_id(a,kind)==need.adaptation){choices.push(Selection{adaptation:a,representation:r,kind});}
    }}
    choices.into_iter().min_by_key(|c|(c.representation.bandwidth,&c.representation.id)).ok_or_else(||if required.is_some(){"Unsupported DASH refresh: selected representation disappeared".into()}else{format!("Unsupported DASH manifest shape: no supported {:?} representation",kind)})
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
    let subtitle=(s.kind==MediaKind::Subtitle).then(||{let roles=s.adaptation.roles.iter().filter_map(|d|d.value.clone()).collect::<Vec<_>>();let forced=roles.iter().any(|v|v.eq_ignore_ascii_case("forced-subtitle")||v.eq_ignore_ascii_case("forced"));let default_track=roles.iter().any(|v|v.eq_ignore_ascii_case("main"));SubtitleMetadata{language:s.adaptation.language.clone().unwrap_or_else(||"und".into()),label:s.adaptation.label.as_ref().map(|l|l.value.trim().to_string()).filter(|s|!s.is_empty()).unwrap_or_else(||s.adaptation.language.clone().unwrap_or_else(||s.representation.id.clone())),roles,accessibility:s.adaptation.accessibility.iter().filter_map(|d|d.value.clone()).collect(),default_track,forced_track:forced}});
    Ok(RepresentationSnapshot{identity,base,template,index,mime_type,codecs,bandwidth:s.representation.bandwidth,subtitle})
}
fn descriptors(rep:&RepresentationSnapshot,dynamic:bool)->Result<Vec<SegmentDescriptor>,String>{
    if !dynamic&&rep.index.represented_segment_count()>MAX_STATIC_SEGMENTS{return Err("Unsupported DASH manifest shape: segment list too large".into())}
    let mut refs=Vec::new(); if let(Some(first),Some(last))=(rep.index.first_position(),rep.index.last_position()){for pos in first..=last{if let Some(r)=rep.index.get(pos).map_err(|_|"Unsupported DASH manifest shape")?{refs.push(r)}}}
    if dynamic{refs.pop();}
    refs.into_iter().map(|r|{let media=expand(rep.template.media.as_deref().unwrap(),&rep.identity.representation,Some(r.position),Some(r.media_time))?;Ok(SegmentDescriptor{identity:SegmentIdentity{representation:rep.identity.clone(),media_time:r.media_time},number:r.position,start:r.presentation_start,end:r.presentation_end,url:rep.base.join(&media).map_err(|_|"Segment fetch failed")?})}).collect()
}
fn merged_template(a:&Adaptation,r:&Representation)->Result<SegmentTemplate,String>{let p=a.template.clone().unwrap_or_default();let c=r.template.clone().unwrap_or_default();let x=SegmentTemplate{timescale:c.timescale.or(p.timescale),pto:c.pto.or(p.pto),start_number:c.start_number.or(p.start_number),initialization:c.initialization.or(p.initialization),media:c.media.or(p.media),timeline:c.timeline.or(p.timeline)};if x.initialization.is_none()||x.media.is_none()||x.timeline.is_none(){Err("Unsupported DASH manifest shape: SegmentTemplate/SegmentTimeline required".into())}else{Ok(x)}}
fn validate_cenc(s:&Selection<'_>)->Result<(),String>{for p in s.adaptation.protections.iter().chain(&s.representation.protections){if p.scheme.eq_ignore_ascii_case("urn:mpeg:dash:mp4protection:2011")&&p.value.as_deref().is_some_and(|v|!v.eq_ignore_ascii_case("cenc")){return Err("Unsupported DASH manifest shape: only CENC is supported".into())}}Ok(())}
fn expand(t:&str,id:&str,n:Option<u64>,time:Option<i128>)->Result<String,String>{let v=t.replace("$RepresentationID$",id).replace("$Number$",&n.map(|v|v.to_string()).unwrap_or_default()).replace("$Time$",&time.map(|v|v.to_string()).unwrap_or_default()).replace("$$","\0");if v.contains('$'){Err("Unsupported DASH manifest shape: unsupported URL template".into())}else{Ok(v.replace('\0',"$"))}}
fn inherit_base(mut base:Url,nodes:&[TextNode])->Result<Url,String>{if let Some(n)=nodes.first(){base=base.join(n.value.trim()).map_err(|_|"Unsupported DASH manifest shape: invalid BaseURL")?}Ok(base)}
fn parse_duration(v:&str)->Result<ExactTime,String>{let seconds=v.strip_prefix("PT").and_then(|x|x.strip_suffix('S')).ok_or("Unsupported DASH manifest shape: duration")?;let micros=(seconds.parse::<f64>().map_err(|_|"Unsupported DASH manifest shape: duration")?*1_000_000.0).round() as i128;ExactTime::new(micros,1_000_000).map_err(|_|"Unsupported DASH manifest shape: duration".into())}
fn parse_std_duration(v:&str)->Result<Duration,String>{let t=parse_duration(v)?;let micros=t.rescale(1_000_000,crate::dash_timeline::Rounding::Ceil).map_err(|_|"Unsupported DASH manifest shape: duration")?;Ok(Duration::from_micros(u64::try_from(micros).map_err(|_|"Unsupported DASH manifest shape: duration")?))}

struct LiveRuntime {
    client:reqwest::Client, manifest_url:Url, snapshot:ManifestSnapshot,
    index:SegmentIndex, kid:[u8;16], key:[u8;16], directory:PathBuf,
    video_init:Vec<u8>, audio_init:Vec<u8>, subtitle_inits:Vec<Vec<u8>>, configs:Option<Vec<Vec<u8>>>,
    seen_cues:HashSet<String>, origin:ExactTime, batch:u64,
}

async fn build_live(url:&str,request_headers:&HashMap<String,String>,kid:[u8;16],key:[u8;16],cancel:&CancellationToken)->Result<(TempDir,String,bool),String>{
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
    let mut index=SegmentIndex::default();let stats=index.merge(&snapshot)?;log_merge(&snapshot,&stats);
    let video_segments=initial_segments(&snapshot.video,snapshot.dynamic)?;
    let audio_segments=initial_segments(&snapshot.audio,snapshot.dynamic)?;
    let subtitle_segments=snapshot.subtitles.iter().map(|s|initial_segments(s,snapshot.dynamic)).collect::<Result<Vec<_>,_>>()?;
    if snapshot.dynamic {
        let selected:HashSet<_>=video_segments.iter().chain(&audio_segments).chain(subtitle_segments.iter().flatten()).map(|segment|segment.identity.clone()).collect();
        for record in index.records.values_mut(){if !selected.contains(&record.descriptor.identity){record.state=SegmentState::Expired;}}
    }
    let origin=subtitle_segments.iter().flatten().fold(video_segments[0].start.min(audio_segments[0].start),|o,s|o.min(s.start));
    let dir=tempfile::Builder::new().prefix("ynotv-native-dash-").tempdir().map_err(|_|"Native DASH temporary storage failed")?;
    let video_init=fetch_init(&client,&snapshot.video,cancel).await?;
    let audio_init=fetch_init(&client,&snapshot.audio,cancel).await?;
    let mut subtitle_inits=Vec::new();for rep in &snapshot.subtitles{subtitle_inits.push(fetch_init(&client,rep,cancel).await?)}
    let mut runtime=LiveRuntime{client,manifest_url,snapshot,index,kid,key,directory:dir.path().to_path_buf(),video_init,audio_init,subtitle_inits,configs:None,seen_cues:HashSet::new(),origin,batch:0};
    let first=runtime.make_batch(&video_segments,&audio_segments,&subtitle_segments,cancel).await?;
    let listener=TcpListener::bind("127.0.0.1:0").await.map_err(|_|"Native DASH packet bridge failed")?;
    let address=listener.local_addr().map_err(|_|"Native DASH packet bridge failed")?;
    let dynamic=runtime.snapshot.dynamic;let token=cancel.clone();
    tokio::spawn(async move{if let Err(error)=serve_live(listener,runtime,first,token.clone()).await{if !token.is_cancelled(){log::error!("[native-dash] live session failed: {}",error);}}});
    Ok((dir,format!("http://{address}/native-dash.rdp"),dynamic))
}
fn initial_segments(rep:&RepresentationSnapshot,dynamic:bool)->Result<Vec<SegmentDescriptor>,String>{
    let mut segments=descriptors(rep,dynamic)?;
    if dynamic&&segments.len()>DYNAMIC_COMPLETE_WINDOW{segments.drain(..segments.len()-DYNAMIC_COMPLETE_WINDOW);}
    if segments.is_empty(){return Err("Unsupported DASH manifest shape: no complete segments".into())}
    Ok(segments)
}
async fn fetch_init(client:&reqwest::Client,rep:&RepresentationSnapshot,cancel:&CancellationToken)->Result<Vec<u8>,String>{
    let init=expand(rep.template.initialization.as_deref().unwrap(),&rep.identity.representation,None,None)?;
    fetch(client,rep.base.join(&init).map_err(|_|"Segment fetch failed")?,cancel,"Segment fetch failed").await
}
async fn download_component(client:&reqwest::Client,init:&[u8],segments:&[SegmentDescriptor],path:&Path,cancel:&CancellationToken)->Result<(),String>{
    let mut bytes=init.to_vec();
    for segment in segments{bytes.extend(fetch(client,segment.url.clone(),cancel,"Segment fetch failed").await?);}
    fs::write(path,bytes).await.map_err(|_|"Segment fetch failed: temporary write".into())
}

impl LiveRuntime {
    async fn make_batch(&mut self,video:&[SegmentDescriptor],audio:&[SegmentDescriptor],subtitles:&[Vec<SegmentDescriptor>],cancel:&CancellationToken)->Result<RdpBatch,String>{
        for segment in video.iter().chain(audio).chain(subtitles.iter().flatten()){self.index.mark(&segment.identity,SegmentState::Scheduled);self.index.mark(&segment.identity,SegmentState::Fetching);}
        self.batch+=1;let vp=self.directory.join(format!("video-{}.mp4",self.batch));let ap=self.directory.join(format!("audio-{}.mp4",self.batch));let out=self.directory.join(format!("packets-{}.rdp",self.batch));
        download_component(&self.client,&self.video_init,video,&vp,cancel).await?;download_component(&self.client,&self.audio_init,audio,&ap,cancel).await?;
        let mut component_paths=vec![vp,ap];for(n,segments)in subtitles.iter().enumerate(){let p=self.directory.join(format!("subtitle-{n}-{}.mp4",self.batch));download_component(&self.client,&self.subtitle_inits[n],segments,&p,cancel).await?;component_paths.push(p)}
        for segment in video.iter().chain(audio).chain(subtitles.iter().flatten()){if self.index.fetched.contains(&segment.identity){return Err("Duplicate DASH segment fetch prevented".into())}self.index.mark(&segment.identity,SegmentState::Fetched);log::info!("DASH segment fetched kind={:?} representation={} media_time={}",segment.identity.representation.kind,segment.identity.representation.representation,segment.identity.media_time);}
        run_packet_producer(&component_paths,&out,self.kid,self.key,cancel).await?;let bytes=fs::read(out).await.map_err(|_|"Native DASH packet output failed")?;let mut batch=RdpBatch::parse(&bytes)?;let bases=subtitles.iter().enumerate().filter_map(|(n,s)|s.first().map(|first|(3+n as u32,first.identity.media_time,self.snapshot.subtitles[n].template.timescale.unwrap_or(1)))).collect::<Vec<_>>();batch.bridge_ttml(&bases,&mut self.seen_cues)?;for(n,rep)in self.snapshot.subtitles.iter().enumerate(){let meta=rep.subtitle.as_ref().unwrap();batch.metadata[2+n]=TrackMetadata{language:meta.language.clone(),title:meta.label.clone(),default_track:meta.default_track,forced_track:meta.forced_track}}
        if let Some(configs)=&self.configs{if configs!=&batch.configs{return Err("Unsupported native DASH codec/init generation change".into())}}else{self.configs=Some(batch.configs.clone())}
        batch.offset(1,video[0].start.checked_sub(self.origin).map_err(|_|"DASH timestamp overflow")?)?;batch.offset(2,audio[0].start.checked_sub(self.origin).map_err(|_|"DASH timestamp overflow")?)?;
        for(n,segments)in subtitles.iter().enumerate(){if let Some(first)=segments.first(){batch.offset(3+n as u32,first.start.checked_sub(self.origin).map_err(|_|"DASH timestamp overflow")?)?}}
        for segment in video.iter().chain(audio).chain(subtitles.iter().flatten()){self.index.mark(&segment.identity,SegmentState::Demuxed);}
        Ok(batch)
    }
    async fn refresh(&mut self,cancel:&CancellationToken)->Result<(),String>{
        let(body,final_url)=fetch_final(&self.client,self.manifest_url.clone(),cancel,"Manifest refresh failed").await?;
        let candidate=parse_snapshot(&body,final_url,self.snapshot.generation+1,Some(&self.snapshot.representations))?;
        let stats=self.index.merge(&candidate)?;if stats.added==0{log::info!("native DASH refresh produced no newer media");}log_snapshot(&candidate);log_merge(&candidate,&stats);self.snapshot=candidate;Ok(())
    }
    fn pending(&self,kind:MediaKind)->Vec<SegmentDescriptor>{let mut result:Vec<_>=self.index.records.values().filter(|r|r.advertised&&r.state==SegmentState::Known&&r.descriptor.identity.representation.kind==kind).map(|r|r.descriptor.clone()).collect();result.sort_by_key(|s|s.start);result}
}

async fn serve_live(listener:TcpListener,mut runtime:LiveRuntime,first:RdpBatch,cancel:CancellationToken)->Result<(),String>{
    let(mut socket,_)=tokio::select!{_=cancel.cancelled()=>return Ok(()),x=listener.accept()=>x.map_err(|_|"Native DASH packet bridge failed")?};
    let mut request=[0u8;2048];tokio::select!{_=cancel.cancelled()=>return Ok(()),x=socket.read(&mut request)=>x.map_err(|_|"Native DASH packet bridge failed")?};
    write_live(&mut socket,b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",&cancel).await?;
    write_live(&mut socket,&first.header(),&cancel).await?;write_live(&mut socket,&first.records,&cancel).await?;
    if !runtime.snapshot.dynamic{write_live(&mut socket,&0x31464f45u32.to_le_bytes(),&cancel).await?;return Ok(())}
    loop{
        let deadline=runtime.snapshot.published_at+runtime.snapshot.minimum_update_period;let now=Instant::now();if deadline>now{tokio::select!{_=cancel.cancelled()=>return Ok(()),_=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>{}}}
        match runtime.refresh(&cancel).await{Ok(())=>{},Err(e)if e=="Native DASH session cancelled"=>return Ok(()),Err(e)=>{log::warn!("[native-dash] refresh failed; retaining snapshot: {}",e);tokio::select!{_=cancel.cancelled()=>return Ok(()),_=tokio::time::sleep(Duration::from_secs(1))=>{}};continue}}
        let video=runtime.pending(MediaKind::Video);let audio=runtime.pending(MediaKind::Audio);let subtitles=runtime.snapshot.subtitles.iter().map(|rep|{let mut s:Vec<_>=runtime.index.records.values().filter(|r|r.advertised&&r.state==SegmentState::Known&&r.descriptor.identity.representation==rep.identity).map(|r|r.descriptor.clone()).collect();s.sort_by_key(|x|x.start);s}).collect::<Vec<_>>();if video.is_empty()||audio.is_empty()||subtitles.iter().any(Vec::is_empty){log::info!("DASH waiting for newer media");continue}
        let count=video.len().min(audio.len());let subtitle_batches=subtitles.into_iter().map(|s|s.into_iter().take(count).collect()).collect::<Vec<_>>();let batch=runtime.make_batch(&video[..count],&audio[..count],&subtitle_batches,&cancel).await?;write_live(&mut socket,&batch.records,&cancel).await?;
    }
}
async fn write_live(socket:&mut TcpStream,bytes:&[u8],cancel:&CancellationToken)->Result<(),String>{tokio::select!{_=cancel.cancelled()=>Err("Native DASH session cancelled".into()),x=socket.write_all(bytes)=>x.map_err(|_|"Native DASH packet bridge disconnected".into())}}
async fn fetch(client:&reqwest::Client,url:Url,c:&CancellationToken,label:&str)->Result<Vec<u8>,String>{fetch_final(client,url,c,label).await.map(|x|x.0)}
async fn fetch_final(client:&reqwest::Client,url:Url,c:&CancellationToken,label:&str)->Result<(Vec<u8>,Url),String>{let r=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=client.get(url).send()=>x.map_err(|_|label.to_string())?};if !r.status().is_success(){return Err(format!("{}: HTTP {}",label,r.status().as_u16()))}let u=r.url().clone();let b=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=r.bytes()=>x.map_err(|_|label.to_string())?};Ok((b.to_vec(),u))}
fn log_snapshot(s:&ManifestSnapshot){log::info!("DASH manifest generation={} type={} publishTime={}",s.generation,if s.dynamic{"dynamic"}else{"static"},s.publish_time.map(|x|x.to_rfc3339()).unwrap_or_else(||"none".into()));for r in [&s.video,&s.audio]{log::info!("[native-dash] selected {:?} representation id={} codecs={} bandwidth={}",r.identity.kind,r.identity.representation,r.codecs,r.bandwidth)}}
fn log_merge(s:&ManifestSnapshot,m:&MergeStats){log::info!("DASH refresh representation={} old_refs={} new_refs={} added={} retained={} expired={}",s.video.identity.representation,m.retained,m.added+m.retained,m.added,m.retained,m.expired)}

#[derive(Clone,Default,Eq,PartialEq)]struct TrackMetadata{language:String,title:String,default_track:bool,forced_track:bool}
struct RdpBatch{configs:Vec<Vec<u8>>,metadata:Vec<TrackMetadata>,records:Vec<u8>}
impl RdpBatch{
    fn parse(bytes:&[u8])->Result<Self,String>{
        let count=if bytes.len()>=16{u32_at(bytes,12)? as usize}else{0};if bytes.len()<16||&bytes[..8]!=b"RDPKT001"||u32_at(bytes,8)?!=1||!(1..=8).contains(&count){return Err("Native DASH packet output header invalid".into())}
        let mut pos=16;let mut configs=Vec::new();for _ in 0..count{let start=pos;let extra=u32_at(bytes,pos+68)? as usize;pos=pos.checked_add(72+extra).filter(|p|*p<=bytes.len()).ok_or("Native DASH packet output truncated")?;configs.push(bytes[start..pos].to_vec());}
        let start=pos;loop{let record=u32_at(bytes,pos)?;if record==0x31464f45{pos+=4;break}if record!=0x31544b50{return Err("Native DASH packet output record invalid".into())}let size=u32_at(bytes,pos+48)? as usize;pos=pos.checked_add(52+size).filter(|p|*p<=bytes.len()).ok_or("Native DASH packet output truncated")?;}
        if pos!=bytes.len(){return Err("Native DASH packet output has trailing bytes".into())}Ok(Self{metadata:vec![TrackMetadata::default();configs.len()],configs,records:bytes[start..pos-4].to_vec()})
    }
    fn header(&self)->Vec<u8>{let mut out=b"RDPKT004".to_vec();out.extend(4u32.to_le_bytes());out.extend((self.configs.len() as u32).to_le_bytes());for(config,meta)in self.configs.iter().zip(&self.metadata){out.extend(config);let flags=u32::from(meta.default_track)|u32::from(meta.forced_track)<<1;out.extend(flags.to_le_bytes());out.extend((meta.language.len()as u32).to_le_bytes());out.extend(meta.language.as_bytes());out.extend((meta.title.len()as u32).to_le_bytes());out.extend(meta.title.as_bytes())}out}
    fn offset(&mut self,track:u32,offset:ExactTime)->Result<(),String>{let mut pos=0;while pos<self.records.len(){let size=u32_at(&self.records,pos+48)? as usize;if u32_at(&self.records,pos+4)?==track{let num=i32_at(&self.records,pos+36)?;let den=i32_at(&self.records,pos+40)?;if num<=0||den<=0{return Err("Native DASH packet time base invalid".into())}let ticks=offset.rescale(den as u64,crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_|"DASH timestamp overflow")?.checked_div(num as i128).and_then(|v|i64::try_from(v).ok()).ok_or("DASH timestamp overflow")?;for at in [pos+12,pos+20]{let value=i64_at(&self.records,at)?;if value!=i64::MIN{self.records[at..at+8].copy_from_slice(&value.checked_add(ticks).ok_or("DASH timestamp overflow")?.to_le_bytes())}}}pos+=52+size}Ok(())}
    fn bridge_ttml(&mut self,bases:&[(u32,i128,u64)],seen:&mut HashSet<String>)->Result<(),String>{
        let subtitle_ids=self.configs.iter().filter(|c|u32_at(c,8).ok()==Some(3)).map(|c|u32_at(c,0)).collect::<Result<HashSet<_>,_>>()?;if subtitle_ids.is_empty(){return Ok(())}
        for config in &mut self.configs{if u32_at(config,8)?!=3{continue}let id=u32_at(config,0)?;if !bases.iter().any(|b|b.0==id){continue}let mut replacement=config[..68].to_vec();replacement[12..16].copy_from_slice(&1i32.to_le_bytes());replacement[16..20].copy_from_slice(&1000i32.to_le_bytes());replacement.extend((crate::ttml::ASS_HEADER.len() as u32).to_le_bytes());replacement.extend(crate::ttml::ASS_HEADER.as_bytes());*config=replacement}
        let mut output=Vec::new();let mut pos=0;while pos<self.records.len(){let size=u32_at(&self.records,pos+48)? as usize;let end=pos+52+size;let track=u32_at(&self.records,pos+4)?;if !subtitle_ids.contains(&track){output.extend_from_slice(&self.records[pos..end]);pos=end;continue}let Some((_,base_media,timescale))=bases.iter().find(|b|b.0==track)else{output.extend_from_slice(&self.records[pos..end]);pos=end;continue};let tb_num=i32_at(&self.records,pos+36)?;let tb_den=i32_at(&self.records,pos+40)?;let packet_pts=i64_at(&self.records,pos+12)?;let packet_start=ExactTime::new((packet_pts as i128).checked_mul(tb_num as i128).ok_or("TTML time overflow")?,tb_den as u64).map_err(|_|"TTML time overflow")?;let media_base=ExactTime::new(*base_media,*timescale).map_err(|_|"DASH timestamp overflow")?;
            for parsed in crate::ttml::parse_document(&self.records[pos+52..end])?{let(start_time,end_time,payload)=match parsed{crate::ttml::ParsedCue::Text(cue)=>{if !cue.unsupported.is_empty(){log::warn!("[native-dash] unsupported TTML features track={} features={}",track,cue.unsupported.join(","))}(cue.start,cue.end,crate::ttml::ass_payload(&cue).into_bytes())},crate::ttml::ParsedCue::Bitmap(cue)=>(cue.start,cue.end,crate::ttml::bitmap_payload(&cue)?)};let original_start=start_time.checked_sub(media_base).map_err(|_|"TTML time overflow")?;let end_time=end_time.checked_sub(media_base).map_err(|_|"TTML time overflow")?;let mut hasher=DefaultHasher::new();payload.hash(&mut hasher);let key=format!("{track}:{}/{}:{}/{}:{:016x}",original_start.numerator(),original_start.denominator(),end_time.numerator(),end_time.denominator(),hasher.finish());if !seen.insert(key){continue}let start=original_start.max(packet_start);let pts=i64::try_from(start.rescale(1000,crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_|"TTML time overflow")?).map_err(|_|"TTML time overflow")?;let duration=i64::try_from(end_time.checked_sub(start).map_err(|_|"TTML time overflow")?.rescale(1000,crate::dash_timeline::Rounding::NearestTiesAway).map_err(|_|"TTML time overflow")?).map_err(|_|"TTML time overflow")?;if duration>0{append_packet(&mut output,track,pts,duration,&payload)}}pos=end}self.records=output;Ok(())
    }
}
fn append_packet(out:&mut Vec<u8>,track:u32,pts:i64,duration:i64,payload:&[u8]){out.extend(0x31544b50u32.to_le_bytes());out.extend(track.to_le_bytes());out.extend(1u32.to_le_bytes());out.extend(pts.to_le_bytes());out.extend(pts.to_le_bytes());out.extend(duration.to_le_bytes());out.extend(1i32.to_le_bytes());out.extend(1000i32.to_le_bytes());out.extend(0u32.to_le_bytes());out.extend((payload.len()as u32).to_le_bytes());out.extend(payload)}
fn u32_at(bytes:&[u8],at:usize)->Result<u32,String>{Ok(u32::from_le_bytes(bytes.get(at..at+4).ok_or("Native DASH packet output truncated")?.try_into().unwrap()))}
fn i32_at(bytes:&[u8],at:usize)->Result<i32,String>{Ok(i32::from_le_bytes(bytes.get(at..at+4).ok_or("Native DASH packet output truncated")?.try_into().unwrap()))}
fn i64_at(bytes:&[u8],at:usize)->Result<i64,String>{Ok(i64::from_le_bytes(bytes.get(at..at+8).ok_or("Native DASH packet output truncated")?.try_into().unwrap()))}

async fn run_packet_producer(components:&[PathBuf],output:&Path,kid:[u8;16],key:[u8;16],c:&CancellationToken)->Result<(),String>{let default=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../experiments/clearkey-cenc-packet-transform/cenc_component_producer");let producer=std::env::var_os("YNOTV_NATIVE_DASH_PACKET_PRODUCER").map(PathBuf::from).unwrap_or(default);if !producer.is_file(){return Err("Native DASH FFmpeg/ClearKey packet producer is unavailable".into())}let hex=|b:[u8;16]|b.iter().map(|x|format!("{x:02x}")).collect::<String>();let mut cmd=Command::new(producer);cmd.args(components).arg(output).env("RUSTDASH_TEST_KID",hex(kid)).env("RUSTDASH_TEST_KEY",hex(key)).kill_on_drop(true).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());let x=tokio::select!{_=c.cancelled()=>return Err("Native DASH session cancelled".into()),x=cmd.output()=>x.map_err(|_|"Native DASH FFmpeg/ClearKey packet producer is unavailable")?};if x.status.success(){Ok(())}else{let d=String::from_utf8_lossy(&x.stderr);Err(if d.contains("UnsupportedScheme"){"Unsupported CENC scheme"}else if d.contains("Unsupported IMSC"){"Unsupported IMSC image profile"}else if x.status.code()==Some(3){"ClearKey KID unavailable"}else{"CENC decrypt failed"}.into())}}

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
    fn append_and_positive_repeat_growth_preserve_identity() {
        let one=snap(&xml(r#"<S t="100" d="20" r="2"/>"#,100,"PT40S","2026-09-20T00:00:00Z"),1);
        let two=snap(&xml(r#"<S t="100" d="20" r="4"/>"#,100,"PT40S","2026-09-20T00:00:01Z"),2);
        let mut index=SegmentIndex::default(); assert_eq!(index.merge(&one).unwrap().added,4);
        let stats=index.merge(&two).unwrap(); assert_eq!(stats.retained,4); assert_eq!(stats.added,4); assert_eq!(stats.expired,0);
    }

    #[test]
    fn dynamic_initial_snapshot_keeps_two_latest_complete_segments() {
        let snapshot=snap(&xml(r#"<S t="100" d="20" r="5"/>"#,100,"PT40S","2026-09-20T00:00:00Z"),1);
        let segments=initial_segments(&snapshot.video,true).unwrap();
        assert_eq!(segments.len(),2);
        assert_eq!(segments.iter().map(|segment|segment.identity.media_time).collect::<Vec<_>>(),vec![160,180]);
        assert_eq!(segments.iter().map(|segment|segment.number).collect::<Vec<_>>(),vec![103,104]);
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
    fn stale_generation_does_not_reschedule_fetched_segment() {
        let one=snap(&xml(r#"<S t="100" d="20" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),1);
        let two=snap(&xml(r#"<S t="100" d="20" r="3"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),2);
        let mut index=SegmentIndex::default();index.merge(&one).unwrap();let used=index.next(MediaKind::Video).unwrap();index.mark(&used.identity,SegmentState::Fetched);index.mark(&used.identity,SegmentState::Demuxed);
        let stats=index.merge(&two).unwrap();assert_eq!(stats.added,0);assert!(index.next(MediaKind::Video).is_some_and(|s|s.identity!=used.identity));assert!(index.fetched.contains(&used.identity));
    }

    #[test]
    fn mup_is_clamped_and_snapshot_metadata_is_immutable() {
        let s=snap(&xml(r#"<S t="100" d="20" r="2"/>"#,1,"PT40S","2026-09-20T00:00:00Z"),7);
        assert_eq!(s.minimum_update_period,MIN_MUP);assert_eq!(s.generation,7);assert_eq!(s.periods,vec!["p"]);assert_eq!(s.representations.len(),2);assert!(s.fetched_at<=SystemTime::now());assert!(s.published_at<=Instant::now());
    }

    #[test]
    fn c4_packet_file_converts_to_live_framing_and_rebases_timestamps() {
        let path=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../experiments/clearkey-cenc-packet-transform/fixtures/decrypted-av.rdp");
        let bytes=std::fs::read(path).unwrap();let mut batch=RdpBatch::parse(&bytes).unwrap();
        assert_eq!(&batch.header()[..8],b"RDPKT004");assert!(!batch.records.is_empty());
        batch.offset(1,ExactTime::new(2,1).unwrap()).unwrap();
        assert_ne!(batch.records,bytes[bytes.len()-batch.records.len()-4..bytes.len()-4]);
    }

    #[test]
    fn discovers_stpp_and_ttml_subtitles_with_manifest_metadata() {
        let data=br#"<MPD type="dynamic"><Period id="p" duration="PT20S">
          <AdaptationSet id="v" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="v-init" media="v-$Time$"><SegmentTimeline><S t="0" d="5" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="2"/></AdaptationSet>
          <AdaptationSet id="a" contentType="audio" mimeType="audio/mp4"><SegmentTemplate timescale="1" initialization="a-init" media="a-$Time$"><SegmentTimeline><S t="0" d="5" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="1"/></AdaptationSet>
          <AdaptationSet id="s-zh" contentType="text" mimeType="application/mp4" lang="zh"><Label>Traditional Chinese</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Accessibility schemeIdUri="urn:test" value="caption"/><SegmentTemplate timescale="1000" initialization="$RepresentationID$/init" media="$RepresentationID$/$Time$"><SegmentTimeline><S t="0" d="5000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="stpp-zh" bandwidth="10000" codecs="stpp.ttml.im1t"/></AdaptationSet>
          <AdaptationSet id="s-en" mimeType="application/ttml+xml" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="forced-subtitle"/><SegmentTemplate timescale="1000" initialization="text-init" media="text-$Time$"><SegmentTimeline><S t="0" d="5000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="ttml-en" bandwidth="2"/></AdaptationSet>
        </Period></MPD>"#;
        let snapshot=snap(data,1);assert_eq!(snapshot.subtitles.len(),2);assert_eq!(snapshot.representations.len(),4);
        let zh=snapshot.subtitles.iter().find(|s|s.identity.representation=="stpp-zh").unwrap();let meta=zh.subtitle.as_ref().unwrap();
        assert_eq!(zh.codecs,"stpp.ttml.im1t");assert_eq!(meta.language,"zh");assert_eq!(meta.label,"Traditional Chinese");assert!(meta.default_track);assert_eq!(meta.accessibility,vec!["caption"]);
        let en=snapshot.subtitles.iter().find(|s|s.identity.representation=="ttml-en").unwrap();assert!(en.subtitle.as_ref().unwrap().forced_track);
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
        let xml=br#"<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="9.5s" end="10.5s">leading</p><p begin="17.5s" end="18.5s">trailing</p></div></body></tt>"#;let mut records=record(xml);records.extend(record(xml));let mut batch=RdpBatch{configs:vec![config()],metadata:vec![TrackMetadata::default()],records};let mut seen=HashSet::new();batch.bridge_ttml(&[(3,10_000,1000)],&mut seen).unwrap();
        assert_eq!(&batch.configs[0][36..40],b"ttml");assert_eq!(i32_at(&batch.configs[0],12).unwrap(),1);assert_eq!(i32_at(&batch.configs[0],16).unwrap(),1000);assert!(batch.configs[0][72..].starts_with(b"[Script Info]"));let mut pos=0;let mut pts=Vec::new();while pos<batch.records.len(){assert_eq!(i32_at(&batch.records,pos+36).unwrap(),1);assert_eq!(i32_at(&batch.records,pos+40).unwrap(),1000);pts.push(i64_at(&batch.records,pos+12).unwrap());pos+=52+u32_at(&batch.records,pos+48).unwrap()as usize}assert_eq!(pts,vec![0,7500]);assert_eq!(seen.len(),2);
    }
}
