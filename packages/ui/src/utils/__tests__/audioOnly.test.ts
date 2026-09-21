import { describe, it, expect } from 'vitest';
import {
  readVideoTrackState,
  readVideoFormatState,
  resolveAudioOnly,
  createAudioOnlyTracker,
} from '../audioOnly';

describe('readVideoTrackState', () => {
  it('reads the sidecar string form', () => {
    expect(readVideoTrackState('no')).toBe('none');
    expect(readVideoTrackState('NO')).toBe('none');
    expect(readVideoTrackState('auto')).toBe('unknown');
    expect(readVideoTrackState(1)).toBe('video');
    expect(readVideoTrackState('1')).toBe('video');
  });

  it('reads the int64 form of a switch-track property', () => {
    // A typed int64 read of mpv's switch-track properties yields -2 when
    // nothing is selected, -1 for "auto", and the track's id (>= 1) otherwise.
    expect(readVideoTrackState(-2)).toBe('none');
    expect(readVideoTrackState('-2')).toBe('none');
    expect(readVideoTrackState(-1)).toBe('unknown');
    expect(readVideoTrackState(3)).toBe('video');
  });

  it('treats a missing or unhelpful value as unknown', () => {
    expect(readVideoTrackState(undefined)).toBe('unknown');
    expect(readVideoTrackState(null)).toBe('unknown');
    expect(readVideoTrackState('')).toBe('unknown');
    expect(readVideoTrackState(0)).toBe('unknown');
    expect(readVideoTrackState(NaN)).toBe('unknown');
  });

  it('reads the boolean form', () => {
    expect(readVideoTrackState(false)).toBe('none');
    expect(readVideoTrackState(true)).toBe('video');
  });
});

describe('readVideoFormatState', () => {
  it('recognises a missing video format', () => {
    expect(readVideoFormatState('none')).toBe('none');
    expect(readVideoFormatState('no')).toBe('none');
    expect(readVideoFormatState('')).toBe('unknown');
    expect(readVideoFormatState(undefined)).toBe('unknown');
    expect(readVideoFormatState(null)).toBe('unknown');
  });

  it('recognises a real codec', () => {
    expect(readVideoFormatState('h264')).toBe('video');
    expect(readVideoFormatState('mjpeg')).toBe('video');
  });
});

describe('resolveAudioOnly', () => {
  it('reports audio-only for every "no track" encoding', () => {
    expect(resolveAudioOnly('no', null)).toBe(true);
    expect(resolveAudioOnly(false, null)).toBe(true);
    expect(resolveAudioOnly(-2, null)).toBe(true);
    expect(resolveAudioOnly(null, 'none')).toBe(true);
    expect(resolveAudioOnly(undefined, 'no')).toBe(true);
  });

  it('reports video when a track is selected', () => {
    expect(resolveAudioOnly(1, 'h264')).toBe(false);
    expect(resolveAudioOnly('1', null)).toBe(false);
    expect(resolveAudioOnly(null, 'h264')).toBe(false);
  });

  it('does not guess when the engine reported nothing', () => {
    // macOS does not poll vid at all: both fields are null.
    expect(resolveAudioOnly(null, null)).toBe(null);
    expect(resolveAudioOnly(undefined, undefined)).toBe(null);
    // mpv's "auto" before playback is initialized.
    expect(resolveAudioOnly(-1, null)).toBe(null);
    expect(resolveAudioOnly('auto', '')).toBe(null);
  });

  it('lets the track selection win over the format', () => {
    // The selected track is authoritative; a stale format must not override it.
    expect(resolveAudioOnly(-2, 'h264')).toBe(true);
    expect(resolveAudioOnly(2, 'none')).toBe(false);
  });
});

describe('createAudioOnlyTracker', () => {
  it('needs two agreeing polls before entering audio-only', () => {
    const tracker = createAudioOnlyTracker();
    expect(tracker.next(true)).toBe(null);
    expect(tracker.next(true)).toBe(true);
    expect(tracker.next(true)).toBe(true);
  });

  it('leaves audio-only as soon as a track appears', () => {
    const tracker = createAudioOnlyTracker();
    expect(tracker.next(true)).toBe(null);
    expect(tracker.next(true)).toBe(true);
    // mpv selects the video track a moment after playback starts.
    expect(tracker.next(false)).toBe(false);
  });

  it('does not let a one-off signal become an answer', () => {
    const tracker = createAudioOnlyTracker();
    expect(tracker.next(true)).toBe(null);
    // A stray poll (a track appearing, or the engine going quiet) restarts the
    // count instead of confirming it.
    expect(tracker.next(false)).toBe(false);
    expect(tracker.next(null)).toBe(null);
    expect(tracker.next(true)).toBe(null);
    expect(tracker.next(true)).toBe(true);
  });

  it('forgets its streak when a new stream loads', () => {
    const tracker = createAudioOnlyTracker();
    expect(tracker.next(true)).toBe(null);
    tracker.reset();
    expect(tracker.next(true)).toBe(null);
    expect(tracker.next(true)).toBe(true);
  });
});
