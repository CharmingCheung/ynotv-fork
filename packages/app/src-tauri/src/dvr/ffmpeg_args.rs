//! FFmpeg argument construction and validation for recordings.
//!
//! Kept out of the recorder so the flag sets and the rules for user-supplied
//! arguments can be unit-tested without spawning FFmpeg.

/// How aggressively FFmpeg's HTTP layer is asked to reconnect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconnectStrategy {
    /// Reconnect after a dropped connection or a network error, but never treat a
    /// normal end-of-stream as a failure. Safe default.
    Auto,
    /// Legacy behaviour: also reconnect at EOF. Needed by some continuous
    /// streams, but on HLS every segment and playlist ends at EOF, so this can
    /// loop on the same byte offset until the server rate-limits the client
    /// (HTTP 403).
    Aggressive,
    /// Send no reconnect flags at all, for servers that reject retries.
    Off,
}

impl ReconnectStrategy {
    /// Parse the stored setting. Anything unrecognised falls back to `Auto`.
    pub fn from_setting(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "aggressive" | "always" | "on" => Self::Aggressive,
            "off" | "disabled" | "none" => Self::Off,
            _ => Self::Auto,
        }
    }

    /// The stored value for this strategy.
    pub fn as_setting(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Aggressive => "aggressive",
            Self::Off => "off",
        }
    }

    /// The HTTP protocol flags for this strategy.
    ///
    /// `is_hls` must be true for any playlist/segment stream (HLS, and for the
    /// same reason DASH-like manifests), `is_catchup` for a past programme.
    pub fn http_args(self, is_hls: bool, is_catchup: bool) -> Vec<&'static str> {
        if self == Self::Off {
            return Vec::new();
        }

        let mut args = vec![
            "-reconnect",
            "1",
            "-reconnect_delay_max",
            "5",
            "-reconnect_on_network_error",
            "1",
        ];

        if !is_catchup {
            // Only meaningful for a response with no known size. This is the gate
            // that lets a dropped connection be resumed at all for streamed
            // (non-seekable) transfers; it never reconnects on its own.
            args.extend(["-reconnect_streamed", "1"]);
        }

        // `-reconnect_at_eof` turns the normal end of a finite response into an
        // error and re-requests from that offset. Correct for a continuous live
        // stream, but a segment-based stream ends at EOF every few seconds, which
        // becomes a tight reconnect loop against the CDN.
        let reconnect_at_eof = match self {
            Self::Auto => !is_catchup && !is_hls,
            Self::Aggressive => !is_catchup,
            Self::Off => false,
        };
        if reconnect_at_eof {
            args.extend(["-reconnect_at_eof", "1"]);
        }

        args
    }
}

/// Where a stream-type verdict came from.
///
/// This matters beyond bookkeeping: the verdict picks the reconnect and HLS
/// flags for the whole recording, so when a recording fails to start or stops
/// early, the log has to say whether the verdict was something the stream said
/// or an assumption. [`StreamTypeSource::is_guess`] is that distinction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamTypeSource {
    /// The URL's path named the kind of stream.
    UrlExtension,
    /// The response declared a playlist Content-Type.
    ContentType,
    /// No usable Content-Type: the body itself started with `#EXTM3U`.
    PlaylistHeader,
    /// Not an http(s) URL, so there was nothing to ask.
    NotHttp,
    /// The probe could not answer and the stream was assumed to be continuous.
    ProbeFailed,
}

impl StreamTypeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UrlExtension => "url-extension",
            Self::ContentType => "content-type",
            Self::PlaylistHeader => "playlist-header",
            Self::NotHttp => "not-http",
            Self::ProbeFailed => "probe-failed",
        }
    }

    /// True when the verdict is an assumption rather than something the stream
    /// said — i.e. when a misbehaving recording should blame the classification.
    pub fn is_guess(self) -> bool {
        matches!(self, Self::ProbeFailed)
    }
}

/// A stream-type decision with the evidence behind it, for the per-recording log.
#[derive(Debug, Clone)]
pub struct StreamType {
    pub is_hls: bool,
    pub source: StreamTypeSource,
    /// The evidence: the extension, the Content-Type, `#EXTM3U`, or the error.
    pub detail: String,
    /// How long the probe took in milliseconds; 0 when the URL answered alone.
    pub probe_ms: u64,
}

impl StreamType {
    /// `"hls"` / `"direct"` — the same words the recordings list stores.
    pub fn kind(&self) -> &'static str {
        if self.is_hls {
            "hls"
        } else {
            "direct"
        }
    }

    /// One-line evidence for the log, e.g.
    /// `hls via content-type (content-type 'application/vnd.apple.mpegurl', 138ms)`.
    pub fn describe(&self) -> String {
        let mut evidence = self.detail.clone();
        if self.probe_ms > 0 {
            if !evidence.is_empty() {
                evidence.push_str(", ");
            }
            evidence.push_str(&format!("{}ms", self.probe_ms));
        }
        if evidence.is_empty() {
            format!("{} via {}", self.kind(), self.source.as_str())
        } else {
            format!("{} via {} ({})", self.kind(), self.source.as_str(), evidence)
        }
    }
}

/// Extensions that are unambiguously a single continuous media file. A playlist
/// served from one of these would be a first, and treating it as segmented is
/// what caused the reconnect loop this module exists to prevent.
const MEDIA_EXTENSIONS: [&str; 15] = [
    ".ts", ".mp4", ".mkv", ".avi", ".mov", ".flv", ".mpg", ".mpeg", ".webm", ".m4v", ".m4s",
    ".aac", ".mp3", ".ogg", ".wav",
];

/// URL-only stream classification.
///
/// `Some(..)` means the path said what the stream is; `None` means it said
/// nothing useful — extensionless and tokenised endpoints, which IPTV portals
/// use constantly — and the caller should ask the response instead.
pub fn stream_type_from_url(url: &str) -> Option<StreamType> {
    let lower = url.to_ascii_lowercase();
    // Ignore the query/fragment so a token such as `?format=.ts` cannot be read
    // as the path's extension.
    let path = lower.split(['?', '#']).next().unwrap_or("");

    if path.contains(".m3u8") {
        return Some(StreamType {
            is_hls: true,
            source: StreamTypeSource::UrlExtension,
            detail: "path contains .m3u8".to_string(),
            probe_ms: 0,
        });
    }

    if let Some(ext) = MEDIA_EXTENSIONS.iter().find(|ext| path.ends_with(**ext)) {
        return Some(StreamType {
            is_hls: false,
            source: StreamTypeSource::UrlExtension,
            detail: format!("path ends with {ext}"),
            probe_ms: 0,
        });
    }

    None
}

/// A stream URL with the parts that can carry an account removed.
///
/// Xtream puts the credentials in the path (`/live/<user>/<password>/<id>.ts`)
/// and other panels put them in the query, so neither belongs in a log line
/// that a user may paste into a bug report. The host, the last path segment (a
/// stream id or file name) and the extension survive, which is what makes a log
/// line identifiable; everything between them becomes an ellipsis.
///
/// Anything that is not an http(s) URL is returned unchanged: a local path has
/// no credentials to hide, and rewriting it would only make the log confusing.
pub fn redact_url(raw: &str) -> String {
    let without_query = raw.split(['?', '#']).next().unwrap_or(raw);
    let (scheme, rest) = match without_query.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") => {
            (scheme, rest)
        }
        // Not a URL we know how to reduce (a file path, `stalker_<hash>`, a pipe).
        _ => return raw.to_string(),
    };

    let mut segments = rest.split('/');
    let raw_authority = segments.next().unwrap_or("");
    // Split at the *last* '@': a password may carry one unencoded ("p@ss"),
    // and splitting at the first would leave "ss@host" behind as the host —
    // half the secret, still in the log. A host can never contain '@'.
    let authority = match raw_authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => raw_authority,
    };
    let path: Vec<&str> = segments.filter(|segment| !segment.is_empty()).collect();
    if authority.is_empty() {
        return format!("{scheme}://…");
    }

    // Keep the final segment only when it looks like an id or a file name — a
    // long or punctuated segment is more likely to be a token than a stream id.
    let tail = path.last().copied().filter(|last| {
        !last.is_empty()
            && last.len() <= 48
            && last
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    });

    match tail {
        Some(last) => format!("{scheme}://{authority}/…/{last}"),
        None => format!("{scheme}://{authority}/…"),
    }
}

/// Options the recorder sets itself. A user-supplied value must not override
/// them: `-stats` is parsed for progress, the input/duration/output path are
/// owned by the recorder, and `-y`/`-n` decide whether an existing file is
/// replaced.
const RESERVED_OPTIONS: [&str; 7] = ["-stats", "-progress", "-i", "-y", "-n", "-t", "-to"];

const MAX_EXTRA_ARGS_LEN: usize = 500;
const MAX_EXTRA_ARGS_TOKENS: usize = 64;

/// Split the user's extra FFmpeg arguments into individual argv entries.
///
/// Arguments are handed to FFmpeg as separate argv values (never through a
/// shell), so quoting is only needed to keep a value that contains spaces in one
/// piece: `-headers "Referer: http://example.com"`.
///
/// The recorder logs and ignores arguments that fail these rules rather than
/// failing the recording; the settings UI validates the same rules up front so
/// an invalid value cannot be saved in the first place.
pub fn parse_extra_ffmpeg_args(raw: &str) -> Result<Vec<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    if raw.len() > MAX_EXTRA_ARGS_LEN {
        return Err(format!("more than {} characters", MAX_EXTRA_ARGS_LEN));
    }

    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in raw.chars() {
        if ch == '\n' || ch == '\r' {
            return Err("line breaks are not allowed".to_string());
        }
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if quote.is_some() {
        return Err("unbalanced quote".to_string());
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    if tokens.len() > MAX_EXTRA_ARGS_TOKENS {
        return Err(format!("more than {} arguments", MAX_EXTRA_ARGS_TOKENS));
    }

    for token in &tokens {
        // Compare the bare flag so `-t=10` is caught as well as `-t 10`. A value
        // (which never starts with `-`) keeps its whole `key=value` shape, so
        // `-metadata comment=-i` is not mistaken for `-i`.
        let bare = token.to_ascii_lowercase();
        let bare = bare.split('=').next().unwrap_or("").to_string();
        if RESERVED_OPTIONS.contains(&bare.as_str()) {
            return Err(format!("{} is managed by the app", bare));
        }
        if looks_like_path_or_url(token) {
            return Err(format!(
                "{} looks like a file or URL; quote it and pass it as the value of a flag",
                token
            ));
        }
    }

    Ok(tokens)
}

/// Detect a bare path or URL, which FFmpeg would read as an extra input file
/// rather than as the value of a flag.
///
/// Only the *start* of the token is inspected, so a quoted header value such as
/// `Referer: http://example.com` is left alone.
fn looks_like_path_or_url(token: &str) -> bool {
    if token.starts_with("http://") || token.starts_with("https://") {
        return true;
    }
    if token.starts_with('/') || token.starts_with('\\') || token.starts_with("//") {
        return true;
    }
    if token.starts_with("./") || token.starts_with("../") || token.starts_with(".\\") {
        return true;
    }
    // Windows drive root, e.g. C:\recordings\x.ts
    let mut chars = token.chars();
    if let (Some(drive), Some(':')) = (chars.next(), chars.next()) {
        if drive.is_ascii_alphabetic() && matches!(chars.next(), Some('/') | Some('\\')) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The verdict alone, for the URL-classification cases below.
    fn hls_from_url(url: &str) -> Option<bool> {
        stream_type_from_url(url).map(|stream| stream.is_hls)
    }

    // --- Reconnect strategy -------------------------------------------------

    #[test]
    fn auto_never_reconnects_at_eof_for_segmented_streams() {
        let args = ReconnectStrategy::Auto.http_args(true, false);
        assert!(args.contains(&"-reconnect_streamed"), "mid-transfer recovery stays on: {args:?}");
        assert!(!args.contains(&"-reconnect_at_eof"), "EOF must not be an error: {args:?}");
        assert!(args.contains(&"-reconnect"));
        assert!(args.contains(&"-reconnect_on_network_error"));
    }

    #[test]
    fn auto_keeps_eof_reconnect_for_continuous_live_streams() {
        let args = ReconnectStrategy::Auto.http_args(false, false);
        assert!(args.contains(&"-reconnect_at_eof"));
        assert!(args.contains(&"-reconnect_streamed"));
    }

    #[test]
    fn catchup_streams_get_no_eof_or_streamed_reconnect() {
        for strategy in [ReconnectStrategy::Auto, ReconnectStrategy::Aggressive] {
            let args = strategy.http_args(false, true);
            assert!(!args.contains(&"-reconnect_at_eof"), "{strategy:?}: {args:?}");
            assert!(!args.contains(&"-reconnect_streamed"), "{strategy:?}: {args:?}");
            assert!(args.contains(&"-reconnect"), "{strategy:?}");
        }
    }

    #[test]
    fn aggressive_restores_the_legacy_behaviour() {
        let args = ReconnectStrategy::Aggressive.http_args(true, false);
        assert!(args.contains(&"-reconnect_at_eof"));
        assert!(args.contains(&"-reconnect_streamed"));
    }

    #[test]
    fn off_sends_no_reconnect_flags() {
        assert!(ReconnectStrategy::Off.http_args(false, false).is_empty());
        assert!(ReconnectStrategy::Off.http_args(true, true).is_empty());
    }

    #[test]
    fn strategy_setting_round_trips_and_defaults_to_auto() {
        for strategy in [
            ReconnectStrategy::Auto,
            ReconnectStrategy::Aggressive,
            ReconnectStrategy::Off,
        ] {
            assert_eq!(ReconnectStrategy::from_setting(strategy.as_setting()), strategy);
        }
        assert_eq!(ReconnectStrategy::from_setting(""), ReconnectStrategy::Auto);
        assert_eq!(ReconnectStrategy::from_setting("  AUTO "), ReconnectStrategy::Auto);
        assert_eq!(ReconnectStrategy::from_setting("garbage"), ReconnectStrategy::Auto);
    }

    // --- URL classification -------------------------------------------------

    #[test]
    fn playlist_urls_are_detected_without_a_probe() {
        assert_eq!(hls_from_url("http://host/live/index.m3u8"), Some(true));
        assert_eq!(hls_from_url("http://host/live/mono.m3u8"), Some(true));
        assert_eq!(hls_from_url("https://host/x/PLAYLIST.M3U8?token=abc"), Some(true));
        assert_eq!(hls_from_url("http://host/live/index.m3u8#frag"), Some(true));
    }

    #[test]
    fn plain_media_urls_are_not_probed() {
        assert_eq!(hls_from_url("http://host:8080/live/user/pass/1234.ts"), Some(false));
        assert_eq!(hls_from_url("http://host/live/user/pass/1234.ts?token=abc"), Some(false));
        assert_eq!(hls_from_url("http://host/movie/movie.mp4"), Some(false));
        assert_eq!(hls_from_url("file:///C:/recordings/a.mkv"), Some(false));
    }

    #[test]
    fn extensionless_and_tokenised_urls_need_a_probe() {
        assert_eq!(hls_from_url("http://host:8080/live/user/pass/1234"), None);
        assert_eq!(hls_from_url("http://host/stream?token=abc"), None);
        assert_eq!(hls_from_url("http://host/play/a1b2c3"), None);
    }

    #[test]
    fn classification_reports_the_evidence_the_log_needs() {
        let playlist = stream_type_from_url("https://host/x/PLAYLIST.M3U8?token=abc").unwrap();
        assert!(playlist.is_hls);
        assert_eq!(playlist.source, StreamTypeSource::UrlExtension);
        assert_eq!(playlist.source.as_str(), "url-extension");
        assert!(!playlist.source.is_guess());
        assert_eq!(playlist.kind(), "hls");
        assert_eq!(playlist.describe(), "hls via url-extension (path contains .m3u8)");

        let direct = stream_type_from_url("http://host:8080/live/u/p/1234.ts").unwrap();
        assert!(!direct.is_hls);
        assert_eq!(direct.kind(), "direct");
        assert_eq!(direct.describe(), "direct via url-extension (path ends with .ts)");

        assert!(stream_type_from_url("http://host/play/a1b2c3").is_none());
    }

    #[test]
    fn a_probe_verdict_records_what_it_saw() {
        let playlist = StreamType {
            is_hls: true,
            source: StreamTypeSource::ContentType,
            detail: "content-type 'application/vnd.apple.mpegurl'".to_string(),
            probe_ms: 138,
        };
        assert_eq!(
            playlist.describe(),
            "hls via content-type (content-type 'application/vnd.apple.mpegurl', 138ms)"
        );
        assert!(!playlist.source.is_guess());
    }

    #[test]
    fn a_probe_failure_is_marked_as_a_guess() {
        let failed = StreamType {
            is_hls: false,
            source: StreamTypeSource::ProbeFailed,
            detail: "probe timed out after 4s".to_string(),
            probe_ms: 4001,
        };
        assert!(
            failed.source.is_guess(),
            "a failed probe must be flagged, not silently treated as a direct stream"
        );
        assert_eq!(
            failed.describe(),
            "direct via probe-failed (probe timed out after 4s, 4001ms)"
        );
        assert!(!StreamTypeSource::PlaylistHeader.is_guess());
        assert!(!StreamTypeSource::NotHttp.is_guess());
    }

    // --- URL redaction ------------------------------------------------------

    #[test]
    fn redaction_drops_credentials_from_the_path() {
        // Xtream: /live/<user>/<password>/<id>.ts
        assert_eq!(
            // example.com is reserved for documentation, so this is visibly a fixture.
            redact_url("http://example.com:8080/live/testuser/hunter2/1234.ts"),
            "http://example.com:8080/…/1234.ts"
        );
        assert!(!redact_url("http://host/live/testuser/hunter2/1234.ts").contains("hunter2"));
    }

    #[test]
    fn redaction_drops_the_query_entirely() {
        let redacted = redact_url("http://host/player_api.php?username=testuser&password=hunter2&stream=9");
        assert_eq!(redacted, "http://host/…/player_api.php");
        assert!(!redacted.contains("hunter2"));
        assert!(!redacted.contains("username"));
    }

    #[test]
    fn redaction_handles_edges_without_losing_the_host() {
        // No path at all.
        assert_eq!(redact_url("https://host:443"), "https://host:443/…");
        // A tokenish last segment is dropped rather than logged.
        assert_eq!(
            redact_url("http://host/play/eyJhbGciOiJIUzI1NiIsInR="),
            "http://host/…"
        );
        // Fragments and UPPERCASE schemes.
        assert_eq!(redact_url("HTTP://host/a/b.ts#frag"), "HTTP://host/…/b.ts");
        // Not an http(s) URL: left exactly as given.
        assert_eq!(redact_url("file:///C:/recordings/a.ts"), "file:///C:/recordings/a.ts");
        assert_eq!(redact_url("stalker_9f2b"), "stalker_9f2b");
    }

    #[test]
    fn redaction_drops_basic_auth_credentials() {
        assert_eq!(
            redact_url("http://admin:secret123@myiptv.com:8080/live/1234.ts"),
            "http://myiptv.com:8080/…/1234.ts"
        );
        assert!(!redact_url("http://admin:secret123@myiptv.com:8080/live/1234.ts").contains("secret123"));
        assert!(!redact_url("http://admin:secret123@myiptv.com:8080/live/1234.ts").contains("admin"));
    }

    #[test]
    fn redaction_survives_an_at_sign_inside_the_password() {
        // An unencoded '@' in the password must not be mistaken for the host
        // separator: splitting at the first one would log "ss@host" as the host.
        assert_eq!(
            redact_url("http://user:p@ss@myiptv.com:8080/live/1234.ts"),
            "http://myiptv.com:8080/…/1234.ts"
        );
        assert_eq!(
            redact_url("rtsp://user:p@ss@host/path"),
            "rtsp://user:p@ss@host/path"
        );
    }

    // --- Extra argument parsing --------------------------------------------

    #[test]
    fn empty_extra_args_produce_nothing() {
        assert_eq!(parse_extra_ffmpeg_args(""), Ok(Vec::new()));
        assert_eq!(parse_extra_ffmpeg_args("   \t "), Ok(Vec::new()));
    }

    #[test]
    fn splits_arguments_and_keeps_quoted_values_together() {
        assert_eq!(
            parse_extra_ffmpeg_args("-probesize 10M -analyzeduration 5M"),
            Ok(vec![
                "-probesize".to_string(),
                "10M".to_string(),
                "-analyzeduration".to_string(),
                "5M".to_string()
            ])
        );
        assert_eq!(
            parse_extra_ffmpeg_args("-headers \"Referer: http://example.com\" -probesize 10M"),
            Ok(vec![
                "-headers".to_string(),
                "Referer: http://example.com".to_string(),
                "-probesize".to_string(),
                "10M".to_string()
            ])
        );
    }

    #[test]
    fn allows_the_common_output_bitstream_filter() {
        assert_eq!(
            parse_extra_ffmpeg_args("-bsf:a aac_adtstoasc"),
            Ok(vec!["-bsf:a".to_string(), "aac_adtstoasc".to_string()])
        );
    }

    #[test]
    fn rejects_options_the_recorder_owns() {
        for raw in ["-i http://host/x.ts", "-y", "-n", "-stats", "-t 60", "-to 60", "-progress p.txt"] {
            let result = parse_extra_ffmpeg_args(raw);
            assert!(result.is_err(), "{raw} should be rejected, got {result:?}");
        }
        // `-t=60` and the lower-case forms are the same option.
        assert!(parse_extra_ffmpeg_args("-t=60").is_err());
        assert!(parse_extra_ffmpeg_args("-STATS").is_err());
    }

    #[test]
    fn keeps_values_that_merely_look_like_reserved_options() {
        assert_eq!(
            parse_extra_ffmpeg_args("-metadata comment=-i"),
            Ok(vec!["-metadata".to_string(), "comment=-i".to_string()])
        );
    }

    #[test]
    fn rejects_bare_paths_and_urls() {
        for raw in [
            "http://host/other.ts",
            "https://host/other.ts",
            "C:\\recordings\\other.ts",
            "/tmp/other.ts",
            "./other.ts",
        ] {
            assert!(parse_extra_ffmpeg_args(raw).is_err(), "{raw} should be rejected");
        }
    }

    #[test]
    fn rejects_broken_quoting_and_oversized_input() {
        assert!(parse_extra_ffmpeg_args("-headers \"unterminated").is_err());
        assert!(parse_extra_ffmpeg_args(&format!("-probesize {}", "9".repeat(500))).is_err());
        let many = std::iter::repeat("-x 1").take(40).collect::<Vec<_>>().join(" ");
        assert!(parse_extra_ffmpeg_args(&many).is_err());
    }
}
