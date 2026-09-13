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

/// URL-only stream classification.
///
/// `Some(true)` is a playlist, `Some(false)` a plain media URL, and `None` when
/// the URL says nothing useful — extensionless and tokenised endpoints, which
/// IPTV portals use constantly. The caller should probe the response for `None`.
pub fn hls_from_url(url: &str) -> Option<bool> {
    let lower = url.to_ascii_lowercase();
    // Ignore the query/fragment so a token such as `?format=.ts` cannot be read
    // as the path's extension.
    let path = lower.split(['?', '#']).next().unwrap_or("");

    if path.contains(".m3u8") {
        return Some(true);
    }

    // Extensions that are unambiguously a single continuous media file. A
    // playlist served from one of these would be a first, and treating it as
    // segmented is what caused the reconnect loop.
    const MEDIA_EXTENSIONS: [&str; 15] = [
        ".ts", ".mp4", ".mkv", ".avi", ".mov", ".flv", ".mpg", ".mpeg", ".webm", ".m4v", ".m4s",
        ".aac", ".mp3", ".ogg", ".wav",
    ];
    if MEDIA_EXTENSIONS.iter().any(|ext| path.ends_with(ext)) {
        return Some(false);
    }

    None
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
