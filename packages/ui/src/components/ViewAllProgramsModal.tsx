import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StoredChannel, StoredProgram } from '../db';
import { db } from '../db';
import { decompressEpgDescription } from '../utils/compression';
import { formatTime, formatDate } from '../utils/dateTime';
import { useEpgClockFormat } from '../stores/uiStore';
import i18n from '../i18n';
import { ProgramContextMenu } from './ProgramContextMenu';
import { VirtualList, type VirtualListHandle } from './common/VirtualList';
import './ViewAllProgramsModal.css';

interface ViewAllProgramsModalProps {
  isOpen: boolean;
  channel: StoredChannel | null;
  onClose: () => void;
  onPlayCatchup?: (
    channel: StoredChannel,
    programTitle: string,
    startTimeMs: number,
    durationMinutes: number,
    programDesc?: string
  ) => void;
}

interface DayGroup {
  key: string;
  /** Local date of the day's start (label derived from it). */
  date: Date;
  programs: StoredProgram[];
}

type ViewAllRow =
  | { type: 'header'; key: string; date: Date; count: number }
  | { type: 'program'; key: number | string; program: StoredProgram };

const MAX_PROGRAMS = 2000;
const VIEW_ALL_BACK_MS = 45 * 24 * 60 * 60 * 1000;
const VIEW_ALL_FWD_MS = 14 * 24 * 60 * 60 * 1000;
const VIEW_ALL_SQL_LIMIT = 4000;

const toMs = (value: Date | string | undefined): number => {
  if (!value) return NaN;
  return new Date(value).getTime();
};

const dayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/* ── Inline SVG Icons matching FailoverGroupListModal ── */
function TvSvg({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
      <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
      <polyline points="17 2 12 7 7 2" />
    </svg>
  );
}

function CrossSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SearchSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function PlaySvg({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ flexShrink: 0 }}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function MoreSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
      <circle cx="5" cy="12" r="2.2" />
    </svg>
  );
}

function InfoSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function CalendarSvg({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

/**
 * "View All Programs" modal for the 3-column EPG view. Shows every program the
 * DB has for the selected channel, organized into per-day tabs with instant search.
 * Opening it lands on the day that contains the currently-airing program (and scrolls
 * the running show into view). Past programs can be played as catch-up; any
 * program can be right-clicked or action-clicked for the full ProgramContextMenu.
 */
export function ViewAllProgramsModal({
  isOpen,
  channel,
  onClose,
  onPlayCatchup,
}: ViewAllProgramsModalProps) {
  useTranslation();
  const epgClockFormat = useEpgClockFormat();
  const [programs, setPrograms] = useState<StoredProgram[] | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [menu, setMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const virtualListRef = useRef<VirtualListHandle>(null);
  const [stickyInfo, setStickyInfo] = useState<{
    fullDate: string;
    relativeTag?: string;
    isToday: boolean;
    count: number;
    pushOffset: number;
  } | null>(null);
  const scrolledKeyRef = useRef<string | null>(null);

  const channelId = channel?.stream_id ?? null;
  const catchupAvailable = Boolean(channel?.tv_archive) || channel?.tv_archive === 1;

  // Reset transient state every time the modal opens (or the channel changes).
  useEffect(() => {
    if (!isOpen) {
      scrolledKeyRef.current = null;
      return;
    }
    setActiveKey(null);
    setMenu(null);
    setSearchQuery('');
    setNowMs(Date.now());
    scrolledKeyRef.current = null;
  }, [isOpen, channelId]);

  // Load ALL programs for the channel straight from the DB.
  useEffect(() => {
    if (!isOpen || !channelId) {
      setPrograms(null);
      return;
    }
    let cancelled = false;
    setPrograms(null);
    (async () => {
      try {
        const dbInstance = await (db as any).dbPromise;
        const now = Date.now();
        const rows = (await dbInstance.select(
          `SELECT * FROM programs_effective
           WHERE stream_id = ?
             AND start < ?
             AND end > ?
           LIMIT ${VIEW_ALL_SQL_LIMIT}`,
          [
            channelId,
            new Date(now + VIEW_ALL_FWD_MS).toISOString(),
            new Date(now - VIEW_ALL_BACK_MS).toISOString(),
          ]
        )) as StoredProgram[];
        if (cancelled) return;
        // Order by parsed timestamp in JS — never by SQL string comparison.
        const ordered = rows
          .map((p) => ({
            ...p,
            description: decompressEpgDescription(p.description) ?? p.description,
          }))
          .sort((a, b) => toMs(a.start) - toMs(b.start))
          .slice(0, MAX_PROGRAMS);
        setPrograms(ordered);
      } catch (err) {
        console.error('[ViewAllPrograms] Failed to load programs:', err);
        if (!cancelled) setPrograms([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, channelId]);

  // Keep running/past state fresh while the modal stays open.
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  // Escape closes the modal — but only when no context menu is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !menu) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, menu]);

  // Group programs into ascending per-day buckets.
  const dayGroups = useMemo<DayGroup[]>(() => {
    if (!programs) return [];
    const groups: DayGroup[] = [];
    let last: DayGroup | null = null;
    for (const p of programs) {
      const startMs = toMs(p.start);
      if (!Number.isFinite(startMs)) continue;
      const key = dayKeyOf(startMs);
      if (!last || last.key !== key) {
        last = { key, date: new Date(startMs), programs: [] };
        groups.push(last);
      }
      last.programs.push(p);
    }
    return groups;
  }, [programs]);

  const formatDayLabel = (dayStart: Date): string => {
    const diffDays = Math.round((startOfDay(new Date(nowMs)) - startOfDay(dayStart)) / 86400000);
    if (diffDays === 0) return i18n.t('time:today', { defaultValue: 'Today' });
    if (diffDays === -1) return i18n.t('time:tomorrow', { defaultValue: 'Tomorrow' });
    if (diffDays === 1) return i18n.t('time:yesterday', { defaultValue: 'Yesterday' });
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
    if (dayStart.getFullYear() !== new Date(nowMs).getFullYear()) opts.year = 'numeric';
    return formatDate(dayStart, opts);
  };

  const formatFullDayHeader = (dayStart: Date) => {
    const diffDays = Math.round((startOfDay(new Date(nowMs)) - startOfDay(dayStart)) / 86400000);
    let relativeTag: string | undefined;
    if (diffDays === 0) relativeTag = i18n.t('time:today', { defaultValue: 'Today' });
    else if (diffDays === -1) relativeTag = i18n.t('time:tomorrow', { defaultValue: 'Tomorrow' });
    else if (diffDays === 1) relativeTag = i18n.t('time:yesterday', { defaultValue: 'Yesterday' });

    const opts: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    };
    if (dayStart.getFullYear() !== new Date(nowMs).getFullYear()) {
      opts.year = 'numeric';
    }
    return {
      fullDate: formatDate(dayStart, opts),
      relativeTag,
      isToday: diffDays === 0,
    };
  };

  // Pick the initial day: the one containing the running program if any,
  // otherwise the day of "now", otherwise the earliest available day.
  useEffect(() => {
    if (!isOpen || activeKey !== null || dayGroups.length === 0) return;
    const now = nowMs;
    const runningDay = dayGroups.find((g) =>
      g.programs.some((p) => {
        const s = toMs(p.start);
        const e = toMs(p.end);
        return s <= now && e > now;
      })
    );
    setActiveKey((runningDay ?? dayGroups.find((g) => g.key === dayKeyOf(now)) ?? dayGroups[0]).key);
  }, [isOpen, activeKey, dayGroups, nowMs]);

  const basePrograms = useMemo(() => {
    if (activeKey === 'all') return programs ?? [];
    if (activeKey) return dayGroups.find((g) => g.key === activeKey)?.programs ?? [];
    return [];
  }, [activeKey, programs, dayGroups]);

  const displayedPrograms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return basePrograms;
    return basePrograms.filter((p) =>
      p.title?.toLowerCase().includes(q) ||
      p.subtitle?.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q)
    );
  }, [basePrograms, searchQuery]);

  const virtualRows = useMemo<ViewAllRow[]>(() => {
    if (!displayedPrograms || displayedPrograms.length === 0) return [];
    if (activeKey !== 'all') {
      return displayedPrograms.map((p) => ({
        type: 'program',
        key: p.id,
        program: p,
      }));
    }

    const rows: ViewAllRow[] = [];
    let lastKey = '';
    const dayCounts = new Map<string, number>();
    for (const p of displayedPrograms) {
      const s = toMs(p.start);
      if (!Number.isFinite(s)) continue;
      const k = dayKeyOf(s);
      dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1);
    }

    for (const p of displayedPrograms) {
      const startMs = toMs(p.start);
      if (!Number.isFinite(startMs)) continue;
      const k = dayKeyOf(startMs);
      if (k !== lastKey) {
        lastKey = k;
        rows.push({
          type: 'header',
          key: `sep-${k}`,
          date: new Date(startMs),
          count: dayCounts.get(k) ?? 0,
        });
      }
      rows.push({
        type: 'program',
        key: p.id,
        program: p,
      });
    }
    return rows;
  }, [activeKey, displayedPrograms]);

  // Scroll the running program into view when the modal opens or the tab changes.
  useEffect(() => {
    if (!isOpen || activeKey === null || searchQuery.trim() || virtualRows.length === 0) return;
    if (scrolledKeyRef.current === activeKey) return;
    scrolledKeyRef.current = activeKey;

    const currentNow = Date.now();
    const raf = requestAnimationFrame(() => {
      const runningIndex = virtualRows.findIndex((r) => {
        if (r.type !== 'program') return false;
        const s = toMs(r.program.start);
        const e = toMs(r.program.end);
        return s <= currentNow && e > currentNow;
      });
      if (runningIndex !== -1 && virtualListRef.current) {
        virtualListRef.current.scrollToIndex({ index: runningIndex, align: 'center', behavior: 'auto' });
      } else if (listRef.current) {
        listRef.current.scrollTop = 0;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, activeKey, virtualRows, searchQuery]);

  const updateStickyFromScroll = useCallback(() => {
    if (activeKey !== 'all' || !listRef.current || virtualRows.length === 0) {
      setStickyInfo(null);
      return;
    }

    const st = listRef.current.scrollTop;
    const virtualItems = virtualListRef.current?.getVirtualItems();
    if (!virtualItems || virtualItems.length === 0) return;

    // Find the item currently at or crossing the top of the scroll viewport.
    const topItem = virtualItems.find((vi) => vi.start + vi.size > st) ?? virtualItems[0];
    const topRow = virtualRows[topItem.index];
    if (!topRow) return;

    let dayDate: Date;
    let count = 0;
    if (topRow.type === 'header') {
      dayDate = topRow.date;
      count = topRow.count;
    } else {
      const s = toMs(topRow.program.start);
      dayDate = new Date(s);
      for (let i = topItem.index; i >= 0; i--) {
        const r = virtualRows[i];
        if (r.type === 'header') {
          count = r.count;
          break;
        }
      }
    }

    const headerDetails = formatFullDayHeader(dayDate);

    // Check if the next day's header is pushing the sticky header.
    const nextHeader = virtualItems.find(
      (vi) => vi.index > topItem.index && virtualRows[vi.index]?.type === 'header'
    );
    const H = 44;
    let pushOffset = 0;
    if (nextHeader) {
      const dist = nextHeader.start - st;
      if (dist < H && dist > 0) {
        pushOffset = dist - H;
      }
    }

    setStickyInfo((prev) => {
      if (
        prev &&
        prev.fullDate === headerDetails.fullDate &&
        prev.relativeTag === headerDetails.relativeTag &&
        prev.isToday === headerDetails.isToday &&
        prev.count === count &&
        prev.pushOffset === pushOffset
      ) {
        return prev;
      }
      return {
        ...headerDetails,
        count,
        pushOffset,
      };
    });
  }, [activeKey, virtualRows, nowMs]);

  useEffect(() => {
    if (activeKey !== 'all' || virtualRows.length === 0) {
      setStickyInfo(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      updateStickyFromScroll();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeKey, virtualRows, updateStickyFromScroll]);

  if (!isOpen || !channel) return null;

  const timeStr = (ms: number) =>
    formatTime(new Date(ms), { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });

  const renderProgramCard = (p: StoredProgram) => {
    const startMs = toMs(p.start);
    const endMs = toMs(p.end);
    const isCurrent = startMs <= nowMs && endMs > nowMs;
    const isPast = endMs <= nowMs;
    const clickable = isPast && catchupAvailable && !!onPlayCatchup;
    const dateLabel = formatDate(new Date(startMs), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(new Date(startMs).getFullYear() !== new Date(nowMs).getFullYear() ? { year: 'numeric' } : {}),
    });
    const tooltip = `${p.title}${p.subtitle ? `\n${p.subtitle}` : ''}\n${dateLabel} • ${timeStr(startMs)} – ${timeStr(endMs)}${p.description ? `\n\n${p.description}` : ''}${clickable ? `\n\n${i18n.t('epg:clickPlayCatchup', { defaultValue: 'Click to play catch-up' })}` : `\n\n${i18n.t('live:viewAllTip', { defaultValue: 'Right-click for recording / catch-up options' })}`}`;

    const handlePlay = () => {
      if (!clickable) return;
      const rawStartMs = p.raw_start ? new Date(p.raw_start).getTime() : startMs;
      const durationMins = Math.max(1, Math.round((endMs - startMs) / 60000));
      onPlayCatchup!(channel, p.title, rawStartMs, durationMins, p.description);
      onClose();
    };

    return (
      <div
        key={p.id}
        data-pid={p.id}
        className={`vap-card ${isCurrent ? 'is-current' : ''} ${isPast ? 'is-past' : ''} ${clickable ? 'clickable' : ''}`}
        title={tooltip}
        onClick={handlePlay}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ program: p, x: e.clientX, y: e.clientY });
        }}
      >
        <div className="vap-card-left">
          <div className={`vap-time-badge ${isCurrent ? 'current' : ''}`}>
            {timeStr(startMs)} – {timeStr(endMs)}
          </div>

          <div className="vap-card-main">
            <div className="vap-card-title-row">
              <span className="vap-card-title">{p.title}</span>
              {isCurrent && (
                <span className="vap-running-badge">
                  {i18n.t('common:running', { defaultValue: 'Running' })}
                </span>
              )}
            </div>
            {p.subtitle && (
              <span className="vap-card-subtitle">{p.subtitle}</span>
            )}
            {p.description && (
              <span className="vap-card-desc">{p.description}</span>
            )}
          </div>
        </div>

        <div className="vap-card-actions" onClick={(e) => e.stopPropagation()}>
          {clickable && (
            <button
              type="button"
              className="vap-catchup-btn"
              title={i18n.t('epg:clickPlayCatchup', { defaultValue: 'Click to play catch-up' })}
              onClick={handlePlay}
            >
              <PlaySvg size={10} />
              <span>{i18n.t('live:viewAllCatchup', { defaultValue: 'Catch-up' })}</span>
            </button>
          )}

          <button
            type="button"
            className="vap-action-btn"
            title={i18n.t('common:moreOptions', { defaultValue: 'More options' })}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ program: p, x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreSvg size={13} />
          </button>
        </div>
      </div>
    );
  };

  return createPortal(
    <>
      <div className="view-all-programs-overlay" onClick={onClose}>
        <div
          className="view-all-programs-modal"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="vap-header">
            <div className="vap-header-left">
              {channel.stream_icon ? (
                <img src={channel.stream_icon} className="vap-channel-logo" alt="" />
              ) : (
                <span className="vap-header-icon"><TvSvg size={18} /></span>
              )}
              <h2 title={channel.name}>{channel.name}</h2>
              {programs !== null && programs.length > 0 && (
                <span className="vap-header-badge">
                  {i18n.t('common:daysCount', { count: dayGroups.length })} • {i18n.t('common:programsCount', { count: programs.length })}
                </span>
              )}
              {catchupAvailable && (
                <span className="vap-catchup-badge" title={i18n.t('epg:catchupSupported', { defaultValue: 'Catch-up supported on this channel' })}>
                  <PlaySvg size={9} />
                  <span>{i18n.t('live:viewAllCatchup', { defaultValue: 'Catch-up' })}</span>
                </span>
              )}
            </div>
            <button
              className="vap-close-btn"
              onClick={onClose}
              title={i18n.t('common:close', { defaultValue: 'Close' })}
              aria-label={i18n.t('common:close', { defaultValue: 'Close' })}
            >
              <CrossSvg size={14} />
            </button>
          </div>

          {/* Toolbar with Search and Day Filter Chips */}
          <div className="vap-toolbar">
            <div className="vap-toolbar-top">
              <div className="vap-search-wrapper">
                <span className="vap-search-icon">
                  <SearchSvg size={14} />
                </span>
                <input
                  type="text"
                  className="vap-search-input"
                  placeholder={i18n.t('common:searchPrograms', { defaultValue: 'Search programs by title or description...' })}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="vap-search-clear"
                    onClick={() => setSearchQuery('')}
                    title={i18n.t('common:clear', { defaultValue: 'Clear' })}
                  >
                    <CrossSvg size={11} />
                  </button>
                )}
              </div>
            </div>

            {dayGroups.length > 0 && (
              <div className="vap-day-row">
                <div className="vap-day-chips" role="group" aria-label="Filter by day">
                  <button
                    type="button"
                    className={`vap-day-chip ${activeKey === 'all' ? 'active' : ''}`}
                    onClick={() => setActiveKey('all')}
                  >
                    <CalendarSvg size={12} />
                    <span>{i18n.t('common:all', { defaultValue: 'All' })}</span>
                    {programs && <span className="vap-day-chip-count">{programs.length}</span>}
                  </button>
                  {dayGroups.map((g) => {
                    const isActive = g.key === activeKey;
                    return (
                      <button
                        key={g.key}
                        type="button"
                        className={`vap-day-chip ${isActive ? 'active' : ''}`}
                        onClick={() => setActiveKey(g.key)}
                      >
                        <span>{formatDayLabel(g.date)}</span>
                        <span className="vap-day-chip-count">{g.programs.length}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Program Cards Content */}
          {programs === null ? (
            <div className="vap-content vap-empty">
              {i18n.t('common:loading', { defaultValue: 'Loading…' })}
            </div>
          ) : dayGroups.length === 0 ? (
            <div className="vap-content vap-empty">
              {i18n.t('common:noProgramInfo', { defaultValue: 'No Program Information' })}
            </div>
          ) : displayedPrograms.length === 0 ? (
            <div className="vap-content vap-empty">
              <p>{i18n.t('common:noProgramsFound', { defaultValue: 'No matching programs found' })}</p>
              {searchQuery && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="vap-clear-search-btn"
                    onClick={() => setSearchQuery('')}
                  >
                    {i18n.t('common:clearSearch', { defaultValue: 'Clear search filter' })}
                  </button>
                  {activeKey !== 'all' && (
                    <button
                      type="button"
                      className="vap-clear-search-btn"
                      onClick={() => setActiveKey('all')}
                    >
                      {i18n.t('common:searchAllDays', { defaultValue: 'Search across all days' })}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="vap-content" ref={listRef} onScroll={updateStickyFromScroll}>
              {activeKey === 'all' && stickyInfo && (
                <div
                  className="vap-sticky-header-container"
                  style={{
                    transform: stickyInfo.pushOffset ? `translateY(${stickyInfo.pushOffset}px)` : undefined,
                  }}
                >
                  <div className={`vap-day-separator ${stickyInfo.isToday ? 'is-today' : ''}`}>
                    <div className="vap-day-separator-left">
                      <span className="vap-day-separator-icon">
                        <CalendarSvg size={14} />
                      </span>
                      <span className="vap-day-separator-title">{stickyInfo.fullDate}</span>
                      {stickyInfo.relativeTag && (
                        <span className={`vap-day-separator-badge ${stickyInfo.isToday ? 'today' : 'other'}`}>
                          {stickyInfo.relativeTag}
                        </span>
                      )}
                    </div>
                    <div className="vap-day-separator-right">
                      <span className="vap-day-separator-count">
                        {i18n.t('common:programsCount', { count: stickyInfo.count })}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <VirtualList
                key={`vap-vlist-${activeKey}-${channel.stream_id}`}
                ref={virtualListRef}
                scrollRef={listRef}
                items={virtualRows}
                estimateItemHeight={(index) => (virtualRows[index]?.type === 'header' ? 48 : 62)}
                overscan={8}
                onVirtualItemsChange={updateStickyFromScroll}
                getKey={(row) => row.key}
                renderItem={(row, index) => {
                  if (row.type === 'header') {
                    const headerInfo = formatFullDayHeader(row.date);
                    return (
                      <div
                        className={`vap-virtual-row header ${index === 0 ? 'first-row' : ''}`}
                        style={index === 0 ? { visibility: 'hidden' } : undefined}
                      >
                        <div className={`vap-day-separator ${headerInfo.isToday ? 'is-today' : ''}`}>
                          <div className="vap-day-separator-left">
                            <span className="vap-day-separator-icon">
                              <CalendarSvg size={14} />
                            </span>
                            <span className="vap-day-separator-title">{headerInfo.fullDate}</span>
                            {headerInfo.relativeTag && (
                              <span className={`vap-day-separator-badge ${headerInfo.isToday ? 'today' : 'other'}`}>
                                {headerInfo.relativeTag}
                              </span>
                            )}
                          </div>
                          <div className="vap-day-separator-right">
                            <span className="vap-day-separator-count">
                              {i18n.t('common:programsCount', { count: row.count })}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className={`vap-virtual-row ${index === 0 ? 'first-row' : ''}`}>
                      {renderProgramCard(row.program)}
                    </div>
                  );
                }}
              />
            </div>
          )}

          {/* Footer */}
          <div className="vap-footer">
            <div className="vap-footer-left">
              <InfoSvg size={13} />
              <span>
                {i18n.t('live:viewAllTip', {
                  defaultValue: 'Right-click or click ⋯ on any program for recording, catch-up or watchlist options.',
                })}
              </span>
            </div>
            <div className="vap-footer-right">
              <span className="vap-footer-shortcut">Esc to close</span>
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <ProgramContextMenu
          program={menu.program}
          sourceId={channel.source_id}
          channelId={channel.stream_id}
          channelName={channel.name}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          isCatchupAvailable={catchupAvailable}
        />
      )}
    </>,
    document.body
  );
}
