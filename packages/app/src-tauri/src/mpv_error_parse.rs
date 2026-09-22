//! Failure-message mapping shared by both playback engines.
//!
//! The sidecar engine learns about a failure from the mpv process's stdout/stderr
//! and from its JSON IPC `end-file` event. The embedded libmpv engine (macOS, and
//! Windows with Settings → Playback → Embedded libmpv) learns about it from
//! libmpv's log messages and its `EndFile` event, and its event API carries no
//! error text at all.
//!
//! Both engines have to produce the *same* strings: the frontend's error overlay
//! picks its title/advice from them, and its generic-error guard recognises them
//! ("HTTP Error", "Access Denied", "Stream Not Found", "Stream Error:"). Keeping
//! the mapping here means the two engines can't drift apart.

/// The user-facing message for an HTTP failure reported in an mpv/ffmpeg log line,
/// e.g. `[ffmpeg] https: HTTP error 404 Not Found`.
///
/// Returns `None` for any line that doesn't report a 4xx/5xx status, so ordinary
/// log traffic can be fed straight in.
pub fn http_error_message(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    let pos = lower.find("http error")?;
    let after = &lower[pos + "http error".len()..];
    let code = after
        .split_whitespace()
        .find_map(|part| {
            let clean = part.trim_matches(':').trim_matches(',');
            clean.parse::<u16>().ok().filter(|c| (400..600).contains(c))
        })?;

    Some(match code {
        401 => "Access Denied (401): Authentication required".to_string(),
        403 => "Access Denied (403): Stream blocked by server".to_string(),
        404 => "Stream Not Found (404)".to_string(),
        _ => format!("HTTP Error ({}): Unable to load stream", code),
    })
}

/// The message `mpv-end-file-error` carries for a stopped file.
///
/// `reason` is mpv's end-file reason ("error", "eof", "stop", …) and `file_error`
/// is the error text that accompanies it when there is one (the sidecar's JSON IPC
/// reports it; libmpv's event API does not, so it passes `""`).
///
/// Returns `None` unless the reason is `error`, mirroring the sidecar's behaviour
/// of only raising this event for real failures.
pub fn end_file_error_message(reason: &str, file_error: &str) -> Option<String> {
    if reason != "error" {
        return None;
    }

    let lower = file_error.to_lowercase();
    let message = if lower.contains("403") || lower.contains("forbidden") {
        "Access Denied (403): Stream blocked by server".to_string()
    } else if lower.contains("401") || lower.contains("unauthorized") {
        "Access Denied (401): Authentication required".to_string()
    } else if lower.contains("404") {
        "Stream Not Found (404)".to_string()
    } else if lower.contains("demuxer") || lower.contains("unsupported") {
        "Stream Unavailable: Server returned invalid content".to_string()
    } else if file_error.is_empty() {
        "Stream Error: Unknown playback error".to_string()
    } else {
        format!("Stream Error: {}", file_error)
    };

    Some(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_ffmpeg_http_line_to_a_specific_message() {
        assert_eq!(
            http_error_message("[ffmpeg] https: HTTP error 404 Not Found").as_deref(),
            Some("Stream Not Found (404)")
        );
        assert_eq!(
            http_error_message("[ffmpeg] http: HTTP error 403 Forbidden").as_deref(),
            Some("Access Denied (403): Stream blocked by server")
        );
        assert_eq!(
            http_error_message("[ffmpeg] https: HTTP error 401 Unauthorized").as_deref(),
            Some("Access Denied (401): Authentication required")
        );
    }

    #[test]
    fn maps_other_4xx_and_5xx_codes_generically() {
        assert_eq!(
            http_error_message("HTTP error 500 Internal Server Error").as_deref(),
            Some("HTTP Error (500): Unable to load stream")
        );
        assert_eq!(
            http_error_message("[ffmpeg] https: HTTP error 429 Too Many Requests").as_deref(),
            Some("HTTP Error (429): Unable to load stream")
        );
    }

    #[test]
    fn handles_the_colon_and_trailing_comma_shapes() {
        // mpv/yt-dlp print the code with punctuation attached in a few places.
        assert_eq!(
            http_error_message("Unable to download webpage: HTTP Error 404: Not Found").as_deref(),
            Some("Stream Not Found (404)")
        );
        assert_eq!(
            http_error_message("HTTP error 403,").as_deref(),
            Some("Access Denied (403): Stream blocked by server")
        );
    }

    #[test]
    fn ignores_lines_without_a_failure_status() {
        assert_eq!(http_error_message("Opening https://example.com/stream.m3u8"), None);
        assert_eq!(http_error_message("HTTP error"), None);
        assert_eq!(http_error_message("HTTP error 200 OK"), None);
        assert_eq!(http_error_message("HTTP error 999 weird"), None);
        assert_eq!(http_error_message(""), None);
    }

    #[test]
    fn end_file_messages_only_fire_for_errors() {
        assert_eq!(end_file_error_message("eof", ""), None);
        assert_eq!(end_file_error_message("stop", ""), None);
        assert_eq!(
            end_file_error_message("error", "").as_deref(),
            Some("Stream Error: Unknown playback error")
        );
    }

    #[test]
    fn end_file_messages_use_the_file_error_detail() {
        assert_eq!(
            end_file_error_message("error", "HTTP error 403 Forbidden").as_deref(),
            Some("Access Denied (403): Stream blocked by server")
        );
        assert_eq!(
            end_file_error_message("error", "unauthorized").as_deref(),
            Some("Access Denied (401): Authentication required")
        );
        assert_eq!(
            end_file_error_message("error", "not found 404").as_deref(),
            Some("Stream Not Found (404)")
        );
        assert_eq!(
            end_file_error_message("error", "demuxer failed").as_deref(),
            Some("Stream Unavailable: Server returned invalid content")
        );
        assert_eq!(
            end_file_error_message("error", "loading failed").as_deref(),
            Some("Stream Error: loading failed")
        );
    }
}
