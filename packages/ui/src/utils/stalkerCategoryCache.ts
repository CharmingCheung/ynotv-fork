/**
 * Cache markers for lazily-loaded Stalker VOD/series categories.
 *
 * Each category records a small marker in localStorage when a sync succeeds. Older builds stored
 * a bare timestamp (`String(Date.now())`) and, at the time, a category could be cached after only
 * its first page had been fetched — a cache that looks complete while holding a single page. A
 * bare timestamp can't say which pagination logic produced the cached rows, so a single-page
 * cache written by one of those builds is treated as truncated and refetched immediately instead
 * of waiting out the cache TTL.
 *
 * That refetch is attempted once per marker (`healAttemptedAt`): if it fails or is deferred, the
 * category keeps its "rows may be truncated" flag — so the suspicion is never lost — but falls
 * back to the normal cache timer rather than forcing a sync on every single open.
 */

/** Bumped whenever the meaning of a stored marker changes. */
export const STALKER_CATEGORY_CACHE_VERSION = 2;

/**
 * The standard Stalker page size. A category cached with at most this many items is
 * indistinguishable from one that stopped after its first page.
 */
export const STALKER_SINGLE_PAGE_ITEM_COUNT = 14;

export interface StalkerCategoryCacheMarker {
  /** Timestamp (ms) of the last successful sync, or null when there is no usable marker. */
  syncedAt: number | null;
  /** True when the cached rows may have come from a build that could cache a truncated category. */
  legacy: boolean;
  /** Timestamp (ms) of the last forced refetch of a suspected-truncated cache, if any. */
  healAttemptedAt: number | null;
}

const EMPTY_MARKER: StalkerCategoryCacheMarker = { syncedAt: null, legacy: false, healAttemptedAt: null };

export function readStalkerCategoryCacheMarker(raw: string | null | undefined): StalkerCategoryCacheMarker {
  if (raw == null || raw.trim() === '') return EMPTY_MARKER;

  // Legacy format: a bare epoch-ms string.
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return { syncedAt: asNumber, legacy: true, healAttemptedAt: null };
  }

  try {
    const parsed = JSON.parse(raw) as { v?: number; ts?: number; legacy?: boolean; heal?: number } | null;
    const ts = Number(parsed?.ts);
    if (!Number.isFinite(ts) || ts <= 0) return EMPTY_MARKER;
    const version = Number(parsed?.v);
    const heal = Number(parsed?.heal);
    return {
      syncedAt: ts,
      // An explicit flag keeps the suspicion alive even though the marker itself is current.
      legacy: parsed?.legacy === true || !Number.isFinite(version) || version < STALKER_CATEGORY_CACHE_VERSION,
      healAttemptedAt: Number.isFinite(heal) && heal > 0 ? heal : null,
    };
  } catch {
    return EMPTY_MARKER;
  }
}

export function writeStalkerCategoryCacheMarker(
  options: { syncedAt?: number; legacy?: boolean; healAttemptedAt?: number } = {},
): string {
  const payload: { v: number; ts: number; legacy?: boolean; heal?: number } = {
    v: STALKER_CATEGORY_CACHE_VERSION,
    ts: options.syncedAt ?? Date.now(),
  };
  if (options.legacy) payload.legacy = true;
  if (options.healAttemptedAt != null) payload.heal = options.healAttemptedAt;
  return JSON.stringify(payload);
}

/**
 * True when a cached category may have been written by a build that could only fetch its first
 * page. The caller must pass the real row count: one page (or fewer) of items is the only
 * signature those builds could produce for a category that actually holds more.
 */
export function isLikelyTruncatedStalkerCache(
  marker: StalkerCategoryCacheMarker,
  storedItemCount: number,
): boolean {
  return marker.legacy && storedItemCount > 0 && storedItemCount <= STALKER_SINGLE_PAGE_ITEM_COUNT;
}
