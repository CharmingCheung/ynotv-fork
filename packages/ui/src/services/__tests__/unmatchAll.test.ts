/**
 * Bulk Automatch undo (epg-overrides.unmatchAutomatchChannels).
 *
 * "Undo all" has to reach exactly the same end state as clicking Unmatch on every
 * row — the id and the copied guide go, the pre-run override row comes back — while
 * touching the library once instead of once per channel. These tests pin that
 * contract: which rows are reported undone, that a hand-match made after the run is
 * never clobbered, that a row with no guide is not given a bogus DELETE, and that
 * the guide delete is batched rather than per channel.
 *
 * The table objects are mocked here, so the adapter's own per-write
 * announcements don't run — the notification count asserted below is the
 * service's explicit one (see its doc comment).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbInstance, overrides, notify } = vi.hoisted(() => ({
  dbInstance: { select: vi.fn(), execute: vi.fn() },
  overrides: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  notify: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { dbPromise: Promise.resolve(dbInstance), epgChannelOverrides: overrides },
}));
vi.mock('../../db/sqlite-adapter', () => ({
  dbEvents: { notify },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ globalEpgLinks: [] }) },
}));

import { unmatchAutomatchChannels } from '../epg-overrides';

beforeEach(() => {
  dbInstance.select.mockReset();
  dbInstance.execute.mockReset().mockResolvedValue(undefined);
  overrides.get.mockReset().mockResolvedValue(null);
  overrides.put.mockReset().mockResolvedValue(undefined);
  overrides.delete.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
});

describe('unmatchAutomatchChannels', () => {
  it('takes back a match and restores the pre-run override row', async () => {
    overrides.get.mockResolvedValue({ stream_id: 's1', epg_channel_id: 'feed.1' });

    const result = await unmatchAutomatchChannels([
      { streamId: 's1', epgChannelId: 'feed.1', prior: { logoBackground: 'dark' } },
    ]);

    expect(result.undoneStreamIds).toEqual(['s1']);
    expect(result.modifiedStreamIds).toEqual([]);
    expect(dbInstance.execute).toHaveBeenCalledWith('DELETE FROM programs WHERE stream_id IN ($1)', ['s1']);
    expect(overrides.put).toHaveBeenCalledWith(
      expect.objectContaining({ stream_id: 's1', logo_background: 'dark' })
    );
  });

  it('deletes the override row when the channel had none before the run', async () => {
    overrides.get.mockResolvedValue({ stream_id: 's1', epg_channel_id: 'feed.1' });

    await unmatchAutomatchChannels([{ streamId: 's1', epgChannelId: 'feed.1', prior: {} }]);

    expect(overrides.delete).toHaveBeenCalledWith('s1');
    expect(overrides.put).not.toHaveBeenCalled();
    // Deleted rows are announced as deletions, matching the single-row undo.
    expect(notify).toHaveBeenCalledWith('epg_channel_overrides', 'delete');
  });

  it('leaves a channel matched by hand after the run alone', async () => {
    overrides.get.mockResolvedValue({ stream_id: 's1', epg_channel_id: 'chosen.by.hand' });

    const result = await unmatchAutomatchChannels([
      { streamId: 's1', epgChannelId: 'feed.1', prior: {} },
    ]);

    expect(result.undoneStreamIds).toEqual([]);
    expect(result.modifiedStreamIds).toEqual(['s1']);
    expect(overrides.put).not.toHaveBeenCalled();
    expect(overrides.delete).not.toHaveBeenCalled();
    expect(dbInstance.execute).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('retires an already-gone row without a guide delete', async () => {
    overrides.get.mockResolvedValue(null);

    const result = await unmatchAutomatchChannels([
      { streamId: 's1', epgChannelId: 'feed.1', prior: {} },
    ]);

    expect(result.undoneStreamIds).toEqual(['s1']);
    expect(dbInstance.execute).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('batches the copied-guide delete instead of one statement per channel', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`);
    overrides.get.mockImplementation(async (id: string) => ({ stream_id: id, epg_channel_id: `feed.${id}` }));

    const result = await unmatchAutomatchChannels(
      ids.map(id => ({ streamId: id, epgChannelId: `feed.${id}`, prior: {} }))
    );

    expect(result.undoneStreamIds).toHaveLength(250);
    expect(dbInstance.execute).toHaveBeenCalledTimes(2);
    const [firstSql, firstParams] = dbInstance.execute.mock.calls[0];
    expect(firstSql).toContain('WHERE stream_id IN ($1');
    expect(firstSql).toContain('$200');
    expect(firstParams).toHaveLength(200);
    expect(dbInstance.execute.mock.calls[1][1]).toHaveLength(50);
    // The service's own announcements: once per affected table for the whole run.
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it('does nothing at all for an empty run', async () => {
    const result = await unmatchAutomatchChannels([]);
    expect(result).toEqual({ undoneStreamIds: [], modifiedStreamIds: [] });
    expect(overrides.get).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
