import { useState, useEffect, useMemo, useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { createPortal } from 'react-dom';
import { db, type StoredChannel, type EpgChannelOverride } from '../db';
import { ChannelLogo } from './ChannelLogo';
import { batchUpsertLogoOverrides } from '../services/epg-overrides';
import { storedLogoPaddingOverride, type LogoPaddingOverride } from '../utils/logoPadding';
import './LogoEditorModal.css';

export interface LogoEditorModalProps {
  categoryId: string;
  categoryName: string;
  sourceId: string;
  onClose: () => void;
}

export function LogoEditorModal({
  categoryId,
  categoryName,
  sourceId,
  onClose,
}: LogoEditorModalProps) {
  const { t } = useTranslation('logoEditor');
  const [channels, setChannels] = useState<StoredChannel[]>([]);
  const [existingOverrides, setExistingOverrides] = useState<Map<string, EpgChannelOverride>>(new Map());
  const [logoBgMap, setLogoBgMap] = useState<Record<string, 'auto' | 'light' | 'dark'>>({});
  const [initialBgMap, setInitialBgMap] = useState<Record<string, 'auto' | 'light' | 'dark'>>({});
  // Tile padding is tri-state: 'default' = the user asked for Normal, 'none' = No
  // Pad, and `undefined` = no choice of its own, so the tile follows Settings →
  // Logos. See utils/logoPadding.
  const [logoPaddingMap, setLogoPaddingMap] = useState<Record<string, LogoPaddingOverride>>({});
  const [initialPaddingMap, setInitialPaddingMap] = useState<Record<string, LogoPaddingOverride>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'auto' | 'light' | 'dark' | 'no-padding'>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  // Virtualized grid: only cards near the scroll viewport are rendered. Selection and
  // bulk actions always operate on the full `filteredChannels` array, never the window.
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const measureCardRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const [gridWidth, setGridWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Load category channels and existing logo overrides
  useEffect(() => {
    let isMounted = true;
    async function loadCategoryChannels() {
      setLoading(true);
      try {
        let channelList: StoredChannel[] = [];

        if (categoryId.startsWith('link:')) {
          const linkId = parseInt(categoryId.replace('link:', ''), 10);
          if (!isNaN(linkId)) {
            const link = await db.playlistCategoryLinks.get(linkId);
            if (link) {
              channelList = await db.channels.whereRaw(
                `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
                [link.source_id, link.category_id]
              ).toArray();

              let manualMappings = await db.playlistIndividualChannels
                .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.playlist_id, `link:${link.id}`])
                .toArray();
              if (manualMappings.length === 0) {
                manualMappings = await db.playlistIndividualChannels
                  .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.source_id, link.category_id])
                  .toArray();
              }
              if (manualMappings.length > 0) {
                const streamIds = manualMappings.map(m => m.stream_id);
                const manualChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
                const manualMap = new Map(manualChannels.map(ch => [ch.stream_id, ch]));
                const orderedManual = manualMappings
                  .sort((a, b) => a.display_order - b.display_order)
                  .map(m => manualMap.get(m.stream_id))
                  .filter((ch): ch is StoredChannel => ch !== undefined);

                const manualStreamIds = new Set(manualMappings.map(m => m.stream_id));
                const remainingDynamic = channelList.filter(ch => !manualStreamIds.has(ch.stream_id));
                channelList = [...orderedManual, ...remainingDynamic];
              }
            }
          }
        } else {
          // Standard category
          if (sourceId) {
            channelList = await db.channels.whereRaw(
              `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
              [sourceId, categoryId]
            ).toArray();
          } else {
            channelList = await db.channels.where('category_ids').equals(categoryId).toArray();
          }

          // Check manual playlist individual channel additions
          const manualMappings = await db.playlistIndividualChannels
            .whereRaw('playlist_id = ? AND parent_category_id = ?', [sourceId, categoryId])
            .toArray();
          if (manualMappings.length > 0) {
            const streamIds = manualMappings.map(m => m.stream_id);
            const manualChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
            const manualMap = new Map(manualChannels.map(ch => [ch.stream_id, ch]));
            const orderedManual = manualMappings
              .sort((a, b) => a.display_order - b.display_order)
              .map(m => manualMap.get(m.stream_id))
              .filter((ch): ch is StoredChannel => ch !== undefined);

            const manualStreamIds = new Set(manualMappings.map(m => m.stream_id));
            const remainingDynamic = channelList.filter(ch => !manualStreamIds.has(ch.stream_id));
            channelList = [...orderedManual, ...remainingDynamic];
          }
        }

        // Fetch logo overrides for these channels
        const streamIds = channelList.map(ch => ch.stream_id);
        const overridesMap = new Map<string, EpgChannelOverride>();
        const bgMap: Record<string, 'auto' | 'light' | 'dark'> = {};
        const padMap: Record<string, LogoPaddingOverride> = {};

        if (streamIds.length > 0) {
          const overrides = await db.epgChannelOverrides.where('stream_id').anyOf(streamIds).toArray();
          for (const ov of overrides) {
            overridesMap.set(ov.stream_id, ov);
            if (ov.logo_background) {
              bgMap[ov.stream_id] = ov.logo_background as 'auto' | 'light' | 'dark';
            }
            if (ov.logo_padding) {
              padMap[ov.stream_id] = storedLogoPaddingOverride(ov.logo_padding);
            }
          }
        }

        for (const ch of channelList) {
          if (!bgMap[ch.stream_id]) {
            bgMap[ch.stream_id] = 'auto';
          }
          // Deliberately no padding default: a channel with no override of its own
          // has made no choice, and seeding 'default' here would read as one — the
          // tile would then render padded no matter what Settings → Logos says.
        }

        if (isMounted) {
          setChannels(channelList);
          setExistingOverrides(overridesMap);
          setLogoBgMap(bgMap);
          setInitialBgMap(bgMap);
          setLogoPaddingMap(padMap);
          setInitialPaddingMap(padMap);
          setLoading(false);
        }
      } catch (err) {
        console.error('[LogoEditorModal] Failed to load category channels:', err);
        if (isMounted) setLoading(false);
      }
    }

    loadCategoryChannels();
    return () => { isMounted = false; };
  }, [categoryId, sourceId]);

  // Track the grid viewport size + scroll so only visible cards are rendered
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  // Filter channels based on search and status filter
  const filteredChannels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return channels.filter(ch => {
      const matchesSearch = !query || ch.name.toLowerCase().includes(query) || ch.stream_id.toLowerCase().includes(query);
      const bg = logoBgMap[ch.stream_id] || 'auto';
      const pad = logoPaddingMap[ch.stream_id];

      let matchesFilter = true;
      if (filterMode === 'auto' || filterMode === 'light' || filterMode === 'dark') {
        matchesFilter = bg === filterMode;
      } else if (filterMode === 'no-padding') {
        matchesFilter = pad === 'none';
      }
      return matchesSearch && matchesFilter;
    });
  }, [channels, searchQuery, filterMode, logoBgMap, logoPaddingMap]);

  // Virtualized grid window: compute which rows are visible and slice the full
  // filtered array accordingly. The CSS grid re-flows the visible slice correctly
  // because it always starts at a row boundary (startIndex is a multiple of columns).
  const CARD_MIN_WIDTH = 210;
  const CARD_GAP = 14;
  const ROW_OVERSCAN = 2;

  const columns = Math.max(1, Math.floor((gridWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  const totalRows = Math.ceil(filteredChannels.length / columns);
  const rowH = rowHeight;
  const firstVisibleRow = rowH > 0 ? Math.max(0, Math.floor(viewport.scrollTop / rowH)) : 0;
  const visibleRows = rowH > 0 ? Math.ceil(viewport.height / rowH) + ROW_OVERSCAN : 0;
  const startRow = rowH > 0 ? Math.max(0, firstVisibleRow - ROW_OVERSCAN) : 0;
  const endRow = rowH > 0 ? Math.min(totalRows, firstVisibleRow + visibleRows + ROW_OVERSCAN) : Math.min(totalRows, 1);
  const startIndex = Math.min(filteredChannels.length, startRow * columns);
  const endIndex = Math.min(filteredChannels.length, endRow * columns);
  const visibleChannels = filteredChannels.slice(startIndex, endIndex);

  // Measure the GRID's width (not the padded scroll container) so the column
  // count matches the CSS auto-fill layout exactly — otherwise the virtual
  // window misaligns with the real card rows.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () => setGridWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [filteredChannels]);

  // Reset scroll when the search/filter inputs change (not on bg/pad edits, which
  // also recreate filteredChannels) so the user isn't left in empty space after a filter change
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [searchQuery, filterMode, channels]);

  // Measure the real card height from the first rendered card so the row math stays correct
  useLayoutEffect(() => {
    const el = measureCardRef.current;
    if (el && el.offsetHeight > 0) {
      const next = el.offsetHeight + CARD_GAP;
      setRowHeight(prev => (prev === next ? prev : next));
    }
  });

  // Count summary by background type & padding mode
  const counts = useMemo(() => {
    let autoCount = 0;
    let lightCount = 0;
    let darkCount = 0;
    let noPadCount = 0;
    for (const ch of channels) {
      const bg = logoBgMap[ch.stream_id] || 'auto';
      const pad = logoPaddingMap[ch.stream_id];
      if (bg === 'light') lightCount++;
      else if (bg === 'dark') darkCount++;
      else autoCount++;

      if (pad === 'none') noPadCount++;
    }
    return { total: channels.length, auto: autoCount, light: lightCount, dark: darkCount, noPadding: noPadCount };
  }, [channels, logoBgMap, logoPaddingMap]);

  // Handle select all / deselect all for filtered channels
  const allFilteredSelected = useMemo(() => {
    if (filteredChannels.length === 0) return false;
    return filteredChannels.every(ch => selectedIds.has(ch.stream_id));
  }, [filteredChannels, selectedIds]);

  const toggleSelectAllFiltered = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const ch of filteredChannels) {
          next.delete(ch.stream_id);
        }
      } else {
        for (const ch of filteredChannels) {
          next.add(ch.stream_id);
        }
      }
      return next;
    });
  }, [allFilteredSelected, filteredChannels]);

  const toggleSelectChannel = useCallback((streamId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(streamId)) {
        next.delete(streamId);
      } else {
        next.add(streamId);
      }
      return next;
    });
  }, []);

  // Individual background update
  const setChannelBg = useCallback((streamId: string, bg: 'auto' | 'light' | 'dark') => {
    setLogoBgMap(prev => ({
      ...prev,
      [streamId]: bg,
    }));
  }, []);

  // Individual padding update
  const setChannelPadding = useCallback((streamId: string, pad: LogoPaddingOverride) => {
    setLogoPaddingMap(prev => ({
      ...prev,
      [streamId]: pad,
    }));
  }, []);

  // Bulk background update
  const applyBulkBg = useCallback((bg: 'auto' | 'light' | 'dark') => {
    const targetIds = selectedIds.size > 0 ? Array.from(selectedIds) : filteredChannels.map(ch => ch.stream_id);
    if (targetIds.length === 0) return;

    setLogoBgMap(prev => {
      const next = { ...prev };
      for (const id of targetIds) {
        next[id] = bg;
      }
      return next;
    });
  }, [selectedIds, filteredChannels]);

  // Bulk padding update
  const applyBulkPadding = useCallback((pad: LogoPaddingOverride) => {
    const targetIds = selectedIds.size > 0 ? Array.from(selectedIds) : filteredChannels.map(ch => ch.stream_id);
    if (targetIds.length === 0) return;

    setLogoPaddingMap(prev => {
      const next = { ...prev };
      for (const id of targetIds) {
        next[id] = pad;
      }
      return next;
    });
  }, [selectedIds, filteredChannels]);

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    for (const ch of channels) {
      const currentBg = logoBgMap[ch.stream_id] || 'auto';
      const initialBg = initialBgMap[ch.stream_id] || 'auto';
      if (currentBg !== initialBg) return true;

      // Compared raw, so "no choice" (undefined) is a state of its own: putting a
      // channel back on the global setting is a change worth saving.
      const currentPad = logoPaddingMap[ch.stream_id];
      const initialPad = initialPaddingMap[ch.stream_id];
      if (currentPad !== initialPad) return true;
    }
    return false;
  }, [channels, logoBgMap, initialBgMap, logoPaddingMap, initialPaddingMap]);

  // Save changes to database
  const handleSaveChanges = async () => {
    setSaving(true);
    try {
      const updates: Array<{
        streamId: string;
        logoBackground?: 'auto' | 'light' | 'dark';
        // `null` is the explicit "no choice", which the write path has to tell
        // apart from an update that simply doesn't mention padding.
        logoPadding?: 'default' | 'none' | null;
      }> = [];
      for (const ch of channels) {
        const currentBg = logoBgMap[ch.stream_id] || 'auto';
        const initialBg = initialBgMap[ch.stream_id] || 'auto';
        const currentPad = logoPaddingMap[ch.stream_id];
        const initialPad = initialPaddingMap[ch.stream_id];
        if (currentBg !== initialBg || currentPad !== initialPad) {
          // Send only what the user changed: an unchanged field is kept from the
          // stored override, and sending it anyway would record a choice that was
          // never made — editing a channel's background would pin a tile padding
          // onto it, which then overrides the global Tile Layout setting.
          updates.push({
            streamId: ch.stream_id,
            ...(currentBg !== initialBg ? { logoBackground: currentBg } : {}),
            // `currentPad` undefined means the user put the channel back on the
            // global setting; `null` says so, where omitting the field would mean
            // "leave the stored padding alone".
            ...(currentPad !== initialPad ? { logoPadding: currentPad ?? null } : {}),
          });
        }
      }

      if (updates.length > 0) {
        await batchUpsertLogoOverrides(updates);
        setInitialBgMap({ ...logoBgMap });
        setInitialPaddingMap({ ...logoPaddingMap });
        setSaveSuccess(`✓ Updated ${updates.length} channel logo setting${updates.length > 1 ? 's' : ''}`);
        setTimeout(() => setSaveSuccess(null), 3000);
      }
    } catch (err) {
      console.error('[LogoEditorModal] Error saving logo settings:', err);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="logo-editor-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="logo-editor-modal" role="dialog" aria-modal="true" aria-labelledby="logo-editor-title">
        
        {/* Header */}
        <div className="logo-editor-header">
          <div className="logo-editor-title-group">
            <h2 id="logo-editor-title" className="logo-editor-title">
              🖼️ {t('title')} — <span>{categoryName}</span>
            </h2>
            <div className="logo-editor-subtitle">
              {t('subtitle')}
            </div>
          </div>
          <button className="logo-editor-close-btn" onClick={onClose} title={t('closeEsc')}>✕</button>
        </div>

        {/* Toolbar & Filters */}
        <div className="logo-editor-toolbar">
          <div className="logo-editor-search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="logo-editor-search-input"
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="clear-search-btn" onClick={() => setSearchQuery('')}>✕</button>
            )}
          </div>

          <div className="logo-editor-filter-tabs">
            <button
              className={`filter-tab ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              {t('allTab', { count: counts.total })}
            </button>
            <button
              className={`filter-tab ${filterMode === 'auto' ? 'active' : ''}`}
              onClick={() => setFilterMode('auto')}
            >
              {t('autoTab', { count: counts.auto })}
            </button>
            <button
              className={`filter-tab ${filterMode === 'light' ? 'active' : ''}`}
              onClick={() => setFilterMode('light')}
            >
              ☀️ {t('lightTab', { count: counts.light })}
            </button>
            <button
              className={`filter-tab ${filterMode === 'dark' ? 'active' : ''}`}
              onClick={() => setFilterMode('dark')}
            >
              🌙 {t('darkTab', { count: counts.dark })}
            </button>
            <button
              className={`filter-tab ${filterMode === 'no-padding' ? 'active' : ''}`}
              onClick={() => setFilterMode('no-padding')}
            >
              🖼️ {t('noPaddingTab', { count: counts.noPadding })}
            </button>
          </div>
        </div>

        {/* Selection & Bulk Actions Bar */}
        <div className="logo-editor-selection-bar">
          <label className="logo-editor-select-all-label">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAllFiltered}
              disabled={filteredChannels.length === 0}
            />
            <span>
              {selectedIds.size > 0
                ? t('selectedCount', { count: selectedIds.size })
                : t('selectAllCount', { count: filteredChannels.length })}
            </span>
          </label>

          <div className="logo-editor-bulk-actions">
            <span className="bulk-action-label">{t('backgroundLabel')}</span>
            <button
              className="bulk-btn bulk-btn-light"
              onClick={() => applyBulkBg('light')}
              title={selectedIds.size > 0 ? t('applyLightSelected') : t('applyLightAll')}
            >
              ☀️ {t('light')}
            </button>
            <button
              className="bulk-btn bulk-btn-dark"
              onClick={() => applyBulkBg('dark')}
              title={selectedIds.size > 0 ? t('applyDarkSelected') : t('applyDarkAll')}
            >
              🌙 {t('dark')}
            </button>
            <button
              className="bulk-btn bulk-btn-auto"
              onClick={() => applyBulkBg('auto')}
              title={selectedIds.size > 0 ? t('resetAutoSelected') : t('resetAutoAll')}
            >
              🔄 {t('auto')}
            </button>

            <div className="bulk-action-divider" />

            <span className="bulk-action-label">{t('paddingLabel')}</span>
            <button
              className="bulk-btn bulk-btn-pad-default"
              onClick={() => applyBulkPadding(undefined)}
              title={i18n.t('epg:paddingDefaultTitle')}
            >
              ✨ {i18n.t('common:default')}
            </button>
            <button
              className="bulk-btn bulk-btn-no-pad"
              onClick={() => applyBulkPadding('none')}
              title={selectedIds.size > 0 ? t('removePaddingSelected') : t('removePaddingAll')}
            >
              🖼️ {t('removePadding')}
            </button>
            <button
              className="bulk-btn bulk-btn-pad-default"
              onClick={() => applyBulkPadding('default')}
              title={selectedIds.size > 0 ? t('normalPaddingSelected') : t('normalPaddingAll')}
            >
              📐 {t('normalPadding')}
            </button>
          </div>
        </div>

        {/* Channel Grid */}
        <div className="logo-editor-content" ref={contentRef}>
          {loading ? (
            <div className="logo-editor-loading">
              <div className="spinner" />
              <span>{t('loadingChannels')}</span>
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="logo-editor-empty">
              {channels.length === 0 ? t('noChannelsCategory') : t('noChannelsFilter')}
            </div>
          ) : (
            <div className="logo-editor-grid" ref={gridRef}>
              {startIndex > 0 && (
                <div
                  className="logo-editor-virtual-spacer"
                  style={{ gridColumn: '1 / -1', height: startRow * rowH }}
                />
              )}
              {visibleChannels.map((channel, i) => {
                const isSelected = selectedIds.has(channel.stream_id);
                const bg = logoBgMap[channel.stream_id] || 'auto';
                const pad = logoPaddingMap[channel.stream_id];

                return (
                  <div
                    key={channel.stream_id}
                    ref={i === 0 ? measureCardRef : undefined}
                    className={`logo-editor-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={(e) => {
                      // Prevent toggling checkbox when clicking interactive pill buttons
                      const target = e.target as HTMLElement;
                      if (!target.closest('.segmented-btn') && !target.closest('input[type="checkbox"]')) {
                        toggleSelectChannel(channel.stream_id);
                      }
                    }}
                  >
                    {/* Card Top: Checkbox & Name */}
                    <div className="card-header-row">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectChannel(channel.stream_id)}
                      />
                      <span className="channel-title" title={channel.name}>
                        {channel.name}
                      </span>
                    </div>

                    {/* Preview Box */}
                    <div className="card-preview-area">
                      <div className="preview-logo-wrapper">
                        <ChannelLogo
                          src={channel.stream_icon}
                          name={channel.name}
                          background={bg}
                          padding={pad}
                        />
                      </div>
                      <div className={`status-badge status-${bg}`}>
                        {bg === 'light' ? '☀️ Light' : bg === 'dark' ? '🌙 Dark' : 'Default'}
                        {pad === 'none' ? ' • No Pad' : ''}
                      </div>
                    </div>

                    {/* Segmented Control Pills for Background */}
                    <div className="card-segmented-control">
                      <button
                        className={`segmented-btn ${bg === 'auto' ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setChannelBg(channel.stream_id, 'auto'); }}
                        title={i18n.t('epg:defaultBgTitle')}
                      >
                        Default
                      </button>
                      <button
                        className={`segmented-btn ${bg === 'light' ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setChannelBg(channel.stream_id, 'light'); }}
                        title={i18n.t('epg:lightBgTitle')}
                      >
                        Light
                      </button>
                      <button
                        className={`segmented-btn ${bg === 'dark' ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setChannelBg(channel.stream_id, 'dark'); }}
                        title={i18n.t('epg:darkBgTitle')}
                      >
                        Dark
                      </button>
                    </div>

                    {/* Segmented Control Pills for Padding. Three options, matching
                        the EPG editor's framing control: Default follows Settings →
                        Logos, Normal and No Pad are explicit choices of this
                        channel's own. */}
                    <div className="card-segmented-control card-padding-control">
                      <button
                        className={`segmented-btn ${pad === undefined ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setChannelPadding(channel.stream_id, undefined); }}
                        title={i18n.t('epg:paddingDefaultTitle')}
                      >
                        ✨ {i18n.t('common:default')}
                      </button>
                      <button
                        className={`segmented-btn ${pad === 'default' ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setChannelPadding(channel.stream_id, 'default'); }}
                        title={i18n.t('epg:normalPaddingTitle')}
                      >
                        📐 {i18n.t('epg:normalPadding')}
                      </button>
                      <button
                        className={`segmented-btn ${pad === 'none' ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setChannelPadding(channel.stream_id, 'none'); }}
                        title={i18n.t('epg:noPadTitle')}
                      >
                        🖼️ {i18n.t('epg:noPad')}
                      </button>
                    </div>
                  </div>
                );
              })}
              {endIndex < filteredChannels.length && (
                <div
                  className="logo-editor-virtual-spacer"
                  style={{ gridColumn: '1 / -1', height: (totalRows - endRow) * rowH }}
                />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="logo-editor-footer">
          <div className="footer-status-left">
            {saveSuccess && <span className="save-success-msg">{saveSuccess}</span>}
            {!saveSuccess && hasChanges && <span className="unsaved-msg">● {t('unsavedChanges')}</span>}
          </div>
          <div className="footer-actions-right">
            <button className="logo-editor-btn logo-editor-btn-secondary" onClick={onClose}>
              {i18n.t('common:cancel')}
            </button>
            <button
              className="logo-editor-btn logo-editor-btn-primary"
              onClick={handleSaveChanges}
              disabled={saving || !hasChanges}
            >
              {saving ? t('saving') : `💾 ${t('saveChanges')}`}
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}
