import { describe, expect, it } from 'vitest';
import {
  didLiveTimelineRebase,
  effectiveLiveStallThreshold,
  isLikelyHlsStream,
} from '../playbackHealth';

describe('live playback health helpers', () => {
  it('recognizes common HLS URL forms', () => {
    expect(isLikelyHlsStream('https://example.test/live/index.m3u8')).toBe(true);
    expect(isLikelyHlsStream('https://example.test/hls/channel/index')).toBe(true);
    expect(isLikelyHlsStream('https://example.test/live/12?output=m3u8')).toBe(true);
    expect(isLikelyHlsStream('https://example.test/live/12.ts')).toBe(false);
  });

  it('gives live HLS enough time for playlist refreshes', () => {
    expect(effectiveLiveStallThreshold(10_000, 'https://example.test/index.m3u8')).toBe(30_000);
    expect(effectiveLiveStallThreshold(45_000, 'https://example.test/index.m3u8')).toBe(45_000);
    expect(effectiveLiveStallThreshold(10_000, 'https://example.test/live.ts')).toBe(10_000);
  });

  it('distinguishes a timeline rebase from normal forward progress', () => {
    expect(didLiveTimelineRebase(0.4, 48.2)).toBe(true);
    expect(didLiveTimelineRebase(47.8, 48.2)).toBe(false);
    expect(didLiveTimelineRebase(49, 48.2)).toBe(false);
  });
});
