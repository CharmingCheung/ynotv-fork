/**
 * RecentView - Grid view of recently watched movies/series
 *
 * Shows recently watched items with progress bars and episode info
 */

import { useCallback, useMemo, useRef } from 'react';
import { VirtualGrid, type VirtualGridHandle } from '../common/VirtualGrid';
import { MediaCard } from './MediaCard';
import type { StoredMovie, StoredSeries } from '../../db';
import type { RecentlyWatchedItem } from '../../hooks/useVod';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useScrollMemory } from '../../hooks/useScrollMemory';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './VodBrowse.css';

export interface RecentViewProps {
  type: 'movie' | 'series';
  items: RecentlyWatchedItem<StoredMovie | StoredSeries>[];
  loading: boolean;
  onItemClick: (item: StoredMovie | StoredSeries, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => void;
  onRemove?: (item: StoredMovie | StoredSeries) => void;
  onPlayItem?: (item: StoredMovie | StoredSeries, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => void;
}

export function RecentView({
  type,
  items,
  loading,
  onItemClick,
  onRemove,
  onPlayItem,
}: RecentViewProps) {
  useTranslation();
  const virtualGridRef = useRef<VirtualGridHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const vodShowSourceBadge = useSettingsStore((s) => s.vodShowSourceBadge);
  const sourceNameMap = useSourceNameMap();

  // Extract raw items for the grid
  const rawItems = useMemo(() => {
    return items.map(i => i.item);
  }, [items]);

  // Recently Watched is its own list, so it keeps a scroll position of its own
  // across playback and section switches.
  const { onScroll: handleGridScroll } = useScrollMemory({
    listKey: `vod:${type}:list:recent`,
    scrollRef,
    ready: !loading && items.length > 0,
    onNoSavedPosition: () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    },
  });

  // Create maps for quick lookup
  const progressMap = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach(item => {
      const id = type === 'movie' 
        ? (item.item as StoredMovie).stream_id 
        : (item.item as StoredSeries).series_id;
      map.set(id, item.progress_percent);
    });
    return map;
  }, [items, type]);

  const episodeDataMap = useMemo(() => {
    if (type !== 'series') return undefined;
    const map = new Map<string, { seasonNum?: number; episodeNum?: number; episodeTitle?: string }>();
    items.forEach(item => {
      const seriesItem = item as RecentlyWatchedItem<StoredSeries>;
      const id = seriesItem.item.series_id;
      map.set(id, {
        seasonNum: seriesItem.season_num,
        episodeNum: seriesItem.episode_num,
        episodeTitle: seriesItem.episode_title,
      });
    });
    return map;
  }, [items, type]);

  // Grid item renderer
  const ItemContent = useCallback((index: number, item: StoredMovie | StoredSeries) => {
    if (!item) return null;

    const itemId = type === 'movie' 
      ? (item as StoredMovie).stream_id 
      : (item as StoredSeries).series_id;
    
    const progress = progressMap.get(itemId);
    const episodeData = episodeDataMap?.get(itemId);
    const sourceName = (vodShowSourceBadge && sourceNameMap && item.source_id)
      ? sourceNameMap.get(item.source_id)
      : undefined;

    return (
      <MediaCard
        item={item}
        type={type}
        index={index}
        onClick={(clickedItem) => {
          onItemClick(
            clickedItem,
            episodeData?.seasonNum,
            episodeData?.episodeNum,
            episodeData?.episodeTitle
          );
        }}
        onRemove={onRemove ? () => onRemove(item) : undefined}
        progressPercent={progress}
        isRecentlyWatched={true}
        seasonNum={episodeData?.seasonNum}
        episodeNum={episodeData?.episodeNum}
        episodeTitle={episodeData?.episodeTitle}
        sourceName={sourceName}
        onPlayDirect={onPlayItem ? (clickedItem) => {
          onPlayItem(
            clickedItem,
            episodeData?.seasonNum,
            episodeData?.episodeNum,
            episodeData?.episodeTitle
          );
        } : undefined}
      />
    );
  }, [type, progressMap, episodeDataMap, vodShowSourceBadge, sourceNameMap, onItemClick, onRemove, onPlayItem]);

  if (loading) {
    return (
      <div className="vod-browse">
        <div className="vod-browse__loading-container">
          <div className="vod-browse__spinner" />
          <span>{i18n.t('vod:loadingRecent')}</span>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="vod-browse">
        <div className="vod-browse__empty">
          <h2>{i18n.t('vod:noRecentItems')}</h2>
          <p>{i18n.t('vod:noRecentItemsHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="vod-browse">
      <div
        ref={scrollRef}
        className="vod-browse__grid-scroll flex-1 min-h-0 overflow-y-auto"
        onScroll={handleGridScroll}
      >
        <VirtualGrid
          ref={virtualGridRef}
          items={rawItems}
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

export default RecentView;
