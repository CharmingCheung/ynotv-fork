import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module transitively imports the Tauri DB layer, which doesn't load in
// the node test environment — stub the pieces resolvePlaylistItem touches.
vi.mock('../../db', () => ({
  recordVodWatch: vi.fn(),
  recordEpisodeWatch: vi.fn(),
  getEpisodeProgress: vi.fn(),
  db: {
    vodMovies: { get: vi.fn() },
    vodSeries: { get: vi.fn() },
    vodEpisodes: { get: vi.fn(), whereRaw: vi.fn() },
  },
}));

// Local-library converters + cache access — controlled by the test.
vi.mock('../../services/local-library/local-library', () => ({
  ensureLocalLibraryLoaded: vi.fn().mockResolvedValue(undefined),
  readLocalLibrary: vi.fn(),
  groupLocal: vi.fn(),
  localEntryToStoredMovie: vi.fn(),
  localGroupToStoredSeries: vi.fn(),
  localEntryToStoredEpisode: vi.fn(),
}));

import { resolvePlaylistItem, applyPlaylistResolutions, PLAYLIST_STALE_REMOVAL_DAYS } from '../playlistPlayback';
import { db } from '../../db';
import { useVodMetadataOverridesStore, overrideKey } from '../../stores/vodMetadataOverridesStore';
import { useVodPlaylistStore } from '../../stores/vodPlaylistStore';
import type { PlaylistItem } from '../../stores/vodPlaylistStore';
import {
  readLocalLibrary,
  groupLocal,
  localEntryToStoredMovie,
  localGroupToStoredSeries,
  localEntryToStoredEpisode,
} from '../../services/local-library/local-library';

const dbMock = db as unknown as {
  vodMovies: { get: ReturnType<typeof vi.fn> };
  vodSeries: { get: ReturnType<typeof vi.fn> };
  vodEpisodes: {
    get: ReturnType<typeof vi.fn>;
    whereRaw: ReturnType<typeof vi.fn>;
  };
};
const localMocks = {
  readLocalLibrary: readLocalLibrary as unknown as ReturnType<typeof vi.fn>,
  groupLocal: groupLocal as unknown as ReturnType<typeof vi.fn>,
  localEntryToStoredMovie: localEntryToStoredMovie as unknown as ReturnType<typeof vi.fn>,
  localGroupToStoredSeries: localGroupToStoredSeries as unknown as ReturnType<typeof vi.fn>,
  localEntryToStoredEpisode: localEntryToStoredEpisode as unknown as ReturnType<typeof vi.fn>,
};

function movieItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: 'pi_1',
    playlistId: 'pl_1',
    itemType: 'movie',
    mediaId: 'mv_123',
    title: 'Old Movie Title',
    poster: 'old.jpg',
    directUrl: 'https://old/stream.m3u8',
    sourceId: 'src_1',
    addedAt: 1000,
    ...overrides,
  };
}

function episodeItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: 'pi_2',
    playlistId: 'pl_1',
    itemType: 'episode',
    mediaId: 'ep_1',
    seriesId: 's_1',
    seriesTitle: 'Old Series',
    title: 'Old Series - S01E01',
    poster: 'old.jpg',
    directUrl: 'https://old/ep.m3u8',
    sourceId: 'src_1',
    addedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.vodEpisodes.whereRaw.mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) });
});

describe('resolvePlaylistItem - provider movies', () => {
  it('refreshes title, poster, stream URL, and duration from the current row', async () => {
    dbMock.vodMovies.get.mockResolvedValue({
      stream_id: 'mv_123',
      name: 'New Movie Name',
      title: 'New Movie Title',
      stream_icon: 'new.jpg',
      backdrop_path: 'newback.jpg',
      direct_url: 'https://new/stream.m3u8',
      source_id: 'src_1',
      duration: 120, // minutes
    });

    const resolved = await resolvePlaylistItem(movieItem());
    expect(resolved.title).toBe('New Movie Title');
    expect(resolved.poster).toBe('new.jpg');
    expect(resolved.backdropUrl).toBe('newback.jpg');
    expect(resolved.directUrl).toBe('https://new/stream.m3u8');
    expect(resolved.duration).toBe(120 * 60);
  });

  it('keeps the stored snapshot when the movie no longer exists, marking it unresolvable', async () => {
    dbMock.vodMovies.get.mockResolvedValue(undefined);
    const item = movieItem();
    const resolved = await resolvePlaylistItem(item);
    expect(resolved.title).toBe('Old Movie Title');
    expect(resolved.directUrl).toBe('https://old/stream.m3u8');
    expect(resolved.unresolvableSince).toBeTruthy();
  });

  it('clears unresolvableSince when the movie resolves again', async () => {
    dbMock.vodMovies.get.mockResolvedValue({
      stream_id: 'mv_123',
      name: 'Back',
      title: 'Back',
      direct_url: 'https://new/stream.m3u8',
      source_id: 'src_1',
    });
    const resolved = await resolvePlaylistItem(movieItem({ unresolvableSince: Date.now() - 1000 }));
    expect(resolved.unresolvableSince).toBeUndefined();
    expect(resolved.directUrl).toBe('https://new/stream.m3u8');
  });
});

describe('resolvePlaylistItem - provider episodes', () => {
  it('refreshes episode stream URL and series metadata', async () => {
    dbMock.vodSeries.get.mockResolvedValue({
      series_id: 's_1',
      title: 'New Series',
      name: 'New Series',
      cover: 'newcover.jpg',
      backdrop_path: 'newback.jpg',
      source_id: 'src_1',
    });
    dbMock.vodEpisodes.whereRaw.mockReturnValue({
      first: vi.fn().mockResolvedValue({
        id: 'ep_1',
        series_id: 's_1',
        title: 'Episode 5',
        season_num: 2,
        episode_num: 5,
        direct_url: 'https://new/ep5.m3u8',
        duration: 40, // minutes
      }),
    });

    const resolved = await resolvePlaylistItem(episodeItem());
    expect(dbMock.vodEpisodes.whereRaw).toHaveBeenCalledWith(
      'id = $1 AND series_id = $2',
      ['ep_1', 's_1'],
    );
    expect(resolved.title).toBe('New Series - S02E05: Episode 5');
    expect(resolved.seriesTitle).toBe('New Series');
    expect(resolved.episodeNum).toBe(5);
    expect(resolved.poster).toBe('newcover.jpg');
    expect(resolved.directUrl).toBe('https://new/ep5.m3u8');
    expect(resolved.duration).toBe(40 * 60);
  });

  it('keeps the stored snapshot when the episode is gone, marking it unresolvable', async () => {
    dbMock.vodEpisodes.whereRaw.mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) });
    const item = episodeItem();
    const resolved = await resolvePlaylistItem(item);
    expect(resolved.title).toBe('Old Series - S01E01');
    expect(resolved.unresolvableSince).toBeTruthy();
  });
});

describe('resolvePlaylistItem - metadata overrides', () => {
  it('applies a user-corrected title/poster on top of the fresh row', async () => {
    dbMock.vodMovies.get.mockResolvedValue({
      stream_id: 'mv_123',
      name: 'Provider Title',
      title: 'Provider Title',
      stream_icon: 'provider.jpg',
      direct_url: 'https://new/stream.m3u8',
      source_id: 'src_1',
    });
    useVodMetadataOverridesStore.setState({
      overrides: {
        [overrideKey('mv_123', 'movie')]: {
          override_key: overrideKey('mv_123', 'movie'),
          media_id: 'mv_123',
          media_type: 'movie',
          title: 'User Title',
          poster: 'user.jpg',
          updated_at: Date.now(),
        },
      },
    });

    const resolved = await resolvePlaylistItem(movieItem());
    expect(resolved.title).toBe('User Title');
    expect(resolved.poster).toBe('user.jpg');
    // Stream URL still comes from the fresh row.
    expect(resolved.directUrl).toBe('https://new/stream.m3u8');
  });
});

describe('resolvePlaylistItem - local library', () => {
  it('refreshes a local movie from the library cache', async () => {
    const item = movieItem({ mediaId: 'local_T:/Movies/Gladiator.mkv', sourceId: 'local' });
    localMocks.readLocalLibrary.mockReturnValue([
      { id: 'T:/Movies/Gladiator.mkv', path: 'T:/Movies/Gladiator.mkv', type: 'movie', title: 'Gladiator' },
    ]);
    localMocks.localEntryToStoredMovie.mockReturnValue({
      stream_id: 'local_T:/Movies/Gladiator.mkv',
      name: 'Gladiator',
      title: 'Gladiator',
      stream_icon: 'http://img/poster.jpg',
      backdrop_path: 'http://img/back.jpg',
      direct_url: 'T:/Movies/Gladiator.mkv',
      duration: 9000,
    });

    const resolved = await resolvePlaylistItem(item);
    expect(localMocks.localEntryToStoredMovie).toHaveBeenCalled();
    expect(resolved.directUrl).toBe('T:/Movies/Gladiator.mkv');
    expect(resolved.poster).toBe('http://img/poster.jpg');
    expect(resolved.sourceName).toBe('Local');
  });

  it('keeps the snapshot when the local file was removed from the library, marking it unresolvable', async () => {
    const item = movieItem({ mediaId: 'local_T:/Movies/Gone.mkv', sourceId: 'local' });
    localMocks.readLocalLibrary.mockReturnValue([]);
    const resolved = await resolvePlaylistItem(item);
    expect(resolved.title).toBe('Old Movie Title');
    expect(resolved.unresolvableSince).toBeTruthy();
  });

  it('marks unavailable: true on a local item when the file is unavailable', async () => {
    const item = movieItem({ mediaId: 'local_T:/Movies/Gladiator.mkv', sourceId: 'local' });
    localMocks.readLocalLibrary.mockReturnValue([
      { id: 'T:/Movies/Gladiator.mkv', path: 'T:/Movies/Gladiator.mkv', type: 'movie', title: 'Gladiator', unavailable: true },
    ]);
    localMocks.localEntryToStoredMovie.mockReturnValue({
      stream_id: 'local_T:/Movies/Gladiator.mkv',
      title: 'Gladiator',
      direct_url: 'T:/Movies/Gladiator.mkv',
    });

    const resolved = await resolvePlaylistItem(item);
    expect(resolved.unavailable).toBe(true);
  });

  it('clears unavailable when a previously unavailable local item is restored', async () => {
    const item = movieItem({ mediaId: 'local_T:/Movies/Gladiator.mkv', sourceId: 'local', unavailable: true });
    localMocks.readLocalLibrary.mockReturnValue([
      { id: 'T:/Movies/Gladiator.mkv', path: 'T:/Movies/Gladiator.mkv', type: 'movie', title: 'Gladiator', unavailable: false },
    ]);
    localMocks.localEntryToStoredMovie.mockReturnValue({
      stream_id: 'local_T:/Movies/Gladiator.mkv',
      title: 'Gladiator',
      direct_url: 'T:/Movies/Gladiator.mkv',
    });

    const resolved = await resolvePlaylistItem(item);
    expect(resolved.unavailable).toBeUndefined();
  });

  it('persists resolved fields back into the stored playlist item', async () => {
    const store = useVodPlaylistStore.getState();
    const pl = store.createPlaylist('Persist Test');
    store.addItemToPlaylist(pl.id, {
      itemType: 'movie',
      mediaId: 'mv_1',
      title: 'Old Title',
      poster: 'old.jpg',
      directUrl: 'https://old/stream.m3u8',
      sourceId: 'src_1',
    });

    const stored = useVodPlaylistStore.getState().playlists[0].items[0];
    applyPlaylistResolutions([
      { ...stored, title: 'New Title', poster: 'new.jpg', directUrl: 'https://new/stream.m3u8' },
    ]);

    const after = useVodPlaylistStore.getState().playlists[0].items[0];
    expect(after.title).toBe('New Title');
    expect(after.poster).toBe('new.jpg');
    expect(after.directUrl).toBe('https://new/stream.m3u8');
    // Identity / membership never change.
    expect(after.id).toBe(stored.id);
    expect(after.playlistId).toBe(stored.playlistId);
    expect(after.mediaId).toBe('mv_1');
  });

  it('prunes items whose source has been unresolvable past the stale window', async () => {
    const store = useVodPlaylistStore.getState();
    const pl = store.createPlaylist('Prune Test');
    store.addItemToPlaylist(pl.id, {
      itemType: 'movie',
      mediaId: 'gone_1',
      title: 'Gone',
      directUrl: 'https://old/stream.m3u8',
      sourceId: 'src_1',
    });
    store.addItemToPlaylist(pl.id, {
      itemType: 'movie',
      mediaId: 'ok_1',
      title: 'Fine',
      directUrl: 'https://ok/stream.m3u8',
      sourceId: 'src_1',
    });

    const items = useVodPlaylistStore.getState().playlists[0].items;
    const staleCutoff = Date.now() - (PLAYLIST_STALE_REMOVAL_DAYS + 1) * 24 * 60 * 60 * 1000;
    applyPlaylistResolutions([
      { ...items.find((i) => i.mediaId === 'gone_1')!, unresolvableSince: staleCutoff },
      { ...items.find((i) => i.mediaId === 'ok_1')!, unresolvableSince: undefined },
    ]);

    const remaining = useVodPlaylistStore.getState().playlists[0].items;
    expect(remaining.map((i) => i.mediaId)).toEqual(['ok_1']);
  });

  it('refreshes a local episode with the current series group metadata', async () => {
    const item = episodeItem({
      mediaId: 'T:/Shows/Show/S01E01.mkv',
      seriesId: 'local_show',
      sourceId: 'local',
    });
    localMocks.readLocalLibrary.mockReturnValue([
      { id: 'T:/Shows/Show/S01E01.mkv', path: 'T:/Shows/Show/S01E01.mkv', type: 'show', title: 'Show', season: 1, episode: 1 },
    ]);
    localMocks.groupLocal.mockReturnValue([
      {
        kind: 'show',
        key: 'show',
        head: { id: 'T:/Shows/Show/S01E01.mkv', title: 'Show' },
        episodes: [{ id: 'T:/Shows/Show/S01E01.mkv' }],
      },
    ]);
    localMocks.localGroupToStoredSeries.mockReturnValue({
      series_id: 'local_show',
      title: 'Show',
      name: 'Show',
      cover: 'http://img/cover.jpg',
      backdrop_path: 'http://img/back.jpg',
    });
    localMocks.localEntryToStoredEpisode.mockReturnValue({
      id: 'T:/Shows/Show/S01E01.mkv',
      series_id: 'local_show',
      title: 'Episode 1',
      episode_num: 1,
      season_num: 1,
      direct_url: 'T:/Shows/Show/S01E01.mkv',
      duration: 2400,
    });

    const resolved = await resolvePlaylistItem(item);
    expect(resolved.directUrl).toBe('T:/Shows/Show/S01E01.mkv');
    expect(resolved.poster).toBe('http://img/cover.jpg');
    expect(resolved.seasonNum).toBe(1);
    expect(resolved.episodeNum).toBe(1);
    expect(resolved.sourceName).toBe('Local');
  });
});
