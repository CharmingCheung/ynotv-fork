import { recordVodWatch, recordEpisodeWatch, getEpisodeProgress, db } from '../db';
import type { Playlist, PlaylistItem } from '../stores/vodPlaylistStore';
import { useVodPlaylistStore } from '../stores/vodPlaylistStore';
import { useActivePlaylistStore, isActivePlaylistItem } from '../stores/activePlaylistStore';
import { useVodPlaylistProgressStore, type PlaylistItemProgressSnapshot } from '../stores/vodPlaylistProgressStore';
import {
  useVodMetadataOverridesStore,
  overrideKey,
  applyVodMetadataOverride,
} from '../stores/vodMetadataOverridesStore';
import type { PlaylistItemProgress } from '../hooks/usePlaylistProgress';
import type { VodPlayInfo } from '../types/media';
import type { LocalEntry } from '../services/local-library/types';
import {
  ensureLocalLibraryLoaded,
  readLocalLibrary,
  groupLocal,
  localEntryToStoredMovie,
  localGroupToStoredSeries,
  localEntryToStoredEpisode,
} from '../services/local-library/local-library';

/**
 * True when a playlist item's source has been removed or disabled, or when a
 * local library item's file/storage is unavailable.
 * Items without a sourceId (rare/manual) stay visible.
 * While sources are still loading (null) nothing is treated as hidden due to
 * IPTV source status, so the UI never flashes items away during startup.
 */
export function isPlaylistItemHidden(
  item: PlaylistItem,
  enabledSources: Set<string> | null,
  localLibrary?: LocalEntry[],
): boolean {
  if (item.sourceId === 'local') {
    if (item.unavailable) return true;
    const entries = localLibrary ?? readLocalLibrary();
    if (entries.length > 0) {
      const normUrl = item.directUrl?.toLowerCase();
      const entry =
        item.itemType === 'movie'
          ? entries.find(
              (e) =>
                e.type === 'movie' &&
                (`local_${e.id}` === item.mediaId ||
                  (normUrl && e.path.toLowerCase() === normUrl)),
            )
          : entries.find(
              (e) =>
                e.id === item.mediaId ||
                (normUrl && e.path.toLowerCase() === normUrl),
            );
      if (entry && entry.unavailable) return true;
    }
    return false;
  }
  if (!enabledSources) return false;
  return !!item.sourceId && !enabledSources.has(item.sourceId);
}

/**
 * How long an unresolvable playlist item is kept before it's auto-removed from
 * every playlist. "Unresolvable" means the source row / local file is gone
 * (source removed from the app, or re-synced away) — not merely a disabled
 * source, which still resolves and is handled by isPlaylistItemHidden.
 */
export const PLAYLIST_STALE_REMOVAL_DAYS = 3;

/**
 * Rebuild a playlist item's display/playback data from the CURRENT source row
 * (vodMovies / vodEpisodes+vodSeries) or the local library, so items stay in
 * sync after source re-syncs, credential changes, or metadata edits — the same
 * philosophy as Favorites, which resolve by id at render time. Falls back to
 * the stored snapshot when the item can't be found (e.g. the source or file
 * was removed).
 *
 * The stored `id`/`playlistId`/`mediaId`/`addedAt` are preserved so playlist
 * order, progress tracking, and the play queue keep working unchanged.
 *
 * Items that can't be resolved get `unresolvableSince` set (the first time
 * they fail); successful resolutions clear it. Transient errors (e.g. the DB
 * not ready yet) return the snapshot WITHOUT marking it, so a boot hiccup can't
 * age an item toward auto-removal.
 */
export async function resolvePlaylistItem(item: PlaylistItem): Promise<PlaylistItem> {
  try {
    if (item.sourceId === 'local') return await resolveLocalPlaylistItem(item);

    if (item.itemType === 'movie') {
      const row = await db.vodMovies.get(item.mediaId);
      if (!row) return unresolved(item);
      // Apply user-corrected metadata (title/poster/plot) on top of the fresh row.
      const movie = applyVodMetadataOverride(
        row,
        useVodMetadataOverridesStore.getState().overrides[overrideKey(row.stream_id, 'movie')],
      );
      return {
        ...item,
        unresolvableSince: undefined,
        title: movie.title || movie.name || item.title,
        poster: movie.stream_icon || movie.backdrop_path || item.poster,
        backdropUrl: movie.backdrop_path || item.backdropUrl,
        directUrl: movie.direct_url || item.directUrl,
        sourceId: movie.source_id || item.sourceId,
        duration: movie.duration ? movie.duration * 60 : item.duration,
      };
    }

    // Episode: refresh the episode row (fresh stream URL) plus the series row
    // (fresh title/poster). Filtered by series_id too, so id collisions across
    // sources can't resolve to the wrong series' episode.
    const [series, ep] = await Promise.all([
      item.seriesId ? db.vodSeries.get(item.seriesId) : Promise.resolve(undefined),
      item.seriesId
        ? db.vodEpisodes.whereRaw('id = $1 AND series_id = $2', [item.mediaId, item.seriesId]).first()
        : db.vodEpisodes.get(item.mediaId),
    ]);
    if (!ep) return unresolved(item);

    const seriesRow = series
      ? applyVodMetadataOverride(
          series,
          useVodMetadataOverridesStore.getState().overrides[overrideKey(series.series_id, 'series')],
        )
      : undefined;
    const seriesTitle = seriesRow?.title || seriesRow?.name || item.seriesTitle || item.title;
    const epTitle = ep.title || item.episodeTitle || '';
    return {
      ...item,
      unresolvableSince: undefined,
      title: `${seriesTitle} - S${String(ep.season_num).padStart(2, '0')}E${String(ep.episode_num).padStart(2, '0')}${epTitle ? `: ${epTitle}` : ''}`,
      seriesTitle,
      episodeTitle: epTitle || undefined,
      seasonNum: ep.season_num,
      episodeNum: ep.episode_num,
      poster: seriesRow?.cover || item.poster,
      backdropUrl: seriesRow?.backdrop_path || item.backdropUrl,
      directUrl: ep.direct_url || item.directUrl,
      sourceId: seriesRow?.source_id || item.sourceId,
      duration: ep.duration ? ep.duration * 60 : item.duration,
    };
  } catch (err) {
    // Transient failure (DB not ready, etc.) — keep the snapshot unmarked so
    // a boot hiccup can't age the item toward auto-removal.
    console.warn('[Playlist] Failed to resolve item, keeping snapshot:', err);
    return item;
  }
}

/** Mark an item as unresolvable (first failure sets the timestamp). */
function unresolved(item: PlaylistItem): PlaylistItem {
  return { ...item, unresolvableSince: item.unresolvableSince ?? Date.now() };
}

/** Resolve a local-library playlist item against the current library cache. */
async function resolveLocalPlaylistItem(item: PlaylistItem): Promise<PlaylistItem> {
  await ensureLocalLibraryLoaded();
  const entries = readLocalLibrary();
  if (entries.length === 0) return unresolved(item);

  // Local movies store `local_<path>` as mediaId; local episodes store the
  // file path directly (the episode entry id).
  const normUrl = item.directUrl?.toLowerCase();
  const entry =
    item.itemType === 'movie'
      ? entries.find(
          (e) =>
            e.type === 'movie' &&
            (`local_${e.id}` === item.mediaId ||
              (normUrl && e.path.toLowerCase() === normUrl)),
        )
      : entries.find(
          (e) =>
            e.id === item.mediaId ||
            (normUrl && e.path.toLowerCase() === normUrl),
        );
  if (!entry) return unresolved(item);

  const isUnavailable = !!entry.unavailable;

  if (item.itemType === 'movie') {
    const movie = localEntryToStoredMovie(entry);
    return {
      ...item,
      unresolvableSince: undefined,
      unavailable: isUnavailable ? true : undefined,
      title: movie.title || movie.name || item.title,
      poster: movie.stream_icon || item.poster,
      backdropUrl: movie.backdrop_path || item.backdropUrl,
      directUrl: movie.direct_url || item.directUrl,
      duration: movie.duration ? movie.duration * 60 : item.duration,
      sourceName: 'Local',
    };
  }

  // Episode: re-derive the series group so the poster/title follow the show.
  const key = item.seriesId ? item.seriesId.slice('local_'.length) : undefined;
  const group = key ? groupLocal(entries).find((g) => g.kind === 'show' && g.key === key) : undefined;
  if (!group || group.kind !== 'show') return unresolved(item);

  const series = localGroupToStoredSeries(group);
  const ep = localEntryToStoredEpisode(entry, series.series_id, group.head.title);
  const epTitle = ep.title && !ep.title.startsWith('Episode ') ? ep.title : '';
  return {
    ...item,
    unresolvableSince: undefined,
    unavailable: isUnavailable ? true : undefined,
    title: `${series.title || item.seriesTitle || item.title} - S${String(ep.season_num).padStart(2, '0')}E${String(ep.episode_num).padStart(2, '0')}${epTitle ? `: ${epTitle}` : ''}`,
    seriesTitle: series.title || item.seriesTitle,
    episodeTitle: epTitle || item.episodeTitle,
    seasonNum: ep.season_num,
    episodeNum: ep.episode_num,
    poster: series.cover || item.poster,
    backdropUrl: series.backdrop_path || item.backdropUrl,
    directUrl: ep.direct_url || item.directUrl,
    duration: ep.duration ? ep.duration * 60 : item.duration,
    sourceName: 'Local',
  };
}

// Display/playback fields that may be refreshed from the live source. Identity
// (id/playlistId/mediaId/addedAt) and order are never touched.
const RESOLVABLE_FIELDS: (keyof PlaylistItem)[] = [
  'title',
  'poster',
  'backdropUrl',
  'directUrl',
  'sourceId',
  'sourceName',
  'seriesTitle',
  'episodeTitle',
  'seasonNum',
  'episodeNum',
  'duration',
  'unresolvableSince',
  'unavailable',
];

/**
 * Persist resolved metadata back into the stored playlist items, so the
 * persisted blob (and therefore exports/imports) carries fresh titles,
 * posters, and stream URLs instead of the add-time snapshot. Also prunes items
 * that have been unresolvable (source/file gone) for PLAYLIST_STALE_REMOVAL_DAYS
 * days. Item ids, playlist membership, and order are preserved.
 */
export function applyPlaylistResolutions(resolvedItems: PlaylistItem[]): void {
  if (resolvedItems.length === 0) return;
  const store = useVodPlaylistStore.getState();
  const byId = new Map(resolvedItems.map((i) => [i.id, i]));
  const staleCutoff = Date.now() - PLAYLIST_STALE_REMOVAL_DAYS * 24 * 60 * 60 * 1000;
  const staleIds = new Set<string>();

  for (const pl of store.playlists) {
    for (const stored of pl.items) {
      const resolved = byId.get(stored.id);
      if (!resolved) continue;

      if (resolved.unresolvableSince != null && resolved.unresolvableSince < staleCutoff) {
        staleIds.add(stored.id);
        continue;
      }

      const patch: Partial<PlaylistItem> = {};
      for (const field of RESOLVABLE_FIELDS) {
        if (resolved[field] !== stored[field]) {
          (patch as Record<string, unknown>)[field] = resolved[field];
        }
      }
      if (Object.keys(patch).length > 0) {
        store.updatePlaylistItem(pl.id, stored.id, patch);
      }
    }
  }

  if (staleIds.size > 0) {
    for (const pl of store.playlists) {
      const toRemove = pl.items.filter((i) => staleIds.has(i.id)).map((i) => i.id);
      if (toRemove.length > 0) store.removeItemsFromPlaylist(pl.id, toRemove);
    }
  }
}

/**
 * Build the canonical VodPlayInfo for a playlist item, mirroring what
 * SeriesDetail/MovieDetail pass to playback so that resume and progress
 * tracking work exactly like normal VOD playback.
 *
 * For episodes the mediaId uses the `seriesId_ep_episodeId` shape the
 * playback progress-save and resume paths key on.
 */
export function playlistItemToVodInfo(item: PlaylistItem): VodPlayInfo {
  const isEpisode = item.itemType === 'episode';
  return {
    url: item.directUrl || '',
    title: item.title,
    type: isEpisode ? 'series' : 'movie',
    source_id: item.sourceId,
    mediaId: isEpisode && item.seriesId ? `${item.seriesId}_ep_${item.mediaId}` : item.mediaId,
    seriesId: item.seriesId,
    seasonNum: item.seasonNum,
    episodeNum: item.episodeNum,
    episodeId: isEpisode ? item.mediaId : undefined,
    episodeInfo: isEpisode
      ? `S${item.seasonNum ?? 0} E${item.episodeNum ?? 0}${item.episodeTitle ? ` · ${item.episodeTitle}` : ''}`
      : undefined,
    backdropUrl: item.backdropUrl || undefined,
    posterUrl: item.poster || undefined,
  };
}

/**
 * Find the most recently watched item of a playlist. Items with no watch
 * history (watchedAt 0) are ignored; returns null when nothing was watched.
 */
/**
 * Build the progress map for a set of playlist items from the DB history rows
 * (episode_history + vod_history), filling any gaps from the localStorage
 * snapshots so playlists keep resume/last-watched info even after a cache
 * clear wiped the history tables. Keyed by playlist item id.
 */
export function buildPlaylistProgressMap(
  items: PlaylistItem[],
  episodes: Record<string, { progress_seconds: number; total_duration: number; completed: boolean; watched_at: number }>,
  movies: Record<string, { progress_seconds: number; total_duration: number; watched_at: number }>,
  snapshots: Record<string, PlaylistItemProgressSnapshot>
): Map<string, PlaylistItemProgress> {
  const next = new Map<string, PlaylistItemProgress>();

  // DB history is the source of truth while it exists (freshest data).
  for (const item of items) {
    if (item.itemType === 'episode') {
      const p = episodes[item.mediaId];
      if (!p) continue;
      const dur = p.total_duration;
      const prog = p.progress_seconds;
      const completed = p.completed || (dur > 0 && prog / dur >= 0.9);
      next.set(item.id, {
        progressSeconds: prog,
        totalDuration: dur,
        completed,
        percent: dur > 0 ? Math.min(100, (prog / dur) * 100) : 0,
        watchedAt: p.watched_at || 0,
      });
    } else {
      const p = movies[item.mediaId];
      if (!p) continue;
      const dur = p.total_duration;
      const prog = p.progress_seconds;
      next.set(item.id, {
        progressSeconds: prog,
        totalDuration: dur,
        completed: dur > 0 && prog / dur >= 0.9,
        percent: dur > 0 ? Math.min(100, (prog / dur) * 100) : 0,
        watchedAt: p.watched_at || 0,
      });
    }
  }

  // Fall back to localStorage snapshots for items the DB has no history for
  // (e.g. after "Clear All Cached Data" wiped the history tables).
  for (const item of items) {
    if (next.has(item.id)) continue;
    const snap = snapshots[item.id];
    if (!snap) continue;
    const dur = snap.totalDuration;
    next.set(item.id, {
      progressSeconds: snap.progressSeconds,
      totalDuration: dur,
      completed: snap.completed || (dur > 0 && snap.progressSeconds / dur >= 0.9),
      percent: dur > 0 ? Math.min(100, (snap.progressSeconds / dur) * 100) : 0,
      watchedAt: snap.watchedAt || 0,
    });
  }

  return next;
}

/**
 * Snapshot the currently playing item's progress into the playlist progress
 * store (localStorage) when a playlist item is what's actually playing. The
 * DB history this mirrors is wiped by "Clear All Cached Data", so the
 * snapshot keeps playlists' resume hints and "last watched" info intact.
 */
export function snapshotPlaylistProgress(
  vodInfo: VodPlayInfo | null | undefined,
  position: number,
  duration: number
): void {
  if (!vodInfo || position <= 0 || duration <= 0) return;
  const active = useActivePlaylistStore.getState();
  if (!active.activePlaylistId || active.currentIndex < 0) return;
  const item = active.items[active.currentIndex];
  if (!item || !isActivePlaylistItem(vodInfo, item)) return;
  useVodPlaylistProgressStore.getState().setProgress(item.id, {
    progressSeconds: Math.floor(position),
    totalDuration: Math.floor(duration),
    completed: position / duration >= 0.9,
    watchedAt: Date.now(),
  });
}

export function findLastWatchedItem(
  items: PlaylistItem[],
  progressMap: ReadonlyMap<string, PlaylistItemProgress>
): PlaylistItem | null {
  let best: PlaylistItem | null = null;
  let bestAt = 0;
  for (const item of items) {
    const p = progressMap.get(item.id);
    const at = p?.watchedAt ?? 0;
    if (at > bestAt) {
      best = item;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Sort playlists so the most recently watched one comes first (by the latest
 * watched_at among each playlist's items). Never-played playlists sink below
 * the watched ones, keeping their original relative order (stable sort).
 */
export function sortPlaylistsByLastPlayed(
  playlists: Playlist[],
  progressMap: ReadonlyMap<string, PlaylistItemProgress>
): Playlist[] {
  const lastPlayedAt = (pl: Playlist): number => {
    let max = 0;
    for (const item of pl.items) {
      const at = progressMap.get(item.id)?.watchedAt ?? 0;
      if (at > max) max = at;
    }
    return max;
  };
  return [...playlists].sort((a, b) => lastPlayedAt(b) - lastPlayedAt(a));
}

/**
 * Record a playlist item into vod_history (the Recent rail) and episode
 * progress, mirroring the recording done by SeriesDetail/MovieDetail when a
 * video starts. Existing episode resume position is preserved so replaying an
 * item never wipes its progress.
 */
export async function recordPlaylistItemWatch(item: PlaylistItem): Promise<void> {
  if (item.itemType === 'movie') {
    await recordVodWatch(item.mediaId, 'movie', item.sourceId || '', item.title, item.poster || undefined);
    return;
  }
  if (!item.seriesId) return;

  // Preserve any existing episode progress instead of resetting it.
  let resumePosition = 0;
  let duration = 0;
  try {
    const progress = await getEpisodeProgress(item.mediaId);
    const isCompleted = progress?.completed === 1 || 
      (progress && (progress.total_duration ?? 0) > 0 && ((progress.progress_seconds ?? 0) / (progress.total_duration ?? 1)) >= 0.95);
    if (!isCompleted && progress && (progress.progress_seconds ?? 0) > 10 && (progress.total_duration ?? 0) > 0) {
      resumePosition = progress.progress_seconds ?? 0;
      duration = progress.total_duration ?? 0;
    }
  } catch (err) {
    console.warn('[Playlist] Failed to read existing episode progress:', err);
  }

  await recordVodWatch(
    item.seriesId,
    'series',
    item.sourceId || '',
    item.seriesTitle || item.title,
    item.poster || undefined,
    item.seasonNum,
    item.episodeNum,
    item.episodeTitle || `Episode ${item.episodeNum ?? 0}`
  );
  await recordEpisodeWatch(
    item.mediaId,
    item.seriesId,
    item.sourceId || '',
    item.seasonNum ?? 0,
    item.episodeNum ?? 0,
    item.episodeTitle || '',
    resumePosition,
    duration
  );
}
