import { useCallback, useMemo, useRef, useState } from 'react';
import { VirtualGrid, type VirtualGridHandle } from '../common/VirtualGrid';
import { MediaCard } from './MediaCard';
import type { StoredMovie, StoredSeries } from '../../db';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useVodLastWatchedMap } from '../../hooks/useVod';
import { useScrollMemory } from '../../hooks/useScrollMemory';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  DEFAULT_SORT_DIRECTION,
  sortVodItems,
  type SortDirection,
  type VodSortKey,
} from './vodSort';
import './VodBrowse.css';

// Sort options available in the Favorites view (in dropdown order)
const FAVORITES_SORT_KEYS: VodSortKey[] = ['default', 'name', 'year', 'rating', 'lastWatched'];

export interface FavoritesViewProps {
  type: 'movie' | 'series';
  items: (StoredMovie | StoredSeries)[];
  loading: boolean;
  onItemClick: (item: StoredMovie | StoredSeries) => void;
}

export function FavoritesView({
  type,
  items,
  loading,
  onItemClick,
}: FavoritesViewProps) {
  useTranslation();
  const virtualGridRef = useRef<VirtualGridHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const removeFavorite = useVodFavoritesStore((s) => s.removeFavorite);
  const favorites = useVodFavoritesStore((s) => s.favorites);
  const sourceNameMap = useSourceNameMap();

  const [showSourceBadge, setShowSourceBadge] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodFavoritesShowSourceBadge');
      return saved === 'true';
    }
    return false;
  });

  // Sort preference (persisted)
  const [sortKey, setSortKey] = useState<VodSortKey>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodFavoritesSortBy');
      if (saved && (FAVORITES_SORT_KEYS as string[]).includes(saved)) {
        return saved as VodSortKey;
      }
    }
    return 'default';
  });

  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    if (typeof window !== 'undefined') {
      const savedDir = localStorage.getItem('vodFavoritesSortDir');
      if (savedDir === 'asc' || savedDir === 'desc') {
        return savedDir;
      }
    }
    return DEFAULT_SORT_DIRECTION.default;
  });

  const setSortAndSave = useCallback((key: VodSortKey) => {
    setSortKey(key);
    setSortDirection(DEFAULT_SORT_DIRECTION[key]);
    if (typeof window !== 'undefined') {
      localStorage.setItem('vodFavoritesSortBy', key);
      localStorage.setItem('vodFavoritesSortDir', DEFAULT_SORT_DIRECTION[key]);
    }
  }, []);

  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => {
      const next = prev === 'asc' ? 'desc' : 'asc';
      if (typeof window !== 'undefined') {
        localStorage.setItem('vodFavoritesSortDir', next);
      }
      return next;
    });
  }, []);

  // Handle selecting the same sort key again: toggle direction instead
  const handleSortSelect = useCallback((key: VodSortKey) => {
    if (key === sortKey) {
      toggleSortDirection();
      return;
    }
    setSortAndSave(key);
  }, [sortKey, setSortAndSave, toggleSortDirection]);

  // Map of favorite id -> when it was added to favorites
  const addedAtMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of favorites) {
      if (f.type === type) {
        map.set(f.id, f.addedAt);
      }
    }
    return map;
  }, [favorites, type]);

  // Last watched timestamps from vod_history (media_id -> watched_at)
  const lastWatchedMap = useVodLastWatchedMap(type);

  // Sorted items based on the active sort preference
  const sortedItems = useMemo(
    () => sortVodItems(items, type, sortKey, sortDirection, { addedAtMap, lastWatchedMap }),
    [items, type, sortKey, sortDirection, addedAtMap, lastWatchedMap]
  );

  // Favorites is its own list: it keeps a scroll position independent of the
  // category grids, across playback and section switches.
  const { onScroll: handleGridScroll } = useScrollMemory({
    listKey: `vod:${type}:list:favorites`,
    scrollRef,
    ready: !loading && items.length > 0,
    onNoSavedPosition: () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    },
  });

  const toggleSourceBadge = useCallback(() => {
    setShowSourceBadge((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem('vodFavoritesShowSourceBadge', String(next));
      }
      return next;
    });
  }, []);

  const handleRemove = useCallback((item: StoredMovie | StoredSeries) => {
    const id = type === 'movie'
      ? (item as StoredMovie).stream_id
      : (item as StoredSeries).series_id;
    removeFavorite(id, type);
  }, [type, removeFavorite]);

  const ItemContent = useCallback((index: number, item: StoredMovie | StoredSeries) => {
    if (!item) return null;

    const sourceName = (showSourceBadge && sourceNameMap)
      ? sourceNameMap.get(item.source_id)
      : undefined;

    return (
      <MediaCard
        item={item}
        type={type}
        index={index}
        onClick={onItemClick}
        isFavorited={true}
        onToggleFavorite={handleRemove}
        sourceName={sourceName}
      />
    );
  }, [type, onItemClick, handleRemove, showSourceBadge, sourceNameMap]);

  if (loading) {
    return (
      <div className="vod-browse">
        <div className="vod-browse__loading-container">
          <div className="vod-browse__spinner" />
          <span>{i18n.t('vod:loadingFavorites')}</span>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="vod-browse">
        <div className="vod-browse__empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="48" height="48" style={{ marginBottom: '16px', opacity: 0.5 }}>
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2>{i18n.t('vod:noFavorites')}</h2>
          <p>{i18n.t('vod:noFavoritesHint', { type: type === 'movie' ? i18n.t('vod:movie') : i18n.t('vod:series') })}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="vod-browse">
      <div className="vod-browse__toolbar">
        <div className="vod-browse__toolbar-left">
          <span className="vod-browse__category-name">{i18n.t('vod:favorites')}</span>
          <span className="vod-browse__item-count">{i18n.t('vod:itemCount', { count: items.length })}</span>
        </div>
        <div className="vod-browse__toolbar-right">
          <div className="vod-browse__sort-container">
            <span className="vod-browse__sort-label">{i18n.t('vod:sort')}</span>
            <select
              className="vod-browse__sort-select"
              value={sortKey}
              onChange={(e) => handleSortSelect(e.target.value as VodSortKey)}
              aria-label={i18n.t('vod:sort')}
            >
              <option value="default">{i18n.t('vod:sortAdded')}</option>
              <option value="name">{i18n.t('vod:sortName')}</option>
              <option value="year">{i18n.t('vod:sortYear')}</option>
              <option value="rating">{i18n.t('vod:sortRating')}</option>
              <option value="lastWatched">{i18n.t('vod:sortLastWatched')}</option>
            </select>
            <button
              className={`vod-sort-dir-btn ${sortDirection === 'desc' ? 'active' : ''}`}
              onClick={toggleSortDirection}
              title={sortDirection === 'asc' ? i18n.t('vod:sortAscending') : i18n.t('vod:sortDescending')}
              aria-label={sortDirection === 'asc' ? i18n.t('vod:sortAscending') : i18n.t('vod:sortDescending')}
              type="button"
            >
              {sortDirection === 'asc' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M12 19V5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M12 5v14" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 12l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          <button
            className={`vod-favorites-toggle-btn ${showSourceBadge ? 'active' : ''}`}
            onClick={toggleSourceBadge}
            title={showSourceBadge ? i18n.t('vod:hideSourceBadge') : i18n.t('vod:showSourceBadge')}
            aria-label={i18n.t('vod:toggleSourceBadge')}
            type="button"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{i18n.t('common:showSource')}</span>
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="vod-browse__grid-scroll flex-1 min-h-0 overflow-y-auto"
        onScroll={handleGridScroll}
      >
        <VirtualGrid
          ref={virtualGridRef}
          items={sortedItems}
          scrollRef={scrollRef}
          minColumnWidth={164}
          gapX={8}
          gapY={12}
          estimateRowHeight={276}
          renderItem={(item, index) => ItemContent(index, item)}
          overscan={4}
        />
      </div>
    </div>
  );
}

export default FavoritesView;
