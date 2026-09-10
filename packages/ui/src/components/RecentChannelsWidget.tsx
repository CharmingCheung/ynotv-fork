import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getRecentChannels, onRecentChannelsUpdate, type RecentChannelEntry } from '../utils/recentChannels';
import { useCurrentProgram } from '../hooks/useChannels';
import { useWidgetChannelScroll } from '../hooks/useWidgetChannelScroll';
import { db } from '../db';
import type { StoredChannel } from '../db';
import './RecentChannelsWidget.css';

interface RecentChannelItemProps {
  entry: RecentChannelEntry;
  onChannelClick: (channel: StoredChannel) => void;
  isCurrent?: boolean;
}

function RecentChannelItem({ entry, onChannelClick, isCurrent }: RecentChannelItemProps) {
  const currentProgram = useCurrentProgram(entry.streamId);

  const handleClick = useCallback(async () => {
    const channel = await db.channels.get(entry.streamId);
    if (channel) {
      onChannelClick(channel);
    }
  }, [entry.streamId, onChannelClick]);

  return (
    <div
      className={`recent-channel-item${isCurrent ? ' currently-playing' : ''}`}
      data-stream-id={entry.streamId}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      title={`${entry.channelName}${currentProgram ? ` - ${currentProgram.title}` : ''}`}
    >
      <div className="recent-channel-name">{entry.channelName}</div>
      {currentProgram && (
        <div className="recent-channel-program">{currentProgram.title}</div>
      )}
    </div>
  );
}

interface RecentChannelsWidgetProps {
  showControls: boolean;
  activeView: string;
  onChannelClick: (channel: StoredChannel) => void;
  limit?: number;
  isVod: boolean;
  currentChannelId?: string;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

export function RecentChannelsWidget({
  showControls,
  activeView,
  onChannelClick,
  limit = 10,
  isVod,
  currentChannelId,
  onMoveLeft,
  onMoveRight,
}: RecentChannelsWidgetProps) {
  const { t } = useTranslation('widgets');
  const [recentEntries, setRecentEntries] = useState<RecentChannelEntry[]>([]);

  useEffect(() => {
    // Load initial recent channels
    setRecentEntries(getRecentChannels());

    // Subscribe to updates
    const unsubscribe = onRecentChannelsUpdate(() => {
      setRecentEntries(getRecentChannels());
    });

    return unsubscribe;
  }, []);

  const listRef = useRef<HTMLDivElement>(null);

  const limitedEntries = recentEntries.slice(0, limit);

  // Only visible on main screen when controls are shown
  const isMainScreen = activeView === 'none';
  const isVisible = isMainScreen && showControls && recentEntries.length > 0 && !isVod;

  // Restore the user's scroll position when the overlay re-appears, and bring
  // the currently playing channel into view when it changes (the list remounts
  // at the top whenever controls hide, so without this the position is lost).
  const { onListScroll } = useWidgetChannelScroll({
    isVisible,
    currentChannelId,
    listRef,
    itemCount: limitedEntries.length,
  });

  if (!isVisible) {
    return null;
  }

  return (
    <div className="recent-channels-widget">
      <div className="recent-channels-header" style={{ display: 'flex', alignItems: 'center' }}>
        <span>{t('recentWithCount', { count: limit })}</span>
        {(onMoveLeft || onMoveRight) && (
          <div className="widget-move-controls">
            <button className="widget-move-btn" onClick={onMoveLeft} disabled={!onMoveLeft} title={t('moveLeft')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <button className="widget-move-btn" onClick={onMoveRight} disabled={!onMoveRight} title={t('moveRight')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        )}
      </div>
      <div className="recent-channels-list" ref={listRef} onScroll={onListScroll}>
        {limitedEntries.map((entry) => (
          <RecentChannelItem
            key={entry.streamId}
            entry={entry}
            onChannelClick={onChannelClick}
            isCurrent={entry.streamId === currentChannelId}
          />
        ))}
      </div>
    </div>
  );
}
