import { describe, it, expect } from 'vitest';
import {
  GLOBAL_EPG_FRESH_MS,
  attachedEpgSourceIds,
  clearGlobalEpgSourceStamps,
  linkNeedsSyncForAnySource,
  linkNeedsSyncForSource,
} from '../globalEpgFreshness';
import type { GlobalEpgLink } from '../../types/app';

const NOW = 1_700_000_000_000;

function link(overrides: Partial<GlobalEpgLink> = {}): GlobalEpgLink {
  return {
    id: 'link-1',
    name: 'DE1',
    url: 'http://example.test/epg.xml',
    sourceIds: ['A', 'B'],
    ...overrides,
  };
}

describe('global EPG link freshness', () => {
  it('runs for a source it has never been attempted for', () => {
    expect(linkNeedsSyncForSource(link(), 'A', NOW)).toBe(true);
    expect(linkNeedsSyncForSource(link({ lastSynced: NOW }), 'A', NOW)).toBe(true);
  });

  it('skips a source while its own pass is still fresh and matched nothing', () => {
    const l = link({
      lastSynced: NOW - 1000,
      lastSyncResult: {
        timestamp: NOW - 1000,
        totalInserted: 0,
        perSource: {},
        perSourceSyncedAt: { A: NOW - 1000, B: NOW - 1000 },
      },
    });
    expect(linkNeedsSyncForSource(l, 'A', NOW)).toBe(false);
    expect(linkNeedsSyncForSource(l, 'A', NOW + GLOBAL_EPG_FRESH_MS + 1)).toBe(true);
  });

  it('re-runs for a source whose last pass inserted programmes', () => {
    const l = link({
      lastSynced: NOW - 1000,
      lastSyncResult: {
        timestamp: NOW - 1000,
        totalInserted: 42,
        perSource: { A: 42, B: 0 },
        perSourceSyncedAt: { A: NOW - 1000, B: NOW - 1000 },
      },
    });
    expect(linkNeedsSyncForSource(l, 'A', NOW)).toBe(true);
    // ...but not for a source it filled nothing for in the same pass.
    expect(linkNeedsSyncForSource(l, 'B', NOW)).toBe(false);
  });

  it('does not let one source back off another (the reported regression)', () => {
    // The link just ran for A and matched nothing there; B syncs 5 minutes later.
    const l = link({
      lastSynced: NOW - 5 * 60 * 1000,
      lastSyncResult: {
        timestamp: NOW - 5 * 60 * 1000,
        totalInserted: 0,
        perSource: { A: 0, B: 0 },
        perSourceSyncedAt: { A: NOW - 5 * 60 * 1000, B: NOW - 5 * 60 * 1000 },
      },
    });
    // Untouched, the whole link looks fresh for both sources.
    expect(linkNeedsSyncForSource(l, 'A', NOW)).toBe(false);
    expect(linkNeedsSyncForSource(l, 'B', NOW)).toBe(false);

    // B was just resynced, so its stamp is cleared and only B is reconsidered.
    const { links, changed } = clearGlobalEpgSourceStamps([l], new Set(['B']));
    expect(changed).toBe(true);
    expect(links[0].lastSyncResult?.perSourceSyncedAt).toEqual({ A: NOW - 5 * 60 * 1000 });
    expect(linkNeedsSyncForSource(links[0], 'A', NOW)).toBe(false);
    expect(linkNeedsSyncForSource(links[0], 'B', NOW)).toBe(true);
  });

  it('clears stamps without cloning links that have nothing to clear', () => {
    const untouched = link({ id: 'other', sourceIds: ['Z'] });
    const noStamps = link({ id: 'no-stamps' });
    const { links, changed } = clearGlobalEpgSourceStamps([untouched, noStamps], new Set(['A']));
    expect(changed).toBe(false);
    expect(links[0]).toBe(untouched);
    expect(links[1]).toBe(noStamps);

    const empty = clearGlobalEpgSourceStamps([untouched], new Set());
    expect(empty.changed).toBe(false);
    expect(empty.links[0]).toBe(untouched);
  });

  it('scopes the attached sources to the ones just synced', () => {
    const l = link();
    expect(attachedEpgSourceIds(l)).toEqual(['A', 'B']);
    expect(attachedEpgSourceIds(l, new Set(['B', 'C']))).toEqual(['B']);
    expect(attachedEpgSourceIds(l, new Set(['C']))).toEqual([]);
  });

  it('treats a link as eligible when any attached source needs it', () => {
    const l = link({
      lastSynced: NOW,
      lastSyncResult: {
        timestamp: NOW,
        totalInserted: 0,
        perSource: {},
        perSourceSyncedAt: { A: NOW },
      },
    });
    expect(linkNeedsSyncForAnySource(l, ['A'], NOW)).toBe(false);
    expect(linkNeedsSyncForAnySource(l, ['A', 'B'], NOW)).toBe(true);
  });
});
