const HLS_MIN_STALL_THRESHOLD_MS = 30_000;

export function isLikelyHlsStream(url?: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    /\.m3u8?(?:[?#]|$)/.test(lower) ||
    /\/hls(?:[/?#]|$)/.test(lower) ||
    /\/index(?:[?#]|$)/.test(lower) ||
    /[?&](?:output|extension|type)=m3u8?(?:&|$)/.test(lower)
  );
}

export function effectiveLiveStallThreshold(configuredMs: number, url?: string | null): number {
  return isLikelyHlsStream(url)
    ? Math.max(configuredMs, HLS_MIN_STALL_THRESHOLD_MS)
    : configuredMs;
}

/**
 * A live demuxer can rebase its public timeline while playback remains
 * continuous. Treat a clear backwards jump as a new health-check baseline,
 * not as many seconds of stalled playback while the new counter catches up.
 */
export function didLiveTimelineRebase(currentPosition: number, previousPosition: number): boolean {
  return previousPosition > 2 && currentPosition + 2 < previousPosition;
}
