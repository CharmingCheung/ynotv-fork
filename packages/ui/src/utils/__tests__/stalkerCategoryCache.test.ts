import { describe, it, expect } from 'vitest';
import {
  STALKER_CATEGORY_CACHE_VERSION,
  STALKER_SINGLE_PAGE_ITEM_COUNT,
  readStalkerCategoryCacheMarker,
  writeStalkerCategoryCacheMarker,
  isLikelyTruncatedStalkerCache,
} from '../stalkerCategoryCache';

const LEGACY_TS = 1_700_000_000_000;

describe('readStalkerCategoryCacheMarker', () => {
  it('reads a legacy bare timestamp as usable but legacy', () => {
    const marker = readStalkerCategoryCacheMarker(String(LEGACY_TS));
    expect(marker.syncedAt).toBe(LEGACY_TS);
    expect(marker.legacy).toBe(true);
  });

  it('round-trips a versioned marker without flagging it legacy', () => {
    const raw = writeStalkerCategoryCacheMarker({ syncedAt: LEGACY_TS });
    expect(JSON.parse(raw)).toEqual({ v: STALKER_CATEGORY_CACHE_VERSION, ts: LEGACY_TS });

    const marker = readStalkerCategoryCacheMarker(raw);
    expect(marker.syncedAt).toBe(LEGACY_TS);
    expect(marker.legacy).toBe(false);
    expect(marker.healAttemptedAt).toBeNull();
  });

  it('keeps the truncation suspicion and the heal attempt across a forced refetch', () => {
    const raw = writeStalkerCategoryCacheMarker({
      syncedAt: LEGACY_TS,
      legacy: true,
      healAttemptedAt: LEGACY_TS + 60_000,
    });

    const marker = readStalkerCategoryCacheMarker(raw);
    // The original sync time is preserved so the normal cache timer still expires on schedule,
    // and the suspicion survives so a deferred/failed refetch isn't mistaken for a repair.
    expect(marker.syncedAt).toBe(LEGACY_TS);
    expect(marker.legacy).toBe(true);
    expect(marker.healAttemptedAt).toBe(LEGACY_TS + 60_000);
  });

  it('ignores a malformed heal timestamp', () => {
    const marker = readStalkerCategoryCacheMarker('{"v":2,"ts":1700000000000,"legacy":true,"heal":"soon"}');
    expect(marker.legacy).toBe(true);
    expect(marker.healAttemptedAt).toBeNull();
  });

  it('treats a missing or empty marker as never synced', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const marker = readStalkerCategoryCacheMarker(raw as string | null);
      expect(marker.syncedAt).toBeNull();
      expect(marker.legacy).toBe(false);
    }
  });

  it('ignores junk and stale-format payloads instead of throwing', () => {
    for (const raw of ['not-a-timestamp', '{}', '{"v":2}', '{"v":2,"ts":"soon"}', '{"ts":-5}', '[]', 'null']) {
      const marker = readStalkerCategoryCacheMarker(raw);
      expect(marker.syncedAt).toBeNull();
      expect(marker.legacy).toBe(false);
    }
  });

  it('treats a versioned marker from an older version as legacy', () => {
    const marker = readStalkerCategoryCacheMarker(JSON.stringify({ v: 1, ts: LEGACY_TS }));
    expect(marker.syncedAt).toBe(LEGACY_TS);
    expect(marker.legacy).toBe(true);
  });
});

describe('isLikelyTruncatedStalkerCache', () => {
  const legacy = { syncedAt: LEGACY_TS, legacy: true, healAttemptedAt: null };
  const current = { syncedAt: LEGACY_TS, legacy: false, healAttemptedAt: null };

  it('flags a legacy cache holding exactly one page of items', () => {
    expect(isLikelyTruncatedStalkerCache(legacy, STALKER_SINGLE_PAGE_ITEM_COUNT)).toBe(true);
  });

  it('flags a legacy cache holding less than a full page', () => {
    expect(isLikelyTruncatedStalkerCache(legacy, 3)).toBe(true);
  });

  it('leaves legacy caches that clearly span more than one page alone', () => {
    expect(isLikelyTruncatedStalkerCache(legacy, STALKER_SINGLE_PAGE_ITEM_COUNT + 1)).toBe(false);
    expect(isLikelyTruncatedStalkerCache(legacy, 512)).toBe(false);
  });

  it('never flags an empty cache or one written by the current version', () => {
    expect(isLikelyTruncatedStalkerCache(legacy, 0)).toBe(false);
    expect(isLikelyTruncatedStalkerCache(current, STALKER_SINGLE_PAGE_ITEM_COUNT)).toBe(false);
    expect(isLikelyTruncatedStalkerCache(current, 0)).toBe(false);
  });

  it('still reports truncation after a refetch was attempted (the caller gates the retry)', () => {
    const matching = readStalkerCategoryCacheMarker(
      writeStalkerCategoryCacheMarker({ syncedAt: LEGACY_TS, legacy: true, healAttemptedAt: LEGACY_TS }),
    );
    expect(isLikelyTruncatedStalkerCache(matching, STALKER_SINGLE_PAGE_ITEM_COUNT)).toBe(true);
    expect(matching.healAttemptedAt).not.toBeNull();
  });
});
