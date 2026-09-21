/**
 * subtitleIntent.ts — "the user picked this subtitle" for the current stream.
 *
 * The subtitle auto-select poll ticks every 500ms for the first ~7.5s of a
 * stream and re-arms itself whenever mpv's subtitle track list changes (a
 * late-appearing CC service, a subtitle file the user just added). Timing
 * alone cannot tell one of those from a track the user deliberately chose, so
 * during that window the poll could replace the user's pick with the configured
 * default — or turn subtitles off entirely when that default is "Off", which is
 * the behaviour this module exists to stop.
 *
 * The intent is recorded explicitly instead of inferred:
 *   - `Bridge.setSubtitleTrack(id, { userInitiated: true })` and
 *     `Bridge.cycleSubtitle()` write it (only user-facing call sites pass that
 *     flag; the player's own auto-selection never does).
 *   - `usePlayback` reads it in the settling poll, and clears it wherever the
 *     auto-select state is cleared — a new channel, a new VOD, stop — plus a
 *     failover to a different channel.
 *
 * Keeping the store out of both the bridge and the hook makes the rules below
 * unit-testable without a Tauri runtime.
 */

/** How many 500ms poll ticks after a stream loads count as the settling window. */
export const SUBTITLE_SETTLING_ATTEMPTS = 15;

export interface SubtitleIntent {
  /**
   * The track the user chose. `0` means they chose Off; `null` means they chose
   * "next track" (the cycle control) and mpv picked the id for us.
   */
  id: number | null;
}

let intent: SubtitleIntent | null = null;

/** Record the user's choice for the stream that is playing. */
export function setSubtitleIntent(next: SubtitleIntent | null): void {
  intent = next;
}

/** The user's choice for the stream that is playing, or null when they haven't made one. */
export function getSubtitleIntent(): SubtitleIntent | null {
  return intent;
}

/** Forget the choice — a different stream is taking over. */
export function clearSubtitleIntent(): void {
  intent = null;
}

/**
 * The track id to re-apply after mpv reloads the file, or null when there is
 * nothing to re-apply: Off needs no restoring (`file-loaded` already disables
 * subtitles), and a cycled track's id is only known to mpv.
 */
export function restorableSubtitleTrackId(from: SubtitleIntent | null): number | null {
  return from !== null && typeof from.id === 'number' && from.id > 0 ? from.id : null;
}

/** Everything the settling poll knows when it decides what to do with subtitles. */
export interface SubtitleAutoSelectSignals {
  /** The user's choice for this stream; null while they haven't made one. */
  intent: SubtitleIntent | null;
  /** The subtitle track count changed since the previous tick. */
  trackCountChanged: boolean;
  /** Jellyfin declared a subtitle stream for this item (i.e. not "None"). */
  jellyfinWantsSubtitle: boolean;
  /** mpv currently exposes at least one subtitle track. */
  hasSubtitleTracks: boolean;
  /** One of those tracks is already selected. */
  anySubtitleSelected: boolean;
  /** Poll ticks elapsed for this stream. */
  attempts: number;
  /** Auto-select has committed at least once for this stream. */
  autoSelectSettled: boolean;
}

export interface SubtitleAutoSelectPlan {
  /** The user's choice stands: the subtitle half is no longer pending. */
  settleSubtitleAutoSelect: boolean;
  /** Re-arm auto-select so it evaluates the new track set. */
  resetSubtitleAutoSelect: boolean;
}

/**
 * Decide what the settling poll does with subtitles this tick.
 *
 * With no intent this is exactly the pre-existing behaviour: a track-count
 * change re-arms auto-select for the whole settling window, and a Jellyfin item
 * whose subtitle stream is set re-claims a selection that has gone missing
 * (mpv resets `sid` to `no` on load) while the window is open.
 *
 * With an intent both rules stand down: the user's choice is what plays, so
 * there is nothing to re-evaluate and nothing to re-claim.
 */
export function planSubtitleAutoSelect(signals: SubtitleAutoSelectSignals): SubtitleAutoSelectPlan {
  if (signals.intent !== null) {
    return { settleSubtitleAutoSelect: true, resetSubtitleAutoSelect: false };
  }

  const withinSettlingWindow =
    !signals.autoSelectSettled || signals.attempts < SUBTITLE_SETTLING_ATTEMPTS;

  const byTrackCountChange = signals.trackCountChanged && withinSettlingWindow;
  const byJellyfin = signals.jellyfinWantsSubtitle
    && signals.hasSubtitleTracks
    && !signals.anySubtitleSelected
    && signals.attempts < SUBTITLE_SETTLING_ATTEMPTS;

  return {
    settleSubtitleAutoSelect: false,
    resetSubtitleAutoSelect: byTrackCountChange || byJellyfin,
  };
}
