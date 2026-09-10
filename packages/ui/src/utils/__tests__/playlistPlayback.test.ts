import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module transitively imports the Tauri DB layer, which doesn't load in
// the node test environment — stub it out.
vi.mock('../../db', () => ({
  recordVodWatch: vi.fn(),
  recordEpisodeWatch: vi.fn(),
  getEpisodeProgress: vi.fn(),
}));

import {
  buildPlaylistProgressMap,
  findLastWatchedItem,
  snapshotPlaylistProgress,
  sortPlaylistsByLastPlayed,
  isPlaylistItemHidden,
} from '../playlistPlayback';
import type { Playlist, PlaylistItem } from '../../stores/vodPlaylistStore';
import type { PlaylistItemProgress } from '../../hooks/usePlaylistProgress';
import { useActivePlaylistStore } from '../../stores/activePlaylistStore';
import { useVodPlaylistProgressStore } from '../../stores/vodPlaylistProgressStore';

let nextId = 1;

function makeItem(title: string): PlaylistItem {
  const id = `item_${nextId++}`;
  return {
    id,
    playlistId: 'playlist_1',
    addedAt: Date.now() + nextId,
    itemType: 'episode',
    mediaId: id,
    seriesId: 'series1',
    seasonNum: 1,
    episodeNum: nextId,
    title,
    directUrl: `https://example.com/${id}.m3u8`,
    sourceId: 'src_1',
  };
}

function progress(watchedAt: number, progressSeconds = 0, completed = false): PlaylistItemProgress {
  return { progressSeconds, totalDuration: 600, completed, percent: 0, watchedAt };
}

function makePlaylist(name: string, items: PlaylistItem[]): Playlist {
  return {
    id: `pl_${name}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items,
  };
}

describe('sortPlaylistsByLastPlayed', () => {
  let map: Map<string, PlaylistItemProgress>;
  let neverPlayed: Playlist;
  let oldPlayed: Playlist;
  let recentlyPlayed: Playlist;

  beforeEach(() => {
    map = new Map();
    neverPlayed = makePlaylist('Never', [makeItem('N1'), makeItem('N2')]);
    oldPlayed = makePlaylist('Old', [makeItem('O1')]);
    recentlyPlayed = makePlaylist('Recent', [makeItem('R1'), makeItem('R2')]);
    map.set(oldPlayed.items[0].id, progress(1000));
    map.set(recentlyPlayed.items[0].id, progress(9000));
    map.set(recentlyPlayed.items[1].id, progress(5000));
  });

  it('puts the most recently played playlist first', () => {
    const sorted = sortPlaylistsByLastPlayed([neverPlayed, oldPlayed, recentlyPlayed], map);
    expect(sorted.map((p) => p.name)).toEqual(['Recent', 'Old', 'Never']);
  });

  it('uses the latest watch across a playlist items (not the first)', () => {
    // Old has a later item than Recent's single most recent item
    map.set(oldPlayed.items[0].id, progress(20000));
    const sorted = sortPlaylistsByLastPlayed([recentlyPlayed, oldPlayed], map);
    expect(sorted.map((p) => p.name)).toEqual(['Old', 'Recent']);
  });

  it('keeps never-played playlists in their original relative order at the bottom', () => {
    const sorted = sortPlaylistsByLastPlayed([recentlyPlayed, neverPlayed], map);
    expect(sorted.map((p) => p.name)).toEqual(['Recent', 'Never']);
  });

  it('does not mutate the input array', () => {
    const input = [neverPlayed, oldPlayed];
    const before = [...input];
    sortPlaylistsByLastPlayed(input, map);
    expect(input).toEqual(before);
  });
});

describe('findLastWatchedItem', () => {
  let items: PlaylistItem[];
  let map: Map<string, PlaylistItemProgress>;

  beforeEach(() => {
    items = [makeItem('Ep A'), makeItem('Ep B'), makeItem('Ep C')];
    map = new Map();
  });

  it('returns the item with the most recent watchedAt', () => {
    map.set(items[0].id, progress(1000));
    map.set(items[1].id, progress(5000));
    map.set(items[2].id, progress(3000));

    expect(findLastWatchedItem(items, map)?.title).toBe('Ep B');
  });

  it('ignores items with no watch history', () => {
    map.set(items[0].id, progress(1000));
    // items[1] and items[2] have no entry at all

    expect(findLastWatchedItem(items, map)?.title).toBe('Ep A');
  });

  it('returns null when nothing was ever watched', () => {
    expect(findLastWatchedItem(items, map)).toBeNull();
    map.set(items[0].id, progress(0)); // watched_at 0 counts as never watched
    expect(findLastWatchedItem(items, map)).toBeNull();
  });

  it('returns null for an empty playlist', () => {
    expect(findLastWatchedItem([], map)).toBeNull();
  });

  it('prefers a recently watched item even if it has zero progress', () => {
    // Ep C was just started (progress 0) but is the most recent watch
    map.set(items[0].id, progress(1000, 400));
    map.set(items[2].id, progress(9000, 0));

    expect(findLastWatchedItem(items, map)?.title).toBe('Ep C');
  });
});

// ---------------------------------------------------------------------------
// Playlist progress snapshots (survive "Clear All Cached Data")
// ---------------------------------------------------------------------------

describe('buildPlaylistProgressMap', () => {
  it('builds progress from DB episode history rows', () => {
    const item = makeItem('Ep');
    const map = buildPlaylistProgressMap(
      [item],
      { [item.mediaId]: { progress_seconds: 300, total_duration: 600, completed: false, watched_at: 1234 } },
      {},
      {}
    );
    expect(map.get(item.id)).toMatchObject({
      progressSeconds: 300,
      totalDuration: 600,
      completed: false,
      percent: 50,
      watchedAt: 1234,
    });
  });

  it('builds progress from DB movie history rows (90% counts as completed)', () => {
    const item: PlaylistItem = {
      id: 'm1',
      playlistId: 'p1',
      addedAt: 1,
      itemType: 'movie',
      mediaId: 'mv1',
      title: 'Movie',
      directUrl: 'https://example.com/mv1.m3u8',
      sourceId: 'src_1',
    };
    const map = buildPlaylistProgressMap(
      [item],
      {},
      { mv1: { progress_seconds: 900, total_duration: 1000, watched_at: 99 } },
      {}
    );
    expect(map.get(item.id)).toMatchObject({ progressSeconds: 900, totalDuration: 1000, percent: 90, watchedAt: 99 });
    expect(map.get(item.id)!.completed).toBe(true);
  });

  it('falls back to localStorage snapshots when DB history is missing (post cache clear)', () => {
    const item = makeItem('Ep');
    const map = buildPlaylistProgressMap(
      [item],
      {},
      {},
      { [item.id]: { progressSeconds: 120, totalDuration: 600, completed: false, watchedAt: 5555 } }
    );
    expect(map.get(item.id)).toMatchObject({ progressSeconds: 120, totalDuration: 600, watchedAt: 5555, percent: 20 });
  });

  it('prefers DB history over snapshots when both exist', () => {
    const item = makeItem('Ep');
    const map = buildPlaylistProgressMap(
      [item],
      { [item.mediaId]: { progress_seconds: 400, total_duration: 600, completed: false, watched_at: 10 } },
      {},
      { [item.id]: { progressSeconds: 1, totalDuration: 600, completed: false, watchedAt: 9999 } }
    );
    expect(map.get(item.id)!.progressSeconds).toBe(400);
    expect(map.get(item.id)!.watchedAt).toBe(10);
  });

  it('skips items with no DB row and no snapshot', () => {
    const map = buildPlaylistProgressMap([makeItem('Ep')], {}, {}, {});
    expect(map.size).toBe(0);
  });
});

describe('snapshotPlaylistProgress', () => {
  let item: PlaylistItem;

  beforeEach(() => {
    useActivePlaylistStore.setState({
      activePlaylistId: null,
      activePlaylistName: null,
      items: [],
      currentIndex: -1,
      isShuffle: false,
    });
    useVodPlaylistProgressStore.setState({ byItemId: {} });
    item = makeItem('Ep');
    useActivePlaylistStore.getState().startPlayback('pl_1', 'List', [item], 0, false);
  });

  function vodInfoFor(item: PlaylistItem): import('../../types/media').VodPlayInfo {
    return {
      url: item.directUrl!,
      title: item.title,
      type: 'series',
      mediaId: item.mediaId,
      episodeId: item.mediaId,
      seriesId: item.seriesId,
      seasonNum: item.seasonNum,
      episodeNum: item.episodeNum,
    };
  }

  it('writes a snapshot for the current playlist item when the playing item matches', () => {
    snapshotPlaylistProgress(vodInfoFor(item), 300, 600);
    const snap = useVodPlaylistProgressStore.getState().byItemId[item.id];
    expect(snap).toMatchObject({ progressSeconds: 300, totalDuration: 600, completed: false });
    expect(snap.watchedAt).toBeGreaterThan(0);
  });

  it('marks the item completed at 90%+', () => {
    snapshotPlaylistProgress(vodInfoFor(item), 585, 600);
    expect(useVodPlaylistProgressStore.getState().byItemId[item.id].completed).toBe(true);
  });

  it('ignores playback of a non-playlist item', () => {
    snapshotPlaylistProgress({ url: 'https://x/other.m3u8', title: 'Other', type: 'movie', mediaId: 'other' }, 300, 600);
    expect(useVodPlaylistProgressStore.getState().byItemId).toEqual({});
  });

  it('ignores zero position (not yet playing)', () => {
    snapshotPlaylistProgress(vodInfoFor(item), 0, 600);
    expect(useVodPlaylistProgressStore.getState().byItemId).toEqual({});
  });

  it('does nothing when no playlist session is active', () => {
    useActivePlaylistStore.setState({
      activePlaylistId: null,
      activePlaylistName: null,
      items: [],
      currentIndex: -1,
      isShuffle: false,
    });
    snapshotPlaylistProgress(vodInfoFor(item), 300, 600);
    expect(useVodPlaylistProgressStore.getState().byItemId).toEqual({});
  });
});

describe('isPlaylistItemHidden', () => {
  it('returns false when enabledSources is null (startup) for remote items', () => {
    const item = makeItem('Remote');
    item.sourceId = 'src_1';
    expect(isPlaylistItemHidden(item, null)).toBe(false);
  });

  it('returns true when item source is not in enabledSources', () => {
    const item = makeItem('Remote');
    item.sourceId = 'disabled_src';
    expect(isPlaylistItemHidden(item, new Set(['src_1']))).toBe(true);
  });

  it('returns false when item source is in enabledSources', () => {
    const item = makeItem('Remote');
    item.sourceId = 'src_1';
    expect(isPlaylistItemHidden(item, new Set(['src_1']))).toBe(false);
  });

  it('returns false for items with no sourceId', () => {
    const item = makeItem('No Source');
    item.sourceId = undefined;
    expect(isPlaylistItemHidden(item, new Set(['src_1']))).toBe(false);
  });

  it('returns false for local items when available', () => {
    const item = makeItem('Local Movie');
    item.sourceId = 'local';
    item.itemType = 'movie';
    item.mediaId = 'local_file_1';
    item.directUrl = '/path/to/movie.mkv';

    const localLib = [
      { id: 'file_1', path: '/path/to/movie.mkv', type: 'movie', title: 'Movie 1', unavailable: false },
    ] as any;

    expect(isPlaylistItemHidden(item, new Set(['src_1']), localLib)).toBe(false);
  });

  it('returns true for local items when item.unavailable is true', () => {
    const item = makeItem('Local Unavailable');
    item.sourceId = 'local';
    item.unavailable = true;
    expect(isPlaylistItemHidden(item, new Set(['src_1']))).toBe(true);
  });

  it('returns true for local items when local library entry has unavailable: true', () => {
    const item = makeItem('Local Movie');
    item.sourceId = 'local';
    item.itemType = 'movie';
    item.mediaId = 'local_file_1';

    const localLib = [
      { id: 'file_1', path: '/path/to/movie.mkv', type: 'movie', title: 'Movie 1', unavailable: true },
    ] as any;

    expect(isPlaylistItemHidden(item, new Set(['src_1']), localLib)).toBe(true);
  });

  it('returns true for local episode when matched by directUrl and marked unavailable', () => {
    const item = makeItem('Local Ep');
    item.sourceId = 'local';
    item.itemType = 'episode';
    item.mediaId = 'file_ep1';
    item.directUrl = '/path/to/show/s01e01.mkv';

    const localLib = [
      { id: 'different_id', path: '/path/to/show/s01e01.mkv', type: 'show', title: 'Ep 1', unavailable: true },
    ] as any;

    expect(isPlaylistItemHidden(item, new Set(), localLib)).toBe(true);
  });
});
