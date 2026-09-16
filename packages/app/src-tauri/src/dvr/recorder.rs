//! Recording manager
//!
//! Manages FFmpeg processes for recording streams.
//! Handles process lifecycle, monitoring, and status updates.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::dvr::database::DvrDatabase;
use crate::dvr::ffmpeg_args::{
    parse_extra_ffmpeg_args, redact_url, stream_type_from_url, ReconnectStrategy, StreamType,
    StreamTypeSource,
};
use crate::dvr::models::{RecordingEvent, RecordingStatus, Schedule, ScheduleStatus, StopReason};
use crate::dvr::stream_resolver::resolve_stream_url;
use crate::dvr::thumbnail::generate_thumbnail;
use rusqlite::OptionalExtension;
use tauri::Emitter;
use tauri_plugin_store::StoreExt;

use tokio::sync::watch;

/// Active recording handle
struct RecordingHandle {
    /// FFmpeg child process (wrapped in Option so we can take ownership)
    process: Option<Child>,
    /// Recording ID in database
    recording_id: i64,
    /// Schedule that triggered this recording
    schedule: Schedule,
    /// When recording started
    start_time: Instant,
    /// Cancellation signal sender (cloned for external use)
    cancel_tx: watch::Sender<bool>,
    /// Output file path for playback while recording
    file_path: PathBuf,
    /// Progress in seconds parsed from FFmpeg output
    progress_seconds: Arc<parking_lot::Mutex<f64>>,
    /// Progress in bytes parsed from FFmpeg output
    progress_bytes: Arc<parking_lot::Mutex<u64>>,
    /// Instant/rolling download speed in bytes/sec
    speed_bytes_instant: Arc<parking_lot::Mutex<u64>>,
}

/// Manages active recordings
pub struct RecordingManager {
    /// Active recordings by schedule ID
    active_recordings: Arc<Mutex<HashMap<i64, RecordingHandle>>>,
    /// Path to FFmpeg binary
    ffmpeg_path: PathBuf,
    /// Default storage directory
    default_storage: PathBuf,
    /// Database reference
    db: Arc<DvrDatabase>,
    /// App handle for emitting events
    app_handle: tauri::AppHandle,
    /// Channel for recording events
    event_tx: mpsc::Sender<RecordingEvent>,
}

impl RecordingManager {
    /// Create a new recording manager
    /// FFmpeg is optional - if not found, recording functionality will be disabled
    pub fn new(
        app_handle: &tauri::AppHandle,
        db: Arc<DvrDatabase>,
    ) -> Result<Self> {
        // Find FFmpeg binary (optional)
        let ffmpeg_path = match find_ffmpeg(app_handle) {
            Ok(path) => {
                info!("Using FFmpeg: {:?}", path);
                path
            }
            Err(e) => {
                println!("[RecordingManager] WARNING: FFmpeg not found: {}", e);
                println!("[RecordingManager] Recording functionality will be disabled");
                // Use a placeholder path - recording will fail later if attempted
                PathBuf::from("ffmpeg")
            }
        };

        // Get default storage path
        let default_storage = get_default_storage_path()?;
        info!("Default storage: {:?}", default_storage);

        // Ensure storage directory exists (only if FFmpeg is available)
        if ffmpeg_path.exists() || which::which(&ffmpeg_path).is_ok() {
            if let Err(e) = std::fs::create_dir_all(&default_storage) {
                println!("[RecordingManager] WARNING: Could not create storage directory: {}", e);
            }
        }

        // Create event channel
        let (event_tx, mut event_rx) = mpsc::channel::<RecordingEvent>(100);

        let manager = Self {
            active_recordings: Arc::new(Mutex::new(HashMap::new())),
            ffmpeg_path,
            default_storage,
            db,
            app_handle: app_handle.clone(),
            event_tx,
        };

        // Start event processing task
        let app_handle_clone = app_handle.clone();
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                if let Err(e) = app_handle_clone.emit("dvr:event", event) {
                    error!("Failed to emit DVR event: {}", e);
                }
            }
        });

        Ok(manager)
    }

    /// Record a scheduled program
    pub async fn record(&self, schedule: Schedule) -> Result<()> {
        // Check if FFmpeg is available
        if !self.ffmpeg_path.exists() && which::which(&self.ffmpeg_path).is_err() {
            return Err(anyhow::anyhow!(
                "FFmpeg is not available. Please install FFmpeg to use recording functionality."
            ));
        }

        // Check if this is a Stalker source that needs real-time URL resolution.
        // The stored URL is only a hint at this point: a playlist served from an
        // extensionless endpoint reads as non-HLS until the resolved URL is checked.
        let hls_url_hint = schedule.stream_url.as_ref().map(|u| u.contains(".m3u8")).unwrap_or(false);

        // Also check if the channel's direct_url indicates Stalker
        let conn = self.db.get_conn()?;
        let direct_url: Option<String> = conn.query_row(
            "SELECT direct_url FROM channels WHERE stream_id = ?1",
            [&schedule.channel_id],
            |row| row.get(0)
        ).optional()?;

        let is_stalker_channel = direct_url.map(|url| url.starts_with("stalker_")).unwrap_or(false);

        let needs_url_resolution = hls_url_hint || is_stalker_channel;

        println!("[DVR Recorder] Channel {}: hls_url_hint={}, is_stalker={}, needs_resolution={}",
                 schedule.channel_id, hls_url_hint, is_stalker_channel, needs_url_resolution);

        let stream_url = if needs_url_resolution {
            // For Stalker/HLS streams, request fresh URL from frontend
            println!("[DVR Recorder] Stalker/HLS stream detected, requesting fresh URL from frontend");

            // Emit event to frontend to resolve URL
            println!("[DVR Recorder] Emitting dvr:resolve_url_now event for schedule {}", schedule.id);
            let emit_result = self.app_handle.emit("dvr:resolve_url_now", serde_json::json!({
                "schedule_id": schedule.id,
                "channel_id": schedule.channel_id,
                "source_id": schedule.source_id,
            }));
            println!("[DVR Recorder] Emit result: {:?}", emit_result);

            // Wait for frontend to resolve and update the URL
            // Stalker resolution takes ~300-500ms, so we wait 1.5s to be safe
            println!("[DVR Recorder] Waiting 1.5s for frontend URL resolution...");
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

            // Re-fetch schedule to get updated URL
            let updated_schedule = self.db.get_schedule(schedule.id)?
                .ok_or_else(|| anyhow::anyhow!("Schedule disappeared"))?;

            if let Some(ref url) = updated_schedule.stream_url {
                println!("[DVR Recorder] Got updated URL from frontend: {}", url);
                url.clone()
            } else {
                // Fall back to original URL if frontend didn't update
                println!("[DVR Recorder] WARNING: Frontend didn't update URL, falling back to resolver");
                resolve_stream_url(&schedule, &self.db).await?
            }
        } else {
            // For non-HLS streams, use normal resolution
            println!("[DVR Recorder] Non-Stalker stream, using normal resolution");
            resolve_stream_url(&schedule, &self.db).await?
        };
        
        // DEBUG: Log the URL being used for recording
        println!("[DVR Recorder] Recording '{}' using URL: {}", schedule.program_title, stream_url);
        println!("[DVR Recorder] Schedule ID: {}, Channel ID: {}", schedule.id, schedule.channel_id);
        println!("[DVR Recorder] Stored stream_url in schedule: {:?}", schedule.stream_url);
        
        debug!("Resolved stream URL for {}", schedule.program_title);

        // Get storage path from settings or use default
        let storage_path = self.get_storage_path().await?;

        // Look up latest channel name/alias from the channels table
        let channel_name = match self.db.get_channel_by_id(&schedule.channel_id) {
            Ok(Some(ch)) => ch.name,
            _ => schedule.channel_name.clone(),
        };

        // Generate unique filename to avoid database file_path collision
        let (filename, output_path) = generate_unique_filename(&self.db, &storage_path, &schedule, &channel_name);

        // "Record until Stop" schedules are stored with scheduled_end == 0:
        // there is no fixed end time — only a user cancel (stop_recording)
        // ends them. FFmpeg gets no -t limit and the end-time waiter below
        // never fires.
        let is_manual_stop = schedule.scheduled_end == 0;

        // Calculate recording duration
        let duration_secs = schedule.actual_end() - schedule.actual_start();

        // Create recording entry in database
        let recording_id = self.db.add_recording(
            schedule.id,
            output_path.to_str().unwrap(),
            &filename,
            &channel_name,
            &schedule.program_title,
            schedule.scheduled_start,
            schedule.scheduled_end,
        )?;

        info!(
            "Recording #{}: {} ({} seconds)",
            recording_id, filename, duration_secs
        );

        // Emit started event
        let event = RecordingEvent::started(&schedule, recording_id);
        let _ = self.event_tx.send(event).await;

        
        // Build FFmpeg command
        let mut cmd = Command::new(&self.ffmpeg_path);
        cmd.arg("-stats");
        
        // Detect if this is a catchup/replay stream (past program or replay URL)
        let now = chrono::Utc::now().timestamp();
        let is_catchup_stream = schedule.scheduled_end <= now
            || stream_url.contains("start=")
            || stream_url.contains("utc=")
            || stream_url.contains("replay")
            || stream_url.contains("timeshift");

        // Resolve appropriate User-Agent (Source UA -> MAC/Stalker default -> Global Live TV UA -> VLC fallback)
        let user_agent = resolve_user_agent(&self.app_handle, &schedule.source_id);
        info!("[DVR Recorder] Using User-Agent for schedule #{} (source '{}'): {}", schedule.id, schedule.source_id, user_agent);
        println!("[DVR Recorder] Using User-Agent: {}", user_agent);

        // Retrieve DVR settings (reconnect strategy, permissive HLS, extra FFmpeg args)
        let dvr_settings = self.db.get_settings().unwrap_or_default();

        // Detect the stream type from the *resolved* URL. Playlists are routinely
        // served from extensionless or tokenised endpoints, so fall back to the
        // response itself instead of trusting the URL.
        let stream_type = match stream_type_from_url(&stream_url) {
            Some(kind) => kind,
            None => probe_stream_type(&stream_url, &user_agent).await,
        };
        let is_hls = stream_type.is_hls;

        // One line per recording saying what it was classified as, what that
        // decision rested on, the flags it produced, and the URL being captured
        // with any credentials stripped. A recording that fails to start, or that
        // stops early, is then attributable from the log alone: the verdict, its
        // evidence, and — when the evidence is `probe-failed` — the fact that it
        // was a guess rather than something the stream said.
        let strategy = ReconnectStrategy::from_setting(&dvr_settings.reconnect_strategy);
        let is_http = stream_url.starts_with("http://") || stream_url.starts_with("https://");
        let http_args = if is_http {
            strategy.http_args(is_hls, is_catchup_stream)
        } else {
            Vec::new()
        };
        info!(
            "[DVR Recorder] #{} (schedule #{}, '{}') stream: {} | catchup: {} | reconnect: {} [{}] | url: {}",
            recording_id,
            schedule.id,
            channel_name,
            stream_type.describe(),
            is_catchup_stream,
            strategy.as_setting(),
            http_args.join(" "),
            redact_url(&stream_url)
        );
        if stream_type.source.is_guess() {
            warn!(
                "[DVR Recorder] #{} could not be classified ({}); recording it as a continuous non-HLS \
                 stream. If it is empty, stops early, or fails with HTTP errors, this guess is why: the \
                 reconnect and HLS flags for it were chosen for a direct stream.",
                recording_id, stream_type.detail
            );
        }
        println!(
            "[DVR Recorder] Stream type: {} ({})",
            if is_hls { "HLS (playlist)" } else { "Direct" },
            stream_type.describe()
        );
        println!(
            "[DVR Recorder] Reconnect strategy: {} (hls={}, catchup={}, flags: {})",
            strategy.as_setting(),
            is_hls,
            is_catchup_stream,
            http_args.join(" ")
        );

        // Remember what is being captured and how, so the recordings list can show
        // it instead of leaving the answer in the log.
        if let Err(e) = self.db.update_recording_stream_info(
            recording_id,
            stream_type.kind(),
            strategy.as_setting(),
        ) {
            error!(
                "[DVR Recorder] Could not store stream info for recording #{}: {}",
                recording_id, e
            );
        }

        // HTTP reconnection & User-Agent flags (must be specified before the input -i)
        if is_http {
            cmd.arg("-user_agent").arg(&user_agent);
            for arg in &http_args {
                cmd.arg(*arg);
            }
        }

        // Extra user input arguments, before the app-owned input
        for arg in validated_extra_args("extra_input_args", &dvr_settings.extra_input_args) {
            cmd.arg(arg);
        }

        // Input flags
        if is_hls {
            if dvr_settings.allow_permissive_hls_extensions {
                // User opted in: Allow non-standard HLS segment extensions (.jpg, .png, .css)
                cmd.arg("-allowed_segment_extensions").arg("ALL");
                cmd.arg("-extension_picky").arg("0");
            }

            if is_catchup_stream {
                // For catchup/replay downloads, start from beginning of playlist and use persistent connection for fast downloading
                cmd.arg("-live_start_index").arg("0");
                cmd.arg("-http_persistent").arg("1");
            } else {
                // For live edge recording, start from live edge
                cmd.arg("-live_start_index").arg("-1");
                cmd.arg("-http_persistent").arg("0");
            }
        }
        
        cmd.arg("-timeout").arg("30000000")  // 30 second read timeout (microseconds)
            .arg("-i").arg(&stream_url)
            .arg("-c").arg("copy")              // Zero transcoding
            .arg("-fflags").arg("+flush_packets");  // Flush packets immediately

        // Extra user output arguments, before the app-owned output options
        for arg in validated_extra_args("extra_output_args", &dvr_settings.extra_output_args) {
            cmd.arg(arg);
        }

        // Record-until-stop schedules have no fixed duration, so FFmpeg must
        // not receive a -t limit — it keeps recording until the user stops it
        // (cancel sends 'q' and/or kills the process). -t is an output option, so
        // it has to precede the output path or FFmpeg treats it as a trailing
        // option and warns that it may be ignored.
        if !is_manual_stop {
            cmd.arg("-t").arg(duration_secs.to_string());
        }

        cmd.arg("-y")                           // Overwrite if exists
            .arg(&output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Hide console window on Windows (CREATE_NO_WINDOW = 0x08000000)
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        // Spawn FFmpeg process
        let started_at = Instant::now();
        let child = match cmd.spawn().context("Failed to spawn FFmpeg") {
            Ok(child) => child,
            Err(e) => {
                // Say which stream and which flags the start failed on: that is
                // the difference between "FFmpeg would not start" and "FFmpeg
                // would not start on this stream with these flags".
                error!(
                    "[DVR Recorder] #{} failed to start FFmpeg (stream: {}; reconnect: {}; url: {}): {}",
                    recording_id,
                    stream_type.describe(),
                    strategy.as_setting(),
                    redact_url(&stream_url),
                    e
                );
                // The recording row already exists, so close it out rather than
                // leaving it in the list as an in-progress recording forever.
                let _ = self.db.update_recording_status(
                    recording_id,
                    RecordingStatus::Failed,
                    Some(0),
                    Some(&e.to_string()),
                    Some(StopReason::StartFailed.as_code()),
                );
                return Err(e);
            }
        };

        // Create cancellation channel
        let (cancel_tx, cancel_rx) = watch::channel(false);

        let progress_seconds = Arc::new(parking_lot::Mutex::new(0.0));
        let progress_bytes = Arc::new(parking_lot::Mutex::new(0));
        let speed_bytes_instant = Arc::new(parking_lot::Mutex::new(0u64));

        // Track active recording
        let handle = RecordingHandle {
            process: Some(child),
            recording_id,
            schedule: schedule.clone(),
            start_time: Instant::now(),
            cancel_tx,
            file_path: output_path.clone(),
            progress_seconds: progress_seconds.clone(),
            progress_bytes: progress_bytes.clone(),
            speed_bytes_instant: speed_bytes_instant.clone(),
        };

        self.active_recordings.lock().insert(schedule.id, handle);

        // Wait for completion
        let (stop_reason, result) = self.wait_for_recording(
            schedule.id,
            recording_id,
            duration_secs,
            is_manual_stop,
            cancel_rx,
            progress_seconds,
            progress_bytes,
            speed_bytes_instant,
        ).await;

        // Remove from active recordings
        self.active_recordings.lock().remove(&schedule.id);

        // The other half of the per-recording pair started before the spawn: what
        // it was classified as, how long it ran, why it stopped, and FFmpeg's own
        // last word when there was one. Together the two lines answer "was this a
        // classification problem or a stream problem?" without a repro.
        //
        // The reason is normalised the same way the stored row is (a catch-up
        // download reaching the end of its playlist is a completion, not a stream
        // that ended early), so the log and the recordings list can't disagree.
        let logged_reason = match stop_reason {
            StopReason::StreamEnded if is_catchup_stream => StopReason::Completed,
            other => other,
        };
        info!(
            "[DVR Recorder] #{} finished after {}s: {} (stream: {}; reconnect: {}; catchup: {}){}",
            recording_id,
            started_at.elapsed().as_secs(),
            logged_reason.as_code(),
            stream_type.describe(),
            strategy.as_setting(),
            is_catchup_stream,
            result
                .as_ref()
                .err()
                .map(|e| format!(" — {}", e))
                .unwrap_or_default()
        );

        // Handle result
        match result {
            Ok(()) => {
                // A clean exit means either the scheduled end was reached, or a
                // finite (catch-up) download ran to the end of its playlist. For a
                // live broadcast it means the stream itself ended before the
                // programme did — worth surfacing rather than reporting a plain
                // success.
                let stop_reason = match stop_reason {
                    StopReason::StreamEnded if is_catchup_stream => StopReason::Completed,
                    other => other,
                };
                info!(
                    "Recording #{} completed successfully ({})",
                    recording_id,
                    stop_reason.as_code()
                );

                // Get final file size
                let file_size = std::fs::metadata(&output_path)
                    .map(|m| m.len() as i64)
                    .ok();

                // Update recording status with file size
                self.db.update_recording_status(
                    recording_id,
                    RecordingStatus::Completed,
                    file_size,
                    None,
                    Some(stop_reason.as_code()),
                )?;

                // Update schedule status to completed
                self.db.update_schedule_status(schedule.id, ScheduleStatus::Completed)?;

                // Get storage path for thumbnail generation
                let storage_path = self.get_storage_path().await?;

                // Generate thumbnail & optional auto-conversion sequentially in background
                let video_path = output_path.to_string_lossy().to_string();
                let db = self.db.clone();
                let app_handle_clone = self.app_handle.clone();
                let recording_id_for_thumb = recording_id;
                let storage_path_for_thumb = storage_path.to_string_lossy().to_string();
                let schedule_clone = schedule.clone();

                tokio::spawn(async move {
                    // 1. Generate thumbnail
                    match generate_thumbnail(&video_path, recording_id_for_thumb, &storage_path_for_thumb).await {
                        Ok(Some(thumb_path)) => {
                            if let Err(e) = db.update_recording_thumbnail(
                                recording_id_for_thumb,
                                thumb_path.to_str().unwrap_or(""),
                            ) {
                                error!("Failed to update thumbnail path in database: {}", e);
                            }
                        }
                        Ok(None) => {
                            warn!("Thumbnail generation returned None for recording {}", recording_id_for_thumb);
                        }
                        Err(e) => {
                            error!("Thumbnail generation failed for recording {}: {}", recording_id_for_thumb, e);
                        }
                    }

                    // 2. Auto-conversion
                    let settings = db.get_settings().unwrap_or_default();
                    let auto_convert = settings.auto_convert_format.to_lowercase();
                    if auto_convert == "mp4" || auto_convert == "mkv" {
                        info!("[DVR Recorder] Auto converting completed recording #{} to {}", recording_id_for_thumb, auto_convert);
                        if let Err(e) = convert_recording_to_format(&app_handle_clone, &db, recording_id_for_thumb, &auto_convert).await {
                            error!("[DVR Recorder] Auto conversion failed for recording #{}: {}", recording_id_for_thumb, e);
                        } else {
                            // Emit completed event again to notify frontend about the format change
                            let _ = app_handle_clone.emit("dvr:event", RecordingEvent::completed(&schedule_clone, recording_id_for_thumb));
                        }
                    }
                });

                // Emit completed event
                let event = RecordingEvent::completed(&schedule, recording_id);
                let _ = self.event_tx.send(event).await;

                Ok(())
            }
            Err(e) => {
                error!("Recording #{} failed: {}", recording_id, e);

                // Check if file was partially created
                let file_size = std::fs::metadata(&output_path)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);

                let status = if file_size > 0 {
                    RecordingStatus::Partial
                } else {
                    RecordingStatus::Failed
                };

                // Update database
                self.db.update_recording_status(
                    recording_id,
                    status.clone(),
                    Some(file_size),
                    Some(&e.to_string()),
                    Some(stop_reason.as_code()),
                )?;

                // For partial recordings, also generate a thumbnail
                if file_size > 0 {
                    let storage_path = self.get_storage_path().await?;
                    let video_path = output_path.to_string_lossy().to_string();
                    let db = self.db.clone();
                    let recording_id_for_thumb = recording_id;
                    let storage_path_for_thumb = storage_path.to_string_lossy().to_string();

                    tokio::spawn(async move {
                        match generate_thumbnail(&video_path, recording_id_for_thumb, &storage_path_for_thumb).await {
                            Ok(Some(thumb_path)) => {
                                if let Err(e) = db.update_recording_thumbnail(
                                    recording_id_for_thumb,
                                    thumb_path.to_str().unwrap_or(""),
                                ) {
                                    error!("Failed to update thumbnail path for partial recording: {}", e);
                                }
                            }
                            Ok(None) => {
                                warn!("Thumbnail generation returned None for partial recording {}", recording_id_for_thumb);
                            }
                            Err(e) => {
                                error!("Thumbnail generation failed for partial recording {}: {}", recording_id_for_thumb, e);
                            }
                        }
                    });
                }

                // Emit failed event
                let event = RecordingEvent::failed(&schedule, e.to_string());
                let _ = self.event_tx.send(event).await;

                Err(e)
            }
        }
    }

    /// Wait for a recording to complete
    async fn wait_for_recording(
        &self,
        schedule_id: i64,
        recording_id: i64,
        expected_duration: i64,
        manual_stop: bool,
        mut cancel_rx: watch::Receiver<bool>,
        progress_seconds: Arc<parking_lot::Mutex<f64>>,
        progress_bytes: Arc<parking_lot::Mutex<u64>>,
        speed_bytes_instant: Arc<parking_lot::Mutex<u64>>,
    ) -> (StopReason, Result<()>) {
        // Take ownership of the process from the handle. These are pre-flight
        // failures: the recording loop never got going at all.
        let mut child = {
            let mut recordings = self.active_recordings.lock();
            let Some(handle) = recordings.get_mut(&schedule_id) else {
                return (
                    StopReason::StartFailed,
                    Err(anyhow::anyhow!("Recording handle not found")),
                );
            };
            match handle.process.take() {
                Some(process) => process,
                None => {
                    return (
                        StopReason::StartFailed,
                        Err(anyhow::anyhow!("Recording process already taken")),
                    )
                }
            }
        };

        // Start a task to capture stderr.
        // IMPORTANT: FFmpeg writes progress stats with \r (carriage return) not \n.
        // We must read raw bytes and split on both \r and \n to capture real-time progress.
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                return (
                    StopReason::StartFailed,
                    Err(anyhow::anyhow!("Failed to take stderr")),
                )
            }
        };

        let progress_seconds_clone = progress_seconds.clone();
        let progress_bytes_clone = progress_bytes.clone();
        let speed_bytes_instant_clone = speed_bytes_instant.clone();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::<u8>::new();
            let mut output = String::new();
            let mut raw_byte = [0u8; 1];
            // Track previous bytes + timestamp for rolling speed
            let mut last_bytes: u64 = 0;
            let mut last_speed_time = Instant::now();

            loop {
                match reader.read(&mut raw_byte).await {
                    Ok(0) => break, // EOF
                    Err(_) => break,
                    Ok(_) => {
                        let byte = raw_byte[0];
                        if byte == b'\r' || byte == b'\n' {
                            if !buf.is_empty() {
                                let line = String::from_utf8_lossy(&buf).to_string();
                                buf.clear();

                                let (secs, size_bytes) = parse_ffmpeg_line(&line);
                                if let Some(s) = secs {
                                    *progress_seconds_clone.lock() = s;
                                }
                                if let Some(b) = size_bytes {
                                    *progress_bytes_clone.lock() = b;
                                    // Compute rolling speed over the last interval
                                    let elapsed = last_speed_time.elapsed().as_secs_f64();
                                    if elapsed >= 0.5 && b > last_bytes {
                                        let speed = ((b - last_bytes) as f64 / elapsed) as u64;
                                        *speed_bytes_instant_clone.lock() = speed;
                                        last_bytes = b;
                                        last_speed_time = Instant::now();
                                    } else if elapsed >= 5.0 {
                                        // No new data for 5s — reset speed to 0
                                        *speed_bytes_instant_clone.lock() = 0;
                                        last_speed_time = Instant::now();
                                    }
                                }

                                println!("[FFmpeg #{}] {}", recording_id, line);
                                output.push_str(&line);
                                output.push('\n');
                            }
                        } else {
                            buf.push(byte);
                        }
                    }
                }
            }

            output
        });

        // Wrap in Option to handle timeout case
        let mut stderr_task_opt = Some(stderr_task);

        // Take stdin to send 'q' signal for graceful stopping
        let stdin = child.stdin.take();

        // Calculate absolute end time, using DB schedule if possible.
        // Record-until-stop schedules (scheduled_end == 0) have no end: the
        // waiter is pointed ~100 years out so only a user cancel can stop it.
        let mut actual_end_time = if manual_stop {
            chrono::Utc::now().timestamp() + 100 * 365 * 24 * 3600
        } else if let Ok(Some(s)) = self.db.get_schedule(schedule_id) {
            s.actual_end()
        } else {
            chrono::Utc::now().timestamp() + expected_duration
        };

        info!("Recording #{} started, expected to end at timestamp: {} (duration: {}s)", 
              recording_id, actual_end_time, expected_duration);

        // Wait for completion, schedule end, OR cancellation
        let result = tokio::select! {
            // Normal completion (FFmpeg exited on its own)
            status = child.wait() => {
                // An exit we did not ask for. A clean one means the input ended
                // before the scheduled end, unless it is a finite (catch-up)
                // download, where reaching the end is the expected result.
                let reason = match &status {
                    Ok(s) if s.success() => StopReason::StreamEnded,
                    _ => StopReason::FfmpegError,
                };

                // Get stderr output
                let stderr_task = stderr_task_opt.take()
                    .expect("stderr_task should exist");
                let stderr_output = match tokio::time::timeout(
                    Duration::from_secs(5),
                    stderr_task
                ).await {
                    Ok(Ok(output)) => output,
                    _ => "(stderr capture timed out or failed)".to_string(),
                };

                let outcome = match status {
                    Ok(s) if s.success() => Ok(()),
                    Ok(s) => {
                        let code = s.code().unwrap_or(-1);
                        // error!, not eprintln!: in a release build there is no
                        // console attached to the process, so the one piece of
                        // output that explains a failed recording has to go to the
                        // log file like everything else.
                        error!(
                            "[DVR Recorder] FFmpeg exited with code {} for recording #{}; full stderr:\n{}",
                            code, recording_id, stderr_output
                        );
                        Err(anyhow::anyhow!("FFmpeg exited with code {}: {}", code, stderr_output.lines().last().unwrap_or("unknown error")))
                    }
                    Err(e) => Err(anyhow::anyhow!("FFmpeg wait error: {}", e))
                };

                (reason, outcome)
            }

            // Cancelled by user
            _ = cancel_rx.changed() => {
                info!("Recording #{} cancelled by user, stopping FFmpeg gracefully...", recording_id);
                let mut gracefully_stopped = false;
                if let Some(mut stdin_pipe) = stdin {
                    use tokio::io::AsyncWriteExt;
                    if stdin_pipe.write_all(b"q\n").await.is_ok() && stdin_pipe.flush().await.is_ok() {
                        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                            Ok(Ok(status)) => {
                                if status.success() {
                                    info!("Recording #{} stopped gracefully via stdin 'q' on user cancellation", recording_id);
                                } else {
                                    warn!("Recording #{} FFmpeg exited with non-zero code {} after graceful cancel", recording_id, status.code().unwrap_or(-1));
                                }
                                gracefully_stopped = true;
                            }
                            _ => {}
                        }
                    }
                }
                if !gracefully_stopped {
                    let _ = child.kill().await;
                }
                if let Some(task) = stderr_task_opt {
                    task.abort();
                }
                (
                    StopReason::StoppedByUser,
                    Err(anyhow::anyhow!("Recording cancelled by user")),
                )
            }

            // Target duration / end time reached
            _ = async {
                let now = chrono::Utc::now().timestamp();
                if actual_end_time <= now {
                    // Past recording (catch-up download). Let FFmpeg run to completion naturally.
                    tokio::time::sleep(Duration::from_secs(3600 * 24 * 365 * 10)).await;
                }

                loop {
                    let now = chrono::Utc::now().timestamp();
                    if now >= actual_end_time {
                        break;
                    }

                    // Sleep for up to 5 seconds
                    let sleep_duration = std::cmp::max(1, std::cmp::min(5, actual_end_time - now));
                    tokio::time::sleep(Duration::from_secs(sleep_duration as u64)).await;

                    // Poll database to check if schedule end time / padding changed
                    match self.db.get_schedule(schedule_id) {
                        Ok(Some(updated_schedule)) => {
                            // Manual (record-until-stop) schedules keep their
                            // far-future end — padding edits must not let the
                            // end-time waiter fire and cut the recording.
                            let new_end = if updated_schedule.scheduled_end == 0 {
                                actual_end_time
                            } else {
                                updated_schedule.actual_end()
                            };
                            if new_end != actual_end_time {
                                info!("Recording #{} scheduled end time updated dynamically: {} -> {}", 
                                      recording_id, actual_end_time, new_end);
                                actual_end_time = new_end;
                            }
                        }
                        Ok(None) => {
                            warn!("Recording #{} schedule record disappeared from database", recording_id);
                        }
                        Err(e) => {
                            warn!("Recording #{} failed to query updated schedule: {}", recording_id, e);
                        }
                    }
                }
            } => {
                info!("Recording #{} reached scheduled end time ({}). Stopping FFmpeg gracefully...", 
                      recording_id, actual_end_time);

                let mut gracefully_stopped = false;
                if let Some(mut stdin_pipe) = stdin {
                    use tokio::io::AsyncWriteExt;
                    if stdin_pipe.write_all(b"q\n").await.is_ok() && stdin_pipe.flush().await.is_ok() {
                        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                            Ok(Ok(status)) => {
                                if status.success() {
                                    info!("Recording #{} stopped gracefully via stdin 'q'", recording_id);
                                } else {
                                    warn!("Recording #{} FFmpeg exited with non-zero code {} after graceful stop", recording_id, status.code().unwrap_or(-1));
                                }
                                gracefully_stopped = true;
                            }
                            _ => {}
                        }
                    }
                }

                if !gracefully_stopped {
                    warn!("Recording #{} could not be stopped gracefully, killing process", recording_id);
                    let _ = child.kill().await;
                }

                (StopReason::Completed, Ok(()))
            }
        };

        result
    }

    /// Stop a specific recording by schedule ID
    pub async fn stop_recording(&self, schedule_id: i64) -> Result<()> {
        println!("[DVR Recorder] stop_recording called for schedule {}", schedule_id);
        info!("Stopping recording for schedule {}", schedule_id);

        // Debug: print all active recordings
        {
            let recordings = self.active_recordings.lock();
            println!("[DVR Recorder] Active recordings: {:?}", recordings.keys().collect::<Vec<_>>());
        }

        // Get the cancel_tx sender
        let cancel_tx = {
            let recordings = self.active_recordings.lock();
            recordings.get(&schedule_id).map(|h| h.cancel_tx.clone())
        };

        if let Some(cancel_tx) = cancel_tx {
            println!("[DVR Recorder] Found recording, sending cancellation signal");
            info!("Sending cancellation signal for schedule {}", schedule_id);
            let _ = cancel_tx.send(true);

            // Give the cancellation a moment to be processed, then kill directly
            tokio::time::sleep(Duration::from_millis(100)).await;

            // Also try to kill the process directly
            // Take the process out of the handle while the lock is held, then kill outside
            let process_to_kill = {
                let mut recordings = self.active_recordings.lock();
                recordings.get_mut(&schedule_id).and_then(|h| h.process.take())
            };
            if let Some(mut process) = process_to_kill {
                println!("[DVR Recorder] Killing FFmpeg process directly");
                let _ = process.kill().await;
                info!("Killed FFmpeg process for schedule {}", schedule_id);
            } else {
                println!("[DVR Recorder] Process already taken (likely already stopped)");
            }
        } else {
            println!("[DVR Recorder] No active recording found for schedule {}", schedule_id);
            info!("No active recording found for schedule {}", schedule_id);
        }

        Ok(())
    }

    /// Stop all active recordings
    pub async fn stop_all_recordings(&self) -> Result<()> {
        let recordings: Vec<i64> = {
            let guard = self.active_recordings.lock();
            guard.keys().copied().collect()
        };

        info!("Stopping {} active recordings", recordings.len());

        for schedule_id in recordings {
            if let Some(mut handle) = self.active_recordings.lock().remove(&schedule_id) {
                if let Some(mut process) = handle.process.take() {
                    let _ = process.kill().await;
                }

                // Update status
                let _ = self.db.update_schedule_status(schedule_id, ScheduleStatus::Canceled);
            }
        }

        Ok(())
    }

    /// Get storage path from settings
    async fn get_storage_path(&self) -> Result<PathBuf> {
        let settings = self.db.get_settings()?;

        if settings.storage_path.is_empty() {
            Ok(self.default_storage.clone())
        } else {
            let path = PathBuf::from(&settings.storage_path);
            std::fs::create_dir_all(&path)?;
            Ok(path)
        }
    }

    /// Get active recordings with their current progress
    pub fn get_active_recordings(&self) -> Vec<RecordingProgress> {
        let recordings = self.active_recordings.lock();
        recordings
            .values()
            .map(|handle| {
                let elapsed = handle.start_time.elapsed().as_secs() as i64;
                let file_path = handle.file_path.to_string_lossy().to_string();
                let secs = *handle.progress_seconds.lock();
                let bytes = *handle.progress_bytes.lock();
                // Use the rolling instant speed if available (updated by the stderr reader),
                // falling back to the average speed over the whole session.
                let instant_speed = *handle.speed_bytes_instant.lock();
                let speed = if instant_speed > 0 {
                    instant_speed
                } else if handle.start_time.elapsed().as_secs_f64() > 0.0 && bytes > 0 {
                    (bytes as f64 / handle.start_time.elapsed().as_secs_f64()) as u64
                } else {
                    0
                };
                RecordingProgress {
                    schedule_id: handle.schedule.id,
                    recording_id: handle.recording_id,
                    channel_name: handle.schedule.channel_name.clone(),
                    program_title: handle.schedule.program_title.clone(),
                    elapsed_seconds: elapsed,
                    scheduled_duration: handle.schedule.scheduled_end - handle.schedule.scheduled_start,
                    file_path,
                    progress_seconds: Some(secs),
                    progress_bytes: Some(bytes),
                    speed_bytes: Some(speed),
                }
            })
            .collect()
    }
}

/// Progress information for an active recording
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecordingProgress {
    pub schedule_id: i64,
    pub recording_id: i64,
    pub channel_name: String,
    pub program_title: String,
    pub elapsed_seconds: i64,
    pub scheduled_duration: i64,
    pub file_path: String,
    pub progress_seconds: Option<f64>,
    pub progress_bytes: Option<u64>,
    pub speed_bytes: Option<u64>,
}

/// Find FFmpeg binary
pub fn find_ffmpeg(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;

    // First try to resolve as a sidecar (bundled external binary)
    // Sidecars are placed in the same directory as the main executable
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            // Sidecar naming: ffmpeg.exe on Windows, ffmpeg on Unix
            let sidecar_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            let sidecar_path = dir.join(&sidecar_name);
            if sidecar_path.exists() {
                println!("[FFmpeg] Found sidecar at: {:?}", sidecar_path);
                return Ok(sidecar_path);
            }

            // Also check for platform-specific names (tauri bundles with target triple)
            #[cfg(target_os = "windows")]
            let platform_ffmpeg = dir.join("ffmpeg-x86_64-pc-windows-msvc.exe");
            #[cfg(target_os = "macos")]
            let platform_ffmpeg = dir.join("ffmpeg-x86_64-apple-darwin");
            #[cfg(target_os = "linux")]
            let platform_ffmpeg = dir.join("ffmpeg-x86_64-unknown-linux-gnu");

            if platform_ffmpeg.exists() {
                println!("[FFmpeg] Found platform-specific binary at: {:?}", platform_ffmpeg);
                return Ok(platform_ffmpeg);
            }
        }
    }

    // Try bundled FFmpeg in resources (legacy path)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let bundled = resource_dir.join("bin").join("ffmpeg-x86_64-pc-windows-msvc.exe");

        #[cfg(target_os = "macos")]
        let bundled = resource_dir.join("bin").join("ffmpeg-x86_64-apple-darwin");

        #[cfg(target_os = "linux")]
        let bundled = resource_dir.join("bin").join("ffmpeg-x86_64-unknown-linux-gnu");

        if bundled.exists() {
            println!("[FFmpeg] Found in resources: {:?}", bundled);
            return Ok(bundled);
        }
    }

    // Try development path
    #[cfg(debug_assertions)]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

        if dev_path.exists() {
            println!("[FFmpeg] Found in dev path: {:?}", dev_path);
            return Ok(dev_path);
        }
    }

    // Fallback to system FFmpeg
    let ffmpeg = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

    // Check PATH
    if let Ok(path) = which::which(ffmpeg) {
        println!("[FFmpeg] Found in PATH: {:?}", path);
        return Ok(path);
    }

    Err(anyhow::anyhow!(
        "FFmpeg not found. Please install FFmpeg or ensure it's bundled with the app."
    ))
}

/// Get default storage path
fn get_default_storage_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Failed to get home directory")?;
    let path = home.join("Videos").join("IPTV-Recordings");
    Ok(path)
}

/// Generate filename for recording
fn generate_filename(schedule: &Schedule, channel_name: &str) -> String {
    let timestamp = chrono::DateTime::from_timestamp(schedule.scheduled_start, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H-%M-%S").to_string())
        .unwrap_or_else(|| "unknown".to_string());

    // Sanitize for Windows
    let sanitized_title: String = schedule
        .program_title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .take(50)
        .collect();

    let sanitized_channel: String = channel_name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .take(30)
        .collect();

    format!("{}_{}_{}.ts", timestamp, sanitized_channel, sanitized_title)
}

/// Extra FFmpeg arguments from settings, validated.
///
/// Invalid input never fails a recording: the arguments are reported and dropped
/// so the recording still runs with the app's own flags. The settings UI applies
/// the same rules before saving, making this a safety net rather than the gate.
fn validated_extra_args(key: &str, raw: &str) -> Vec<String> {
    match parse_extra_ffmpeg_args(raw) {
        Ok(args) => args,
        Err(reason) => {
            error!("[DVR Recorder] Ignoring {} from settings: {}", key, reason);
            Vec::new()
        }
    }
}

/// Probe a stream for an HLS playlist when its URL gives no hint.
///
/// Live IPTV playlists are commonly served from extensionless or tokenised
/// endpoints, so the response is the only signal available. Best effort: any
/// failure returns false, which keeps the behaviour of a plain URL check.
/// Ask the response itself what the stream is, for a URL that said nothing.
///
/// Every branch reports its evidence: this verdict decides the reconnect and HLS
/// flags for the whole recording, so a probe that fails is a *guess* that the
/// stream is continuous, and the log has to say so rather than leave a broken
/// recording to be explained by inference.
async fn probe_stream_type(stream_url: &str, user_agent: &str) -> StreamType {
    let started = Instant::now();
    let probe_ms = |started: &Instant| started.elapsed().as_millis() as u64;

    if !(stream_url.starts_with("http://") || stream_url.starts_with("https://")) {
        return StreamType {
            is_hls: false,
            source: StreamTypeSource::NotHttp,
            detail: "not an http(s) URL".to_string(),
            probe_ms: 0,
        };
    }

    println!("[DVR Recorder] URL gives no stream type hint, probing the stream...");

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            return StreamType {
                is_hls: false,
                source: StreamTypeSource::ProbeFailed,
                detail: format!("http client unavailable: {e}"),
                probe_ms: probe_ms(&started),
            }
        }
    };

    let response = match client
        .get(stream_url)
        .header(reqwest::header::USER_AGENT, user_agent)
        // A playlist is tiny; never pull more than a token from the stream.
        .header(reqwest::header::RANGE, "bytes=0-2047")
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => {
            let detail = if e.is_timeout() {
                "probe timed out after 4s".to_string()
            } else {
                format!("probe request failed: {e}")
            };
            println!(
                "[DVR Recorder] Stream probe failed ({}), assuming a direct stream",
                detail
            );
            return StreamType {
                is_hls: false,
                source: StreamTypeSource::ProbeFailed,
                detail,
                probe_ms: probe_ms(&started),
            };
        }
    };

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("mpegurl") {
        return StreamType {
            is_hls: true,
            source: StreamTypeSource::ContentType,
            detail: format!("content-type '{content_type}'"),
            probe_ms: probe_ms(&started),
        };
    }

    // Some portals serve playlists with no useful Content-Type, where the
    // `#EXTM3U` marker is the only answer. Read a bounded amount so a live stream
    // that ignores the Range request cannot buffer without limit.
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while body.len() < 2048 {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }

    let is_hls = String::from_utf8_lossy(&body)
        .trim_start()
        .starts_with("#EXTM3U");
    let detail = if is_hls {
        format!("content-type '{content_type}', body starts with #EXTM3U")
    } else {
        format!("content-type '{content_type}', no #EXTM3U in the first 2KB")
    };
    println!(
        "[DVR Recorder] Stream probe: {}",
        if is_hls {
            "playlist".to_string()
        } else {
            format!("not a playlist ({detail})")
        }
    );

    StreamType {
        is_hls,
        source: StreamTypeSource::PlaylistHeader,
        detail,
        probe_ms: probe_ms(&started),
    }
}

/// Generate a unique filename and output path to prevent UNIQUE constraint collisions in SQLite or on disk
fn generate_unique_filename(db: &DvrDatabase, storage_path: &Path, schedule: &Schedule, channel_name: &str) -> (String, PathBuf) {
    let base_filename = generate_filename(schedule, channel_name);
    let (stem, ext) = match base_filename.rfind('.') {
        Some(idx) => (&base_filename[..idx], &base_filename[idx + 1..]),
        None => (base_filename.as_str(), "ts"),
    };

    let mut counter = 0;
    loop {
        let filename = if counter == 0 {
            format!("{}.{}", stem, ext)
        } else {
            format!("{}_{}.{}", stem, counter, ext)
        };

        let output_path = storage_path.join(&filename);
        let path_str = output_path.to_string_lossy().to_string();

        let exists_in_db = db.file_path_exists(&path_str).unwrap_or(false);
        if !exists_in_db && !output_path.exists() {
            return (filename, output_path);
        }

        counter += 1;
    }
}

/// Convert a recording from .ts to mp4 or mkv using FFmpeg copy (lossless remuxing)
pub async fn convert_recording_to_format(
    app_handle: &tauri::AppHandle,
    db: &DvrDatabase,
    recording_id: i64,
    format: &str,
) -> Result<()> {
    let format = format.to_lowercase();
    if format != "mp4" && format != "mkv" {
        return Err(anyhow::anyhow!("Unsupported conversion format: {}", format));
    }

    // 1. Get recording from database
    let recording = db.get_recording(recording_id)?
        .ok_or_else(|| anyhow::anyhow!("Recording not found"))?;

    let input_path = PathBuf::from(&recording.file_path);
    if !input_path.exists() {
        return Err(anyhow::anyhow!("Recording file does not exist on disk: {:?}", input_path));
    }

    // 2. Generate output path
    let output_path = input_path.with_extension(&format);
    if input_path == output_path {
        return Err(anyhow::anyhow!("Input and output formats are the same: {}", format));
    }

    // Find FFmpeg binary path
    let ffmpeg_path = find_ffmpeg(app_handle)?;

    // 3. Build and execute FFmpeg command
    info!(
        "[DVR Converter] Converting recording #{} from .ts to .{} ({:?})",
        recording_id, format, output_path
    );

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.arg("-i").arg(&input_path)
       .arg("-c").arg("copy")
       .arg("-map").arg("0")
       .arg("-y")
       .arg(&output_path)
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // Hide console window

    let mut child = cmd.spawn().context("Failed to spawn FFmpeg for conversion")?;
    
    // Capture stderr output for logging on failure
    let stderr = child.stderr.take().context("Failed to capture FFmpeg stderr")?;
    let stderr_task = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let mut last_error_line = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            last_error_line = line;
        }
        last_error_line
    });

    let status = child.wait().await.context("FFmpeg conversion process failed")?;
    
    let last_err = stderr_task.await.unwrap_or_default();

    if !status.success() {
        // If it failed, delete output_path if it was partially created
        if output_path.exists() {
            let _ = std::fs::remove_file(&output_path);
        }
        return Err(anyhow::anyhow!(
            "FFmpeg conversion exited with error: {}",
            if last_err.is_empty() { "unknown error".to_string() } else { last_err }
        ));
    }

    // 4. Update database with new file info
    let file_size = std::fs::metadata(&output_path)
        .context("Failed to read converted file metadata")?
        .len() as i64;
    let new_filename = output_path.file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid filename"))?
        .to_string_lossy().to_string();
    let new_filepath_str = output_path.to_string_lossy().to_string();

    db.update_recording_file_info(recording_id, &new_filepath_str, &new_filename, file_size)?;

    // 5. Delete original .ts file
    if let Err(e) = std::fs::remove_file(&input_path) {
        warn!("[DVR Converter] Failed to delete original file {:?}: {}", input_path, e);
    } else {
        info!("[DVR Converter] Deleted original .ts file: {:?}", input_path);
    }

    info!("[DVR Converter] Recording #{} successfully converted to .{}", recording_id, format);
    Ok(())
}

fn parse_ffmpeg_line(line: &str) -> (Option<f64>, Option<u64>) {
    let mut secs = None;
    let mut size_bytes = None;
    
    if let Some(pos) = line.rfind("time=") {
        let time_part = &line[pos + 5..];
        let val_str = time_part.split_whitespace().next().unwrap_or("");
        let parts: Vec<&str> = val_str.split(':').collect();
        if parts.len() == 3 {
            if let (Ok(h), Ok(m), Ok(s)) = (
                parts[0].parse::<f64>(),
                parts[1].parse::<f64>(),
                parts[2].parse::<f64>(),
            ) {
                secs = Some(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    
    if let Some(pos) = line.rfind("size=") {
        let size_part = &line[pos + 5..];
        let val_str = size_part.split_whitespace().next().unwrap_or("");
        let clean_val: String = val_str.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(kb) = clean_val.parse::<u64>() {
            size_bytes = Some(kb * 1024);
        }
    }
    
    (secs, size_bytes)
}

/// Helper to resolve the appropriate User-Agent string from sources and settings JSON data
pub fn resolve_user_agent_from_values(
    sources_val: Option<&serde_json::Value>,
    settings_val: Option<&serde_json::Value>,
    source_id: &str,
) -> String {
    let mut source_ua: Option<String> = None;
    let mut source_type: Option<String> = None;

    if let Some(sources) = sources_val.and_then(|v| v.as_array()) {
        for src in sources {
            if src.get("id").and_then(|v| v.as_str()) == Some(source_id) {
                source_type = src.get("type").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(ua) = src.get("user_agent").and_then(|v| v.as_str()) {
                    let trimmed = ua.trim();
                    if !trimmed.is_empty() {
                        source_ua = Some(trimmed.to_string());
                    }
                }
                break;
            }
        }
    }

    // 1. If source has a custom configured User-Agent, use it
    if let Some(ua) = source_ua {
        return ua;
    }

    // 2. If it's a MAC/Stalker source with no custom UA, use the standard MAG/Stalker default UA
    let is_stalker = source_type.as_deref() == Some("stalker") || source_id.starts_with("stalker_");
    if is_stalker {
        return "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3".to_string();
    }

    // 3. Check global Live TV User-Agent from settings
    if let Some(settings) = settings_val {
        let nested = settings.get("settings").and_then(|v| v.as_object());
        let global_ua = nested
            .and_then(|obj| obj.get("globalLiveTvUserAgent"))
            .or_else(|| settings.get("globalLiveTvUserAgent"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        if let Some(ua) = global_ua {
            return ua;
        }
    }

    // 4. Default fallback
    "VLC/3.0.18 LibVLC/3.0.18".to_string()
}

/// Resolve the appropriate User-Agent for a recording given the app handle and source ID
pub fn resolve_user_agent(app_handle: &tauri::AppHandle, source_id: &str) -> String {
    match app_handle.store(".settings.dat") {
        Ok(store) => {
            let sources_val = store.get("sources");
            let settings_val = store.get("settings").or_else(|| {
                let mut map = serde_json::Map::new();
                if let Some(global_ua) = store.get("globalLiveTvUserAgent") {
                    map.insert("globalLiveTvUserAgent".to_string(), global_ua);
                }
                Some(serde_json::Value::Object(map))
            });

            resolve_user_agent_from_values(sources_val.as_ref(), settings_val.as_ref(), source_id)
        }
        Err(e) => {
            warn!("[DVR Recorder] Could not access .settings.dat store: {}. Falling back to default User-Agent.", e);
            if source_id.starts_with("stalker_") {
                "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3".to_string()
            } else {
                "VLC/3.0.18 LibVLC/3.0.18".to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_resolve_user_agent_source_custom() {
        let sources = json!([
            {
                "id": "src_1",
                "type": "xtream",
                "user_agent": "TiviMate/4.6.0"
            }
        ]);
        let settings = json!({
            "settings": {
                "globalLiveTvUserAgent": "GlobalUA/1.0"
            }
        });

        let ua = resolve_user_agent_from_values(Some(&sources), Some(&settings), "src_1");
        assert_eq!(ua, "TiviMate/4.6.0");
    }

    #[test]
    fn test_resolve_user_agent_stalker_default() {
        let sources = json!([
            {
                "id": "src_stalker",
                "type": "stalker",
                "user_agent": ""
            }
        ]);
        let settings = json!({
            "settings": {
                "globalLiveTvUserAgent": "GlobalUA/1.0"
            }
        });

        let ua = resolve_user_agent_from_values(Some(&sources), Some(&settings), "src_stalker");
        assert_eq!(ua, "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3");
    }

    #[test]
    fn test_resolve_user_agent_stalker_custom() {
        let sources = json!([
            {
                "id": "src_stalker",
                "type": "stalker",
                "user_agent": "CustomMAG/3.0"
            }
        ]);
        let settings = json!({
            "settings": {
                "globalLiveTvUserAgent": "GlobalUA/1.0"
            }
        });

        let ua = resolve_user_agent_from_values(Some(&sources), Some(&settings), "src_stalker");
        assert_eq!(ua, "CustomMAG/3.0");
    }

    #[test]
    fn test_resolve_user_agent_global_fallback() {
        let sources = json!([
            {
                "id": "src_xtream",
                "type": "xtream"
            }
        ]);
        let settings = json!({
            "settings": {
                "globalLiveTvUserAgent": "TiviMate/4.6.0"
            }
        });

        let ua = resolve_user_agent_from_values(Some(&sources), Some(&settings), "src_xtream");
        assert_eq!(ua, "TiviMate/4.6.0");
    }

    #[test]
    fn test_resolve_user_agent_vlc_fallback() {
        let sources = json!([
            {
                "id": "src_xtream",
                "type": "xtream"
            }
        ]);
        let settings = json!({});

        let ua = resolve_user_agent_from_values(Some(&sources), Some(&settings), "src_xtream");
        assert_eq!(ua, "VLC/3.0.18 LibVLC/3.0.18");
    }

    #[test]
    fn test_resolve_user_agent_unknown_source_with_global() {
        let sources = json!([]);
        let settings = json!({
            "globalLiveTvUserAgent": "CustomGlobal/2.0"
        });

        let ua = resolve_user_agent_from_values(Some(&sources), Some(&settings), "unknown_src");
        assert_eq!(ua, "CustomGlobal/2.0");
    }
}

