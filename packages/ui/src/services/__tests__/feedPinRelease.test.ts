/**
 * Feed-lock release (epg-overrides.releasePinsForFeed).
 *
 * A channel locked to a feed is served by that feed alone — every other feed
 * skips it, including its own playlist's. So when the EPG source is deleted, or
 * a playlist is detached from it, the lock has to be released or those channels
 * stay blank for good. These tests pin the statement that does it: the scoped
 * form's parameter order (feed first, then the playlists) and the fact that a
 * zero row count never runs the UPDATE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbInstance, notify } = vi.hoisted(() => ({
  dbInstance: { select: vi.fn(), execute: vi.fn() },
  notify: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { dbPromise: Promise.resolve(dbInstance) },
}));
vi.mock('../../db/sqlite-adapter', () => ({
  dbEvents: { notify },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ globalEpgLinks: [] }) },
}));

import { releasePinsForFeed } from '../epg-overrides';

beforeEach(() => {
  dbInstance.select.mockReset();
  dbInstance.execute.mockReset();
  notify.mockReset();
});

describe('releasePinsForFeed', () => {
  it('releases every pin to one feed when no playlists are given', async () => {
    dbInstance.select.mockResolvedValue([{ count: 4 }]);
    dbInstance.execute.mockResolvedValue(undefined);

    const released = await releasePinsForFeed('global_epg_link-1');

    expect(released).toBe(4);
    expect(dbInstance.select).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM epg_channel_overrides WHERE epg_source_id = $1',
      ['global_epg_link-1']
    );
    expect(dbInstance.execute).toHaveBeenCalledWith(
      'UPDATE epg_channel_overrides SET epg_source_id = NULL WHERE epg_source_id = $1',
      ['global_epg_link-1']
    );
    expect(notify).toHaveBeenCalledWith('epg_channel_overrides', 'update');
    expect(notify).toHaveBeenCalledWith('channels', 'update');
  });

  it('scopes to the detached playlists, feed first in the args', async () => {
    dbInstance.select.mockResolvedValue([{ count: 2 }]);
    dbInstance.execute.mockResolvedValue(undefined);

    const released = await releasePinsForFeed('global_epg_link-1', ['playlist-a', 'playlist-b']);

    expect(released).toBe(2);
    const [countSql, countArgs] = dbInstance.select.mock.calls[0];
    expect(countSql).toContain('epg_source_id = $1');
    expect(countSql).toContain('source_id IN ($2, $3)');
    expect(countArgs).toEqual(['global_epg_link-1', 'playlist-a', 'playlist-b']);
    // The UPDATE must target exactly the rows that were counted.
    expect(dbInstance.execute.mock.calls[0][1]).toEqual(countArgs);
    expect(dbInstance.execute.mock.calls[0][0]).toContain('SET epg_source_id = NULL');
  });

  it('matches the update predicate to the count predicate', async () => {
    dbInstance.select.mockResolvedValue([{ count: 1 }]);
    dbInstance.execute.mockResolvedValue(undefined);

    await releasePinsForFeed('playlist-a', ['playlist-b']);

    const countWhere = dbInstance.select.mock.calls[0][0].split(' WHERE ')[1];
    const updateWhere = dbInstance.execute.mock.calls[0][0].split(' WHERE ')[1];
    expect(updateWhere).toBe(countWhere);
  });

  it('never runs the UPDATE when nothing is pinned to the feed', async () => {
    dbInstance.select.mockResolvedValue([{ count: 0 }]);

    const released = await releasePinsForFeed('global_epg_link-1');

    expect(released).toBe(0);
    expect(dbInstance.execute).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a blank feed ref and blank playlist ids', async () => {
    expect(await releasePinsForFeed('   ')).toBe(0);
    expect(dbInstance.select).not.toHaveBeenCalled();

    dbInstance.select.mockResolvedValue([{ count: 0 }]);
    await releasePinsForFeed('global_epg_link-1', ['', '  ']);
    expect(dbInstance.select.mock.calls[0][0]).not.toContain('IN (');
  });

  it('returns 0 instead of throwing when the column is missing', async () => {
    dbInstance.select.mockRejectedValue(new Error('no such column: epg_source_id'));

    expect(await releasePinsForFeed('global_epg_link-1')).toBe(0);
    expect(dbInstance.execute).not.toHaveBeenCalled();
  });
});
