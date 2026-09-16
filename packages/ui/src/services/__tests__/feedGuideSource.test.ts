/**
 * Feed-scoped guide resolution (epg-overrides.findFeedGuideSource and its callers).
 *
 * A tvg-id is shared: one id is often carried by several playlists at once. The old
 * lookups picked "any channel with that id" (`LIMIT 1`, no source filter, no
 * ordering), so a feed with no data could preview another feed's guide, Apply copied
 * that guide onto the channel *and* carried the other playlist's `source_id` with it,
 * and Reset could restore a different playlist's channel. These tests pin the
 * replacement contract: an id resolves inside the feed that was asked about or not at
 * all, the channel being written is never its own source, a copy is stamped with the
 * target channel's own source, and a feed with nothing no longer deletes the guide it
 * cannot replace.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbInstance, programsTable, notify, cacheSelect } = vi.hoisted(() => ({
  dbInstance: { select: vi.fn(), execute: vi.fn() },
  programsTable: { bulkPut: vi.fn() },
  notify: vi.fn(),
  cacheSelect: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: vi.fn(async () => ({ select: cacheSelect })) },
}));

vi.mock('../../db', () => ({
  db: {
    dbPromise: Promise.resolve(dbInstance),
    programs: programsTable,
    epgChannelOverrides: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock('../../db/sqlite-adapter', () => ({
  dbEvents: { notify },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ globalEpgLinks: [] }) },
}));

import {
  findFeedGuideSource,
  getPreviewProgramsForEpgId,
  copyProgramsFromEpgChannel,
  resetChannelToDefault,
} from '../epg-overrides';

beforeEach(() => {
  dbInstance.select.mockReset().mockResolvedValue([]);
  dbInstance.execute.mockReset().mockResolvedValue(undefined);
  programsTable.bulkPut.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
});

/** The SQL of every select the service issued. */
const seenSql = () => dbInstance.select.mock.calls.map(([sql]) => String(sql));
const selectFor = (needle: string) => {
  const call = dbInstance.select.mock.calls.find(([sql]) => String(sql).includes(needle));
  if (!call) throw new Error(`no select containing ${needle}; saw ${seenSql().join(' | ')}`);
  return call as [string, unknown[]];
};

/** Every `DELETE FROM programs` the service issued, with its params. */
const deletedPrograms = () =>
  dbInstance.execute.mock.calls
    .filter(([sql]) => String(sql).startsWith('DELETE FROM programs'))
    .map(([sql, params]) => [String(sql), params] as [string, unknown[]]);

describe('findFeedGuideSource', () => {
  it('resolves an id inside the feed it was asked about', async () => {
    dbInstance.select.mockResolvedValue([{ stream_id: 'feedb_chan' }]);

    const guide = await findFeedGuideSource('shared.us', 'feedB');

    expect(guide).toEqual({ kind: 'channel', streamId: 'feedb_chan' });
    const [sql, params] = selectFor('FROM channels c');
    expect(sql).toContain('c.source_id = $2');
    // Deterministic: native channels first, then a stable order.
    expect(sql).toContain('ORDER BY (o.epg_channel_id IS NOT NULL) ASC, c.stream_id ASC');
    expect(params).toEqual(['shared.us', 'feedB']);
  });

  it('returns nothing when that feed carries no channel for the id', async () => {
    dbInstance.select.mockResolvedValue([]);

    expect(await findFeedGuideSource('shared.us', 'feedC')).toBeNull();
  });

  it('never falls back to another feed: the source filter is always in the query', async () => {
    dbInstance.select.mockResolvedValue([{ stream_id: 'some_chan' }]);

    await findFeedGuideSource('shared.us', 'feedC');

    // The old query had no source clause and an unordered LIMIT 1.
    expect(selectFor('FROM channels c')[0]).not.toMatch(/WHERE COALESCE\(o\.epg_channel_id, c\.epg_channel_id\) = \$1\s+LIMIT 1/);
  });

  it('excludes the channel being written, so a copy cannot read its own rows', async () => {
    dbInstance.select.mockResolvedValue([{ stream_id: 'feedb_chan' }]);

    await findFeedGuideSource('shared.us', 'feedB', 'target_chan');

    const [sql, params] = selectFor('FROM channels c');
    expect(sql).toContain('c.stream_id != $3');
    expect(params).toEqual(['shared.us', 'feedB', 'target_chan']);
  });

  it('treats a global EPG link as its cache DB, with no channels lookup', async () => {
    expect(await findFeedGuideSource('shared.us', 'global_epg_link1')).toEqual({
      kind: 'cache',
      linkId: 'link1',
    });
    expect(dbInstance.select).not.toHaveBeenCalled();
  });

  it('returns nothing for a blank id', async () => {
    expect(await findFeedGuideSource('   ', 'feedB')).toBeNull();
    expect(dbInstance.select).not.toHaveBeenCalled();
  });

  it('prefers a native channel over an overridden sibling carrying the same id', async () => {
    dbInstance.select.mockResolvedValue([{ stream_id: 'feedb_native' }]);

    const guide = await findFeedGuideSource('shared.us', 'feedB');

    expect(guide).toEqual({ kind: 'channel', streamId: 'feedb_native' });
    // An override naming this id is what Automatch writes, and such a sibling can
    // hold nothing — it must not shadow a native channel that has the guide.
    const [sql] = selectFor('FROM channels c');
    expect(sql).toContain('ORDER BY (o.epg_channel_id IS NOT NULL) ASC, c.stream_id ASC');
  });
});

describe('getPreviewProgramsForEpgId', () => {
  it('previews only the feed the result belongs to', async () => {
    dbInstance.select.mockResolvedValue([]);

    const preview = await getPreviewProgramsForEpgId('shared.us', 3, 'feedC');

    expect(preview).toEqual([]);
    const [sql, params] = selectFor('FROM channels c');
    expect(sql).toContain('c.source_id = $2');
    expect(params).toEqual(['shared.us', 'feedC']);
  });

  it('reads the feed channel it resolved', async () => {
    dbInstance.select.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM channels c')) return [{ stream_id: 'feedb_chan' }];
      if (String(sql).includes('FROM programs')) {
        return [{
          id: 'feedb_chan_1',
          stream_id: 'feedb_chan',
          title: 'Road Wars',
          start: '2026-09-16T00:00:00.000Z',
          end: '2026-09-16T00:30:00.000Z',
          source_id: 'feedB',
        }];
      }
      return [];
    });

    const preview = await getPreviewProgramsForEpgId('shared.us', 3, 'feedB');

    expect(preview.map(p => p.title)).toContain('Road Wars');
    // The programmes come from the feed's channel, passed as the query parameter.
    expect(
      dbInstance.select.mock.calls.some(([, params]) =>
        (params as unknown[] | undefined)?.includes('feedb_chan')
      )
    ).toBe(true);
  });
});

describe('copyProgramsFromEpgChannel', () => {
  it('leaves the guide alone when the picked feed has nothing for the id', async () => {
    dbInstance.select.mockImplementation(async (sql: string) =>
      String(sql).includes('COUNT(*) AS rows') ? [{ rows: 12 }] : []
    );

    const copied = await copyProgramsFromEpgChannel('target_chan', 'shared.us', 'feedC');

    // Rows held, not rows copied: the channel kept its 12 programmes.
    expect(copied).toBe(12);
    // No DELETE: the old code wiped the channel before finding there was nothing to copy.
    expect(dbInstance.execute).not.toHaveBeenCalled();
    expect(programsTable.bulkPut).not.toHaveBeenCalled();
  });

  it('reports the rows held when the picked link\'s cache has nothing either', async () => {
    cacheSelect.mockResolvedValueOnce([] as unknown[]);
    dbInstance.select.mockImplementation(async (sql: string) =>
      String(sql).includes('COUNT(*) AS rows') ? [{ rows: 7 }] : []
    );

    const copied = await copyProgramsFromEpgChannel('target_chan', 'shared.us', 'global_epg_link1');

    expect(cacheSelect).toHaveBeenCalledWith(
      'SELECT * FROM programs WHERE stream_id = $1',
      ['shared.us']
    );
    expect(copied).toBe(7);
    expect(dbInstance.execute).not.toHaveBeenCalled();
  });

  it("replaces the guide with the pinned feed's rows, stamped with the target's source", async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ stream_id: 'feedb_chan' }])                    // feed lookup
      .mockResolvedValueOnce([{ source_rows: 74, target_rows: 12 }])           // guide source vs channel
      .mockResolvedValueOnce([{ source_id: 'feedA' }]);                        // target channel's source

    const copied = await copyProgramsFromEpgChannel('target_chan', 'shared.us', 'feedB');

    expect(copied).toBe(74);
    expect(dbInstance.execute).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM programs WHERE stream_id = $1',
      ['target_chan']
    );
    const [, params] = dbInstance.execute.mock.calls[1];
    // $3 is the target's own source, not the source channel's — a copy must never
    // grow another playlist's programme count.
    expect(params).toEqual(['target_chan', 'feedb_chan', 'feedA']);
  });

  it("keeps the guide when the feed's channel is known but holds nothing", async () => {
    // A feed whose download came back empty: its channel carries the id but has no
    // programmes, and that must not wipe the guide the channel already holds.
    dbInstance.select
      .mockResolvedValueOnce([{ stream_id: 'feedc_chan' }])
      .mockResolvedValueOnce([{ source_rows: 0, target_rows: 74 }]);

    const copied = await copyProgramsFromEpgChannel('target_chan', 'shared.us', 'feedC');

    expect(copied).toBe(74);
    expect(dbInstance.execute).not.toHaveBeenCalled();
  });
});

describe('resetChannelToDefault', () => {
  it("restores from the channel's own feed, not another playlist sharing the id", async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', source_id: 'feedA' }])  // channels row
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', epg_source_id: null }]) // override row
      .mockResolvedValueOnce([{ stream_id: 'sourcea_chan' }])                       // own feed's guide
      .mockResolvedValueOnce([{ source_rows: 96, target_rows: 0 }])                 // guide source vs channel
      .mockResolvedValueOnce([{ source_id: 'feedA' }]);                             // target's source

    await resetChannelToDefault('target_chan');

    const [guideSql, guideParams] = selectFor('FROM channels c');
    expect(guideSql).toContain('c.source_id = $2');
    expect(guideParams).toEqual(['ownid.us', 'feedA', 'target_chan']);

    const insert = dbInstance.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT OR REPLACE INTO programs')
    );
    expect(insert?.[1]).toEqual(['target_chan', 'sourcea_chan', 'feedA']);
  });

  it('keeps the guide a self-matched override holds when its own feed has nothing to restore', async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', source_id: 'feedA' }])
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', epg_source_id: null }]) // names its own id
      .mockResolvedValueOnce([]);  // own feed carries no such id

    await resetChannelToDefault('target_chan');

    // Those rows are the provider's, so they stay (the next sync owns them again).
    expect(deletedPrograms()).toEqual([]);
    // The override still goes: the lock is released either way.
    expect(dbInstance.execute).toHaveBeenCalledWith(
      'DELETE FROM epg_channel_overrides WHERE stream_id = $1',
      ['target_chan']
    );
  });

  it('drops rows the override borrowed from another feed when there is nothing to restore', async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', source_id: 'feedA' }])
      .mockResolvedValueOnce([{ epg_channel_id: 'shared.us', epg_source_id: 'feedB' }])
      .mockResolvedValueOnce([])                       // own feed carries no such id
      .mockResolvedValueOnce([{ rows: 74 }]);          // rows about to be dropped

    await resetChannelToDefault('target_chan');

    expect(deletedPrograms()).toEqual([
      ['DELETE FROM programs WHERE stream_id = $1', ['target_chan']],
    ]);
  });

  it('keeps a channel\'s rows when there is no override to undo', async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ epg_channel_id: null, source_id: 'feedA' }])
      .mockResolvedValueOnce([]);  // no override row

    await resetChannelToDefault('target_chan');

    // A link can legitimately fill a channel that has no id of its own; a reset with
    // nothing to undo must not throw that guide away.
    expect(deletedPrograms()).toEqual([]);
  });

  it('drops rows for a channel with no provider id of its own', async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ epg_channel_id: null, source_id: 'feedA' }])
      .mockResolvedValueOnce([{ epg_channel_id: 'shared.us', epg_source_id: null }])
      .mockResolvedValueOnce([{ rows: 30 }]);

    await resetChannelToDefault('target_chan');

    expect(deletedPrograms()).toEqual([
      ['DELETE FROM programs WHERE stream_id = $1', ['target_chan']],
    ]);
  });

  it('drops rows a pin to another feed brought in, even when the id is its own', async () => {
    dbInstance.select
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', source_id: 'feedA' }])
      .mockResolvedValueOnce([{ epg_channel_id: 'ownid.us', epg_source_id: 'feedB' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ rows: 12 }]);

    await resetChannelToDefault('target_chan');

    expect(deletedPrograms()).toEqual([
      ['DELETE FROM programs WHERE stream_id = $1', ['target_chan']],
    ]);
  });
});
