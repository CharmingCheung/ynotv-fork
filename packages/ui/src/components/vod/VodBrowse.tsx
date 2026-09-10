/**
 * VodBrowse - Virtualized gallery grid with A-Z navigation
 *
 * Shows category-filtered content in a grid with infinite scroll
 * and alphabet quick-nav rail. Uses @tanstack/react-virtual row-based
 * virtualization for 60fps controller/remote navigation.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { VirtualGrid, type VirtualGridHandle } from '../common/VirtualGrid';
import { PosterSizeSlider, type PosterSizePreset } from '../PosterSizeSlider';
import { MediaCard } from './MediaCard';
import { AlphabetRail } from './AlphabetRail';
import type { StoredMovie, StoredSeries } from '../../db';
import {
  usePaginatedMovies,
  usePaginatedSeries,
  useAlphabetIndex,
  useCurrentLetter,
  useLazyStalkerLoader,
  useVodLastWatchedMap,
} from '../../hooks/useVod';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  DEFAULT_SORT_DIRECTION,
  sortVodItems,
  type SortDirection,
  type VodSortKey,
} from './vodSort';
import './VodBrowse.css';

// Persists each VOD grid's scroll offset across unmounts. The Movies/Series
// pages are torn down when playback starts or the user switches sections
// (TransitionView unmounts them), which destroys the grid's scrollTop. Caching
// it here (keyed by view + category + search) lets us restore the exact spot
// when the user comes back, even in lists with thousands of items.
const savedVodGridScroll = new Map<string, number>();

const VOD_POSTER_SIZE_PRESETS = [
  { value: 100, label: 'XS' },
  { value: 120, label: 'S' },
  { value: 140, label: 'M' },
  { value: 160, label: 'L' },
  { value: 180, label: 'XL' },
  { value: 200, label: '2XL' },
  { value: 240, label: '3XL' },
] as const satisfies readonly PosterSizePreset[];

type VodPosterSizeValue = (typeof VOD_POSTER_SIZE_PRESETS)[number]['value'];

const VOD_BROWSE_SORT_KEYS: VodSortKey[] = ['added', 'name', 'year', 'rating', 'lastWatched'];

function usePosterSizePreference(): [VodPosterSizeValue, (value: VodPosterSizeValue) => void] {
  const [size, setSize] = useState<VodPosterSizeValue>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodPosterSize');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (VOD_POSTER_SIZE_PRESETS.some(p => p.value === parsed)) {
          return parsed as VodPosterSizeValue;
        }
      }
    }
    return 160;
  });

  const setSizeAndSave = useCallback((newSize: VodPosterSizeValue) => {
    setSize(newSize);
    if (typeof window !== 'undefined') {
      localStorage.setItem('vodPosterSize', String(newSize));
    }
  }, []);

  return [size, setSizeAndSave];
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

export interface VodBrowseProps {
  type: 'movies' | 'series';
  categoryId: string | null;
  categoryName: string;
  search?: string;
  onItemClick: (item: StoredMovie | StoredSeries) => void;
}

export function VodBrowse({
  type,
  categoryId,
  categoryName,
  search,
  onItemClick,
}: VodBrowseProps) {
  useTranslation();
  const virtualGridRef = useRef<VirtualGridHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });

  // Scroll-position persistence (see savedVodGridScroll above).
  const scrollKey = useMemo(
    () => `${type}:${categoryId ?? 'all'}:${search ?? ''}`,
    [type, categoryId, search]
  );
  const lastScrollTopRef = useRef(0);
  const pendingRestoreKeyRef = useRef<string | null>(null);

  // Save the current offset whenever this view is about to be replaced
  // (unmount or category/search change), keyed by the view being left.
  useEffect(() => {
    const key = scrollKey;
    pendingRestoreKeyRef.current = key;
    lastScrollTopRef.current = 0;
    return () => {
      savedVodGridScroll.set(key, lastScrollTopRef.current);
    };
  }, [scrollKey]);

  const [posterSize, setPosterSize] = usePosterSizePreference();

  const [sortBy, setSortBy] = useState<VodSortKey>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodSortBy');
      if (saved && (VOD_BROWSE_SORT_KEYS as string[]).includes(saved)) {
        return saved as VodSortKey;
      }
    }
    return 'name';
  });

  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    if (typeof window !== 'undefined') {
      const savedDir = localStorage.getItem('vodSortDir');
      if (savedDir === 'asc' || savedDir === 'desc') {
        return savedDir;
      }
      const savedBy = localStorage.getItem('vodSortBy');
      if (savedBy && (VOD_BROWSE_SORT_KEYS as string[]).includes(savedBy)) {
        return DEFAULT_SORT_DIRECTION[savedBy as VodSortKey];
      }
    }
    return DEFAULT_SORT_DIRECTION.name;
  });

  const setSortAndSave = useCallback((val: VodSortKey) => {
    setSortBy(val);
    setSortDirection(DEFAULT_SORT_DIRECTION[val]);
    if (typeof window !== 'undefined') {
      localStorage.setItem('vodSortBy', val);
      localStorage.setItem('vodSortDir', DEFAULT_SORT_DIRECTION[val]);
    }
  }, []);

  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => {
      const next = prev === 'asc' ? 'desc' : 'asc';
      if (typeof window !== 'undefined') {
        localStorage.setItem('vodSortDir', next);
      }
      return next;
    });
  }, []);

  const handleSortSelect = useCallback((val: VodSortKey) => {
    if (val === sortBy) {
      toggleSortDirection();
      return;
    }
    setSortAndSave(val);
  }, [sortBy, setSortAndSave, toggleSortDirection]);

  const includeSourceInVodSearch = useSettingsStore((s) => s.includeSourceInVodSearch);
  const vodShowSourceBadge = useSettingsStore((s) => s.vodShowSourceBadge);
  const sourceNameMap = useSourceNameMap();

  const debouncedSearch = useDebouncedValue(search, 300);

  // Scroll to top when category changes (unless there's a saved scroll offset to restore)
  useEffect(() => {
    const saved = savedVodGridScroll.get(scrollKey);
    if ((saved === undefined || saved === 0) && virtualGridRef.current) {
      virtualGridRef.current.scrollToIndex({ index: 0, align: 'start' });
    }
  }, [categoryId, scrollKey]);

  const { syncing: lazyLoading, progress, message, completed, hasCache } = useLazyStalkerLoader(
    type === 'movies' ? 'movies' : 'series',
    categoryId
  );

  const hookSort = sortBy === 'added' ? 'added' : 'name';
  const moviesData = usePaginatedMovies(type === 'movies' ? categoryId : null, debouncedSearch, hookSort, completed);
  const seriesData = usePaginatedSeries(type === 'series' ? categoryId : null, debouncedSearch, hookSort, completed);

  const { items, loading: dataLoading, hasMore, loadMore } = type === 'movies' ? moviesData : seriesData;
  const loading = dataLoading || lazyLoading;

  // Once the items for the current view are rendered, jump back to the saved
  // offset so returning users land exactly where they left off.
  // Use dataLoading so cached items restore immediately instead of waiting
  // for a background Stalker sync to finish.
  useEffect(() => {
    if (dataLoading || items.length === 0) return;
    if (pendingRestoreKeyRef.current !== scrollKey) return;
    pendingRestoreKeyRef.current = null;
    const saved = savedVodGridScroll.get(scrollKey);
    if (saved !== undefined && saved > 0 && scrollRef.current) {
      scrollRef.current.scrollTop = saved;
      lastScrollTopRef.current = saved;
    }
  }, [dataLoading, items.length, scrollKey]);

  const lastWatchedMap = useVodLastWatchedMap(type === 'movies' ? 'movie' : 'series');

  const sortedItems = useMemo(
    () => sortVodItems(items, type === 'movies' ? 'movie' : 'series', sortBy, sortDirection, { lastWatchedMap }),
    [items, type, sortBy, sortDirection, lastWatchedMap]
  );

  const allFavorites = useVodFavoritesStore((s) => s.favorites);
  const favoritedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of allFavorites) {
      if ((type === 'movies' && f.type === 'movie') || (type === 'series' && f.type === 'series')) {
        ids.add(f.id);
      }
    }
    return ids;
  }, [allFavorites, type]);
  const addFavorite = useVodFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useVodFavoritesStore((s) => s.removeFavorite);

  const alphabetIndex = useAlphabetIndex(sortedItems);
  const currentLetter = useCurrentLetter(sortedItems, visibleRange.startIndex);

  const availableLetters = useMemo(() => {
    return new Set(alphabetIndex.keys());
  }, [alphabetIndex]);

  const handleLetterSelect = useCallback((letter: string) => {
    const index = alphabetIndex.get(letter);
    if (index !== undefined && virtualGridRef.current) {
      virtualGridRef.current.scrollToIndex({
        index,
        align: 'start',
      });
    }
  }, [alphabetIndex]);

  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    setVisibleRange(range);
    if (hasMore && !loading && range.endIndex >= sortedItems.length - 20) {
      loadMore();
    }
  }, [hasMore, loading, loadMore, sortedItems.length]);

  const computeItemKey = useCallback(
    (item: StoredMovie | StoredSeries, index: number) => {
      if (!item) return index;
      return type === 'movies'
        ? `movie-${(item as StoredMovie).stream_id}`
        : `series-${(item as StoredSeries).series_id}`;
    },
    [type]
  );

  const cardDimensions = useMemo(() => {
    const cardWidth = posterSize;
    const posterHeight = Math.round(cardWidth * 1.5);
    const infoHeight = posterSize >= 180 ? 36 : posterSize >= 140 ? 32 : 30;
    const cardHeight = posterHeight + infoHeight + 4;
    const itemWidth = cardWidth + 4;
    const itemHeight = cardHeight + 4;
    
    return {
      cardWidth,
      cardHeight,
      posterHeight,
      infoHeight,
      itemWidth,
      itemHeight,
    };
  }, [posterSize]);

  const ItemContent = useCallback(
    (index: number, item: StoredMovie | StoredSeries) => {
      if (!item) return null;

      const itemId = type === 'movies'
        ? (item as StoredMovie).stream_id
        : (item as StoredSeries).series_id;
      const isFav = favoritedIds.has(itemId);

      let sizeLabel: 'small' | 'medium' | 'large' = 'medium';
      if (posterSize <= 120) sizeLabel = 'small';
      else if (posterSize >= 180) sizeLabel = 'large';

      const cardStyle = {
        '--marquee-visible-width': `${cardDimensions.cardWidth}px`,
      } as React.CSSProperties;

      const showBadge = vodShowSourceBadge || (includeSourceInVodSearch && search && search.trim());
      const sourceName = showBadge
        ? (item.source_id === 'local' ? 'Local' : sourceNameMap?.get(item.source_id))
        : undefined;

      return (
        <MediaCard
          item={item}
          type={type === 'movies' ? 'movie' : 'series'}
          index={index}
          onClick={onItemClick}
          size={sizeLabel}
          style={cardStyle}
          isFavorited={isFav}
          sourceName={sourceName}
          onToggleFavorite={(clickedItem) => {
            const clickedId = type === 'movies'
              ? (clickedItem as StoredMovie).stream_id
              : (clickedItem as StoredSeries).series_id;
            if (favoritedIds.has(clickedId)) {
              removeFavorite(clickedId, type === 'movies' ? 'movie' : 'series');
            } else {
              addFavorite({
                id: clickedId,
                type: type === 'movies' ? 'movie' : 'series',
                title: clickedItem.title || clickedItem.name,
                poster: type === 'movies'
                  ? (clickedItem as StoredMovie).stream_icon
                  : (clickedItem as StoredSeries).cover,
                year: clickedItem.year || clickedItem.release_date?.slice(0, 4),
              });
            }
          }}
        />
      );
    },
    [type, onItemClick, posterSize, cardDimensions, favoritedIds, addFavorite, removeFavorite, includeSourceInVodSearch, vodShowSourceBadge, search, sourceNameMap]
  );

  const gridStyle = useMemo(() => ({
    '--vod-card-width': `${cardDimensions.cardWidth}px`,
    '--vod-card-height': `${cardDimensions.cardHeight}px`,
    '--vod-item-width': `${cardDimensions.itemWidth}px`,
    '--vod-item-height': `${cardDimensions.itemHeight}px`,
    '--vod-poster-height': `${cardDimensions.posterHeight}px`,
  } as React.CSSProperties), [cardDimensions]);

  if (lazyLoading && !hasCache) {
    return (
      <div className="vod-browse vod-browse--loading-state">
        <div className="vod-browse__spinner"></div>
        <h3>{i18n.t('vod:loading')}</h3>
        {message && <p>{message}</p>}
        {progress > 0 && (
          <div className="vod-browse__progress-bar">
            <div className="vod-browse__progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
        )}
      </div>
    );
  }

  if (!loading && !lazyLoading && items.length === 0) {
    return (
      <div className="vod-browse vod-browse--empty">
        <div className="vod-browse__empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <h3>{i18n.t('vod:noItemsFound', { type: type === 'movies' ? i18n.t('vod:movies') : i18n.t('vod:series') })}</h3>
          <p>
            {search
              ? i18n.t('vod:noResultsInCategory', { search, category: categoryName })
              : i18n.t('vod:noItemsInCategory', { type: type === 'movies' ? i18n.t('vod:movies') : i18n.t('vod:series'), category: categoryName })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="vod-browse" style={gridStyle}>
      <div className="vod-browse__toolbar">
        <div className="vod-browse__toolbar-left">
          <span className="vod-browse__category-name">{categoryName}</span>
          <span className="vod-browse__item-count">{i18n.t('vod:itemCount', { count: sortedItems.length })}</span>
        </div>
        <div className="vod-browse__toolbar-right">
          {lazyLoading && hasCache && message && (
            <div className="vod-browse__sync-status" title={message}>
              <div className="vod-browse__spinner" />
              <span>{message}</span>
              {progress > 0 && (
                <div className="vod-browse__sync-progress">
                  <div
                    className="vod-browse__sync-progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </div>
          )}
          <div className="vod-browse__sort-container">
            <span className="vod-browse__sort-label">{i18n.t('vod:sort')}</span>
            <select
              className="vod-browse__sort-select"
              value={sortBy}
              onChange={(e) => handleSortSelect(e.target.value as VodSortKey)}
              aria-label={i18n.t('vod:sort')}
            >
              <option value="added">{i18n.t('vod:sortAdded')}</option>
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
          <PosterSizeSlider value={posterSize} presets={VOD_POSTER_SIZE_PRESETS} onChange={(v) => setPosterSize(v as VodPosterSizeValue)} />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="vod-browse__grid-scroll flex-1 min-h-0 overflow-y-auto"
        onScroll={(e) => {
          lastScrollTopRef.current = e.currentTarget.scrollTop;
          // Cancel pending restore on user manual scroll so background sync doesn't clobber it
          pendingRestoreKeyRef.current = null;
        }}
      >
        <VirtualGrid
          ref={virtualGridRef}
          items={sortedItems}
          scrollRef={scrollRef}
          minColumnWidth={cardDimensions.itemWidth}
          gapX={8}
          gapY={12}
          estimateRowHeight={cardDimensions.itemHeight}
          getKey={computeItemKey}
          renderItem={(item, index) => ItemContent(index, item)}
          onRangeChange={handleRangeChange}
          overscan={4}
        />
        {loading && (
          <div className="vod-browse__loading">
            <div className="vod-browse__spinner" />
            <span>{i18n.t('vod:loadingMore')}</span>
          </div>
        )}
      </div>

      {sortedItems.length > 0 && sortBy === 'name' && (
        <AlphabetRail
          currentLetter={currentLetter}
          availableLetters={availableLetters}
          onLetterSelect={handleLetterSelect}
          count={sortedItems.length}
        />
      )}
    </div>
  );
}

export default VodBrowse;
