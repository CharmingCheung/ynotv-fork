import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useCurrentProgram, useEnabledSources } from '../hooks/useChannels';
import { useWidgetChannelScroll } from '../hooks/useWidgetChannelScroll';
import { db } from '../db';
import type { StoredChannel } from '../db';
import './CustomGroupWidget.css';

/* ── Single channel row ──────────────────────────────────────────── */
interface GroupChannelItemProps {
  channel: StoredChannel;
  onChannelClick: (channel: StoredChannel) => void;
  isCurrent?: boolean;
}

function GroupChannelItem({ channel, onChannelClick, isCurrent }: GroupChannelItemProps) {
  const currentProgram = useCurrentProgram(channel.stream_id);

  const handleClick = useCallback(() => {
    onChannelClick(channel);
  }, [channel, onChannelClick]);

  return (
    <div
      className={`group-channel-item${isCurrent ? ' currently-playing' : ''}`}
      data-stream-id={channel.stream_id}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
      }}
      title={`${channel.alias || channel.name}${currentProgram ? ` - ${currentProgram.title}` : ''}`}
    >
      <div className="group-channel-name">{channel.alias || channel.name}</div>
      {currentProgram && (
        <div className="group-channel-program">{currentProgram.title}</div>
      )}
    </div>
  );
}

/* ── Widget ──────────────────────────────────────────────────────── */
interface CustomGroupWidgetProps {
  groupId: string;
  showControls: boolean;
  activeView: string;
  onChannelClick: (channel: StoredChannel) => void;
  isVod: boolean;
  currentChannelId?: string;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

export function CustomGroupWidget({
  groupId,
  showControls,
  activeView,
  onChannelClick,
  isVod,
  currentChannelId,
  onMoveLeft,
  onMoveRight,
}: CustomGroupWidgetProps) {
  const { t } = useTranslation('widgets');
  const enabledSourceIds = useEnabledSources();
  // Single query: load group metadata + ordered channels in one shot
  const data = useLiveQuery(
    async () => {
      const [group, mappings] = await Promise.all([
        db.customGroups.get(groupId),
        db.customGroupChannels.where('group_id').equals(groupId).toArray(),
      ]);

      if (!group) return null;

      // Sort by display_order
      mappings.sort((a, b) => a.display_order - b.display_order);

      // Resolve stream IDs → channel objects (preserving order)
      let channels = (
        await Promise.all(mappings.map((m) => db.channels.get(m.stream_id)))
      ).filter(Boolean) as StoredChannel[];

      if (enabledSourceIds) {
        channels = channels.filter(ch => enabledSourceIds.has(ch.source_id));
      }

      return { group, channels };
    },
    [groupId, enabledSourceIds],
    undefined,
    0,
    'custom_group_channels'
  );

  const listRef = useRef<HTMLDivElement>(null);

  const isMainScreen = activeView === 'none';
  const isVisible = isMainScreen && showControls && (data?.channels?.length ?? 0) > 0 && !isVod;

  // Restore the user's scroll position when the overlay re-appears, and bring
  // the currently playing channel into view when it changes (the list remounts
  // at the top whenever controls hide, so without this the position is lost).
  const { onListScroll } = useWidgetChannelScroll({
    isVisible,
    currentChannelId,
    listRef,
    itemCount: data?.channels?.length ?? 0,
  });

  if (!isVisible) return null;

  const groupName = data!.group.name;

  return (
    <div className="custom-group-widget">
      <div className="custom-group-header" title={groupName} style={{ display: 'flex', alignItems: 'center' }}>
        <span>{groupName}</span>
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
      <div className="custom-group-list" ref={listRef} onScroll={onListScroll}>
        {data!.channels.map((ch) => (
          <GroupChannelItem
            key={ch.stream_id}
            channel={ch}
            onChannelClick={onChannelClick}
            isCurrent={ch.stream_id === currentChannelId}
          />
        ))}
      </div>
    </div>
  );
}
