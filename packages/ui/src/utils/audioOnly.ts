/**
 * Interpreting mpv's video-track state.
 *
 * The audio visualiser is only shown for audio-only streams, but the three
 * player engines report "no video track" in different shapes, and this used to
 * be read as "has video" by mistake:
 *
 *  - Standalone sidecar (mpv.exe over JSON IPC): `vid` is observed, which
 *    delivers mpv's node form of the property: `false` when no track is
 *    selected ("auto" until playback is initialized), the track id otherwise.
 *  - Embedded libmpv (in-process): the status monitor reads the same node form
 *    of `vid` (`mpv_core.rs`), so it sends `false` as well. A *typed* int64 read
 *    of the property is what mpv cannot answer when nothing is selected — it
 *    reports those ids as -2 only through that read — which is why `-2`
 *    (and its string form) is still recognised here.
 *  - macOS: `vid` is polled, but a build that doesn't report it leaves both
 *    fields null.
 *
 * Anything we cannot read is reported as 'unknown' so the caller keeps the
 * current state instead of guessing.
 */

export type VideoTrackState = 'video' | 'none' | 'unknown';

/** mpv's string form for "no track selected". */
const NO_TRACK_TOKENS = new Set(['no', 'none', 'false']);

/** mpv's int64 form for "no track selected" (`-2`), vs "auto" (`-1`). */
const NO_TRACK_ID = -2;

function stateFromNumber(value: number): VideoTrackState {
  if (!Number.isFinite(value)) return 'unknown';
  if (value === NO_TRACK_ID) return 'none';
  if (value >= 1) return 'video';
  // -1 = auto, 0 = unset / not yet reported.
  return 'unknown';
}

export function readVideoTrackState(videoTrackId: unknown): VideoTrackState {
  if (videoTrackId === undefined || videoTrackId === null) return 'unknown';

  if (typeof videoTrackId === 'boolean') return videoTrackId ? 'video' : 'none';
  if (typeof videoTrackId === 'number') return stateFromNumber(videoTrackId);

  if (typeof videoTrackId === 'string') {
    const value = videoTrackId.trim().toLowerCase();
    if (value === '') return 'unknown';
    if (NO_TRACK_TOKENS.has(value)) return 'none';
    if (value === 'auto') return 'unknown';

    // Numeric strings come through when an engine stringifies the id.
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return stateFromNumber(numeric);

    // Any other non-empty value is a real track identifier.
    return 'video';
  }

  return 'unknown';
}

export function readVideoFormatState(videoFormat: unknown): VideoTrackState {
  if (videoFormat === undefined || videoFormat === null) return 'unknown';

  const value = String(videoFormat).trim().toLowerCase();
  if (value === '') return 'unknown';
  if (value === 'no' || value === 'none') return 'none';
  return 'video';
}

/**
 * Decide whether the current stream is audio-only.
 *
 * Returns true for audio-only, false when a video track is present, and null
 * when the engine did not report enough to tell (in which case the caller must
 * leave the current state alone).
 */
export function resolveAudioOnly(videoTrackId: unknown, videoFormat: unknown): boolean | null {
  const track = readVideoTrackState(videoTrackId);
  if (track !== 'unknown') return track === 'none';

  const format = readVideoFormatState(videoFormat);
  if (format !== 'unknown') return format === 'none';

  return null;
}

/**
 * Filters the audio-only signal so a single unrepresentative poll can't flip
 * the UI.
 *
 * mpv selects its video track a moment *after* playback starts, so the first
 * poll of a video stream legitimately reports no track — without this, the
 * visualiser would flash over a video channel for one poll before the walk
 * corrects itself. Entering audio-only therefore needs to be seen twice in a
 * row, while leaving it (a track appearing) is applied at once.
 */
export function createAudioOnlyTracker(requiredConfirmations = 2) {
  let streak = 0;

  return {
    /** Feed one poll's answer. Returns the value to apply now, or null to hold. */
    next(value: boolean | null): boolean | null {
      if (value !== true) {
        streak = 0;
        return value === false ? false : null;
      }
      streak += 1;
      return streak >= requiredConfirmations ? true : null;
    },
    /** Forget the current streak (a new stream is loading). */
    reset(): void {
      streak = 0;
    },
  };
}
