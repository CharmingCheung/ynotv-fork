/**
 * Tests for the subtitle-selection intent store and the settling poll's rules.
 *
 * Two things are pinned here:
 *
 *  1. With no intent, the poll behaves exactly as it did before this feature —
 *     a track-count change re-arms auto-select inside the settling window, and
 *     a Jellyfin item re-claims a lost selection there.
 *  2. With an intent, neither rule fires: the user's choice is authoritative
 *     (the "subtitles come back on after I chose Off" regression).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SUBTITLE_SETTLING_ATTEMPTS,
  clearSubtitleIntent,
  getSubtitleIntent,
  planSubtitleAutoSelect,
  restorableSubtitleTrackId,
  setSubtitleIntent,
  type SubtitleAutoSelectSignals,
} from '../subtitleIntent';

function signals(overrides: Partial<SubtitleAutoSelectSignals> = {}): SubtitleAutoSelectSignals {
  return {
    intent: null,
    trackCountChanged: false,
    jellyfinWantsSubtitle: false,
    hasSubtitleTracks: false,
    anySubtitleSelected: false,
    attempts: 1,
    autoSelectSettled: false,
    ...overrides,
  };
}

beforeEach(() => {
  clearSubtitleIntent();
});

describe('subtitle intent store', () => {
  it('starts empty and round-trips a choice', () => {
    expect(getSubtitleIntent()).toBeNull();

    setSubtitleIntent({ id: 4 });
    expect(getSubtitleIntent()).toEqual({ id: 4 });

    setSubtitleIntent({ id: 0 });
    expect(getSubtitleIntent()).toEqual({ id: 0 });

    clearSubtitleIntent();
    expect(getSubtitleIntent()).toBeNull();
  });

  it('exposes a restorable id only for a real track', () => {
    expect(restorableSubtitleTrackId({ id: 4 })).toBe(4);
    // Off: `file-loaded` leaves subtitles disabled anyway, nothing to restore.
    expect(restorableSubtitleTrackId({ id: 0 })).toBeNull();
    // Cycled by the user: mpv chose the id, we never saw it.
    expect(restorableSubtitleTrackId({ id: null })).toBeNull();
    expect(restorableSubtitleTrackId(null)).toBeNull();
  });
});

describe('planSubtitleAutoSelect without a user choice (pre-existing behaviour)', () => {
  it('re-arms on a track count change inside the settling window', () => {
    expect(planSubtitleAutoSelect(signals({ trackCountChanged: true, attempts: 3 })))
      .toEqual({ settleSubtitleAutoSelect: false, resetSubtitleAutoSelect: true });

    // Also re-arms after auto-select settled, while the window is still open —
    // this `||` is what let the poll override a manual pick mid-settlement.
    expect(planSubtitleAutoSelect(
      signals({ trackCountChanged: true, attempts: 10, autoSelectSettled: true }),
    ).resetSubtitleAutoSelect).toBe(true);
  });

  it('leaves auto-select alone once the window has closed and it has settled', () => {
    expect(planSubtitleAutoSelect(signals({
      trackCountChanged: true,
      attempts: SUBTITLE_SETTLING_ATTEMPTS,
      autoSelectSettled: true,
    }))).toEqual({ settleSubtitleAutoSelect: false, resetSubtitleAutoSelect: false });
  });

  it('re-claims a Jellyfin subtitle that mpv dropped, inside the window', () => {
    expect(planSubtitleAutoSelect(signals({
      jellyfinWantsSubtitle: true,
      hasSubtitleTracks: true,
      attempts: 2,
    })).resetSubtitleAutoSelect).toBe(true);
  });

  it('does not re-claim a Jellyfin subtitle once a track is selected or the window closed', () => {
    expect(planSubtitleAutoSelect(signals({
      jellyfinWantsSubtitle: true,
      hasSubtitleTracks: true,
      anySubtitleSelected: true,
      attempts: 2,
    })).resetSubtitleAutoSelect).toBe(false);

    expect(planSubtitleAutoSelect(signals({
      jellyfinWantsSubtitle: true,
      hasSubtitleTracks: true,
      attempts: SUBTITLE_SETTLING_ATTEMPTS,
    })).resetSubtitleAutoSelect).toBe(false);
  });
});

describe('planSubtitleAutoSelect with a user choice', () => {
  it('settles the subtitle half and never re-arms, even mid-window', () => {
    expect(planSubtitleAutoSelect(signals({
      intent: { id: 4 },
      trackCountChanged: true,
      attempts: 2,
    }))).toEqual({ settleSubtitleAutoSelect: true, resetSubtitleAutoSelect: false });
  });

  it('keeps a Jellyfin item from re-claiming a track the user turned off', () => {
    expect(planSubtitleAutoSelect(signals({
      intent: { id: 0 },
      jellyfinWantsSubtitle: true,
      hasSubtitleTracks: true,
      attempts: 2,
    }))).toEqual({ settleSubtitleAutoSelect: true, resetSubtitleAutoSelect: false });
  });

  it('also holds when the user picked Off and mpv reports tracks vanishing', () => {
    expect(planSubtitleAutoSelect(signals({
      intent: { id: 0 },
      trackCountChanged: true,
      hasSubtitleTracks: false,
      attempts: 1,
    })).resetSubtitleAutoSelect).toBe(false);
  });
});
