import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './EpgEditorModal.css';
import { db, updateChannelsBatch } from '../db';
import type { StoredChannel, StoredCategory } from '../db';
import { ChannelLogo } from './ChannelLogo';
import { useEpgClockFormat } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { activeLocale } from '../utils/dateTime';


import {
  getChannelOverride,
  upsertChannelOverride,
  getEditorProgramsForStream,
  upsertProgramOverride,
  removeProgramOverride,
  restoreProgramOverride,
  searchEpgChannels,
  autoMatchChannelName,
  loadEpgMatchCandidates,
  matchChannelWithCleanNames,
  getPreviewProgramsForEpgId,
  copyProgramsFromEpgChannel,
  resetChannelToDefault,
  unmatchAutomatchChannel,
  unmatchAutomatchChannels,
  releaseChannelFeedPin,
  countFeedPinsInSource,
  releaseFeedPinsInSource,
  type EditorProgram,
  type ScoredEpgChannel,
  type EpgSearchMode,
  type EpgMatchCandidate,
} from '../services/epg-overrides';
import { effectiveMatchName } from '../utils/epgMatchName';
import { buildMissingEpgQuery, buildMissingEpgCountQuery } from '../utils/epgAutomatchFilter';
import { parseStripTags, prepareCleanNameIndex } from '../utils/epgChannelMatch';
import { priorOverrideSnapshot, type PriorOverrideSnapshot } from '../utils/epgAutomatchUndo';
import { VirtualList } from './common/VirtualList';

// ─── Types ────────────────────────────────────────────────────────────────────

type EditorTab = 'channel' | 'programs' | 'search' | 'source' | 'automatch';
type SearchScope = 'source' | 'all';

/**
 * A channel the opt-in cleaned-name tier refused to match because several EPG
 * channels share its cleaned name. Kept so the user can pick one — or dismiss
 * it — from the run's results instead of losing it to a log line.
 */
interface AutomatchRefusal {
  streamId: string;
  sourceId: string;
  channelName: string;
  cleanedName: string;
  totalChoices: number;
  choices: EpgMatchCandidate[];
}

/**
 * One match the run applied, with everything needed to take it back: the id it
 * wrote (so a hand-match made afterwards is never clobbered) and the channel's
 * override row as it was before the run (so unmatching restores it instead of
 * deleting settings the user had set on a channel that merely had no EPG).
 */
interface AutomatchMatch {
  streamId: string;
  sourceId: string;
  channelName: string;
  epgChannelId: string;
  prior: PriorOverrideSnapshot;
  /** Set once undone, so a row can't be unmatch-ed twice. */
  unmatched?: boolean;
}

/** A line of the run's results. Only matched lines carry an `AutomatchMatch`. */
interface AutomatchDetail {
  text: string;
  match?: AutomatchMatch;
}

type AutomatchResults = {
  matched: number;
  skipped: number;
  errors: number;
  ambiguous: number;
  cleaned: number;
  filtered: number;
  unmatched: number;
  details: AutomatchDetail[];
};

/**
 * The feed a channel may be pinned to, or `undefined` when the pin could never be
 * served.
 *
 * A global EPG link only ever fills the sources listed on the link, and a pinned
 * channel is skipped by *every* other feed — including its own source's. So
 * pinning a channel to a link that isn't attached to that channel's playlist
 * would leave it permanently blank instead of merely unmatched. In that case the
 * id is still saved (it works immediately, via the program copy) but no pin is
 * written, which is exactly the pre-pin behaviour.
 *
 * A pin to another *playlist's* feed is always kept: the post-sync alignment
 * copies from that feed's own channel rows, whatever it is attached to.
 */
function servablePin(
  feedSourceId: string | undefined,
  channelSourceId: string | undefined
): string | undefined {
  if (!feedSourceId) return undefined;
  const prefix = 'global_epg_';
  if (!feedSourceId.startsWith(prefix)) return feedSourceId;
  if (!channelSourceId) return undefined;
  const link = useSettingsStore
    .getState()
    .globalEpgLinks.find(l => l.id === feedSourceId.slice(prefix.length));
  if (!link || !link.sourceIds.includes(channelSourceId)) return undefined;
  return feedSourceId;
}

export interface EpgEditorModalProps {
  /** If set, opens directly on a specific channel */
  channel?: StoredChannel;
  /** If set (and no channel provided), opens on the Source EPG tab */
  sourceId?: string;
  sourceName?: string;
  /**
   * Channels for the list tab, instead of every channel of `sourceId`. The guide
   * passes the category it is showing, so the editor opens on the list the user
   * is already looking at and a click opens that channel — the same view a
   * right-click → Edit EPG gives, without hunting for the channel first.
   */
  channelList?: StoredChannel[];
  /** What `channelList` is (a category name), used for the tab + filter labels. */
  channelListName?: string;
  onClose: () => void;
}

/**
 * Which of these channels already carry an EPG override (the dot in the list).
 *
 * Chunked because a category can hold tens of thousands of stream ids and SQLite
 * caps bound parameters — one query per chunk of the primary key is still an
 * indexed lookup, and it avoids pulling the whole overrides table into memory
 * the way the source-scoped join can.
 */
async function loadOverriddenStreamIds(
  dbInstance: { select: (sql: string, params?: unknown[]) => Promise<unknown> },
  streamIds: string[]
): Promise<Set<string>> {
  const ids = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < streamIds.length; i += CHUNK) {
    const chunk = streamIds.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
    const rows = await dbInstance.select(
      `SELECT stream_id FROM epg_channel_overrides WHERE stream_id IN (${placeholders})`,
      chunk
    ) as { stream_id: string }[];
    for (const row of rows) ids.add(row.stream_id);
  }
  return ids;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDatetimeLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToIso(value: string): string {
  if (!value) return '';
  return new Date(value).toISOString();
}

function formatShortDatetime(iso: string, epgClockFormat: '12h' | '24h'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(activeLocale(), {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: epgClockFormat !== '24h',
  });
}

function generateId(): string {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** A single program row in the Programs tab */
function ProgramRow({
  prog,
  onSave,
  onDelete,
  onRestore,
}: {
  prog: EditorProgram;
  onSave: (updated: Partial<EditorProgram>) => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation('epg');
  const epgClockFormat = useEpgClockFormat();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(prog.title);
  const [subtitle, setSubtitle] = useState(prog.subtitle);
  const [desc, setDesc] = useState(prog.description);
  const [start, setStart] = useState(formatDatetimeLocal(prog.start));
  const [end, setEnd] = useState(formatDatetimeLocal(prog.end));

  // Reset edit fields when prog changes externally
  useEffect(() => {
    setTitle(prog.title);
    setSubtitle(prog.subtitle);
    setDesc(prog.description);
    setStart(formatDatetimeLocal(prog.start));
    setEnd(formatDatetimeLocal(prog.end));
    setEditing(false);
  }, [prog.id]);

  function handleSave() {
    onSave({
      title,
      subtitle: subtitle || undefined,
      description: desc || undefined,
      start: datetimeLocalToIso(start),
      end: datetimeLocalToIso(end),
    });
    setEditing(false);
  }

  return (
    <div className={`epg-program-row${prog.is_deleted ? ' is-deleted' : ''}${prog.is_custom ? ' is-custom' : ''}${editing ? ' editing' : ''}`}>
      <div className="epg-program-time">
        <div>{formatShortDatetime(prog.start, epgClockFormat)}</div>
        <div style={{ opacity: 0.6, fontSize: '0.7rem', marginTop: 2 }}>→ {formatShortDatetime(prog.end, epgClockFormat)}</div>
      </div>
      <div className="epg-program-info">
        <div className="epg-program-title">{prog.title || '(No title)'}</div>
        {prog.subtitle && (
          <div className="epg-program-subtitle" style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 2 }}>{prog.subtitle}</div>
        )}
        <div className="epg-program-badges">
          {prog.has_override && !prog.is_deleted && !prog.is_custom && (
            <span className="epg-badge epg-badge-modified">{t('modified')}</span>
          )}
          {prog.is_custom && <span className="epg-badge epg-badge-custom">{t('custom')}</span>}
          {prog.is_deleted && <span className="epg-badge epg-badge-deleted">{t('deleted')}</span>}
        </div>
        {editing && (
          <div className="epg-program-edit-form">
            <div className="full-width">
              <input
                className="epg-editor-input"
                placeholder={t('titlePlaceholder')}
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div className="full-width">
              <input
                className="epg-editor-input"
                placeholder={t('subtitleOptional')}
                value={subtitle}
                onChange={e => setSubtitle(e.target.value)}
              />
            </div>
            <div className="full-width">
              <textarea
                className="epg-editor-textarea"
                placeholder={t('descriptionOptional')}
                value={desc}
                rows={2}
                onChange={e => setDesc(e.target.value)}
              />
            </div>
            <div>
              <label className="epg-editor-label">{t('start')}</label>
              <input
                type="datetime-local"
                className="epg-editor-input"
                value={start}
                onChange={e => setStart(e.target.value)}
              />
            </div>
            <div>
              <label className="epg-editor-label">{t('end')}</label>
              <input
                type="datetime-local"
                className="epg-editor-input"
                value={end}
                onChange={e => setEnd(e.target.value)}
              />
            </div>
            <div className="full-width" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="epg-editor-btn epg-editor-btn-secondary" onClick={() => setEditing(false)}>{i18n.t('common:cancel')}</button>
              <button className="epg-editor-btn epg-editor-btn-primary" onClick={handleSave}>{t('saveProgram')}</button>
            </div>
          </div>
        )}
      </div>
      {!editing && (
        <div className="epg-program-actions">
          {prog.is_deleted ? (
            <button className="epg-program-action-btn restore" onClick={onRestore}>↩ {t('undo')}</button>
          ) : (
            <>
              <button className="epg-program-action-btn" onClick={() => setEditing(true)}>✏ {i18n.t('common:edit')}</button>
              <button className="epg-program-action-btn danger" onClick={onDelete}>🗑 {i18n.t('common:delete')}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function EpgEditorModal({
  channel: initialChannel,
  sourceId,
  sourceName,
  channelList,
  channelListName,
  onClose,
}: EpgEditorModalProps) {
  const { t } = useTranslation('epg');
  const epgClockFormat = useEpgClockFormat();
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Navigation state ──
  // `channelList` is honoured even when empty: the caller asked for a list view,
  // and falling back to the channel tab with no channel renders a blank body.
  const [activeTab, setActiveTab] = useState<EditorTab>(
    initialChannel ? 'channel' : (sourceId || channelList) ? 'source' : 'channel'
  );
  const [channel, setChannel] = useState<StoredChannel | undefined>(initialChannel);
  const resolvedSourceId = channel?.source_id ?? sourceId;

  const epgLogoDisplay = useSettingsStore((s) => s.epgLogoDisplay);
  const sourceLogoDisplayOverrides = useSettingsStore((s) => s.sourceLogoDisplayOverrides);
  const sourceLogoBackgroundOverrides = useSettingsStore((s) => s.sourceLogoBackgroundOverrides);
  const logoDefaultBackground = useSettingsStore((s) => s.logoDefaultBackground);
  const sourceDisplayOverride = channel?.source_id ? sourceLogoDisplayOverrides?.[channel.source_id] : undefined;
  const logoShape = (sourceDisplayOverride || epgLogoDisplay) as 'square' | 'rectangle';
  // What 'Default' resolves to for THIS channel: the source-level override
  // (may force 'auto' = luminance detection) beats the global default.
  const resolvedDefaultBg: 'auto' | 'light' | 'dark' =
    channel?.source_id
      ? (sourceLogoBackgroundOverrides[channel.source_id] ?? logoDefaultBackground)
      : logoDefaultBackground;


  // ── Channel tab state ──
  const [rawChannel, setRawChannel] = useState<StoredChannel | null>(null);
  const [tvgId, setTvgId] = useState('');
  // The TVG-ID as loaded (to detect a manual id change) and the feed the user
  // pinned this channel to (`epg_channel_overrides.epg_source_id`).
  const [originalTvgId, setOriginalTvgId] = useState('');
  const [pinnedFeed, setPinnedFeed] = useState<string | undefined>(undefined);
  // 'Use my name for EPG matching' — replaces the provider name as the matching
  // key (epg_channel_overrides.match_by_alias).
  const [matchByAlias, setMatchByAlias] = useState(false);
  // The channel's own name for matching (`channels.alias`) — editable here so a
  // provider name that can't match a feed doesn't force a trip to Manage
  // Channels. Empty means "no name of my own": the provider name is used.
  const [matchNameDraft, setMatchNameDraft] = useState('');
  // Feed locks in this channel's playlist (Programs tab bulk release).
  const [pinnedInPlaylist, setPinnedInPlaylist] = useState(0);
  const [confirmReleaseAll, setConfirmReleaseAll] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');
  const [logoBackground, setLogoBackground] = useState<'auto' | 'light' | 'dark'>('auto');
  const [logoPadding, setLogoPadding] = useState<'default' | 'none'>('default');
  const [epgLogoUrl, setEpgLogoUrl] = useState('');
  const [timeshiftHours, setTimeshiftHours] = useState('0');
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelSaved, setChannelSaved] = useState(false);

  // ── Channel tab: which name EPG matching will use ──
  // The provider hands us one name; the channel's own name (`channels.alias`) is
  // the other. Matching uses exactly one of them (see effectiveMatchName), so
  // both are shown here and the effective one is named in the hint — an
  // un-renamed channel used to just say "rename it in Manage Channels".
  const providerName = (rawChannel?.name ?? channel?.name ?? '').trim();
  const typedMatchName = matchNameDraft.trim();
  // Typing the provider name back — or clearing the field — means "no name of my
  // own", the same rule the rename in Manage Channels uses.
  const customMatchName = typedMatchName && typedMatchName !== providerName ? typedMatchName : '';
  const effectiveName = matchByAlias && customMatchName ? customMatchName : providerName;

  // ── Programs tab state ──
  const [programs, setPrograms] = useState<EditorProgram[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');
  const [newDesc, setNewDesc]   = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd]     = useState('');

  // ── Search tab state ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('source');
  const [searchMode, setSearchMode] = useState<EpgSearchMode>('m3u');
  const [searchResults, setSearchResults] = useState<ScoredEpgChannel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [autoSearching, setAutoSearching] = useState(false);

  // ── Search preview state (click a result to see its programs) ──
  const [previewResult, setPreviewResult] = useState<ScoredEpgChannel | null>(null);
  const [previewPrograms, setPreviewPrograms] = useState<EditorProgram[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  // Load programs when preview result changes
  useEffect(() => {
    if (!previewResult) { setPreviewPrograms([]); return; }
    setPreviewLoading(true);
    getPreviewProgramsForEpgId(previewResult.id, 3, previewResult.source_id)
      .then(p => setPreviewPrograms(p.filter(prog => !prog.is_deleted)))
      .catch(() => setPreviewPrograms([]))
      .finally(() => setPreviewLoading(false));
  }, [previewResult?.id, previewResult?.source_id]);

  // ── Reset Confirm State ──
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // ── Source name map (id → friendly name) for search results ──
  const [sourceNameMap, setSourceNameMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!window.storage) return;
    window.storage.getSources().then((sourcesResult) => {
      const map = new Map<string, string>();
      if (sourcesResult.data) {
        for (const s of sourcesResult.data) map.set(s.id, s.name);
      }
      const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
      for (const link of globalEpgLinks) {
        map.set(`global_epg_${link.id}`, `${link.name} (Cache)`);
      }
      setSourceNameMap(map);
    }).catch(() => {});
  }, []);

  // ── Source tab state ──
  const [sourceChannels, setSourceChannels] = useState<StoredChannel[]>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  // Track which stream_ids have overrides (for the indicator dot)
  const [overriddenIds, setOverriddenIds] = useState<Set<string>>(new Set());

  // ── Automatch tab state ──
  const [automatchSources, setAutomatchSources] = useState<{ id: string; name: string }[]>([]);
  const [automatchSourceId, setAutomatchSourceId] = useState('');
  const [automatchScope, setAutomatchScope] = useState<SearchScope>('source');
  const [automatchMode, setAutomatchMode] = useState<EpgSearchMode>('m3u');
  // 90% by default: a run writes what it matches straight to the library, and a
  // loose threshold (the old 40%) will happily fill a source with lookalike
  // channels before the user has read the results. Lowering it is a deliberate
  // choice now, rather than what happens when nobody touches the slider.
  const [automatchThreshold, setAutomatchThreshold] = useState(90);
  const [automatchCategories, setAutomatchCategories] = useState<string[]>([]);
  const [automatchAllCategories, setAutomatchAllCategories] = useState(true);
  const [automatchRunning, setAutomatchRunning] = useState(false);
  // Opt-in decorated-name handling for this tab (persisted, default off).
  const epgAutomatchCleanNames = useSettingsStore((s) => s.epgAutomatchCleanNames);
  const setEpgAutomatchCleanNames = useSettingsStore((s) => s.setEpgAutomatchCleanNames);
  const epgAutomatchStripTags = useSettingsStore((s) => s.epgAutomatchStripTags);
  const setEpgAutomatchStripTags = useSettingsStore((s) => s.setEpgAutomatchStripTags);
  // Persisted and on by default: sweep only the channels the app actually shows.
  const epgAutomatchEnabledOnly = useSettingsStore((s) => s.epgAutomatchEnabledOnly);
  const setEpgAutomatchEnabledOnly = useSettingsStore((s) => s.setEpgAutomatchEnabledOnly);
  const enabledOnly = epgAutomatchEnabledOnly !== false;
  const [stripTagsInput, setStripTagsInput] = useState('');
  useEffect(() => {
    setStripTagsInput((epgAutomatchStripTags ?? []).join(', '));
  }, [epgAutomatchStripTags]);
  const [automatchProgress, setAutomatchProgress] = useState<{ matched: number; total: number } | null>(null);
  const [automatchResults, setAutomatchResults] = useState<AutomatchResults | null>(null);
  // Ambiguous refusals from the last run, kept as pickable rows so a refusal is a
  // to-do item rather than a dead end.
  const [automatchRefusals, setAutomatchRefusals] = useState<AutomatchRefusal[]>([]);
  const [resolvingRefusal, setResolvingRefusal] = useState<string | null>(null);
  /** Channel currently being unmatch-ed, and per-row messages after a failure or a stale match. */
  const [unmatchingId, setUnmatchingId] = useState<string | null>(null);
  const [unmatchNotices, setUnmatchNotices] = useState<Record<string, string>>({});
  /** The whole-run undo: armed (two-step confirm), in flight, or reporting a failure. */
  const [confirmUndoAll, setConfirmUndoAll] = useState(false);
  const [undoingAll, setUndoingAll] = useState(false);
  const [undoAllError, setUndoAllError] = useState<string | null>(null);
  /** Scroll container for the virtualized results list. */
  const automatchListRef = useRef<HTMLDivElement>(null);
  const [sourceCategories, setSourceCategories] = useState<StoredCategory[]>([]);

  // ── Load channel override and raw channel when channel changes ──
  useEffect(() => {
    if (!channel) {
      setRawChannel(null);
      return;
    }

    let active = true;
    Promise.all([
      db.channels.get(channel.stream_id),
      getChannelOverride(channel.stream_id)
    ]).then(([rc, ov]) => {
      if (!active) return;
      
      const rawChan = rc || null;
      setRawChannel(rawChan);
      const loadedTvgId = ov?.epg_channel_id ?? channel.epg_channel_id ?? '';
      setTvgId(loadedTvgId);
      setOriginalTvgId(loadedTvgId);
      setPinnedFeed(ov?.epg_source_id || undefined);
      setMatchByAlias(Boolean(ov?.match_by_alias));
      setMatchNameDraft((rawChan?.alias ?? '').trim());
      
      const playlistIcon = rawChan?.stream_icon ?? channel.stream_icon ?? '';
      setLogoUrl(ov?.stream_icon ?? playlistIcon);
      setLogoBackground((ov?.logo_background as 'auto' | 'light' | 'dark') ?? 'auto');
      setLogoPadding((ov?.logo_padding as 'default' | 'none') ?? 'default');
      
      setTimeshiftHours(ov?.timeshift_hours != null ? String(ov.timeshift_hours) : '0');
    }).catch(err => {
      console.error('[EPG Editor] Failed to load channel details:', err);
    });

    // Feed locks elsewhere in this playlist (Programs tab shows them and can
    // release them in bulk).
    setConfirmReleaseAll(false);
    countFeedPinsInSource(channel.source_id).then(count => {
      if (!active) return;
      setPinnedInPlaylist(count);
    }).catch(() => {});

    return () => { active = false; };
  }, [channel]);

  // ── Load matched EPG channel logo when tvgId changes ──
  useEffect(() => {
    if (!tvgId.trim()) {
      setEpgLogoUrl('');
      return;
    }
    db.epgChannels.get(tvgId).then(async epgChan => {
      if (epgChan?.icon_url) {
        setEpgLogoUrl(epgChan.icon_url);
        return;
      }

      // Check cache databases
      if (window.storage) {
        try {
          const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
          const cacheLinks = globalEpgLinks.filter(link => link.saveEntireEpg);
          const Database = (await import('@tauri-apps/plugin-sql')).default;
          
          for (const link of cacheLinks) {
            try {
              const cacheDbName = `epg_cache_${link.id}`;
              const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
              const rows = await cacheDb.select(
                'SELECT icon_url FROM epg_channels WHERE id = $1 LIMIT 1',
                [tvgId]
              ) as { icon_url: string }[];
              if (rows.length > 0 && rows[0].icon_url) {
                setEpgLogoUrl(rows[0].icon_url);
                return;
              }
            } catch {
              // Ignore
            }
          }
        } catch {
          // Ignore
        }
      }

      setEpgLogoUrl('');
    }).catch(err => {
      console.warn('[EPG Editor] Failed to load matched EPG channel details:', err);
      setEpgLogoUrl('');
    });
  }, [tvgId]);

  // ── Load programs when switching to Programs tab ──
  useEffect(() => {
    if (activeTab !== 'programs' || !channel) return;
    setProgramsLoading(true);
    getEditorProgramsForStream(channel.stream_id).then(p => {
      setPrograms(p);
      setProgramsLoading(false);
    });
  }, [activeTab, channel]);

  // ── Load source channels when switching to Source tab ──
  useEffect(() => {
    if (activeTab !== 'source') return;
    // No list tab on a single-channel modal, so never build the source-wide list
    // it would have shown.
    if (channel && !channelList) return;

    // A caller that supplies its own list (the guide's current category) already
    // decided which channels to show, so no source query is needed — and it may
    // span sources or be a category of one.
    if (channelList) {
      setSourceLoading(true);
      const sorted = [...channelList].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setSourceChannels(sorted);
      (db as any).dbPromise
        .then((dbInstance: any) => loadOverriddenStreamIds(dbInstance, sorted.map(ch => ch.stream_id)))
        .then((ids: Set<string>) => setOverriddenIds(ids))
        .catch(() => setOverriddenIds(new Set()))
        .finally(() => setSourceLoading(false));
      return;
    }

    if (!resolvedSourceId) return;
    setSourceLoading(true);
    db.channels.where('source_id').equals(resolvedSourceId).toArray().then(async chans => {
      const sorted = chans.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setSourceChannels(sorted);
      // Load overridden stream ids for dot indicators — source-scoped indexed join
      // instead of pulling the entire overrides table into memory.
      const dbInstance = await (db as any).dbPromise;
      const overrideRows = await dbInstance.select(
        `SELECT o.stream_id FROM epg_channel_overrides o JOIN channels c ON c.stream_id = o.stream_id WHERE c.source_id = $1`,
        [resolvedSourceId]
      ) as { stream_id: string }[];
      const ids = new Set(overrideRows.map(r => r.stream_id));
      setOverriddenIds(ids);
      setSourceLoading(false);
    });
  }, [activeTab, resolvedSourceId, channelList]);

  // ── Load sources for Automatch tab ──
  useEffect(() => {
    if (activeTab !== 'automatch') return;
    if (!window.storage) return;
    window.storage.getSources().then((result: any) => {
      if (result.data) {
        const sources = result.data.map((s: any) => ({ id: s.id, name: s.name }));
        setAutomatchSources(sources);
        if (!automatchSourceId && resolvedSourceId) {
          setAutomatchSourceId(resolvedSourceId);
        } else if (!automatchSourceId && sources.length > 0) {
          setAutomatchSourceId(sources[0].id);
        }
      }
    }).catch(() => {});
  }, [activeTab, resolvedSourceId]);

  // ── Load categories for Automatch tab ──
  useEffect(() => {
    if (activeTab !== 'automatch') return;
    if (!automatchSourceId || automatchScope !== 'source') {
      setSourceCategories([]);
      return;
    }
    db.categories.where('source_id').equals(automatchSourceId).toArray().then(cats => {
      const sorted = cats.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || ''));
      setSourceCategories(sorted);
    });
  }, [activeTab, automatchSourceId, automatchScope]);

  // ── Debounced search ──
  useEffect(() => {
    if (activeTab !== 'search') return;
    if (!searchQuery.trim()) { setSearchResults([]); return; }

    const tid = setTimeout(async () => {
      setSearchLoading(true);
      const results = await searchEpgChannels(
        searchQuery,
        searchScope === 'source' ? resolvedSourceId : undefined,
        50,
        searchMode
      );
      setSearchResults(results);
      setSearchLoading(false);
    }, 300);

    return () => clearTimeout(tid);
  }, [searchQuery, searchScope, searchMode, activeTab, resolvedSourceId]);

  // ── Close on Escape ──
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  /**
   * Edit the channel's own name. A name typed here is meant to *match*, so
   * matching switches to it — a rename that matching ignores is the exact trap
   * this field exists to close. The toggle below puts matching back on the
   * provider name without discarding the name.
   */
  function handleMatchNameChange(value: string) {
    setMatchNameDraft(value);
    const trimmed = value.trim();
    setMatchByAlias(Boolean(trimmed) && trimmed !== providerName);
  }

  /** Back to the provider's name: drops both the rename and the matching flag. */
  function handleResetMatchName() {
    setMatchNameDraft('');
    setMatchByAlias(false);
  }

  // ── Channel tab: save ──
  async function handleSaveChannel() {
    if (!channel) return;
    setChannelSaving(true);
    try {
      const hours = parseFloat(timeshiftHours);
      // The channel's own name lives on the channels row, not the override, so a
      // rename here is written directly — through the same batch helper the
      // rename in Manage Channels uses, where `null` clears the override (a
      // plain update() drops `undefined` and would silently do nothing).
      const nextAlias = customMatchName || null;
      if ((rawChannel?.alias ?? null) !== nextAlias) {
        await updateChannelsBatch([{ streamId: channel.stream_id, alias: nextAlias }]);
        setRawChannel(prev => prev ? { ...prev, alias: nextAlias ?? undefined } : prev);
      }
      // Editing the TVG-ID by hand means the pinned feed may not be the one that
      // provides the new id any more, so the pin is dropped. Saving other fields
      // (logo, timeshift) keeps it. `put` is INSERT OR REPLACE, so the pin must
      // always be written explicitly or it would be erased either way.
      const idChanged = tvgId.trim() !== originalTvgId.trim();
      await upsertChannelOverride({
        stream_id: channel.stream_id,
        epg_channel_id: tvgId.trim() || undefined,
        stream_icon: logoUrl.trim() || undefined,
        logo_background: logoBackground === 'auto' ? undefined : logoBackground,
        logo_padding: logoPadding === 'default' ? undefined : logoPadding,
        timeshift_hours: isNaN(hours) ? 0 : hours,
        epg_source_id: idChanged ? undefined : pinnedFeed,
        match_by_alias: matchByAlias,
      });
      if (idChanged) setPinnedFeed(undefined);
      setChannelSaved(true);
      setTimeout(() => setChannelSaved(false), 2500);
    } finally {
      setChannelSaving(false);
    }
  }

  // ── Programs tab: handlers ──
  async function handleProgramSave(prog: EditorProgram, changes: Partial<EditorProgram>) {
    await upsertProgramOverride({
      id: prog.id,
      stream_id: prog.stream_id,
      title: changes.title ?? prog.title,
      subtitle: changes.subtitle ?? prog.subtitle,
      description: changes.description ?? prog.description,
      start: changes.start ?? prog.start,
      end: changes.end ?? prog.end,
      is_deleted: 0,
      is_custom: prog.is_custom ? 1 : 0,
    });
    setPrograms(prev => prev.map(p =>
      p.id === prog.id
        ? { ...p, ...changes, has_override: true }
        : p
    ));
  }

  async function handleProgramDelete(prog: EditorProgram) {
    if (prog.is_custom) {
      // Hard-remove custom programs (no tombstone needed)
      await removeProgramOverride(prog.id);
      setPrograms(prev => prev.filter(p => p.id !== prog.id));
    } else {
      // Tombstone synced programs
      await upsertProgramOverride({
        id: prog.id,
        stream_id: prog.stream_id,
        title: prog.title,
        description: prog.description,
        start: prog.start,
        end: prog.end,
        is_deleted: 1,
        is_custom: 0,
      });
      setPrograms(prev => prev.map(p =>
        p.id === prog.id ? { ...p, is_deleted: true, has_override: true } : p
      ));
    }
  }

  async function handleProgramRestore(prog: EditorProgram) {
    await restoreProgramOverride(prog.id);
    setPrograms(prev => prev.map(p =>
      p.id === prog.id ? { ...p, is_deleted: false } : p
    ));
  }

  async function handleAddCustomProgram() {
    if (!channel || !newTitle.trim() || !newStart || !newEnd) return;
    const id = generateId();
    const startIso = datetimeLocalToIso(newStart);
    const endIso = datetimeLocalToIso(newEnd);
    await upsertProgramOverride({
      id,
      stream_id: channel.stream_id,
      title: newTitle.trim(),
      subtitle: newSubtitle.trim(),
      description: newDesc.trim(),
      start: startIso,
      end: endIso,
      is_deleted: 0,
      is_custom: 1,
    });
    const newProg: EditorProgram = {
      id, stream_id: channel.stream_id,
      title: newTitle.trim(), subtitle: newSubtitle.trim(), description: newDesc.trim(),
      start: startIso, end: endIso,
      source_id: '', has_override: true,
      is_deleted: false, is_custom: true,
    };
    setPrograms(prev => [...prev, newProg].sort((a, b) => a.start.localeCompare(b.start)));
    setNewTitle(''); setNewSubtitle(''); setNewDesc(''); setNewStart(''); setNewEnd('');
    setShowAddForm(false);
  }

  // ── Search tab: auto-suggest ──
  // Searches with the SAME name the sync matches on (see effectiveMatchName),
  // taken from the Channel tab's field — so a name you are still deciding on can
  // be tried against the feeds before you save it, and once saved the suggestion
  // and the next sync cannot disagree.
  const handleAutoSuggest = useCallback(async () => {
    if (!channel) return;
    setAutoSearching(true);
    const results = await autoMatchChannelName(
      effectiveName,
      searchScope === 'source' ? resolvedSourceId : undefined,
      10,
      searchMode
    );
    setSearchResults(results);
    if (results.length > 0) setSearchQuery(results[0].display_name);
    setAutoSearching(false);
  }, [channel, effectiveName, searchScope, searchMode, resolvedSourceId]);

  // ── Search tab: apply match ──
  async function handleApplyMatch(epgChan: ScoredEpgChannel) {
    if (!channel) return;
    setApplyingId(epgChan.id);
    try {
      const current = await getChannelOverride(channel.stream_id);
      const pin = servablePin(epgChan.source_id, channel.source_id);
      await upsertChannelOverride({
        stream_id: channel.stream_id,
        epg_channel_id: epgChan.id,
        stream_icon: epgChan.icon_url || current?.stream_icon || channel.stream_icon,
        timeshift_hours: current?.timeshift_hours ?? 0,
        // Pin the channel to the feed the user picked. Ids are shared between
        // feeds, so without this a higher-priority global EPG could refill the
        // channel from a different feed than the one chosen here.
        epg_source_id: pin,
        // Kept as-is: an explicit id wins over the name, so the flag is inert
        // here, but silently dropping the user's setting would be surprising.
        match_by_alias: current?.match_by_alias,
      });
      setTvgId(epgChan.id);
      setOriginalTvgId(epgChan.id);
      setPinnedFeed(pin);
      if (epgChan.icon_url) setLogoUrl(epgChan.icon_url);
      setChannelSaved(true);
      setTimeout(() => setChannelSaved(false), 2500);

      // Immediately copy programs from the matched EPG channel so the
      // user sees programs right away without waiting for a full sync.
      try {
        await copyProgramsFromEpgChannel(channel.stream_id, epgChan.id, epgChan.source_id);
      } catch (e) {
        console.warn('[EPG Editor] Could not copy programs immediately:', e);
      }

      setActiveTab('channel');
    } finally {
      setApplyingId(null);
    }
  }

  // ── Source tab: navigate to channel ──
  function handleOpenSourceChannel(ch: StoredChannel) {
    setChannel(ch);
    setActiveTab('channel');
  }

  // ── Channel tab: reset to default ──
  function handleResetToDefault() {
    if (!channel) return;
    setShowResetConfirm(true);
  }

  async function executeResetToDefault() {
    if (!channel) return;
    await resetChannelToDefault(channel.stream_id);
    setShowResetConfirm(false);
    onClose(); // Close the modal since the channel is now reset
  }

  // ── Automatch tab: get channels missing EPG ──
  async function getChannelsMissingEpg(
    sourceId: string | undefined,
    categoryIds: string[],
    scope: SearchScope,
    enabledOnly: boolean
  ): Promise<{ channels: StoredChannel[]; hidden: number }> {
    const dbInstance = await (db as any).dbPromise;

    // `match_by_alias` comes along so the matcher looks the channel up under the
    // same name the sync will use.
    const query = buildMissingEpgQuery({
      scope,
      sourceId,
      categoryIds,
      visibility: enabledOnly ? 'visible' : 'all',
    });
    const rows = await dbInstance.select(query.sql, query.params) as any[];
    const channels = rows.map(r => ({
      ...r,
      category_ids: r.category_ids ? JSON.parse(r.category_ids) : [],
    }));

    // Count what the visible-only scope left out, so the run can say "skipped
    // 12,480 hidden channels" instead of silently doing less work than before.
    let hidden = 0;
    if (enabledOnly) {
      const countQuery = buildMissingEpgCountQuery({
        scope,
        sourceId,
        categoryIds,
        visibility: 'hidden',
      });
      const countRows = await dbInstance.select(countQuery.sql, countQuery.params) as Array<{ cnt: number }>;
      hidden = countRows[0]?.cnt ?? 0;
    }

    return { channels, hidden };
  }

  // ── Automatch tab: run auto-match for all missing channels ──
  async function handleAutoMatchMissing() {
    setAutomatchRunning(true);
    setAutomatchResults(null);
    setAutomatchProgress(null);

    try {
      const { channels, hidden: hiddenChannels } = await getChannelsMissingEpg(
        automatchScope === 'source' ? automatchSourceId : undefined,
        automatchAllCategories ? [] : automatchCategories,
        automatchScope,
        enabledOnly
      );

      if (channels.length === 0) {
        const lines = hiddenChannels > 0
          ? [t('noChannelsMissing'), t('enabledOnlySkipped', { count: hiddenChannels })]
          : [t('noChannelsMissing')];
        setAutomatchResults({
          matched: 0, skipped: 0, errors: 0, ambiguous: 0, cleaned: 0, filtered: hiddenChannels, unmatched: 0,
          details: lines.map(text => ({ text })),
        });
        setAutomatchRunning(false);
        return;
      }

      setAutomatchProgress({ matched: 0, total: channels.length });
      setAutomatchRefusals([]);
      setUnmatchNotices({});
      // A fresh run replaces the previous results, so an armed Undo all from the
      // last one has nothing left to act on.
      setConfirmUndoAll(false);
      setUndoAllError(null);

      let matched = 0;
      let skipped = 0;
      let errors = 0;
      let ambiguous = 0;
      let cleaned = 0;
      const details: AutomatchDetail[] = [];
      const refusals: AutomatchRefusal[] = [];
      const threshold = automatchThreshold / 100;
      const scopeId = automatchScope === 'source' ? (automatchSourceId || undefined) : undefined;

      // The opt-in cleaned-name run resolves every channel against the whole
      // candidate list, so it is loaded AND indexed once instead of re-read per
      // channel (the index is what keeps a large feed's run from taking minutes).
      const cleanIndex = epgAutomatchCleanNames
        ? prepareCleanNameIndex(
            await loadEpgMatchCandidates(scopeId, automatchMode),
            epgAutomatchStripTags,
          )
        : null;

      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        try {
          const matchName = effectiveMatchName(
            { name: ch.name, alias: (ch as any).alias },
            Boolean((ch as any).match_by_alias)
          );
          // Decorated-name handling (opt-in): strip region markers and quality
          // tags from both sides. A cleaned name shared by several EPG channels
          // is reported instead of guessed at, so the user sees exactly which
          // channels this run refused to touch.
          const cleanedMatch = cleanIndex
            ? matchChannelWithCleanNames(
                matchName,
                cleanIndex,
                threshold,
                epgAutomatchStripTags,
                // M3U mode lists the playlist's own channels, so the channel
                // itself is always a candidate — and matching it to itself
                // resolves nothing.
                ch.stream_id,
              )
            : null;

          if (cleanedMatch?.ambiguous) {
            ambiguous++;
            refusals.push({
              streamId: ch.stream_id,
              sourceId: ch.source_id,
              channelName: ch.name,
              cleanedName: cleanedMatch.cleanedName,
              totalChoices: cleanedMatch.totalChoices,
              choices: cleanedMatch.choices,
            });
            details.push({ text: `⚠ ${ch.name} — ${t('automatchAmbiguous', {
              name: cleanedMatch.cleanedName,
              count: cleanedMatch.totalChoices,
            })}` });
            setAutomatchProgress({ matched: matched + skipped + errors + ambiguous, total: channels.length });
            if (i % 3 === 0) await new Promise(r => setTimeout(r, 1));
            continue;
          }

          // With cleaning on, the cleaned names ARE the comparison — falling back
          // to the raw scorer would re-introduce the tags we just removed.
          const results = epgAutomatchCleanNames
            ? []
            : await autoMatchChannelName(matchName, scopeId, 1, automatchMode);
          const topMatch = cleanedMatch?.match ?? (results.length > 0 && results[0].score >= threshold ? results[0] : null);

          if (topMatch) {
            if (cleanedMatch?.match) cleaned++;
            // The row as it stood before this write, so Unmatch can restore it.
            const prior = priorOverrideSnapshot(ch as unknown as Record<string, unknown>);
            // Bulk auto-match picks a *new* id, so any previous feed pin is
            // cleared rather than left pointing at a feed for the old id.
            await upsertChannelOverride({
              stream_id: ch.stream_id,
              epg_channel_id: topMatch.id,
              stream_icon: topMatch.icon_url || ch.stream_icon,
              timeshift_hours: 0,
              epg_source_id: undefined,
              match_by_alias: Boolean((ch as any).match_by_alias),
            });

            try {
              // Pass the feed so a cached global-EPG match copies from its
              // cache DB; for a plain source feed the argument is ignored and
              // the channels-table lookup is used, exactly as before.
              await copyProgramsFromEpgChannel(ch.stream_id, topMatch.id, topMatch.source_id);
            } catch (e) {
              // Non-critical
            }

            matched++;
            details.push({
              text: `✓ ${ch.name} → ${topMatch.display_name} (${(topMatch.score * 100).toFixed(0)}%)${cleanedMatch?.match ? ` · ${t('automatchViaCleaned')}` : ''}`,
              match: {
                streamId: ch.stream_id,
                sourceId: ch.source_id,
                channelName: ch.name,
                epgChannelId: topMatch.id,
                prior,
              },
            });
          } else {
            skipped++;
            if (cleanedMatch) {
              details.push({ text: `✗ ${ch.name} — ${t('automatchCleanNoMatch', {
                name: cleanedMatch.cleanedName,
                threshold: automatchThreshold,
              })}` });
            } else {
              const bestScore = results.length > 0 ? results[0].score : 0;
              details.push({ text: `✗ ${ch.name} — best match ${(bestScore * 100).toFixed(0)}% (below ${automatchThreshold}%)` });
            }
          }
        } catch (e) {
          errors++;
          details.push({ text: `⚠ ${ch.name} — error` });
        }

        setAutomatchProgress({ matched: matched + skipped + errors + ambiguous, total: channels.length });

        // Yield to UI thread occasionally
        if (i % 3 === 0) {
          await new Promise(r => setTimeout(r, 1));
        }
      }

      setAutomatchResults({ matched, skipped, errors, ambiguous, cleaned, filtered: hiddenChannels, unmatched: 0, details });
      setAutomatchRefusals(refusals);
    } finally {
      setAutomatchRunning(false);
    }
  }

  /**
   * Resolve one refused channel from the ambiguity worklist. The user picked the
   * EPG channel that should supply its guide, so this applies exactly what the
   * run would have applied had it been confident — id, feed pin, icon and an
   * immediate program copy — and then drops the row.
   */
  async function handleResolveRefusal(refusal: AutomatchRefusal, choice: EpgMatchCandidate) {
    setResolvingRefusal(refusal.streamId);
    try {
      const current = await getChannelOverride(refusal.streamId);
      const pin = servablePin(choice.source_id, refusal.sourceId);
      await upsertChannelOverride({
        stream_id: refusal.streamId,
        epg_channel_id: choice.id,
        stream_icon: choice.icon_url || current?.stream_icon,
        timeshift_hours: current?.timeshift_hours ?? 0,
        // Same reasoning as an explicit Apply: the id alone is ambiguous across
        // feeds, so the feed the user picked is pinned to the channel.
        epg_source_id: pin,
        match_by_alias: current?.match_by_alias,
      });

      try {
        await copyProgramsFromEpgChannel(refusal.streamId, choice.id, choice.source_id);
      } catch (e) {
        console.warn('[EPG Editor] Could not copy programs immediately:', e);
      }

      setAutomatchRefusals(prev => prev.filter(r => r.streamId !== refusal.streamId));

      // If the row is the channel the modal has open, reflect the choice in the
      // Channel tab instead of leaving stale fields behind.
      if (channel && channel.stream_id === refusal.streamId) {
        setTvgId(choice.id);
        setOriginalTvgId(choice.id);
        setPinnedFeed(pin);
        if (choice.icon_url) setLogoUrl(choice.icon_url);
        setChannelSaved(true);
        setTimeout(() => setChannelSaved(false), 2500);
      }
    } catch (e) {
      console.error('[EPG Editor] Could not apply the chosen match:', e);
    } finally {
      setResolvingRefusal(null);
    }
  }

  /** Drop a refusal without matching it — the user will come back to it later. */
  function dismissRefusal(streamId: string) {
    setAutomatchRefusals(prev => prev.filter(r => r.streamId !== streamId));
  }

  /**
   * If the Channel tab has this stream open, its id, feed and icon are the ones the
   * match wrote, so they have to go back to the pre-run values with it.
   */
  function restoreChannelTabFromPrior(streamId: string, prior: PriorOverrideSnapshot) {
    if (!channel || channel.stream_id !== streamId) return;
    setTvgId('');
    setOriginalTvgId('');
    setPinnedFeed(prior.feedSourceId ?? undefined);
    setLogoUrl(prior.streamIcon ?? rawChannel?.stream_icon ?? channel.stream_icon ?? '');
    setLogoBackground((prior.logoBackground as 'auto' | 'light' | 'dark') ?? 'auto');
    setLogoPadding((prior.logoPadding as 'default' | 'none') ?? 'default');
    setTimeshiftHours(String(prior.timeshiftHours ?? 0));
    setMatchByAlias(Boolean(prior.matchByAlias));
  }

  /**
   * Undo one match from the last run, straight from its results list.
   *
   * The run's snapshot is restored rather than the row simply being deleted, so a
   * logo background, padding or timeshift set on that channel earlier is not lost,
   * and the feed's copied guide is dropped so the rejected match stops showing.
   */
  async function handleUnmatchMatch(match: AutomatchMatch) {
    if (unmatchingId) return;
    setUnmatchingId(match.streamId);
    setUnmatchNotices(prev => {
      const next = { ...prev };
      delete next[match.streamId];
      return next;
    });

    try {
      const outcome = await unmatchAutomatchChannel(match.streamId, match.epgChannelId, match.prior);

      if (outcome === 'modified') {
        // Matched by hand after the run — that choice is newer than this row.
        setUnmatchNotices(prev => ({ ...prev, [match.streamId]: t('automatchUnmatchStale') }));
        return;
      }

      // `missing` means the row was already gone, which for the user is the same
      // outcome as a successful unmatch — so the row is retired either way.
      setAutomatchResults(prev => prev ? {
        ...prev,
        matched: Math.max(0, prev.matched - 1),
        unmatched: prev.unmatched + 1,
        details: prev.details.map(d => d.match?.streamId === match.streamId
          ? { ...d, match: { ...d.match, unmatched: true } }
          : d),
      } : prev);

      restoreChannelTabFromPrior(match.streamId, match.prior);
    } catch (e) {
      console.error('[EPG Editor] Could not unmatch channel:', e);
      setUnmatchNotices(prev => ({ ...prev, [match.streamId]: t('automatchUnmatchFailed') }));
    } finally {
      setUnmatchingId(null);
    }
  }

  /**
   * Undo every match of the last run in one pass.
   *
   * Same outcome per channel as the row-level Unmatch — newer hand-matches are left
   * alone — but the work is batched in the service so a run of thousands only
   * refreshes the library once.
   */
  async function handleUndoAllMatches() {
    if (undoingAll || !automatchResults) return;

    const targets = automatchResults.details
      .map(d => d.match)
      .filter((m): m is AutomatchMatch => m !== undefined && !m.unmatched);
    if (targets.length === 0) {
      setConfirmUndoAll(false);
      return;
    }

    setUndoingAll(true);
    setUndoAllError(null);
    try {
      const { undoneStreamIds, modifiedStreamIds } = await unmatchAutomatchChannels(
        targets.map(m => ({ streamId: m.streamId, epgChannelId: m.epgChannelId, prior: m.prior }))
      );
      const undone = new Set(undoneStreamIds);

      setAutomatchResults(prev => prev ? {
        ...prev,
        matched: Math.max(0, prev.matched - undoneStreamIds.length),
        unmatched: prev.unmatched + undoneStreamIds.length,
        details: prev.details.map(d => {
          const m = d.match;
          if (!m || m.unmatched || !undone.has(m.streamId)) return d;
          return { ...d, match: { ...m, unmatched: true } };
        }),
      } : prev);

      if (modifiedStreamIds.length > 0) {
        // The bulk pass leaves these alone, so the rows say why they stayed.
        setUnmatchNotices(prev => {
          const next = { ...prev };
          for (const id of modifiedStreamIds) next[id] = t('automatchUnmatchStale');
          return next;
        });
      }

      if (channel && undone.has(channel.stream_id)) {
        const target = targets.find(m => m.streamId === channel.stream_id);
        if (target) restoreChannelTabFromPrior(target.streamId, target.prior);
      }
    } catch (e) {
      console.error('[EPG Editor] Could not undo all matches:', e);
      setUndoAllError(t('automatchUndoAllFailed'));
    } finally {
      setUndoingAll(false);
      setConfirmUndoAll(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // The list tab says where its channels came from when the caller passed a set
  // (a category), rather than "All Channels" for an entire source.
  const listTabLabel = channelList ? (channelListName || t('allChannelsTab')) : t('allChannelsTab');

  /**
   * The list tab is for callers that asked for a list (the guide's current
   * category). Opened on one channel — right-click → EPG Editor — an "All
   * Channels" list of the whole source has nothing to do with the channel in
   * front of the user, and a stray click on one of its rows silently swaps the
   * modal over to a different channel, discarding whatever was unsaved. So it is
   * only offered when the caller supplied the list.
   */
  const showListTab = Boolean(channelList) || !channel;

  const filteredSourceChannels = sourceChannels.filter(ch =>
    !sourceFilter || ch.name.toLowerCase().includes(sourceFilter.toLowerCase())
  );

  /** Matches from the last run that are still applied — what "Undo all" takes back. */
  const automatchUndoCount = automatchResults
    ? automatchResults.details.reduce((n, d) => (d.match && !d.match.unmatched ? n + 1 : n), 0)
    : 0;

  const tabs: { key: EditorTab; label: string }[] = channel
    ? [
        { key: 'channel',  label: `📡 ${t('channelTab')}` },
        { key: 'programs', label: `📋 ${t('programsTab')}` },
        { key: 'search',   label: `🔍 ${t('epgSearchTab')}` },
        ...(showListTab ? [{ key: 'source' as const, label: `📺 ${listTabLabel}` }] : []),
        { key: 'automatch', label: `🤖 ${t('automatchTab')}` },
      ]
    : [
        { key: 'source',   label: `📺 ${listTabLabel}` },
        { key: 'search',   label: `🔍 ${t('epgSearchTab')}` },
        { key: 'automatch', label: `🤖 ${t('automatchTab')}` },
      ];

  const title = channel
    ? channel.name
    : sourceName ?? t('editorTitle');

  return createPortal(
    <div className="epg-editor-overlay" ref={overlayRef}>
      <div className="epg-editor-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="epg-editor-header">
          <span style={{ fontSize: '1.2rem' }}>✏️</span>
          <div className="epg-editor-title">
            EPG Editor — <span>{title}</span>
          </div>
          <button className="epg-editor-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div className="epg-editor-tabs">
          {tabs.map(t => (
            <button
              key={t.key}
              className={`epg-editor-tab${activeTab === t.key ? ' active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="epg-editor-body">

          {/* ═══ CHANNEL TAB ═══ */}
          {activeTab === 'channel' && channel && (
            <div>
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('tvgIdLabel')}</label>
                <input
                  className="epg-editor-input"
                  value={tvgId}
                  onChange={e => setTvgId(e.target.value)}
                  placeholder={t('tvgIdPlaceholder')}
                />
                <div className="epg-editor-hint">
                  {t('tvgIdHint')}
                </div>
                {pinnedFeed && tvgId.trim() === originalTvgId.trim() && (
                  <div className="epg-editor-hint epg-editor-pinned-feed">
                    {t('pinnedFeedHint', {
                      name: sourceNameMap.get(pinnedFeed) || pinnedFeed,
                    })}
                  </div>
                )}
              </div>

              {/*
                Which name EPG matching uses, with both names always visible and
                the channel's own name editable in place — a provider name that
                can't match a feed no longer means leaving the editor to rename
                the channel first. Gated on the raw row being loaded so the tab
                can't briefly claim there is no rename.
              */}
              {rawChannel && (
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('matchNameLabel')}</label>

                {/* A grid, so the tag column sizes itself to the longest label
                    in any language and both rows stay aligned. */}
                <div className="epg-editor-match-names">
                  <span className="epg-editor-match-name-tag">📺 {t('matchNameProvider')}</span>
                  <span className="epg-editor-match-name-value" title={providerName}>
                    {providerName}
                  </span>
                  <span className="epg-editor-match-name-tag">✏️ {t('matchNameAlias')}</span>
                  <div className="epg-editor-match-name-control">
                    <input
                      className="epg-editor-input epg-editor-match-name-input"
                      value={matchNameDraft}
                      onChange={e => handleMatchNameChange(e.target.value)}
                      placeholder={t('matchNameCustomPlaceholder', { provider: providerName })}
                    />
                    <button
                      type="button"
                      className="epg-editor-match-name-reset"
                      onClick={handleResetMatchName}
                      disabled={!customMatchName && !matchByAlias}
                      title={t('matchNameResetToProvider')}
                    >
                      ↺ {t('matchNameResetToProvider')}
                    </button>
                  </div>
                </div>

                {/* Only meaningful once there are two names to choose between. */}
                {customMatchName && (
                  <div className="card-segmented-control" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className={`segmented-btn ${!matchByAlias ? 'active' : ''}`}
                      onClick={() => setMatchByAlias(false)}
                      title={t('matchNameProviderTitle')}
                    >
                      📺 {t('matchNameProvider')}
                    </button>
                    <button
                      type="button"
                      className={`segmented-btn ${matchByAlias ? 'active' : ''}`}
                      onClick={() => setMatchByAlias(true)}
                      title={t('matchNameAliasTitle')}
                    >
                      ✏️ {t('matchNameAlias')}
                    </button>
                  </div>
                )}

                <div className="epg-editor-hint">
                  {customMatchName
                    ? (matchByAlias
                        ? t('matchNameAliasHint', {
                            name: customMatchName,
                            provider: providerName,
                          })
                        : t('matchNameProviderHint', {
                            name: customMatchName,
                            provider: providerName,
                          }))
                    : t('matchNameNoCustomName', { provider: providerName })}
                </div>
              </div>
              )}

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('logoUrlLabel')}</label>
                <div className="epg-editor-logo-row">
                  <input
                    className="epg-editor-input"
                    value={logoUrl}
                    onChange={e => setLogoUrl(e.target.value)}
                    placeholder={t('logoUrlPlaceholder')}
                  />
                  <div className="epg-editor-logo-preview-wrapper">
                    <ChannelLogo
                      src={logoUrl || undefined}
                      name={channel?.name || ''}
                      background={logoBackground}
                      defaultBackground={channel?.source_id ? sourceLogoBackgroundOverrides[channel.source_id] : undefined}
                      padding={logoPadding}
                      shape={logoShape}
                      lazy={false}
                    />
                  </div>
                </div>
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('logoBackgroundLabel')}</label>
                <div className="card-segmented-control" style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className={`segmented-btn ${logoBackground === 'auto' ? 'active' : ''}`}
                    onClick={() => setLogoBackground('auto')}
                    title={t('defaultBgTitle')}
                  >
                    ✨ {t('defaultBg')}
                    {resolvedDefaultBg !== 'auto' ? ` (${t(resolvedDefaultBg === 'light' ? 'lightBg' : 'darkBg')})` : ''}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${logoBackground === 'light' ? 'active' : ''}`}
                    onClick={() => setLogoBackground('light')}
                    title={t('lightBgTitle')}
                  >
                    ☀️ {t('lightBg')}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${logoBackground === 'dark' ? 'active' : ''}`}
                    onClick={() => setLogoBackground('dark')}
                    title={t('darkBgTitle')}
                  >
                    🌙 {t('darkBg')}
                  </button>
                </div>
                <div className="epg-editor-hint">
                  {t('logoBgHint')}
                </div>
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('logoPaddingLabel')}</label>
                <div className="card-segmented-control card-padding-control" style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className={`segmented-btn ${logoPadding === 'default' ? 'active' : ''}`}
                    onClick={() => setLogoPadding('default')}
                    title={t('normalPaddingTitle')}
                  >
                    📐 {t('normalPadding')}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${logoPadding === 'none' ? 'active' : ''}`}
                    onClick={() => setLogoPadding('none')}
                    title={t('noPadTitle')}
                  >
                    🖼️ {t('noPad')}
                  </button>
                </div>
                <div className="epg-editor-hint">
                  {t('logoPaddingHint')}
                </div>
              </div>

              {(() => {
                const playlistIcon = rawChannel?.stream_icon || channel.stream_icon;
                if (!playlistIcon && !epgLogoUrl) return null;
                return (
                  <div className="epg-editor-field" style={{ marginTop: -8, marginBottom: 16 }}>
                    <label className="epg-editor-label" style={{ fontSize: '0.75rem', opacity: 0.6 }}>{t('quickSelectLogo')}</label>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 4 }}>
                      {playlistIcon && (
                        <button
                          type="button"
                          onClick={() => setLogoUrl(playlistIcon)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            background: logoUrl === playlistIcon ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
                            border: logoUrl === playlistIcon ? '1px solid rgba(0,212,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            padding: '4px 8px',
                            cursor: 'pointer',
                            color: '#fff',
                            fontSize: '0.75rem',
                            outline: 'none',
                          }}
                        >
                          <img src={playlistIcon} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
                          <span>{t('playlistLogo')}</span>
                        </button>
                      )}
                      {epgLogoUrl && (
                        <button
                          type="button"
                          onClick={() => setLogoUrl(epgLogoUrl)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            background: logoUrl === epgLogoUrl ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
                            border: logoUrl === epgLogoUrl ? '1px solid rgba(0,212,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            padding: '4px 8px',
                            cursor: 'pointer',
                            color: '#fff',
                            fontSize: '0.75rem',
                            outline: 'none',
                          }}
                        >
                          <img src={epgLogoUrl} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
                          <span>{t('epgLogo')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('timeOffsetLabel')}</label>
                <div className="epg-editor-timeshift-row">
                  <input
                    type="number"
                    step="0.5"
                    min="-24"
                    max="24"
                    className="epg-editor-timeshift-input"
                    value={timeshiftHours}
                    onChange={e => setTimeshiftHours(e.target.value)}
                  />
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #888)' }}>
                    {t('timeOffsetHint')}
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 24, padding: 14, background: 'rgba(255,50,50,0.05)', border: '1px solid rgba(255,50,50,0.2)', borderRadius: 8 }}>
                <div style={{ fontSize: '0.85rem', color: '#ffaaaa', marginBottom: 8 }}>
                  <strong>{t('resetChannel')}</strong><br/>
                  {t('resetChannelDesc')}
                </div>
                <button
                  className="epg-editor-btn"
                  style={{ background: 'rgba(255,50,50,0.15)', color: '#ffaaaa', border: '1px solid rgba(255,50,50,0.3)', padding: '6px 12px' }}
                  onClick={handleResetToDefault}
                >
                  ↻ {t('resetToDefault')}
                </button>
              </div>
            </div>
          )}

          {/* ═══ PROGRAMS TAB ═══ */}
          {activeTab === 'programs' && channel && (
            <div>
              <div className="epg-editor-programs-toolbar">
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #888)' }}>
                  {t('showingProgramsRange')} <strong>{channel.name}</strong>
                </span>
                <button
                  className="epg-editor-btn epg-editor-btn-primary"
                  style={{ padding: '7px 14px', fontSize: '0.82rem' }}
                  onClick={() => setShowAddForm(v => !v)}
                >
                  {showAddForm ? `✕ ${i18n.t('common:cancel')}` : `+ ${t('addProgram')}`}
                </button>
              </div>

              {(pinnedFeed || pinnedInPlaylist > 0) && (
                <div className="epg-editor-feed-pin-bar">
                  {pinnedFeed && (
                    <span className="epg-editor-feed-pin-chip">
                      <span className="epg-editor-feed-pin-dot" aria-hidden="true" />
                      {t('pinnedFeedHint', {
                        name: sourceNameMap.get(pinnedFeed) || pinnedFeed,
                      })}
                      <button
                        className="epg-editor-btn"
                        style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                        onClick={async () => {
                          if (!channel) return;
                          await releaseChannelFeedPin(channel.stream_id);
                          setPinnedFeed(undefined);
                          setPinnedInPlaylist(await countFeedPinsInSource(channel.source_id));
                        }}
                      >
                        {t('releaseFeedPin')}
                      </button>
                    </span>
                  )}
                  {pinnedInPlaylist > 0 && channel && (
                    <span className="epg-editor-feed-pin-playlist">
                      {t('feedPinsInPlaylist')} <strong>{pinnedInPlaylist}</strong>
                      <button
                        className={`epg-editor-btn${confirmReleaseAll ? ' epg-editor-btn-primary' : ''}`}
                        style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                        onClick={async () => {
                          if (!confirmReleaseAll) {
                            setConfirmReleaseAll(true);
                            return;
                          }
                          setConfirmReleaseAll(false);
                          await releaseFeedPinsInSource(channel.source_id);
                          setPinnedInPlaylist(0);
                          setPinnedFeed(undefined);
                        }}
                      >
                        {confirmReleaseAll ? t('confirmReleaseAllFeedPins') : t('releaseAllFeedPins')}
                      </button>
                    </span>
                  )}
                </div>
              )}

              {showAddForm && (
                <div style={{
                  padding: 14, marginBottom: 14,
                  border: '1px solid rgba(0,212,255,0.25)',
                  borderRadius: 10,
                  background: 'rgba(0,212,255,0.04)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">{t('titleRequired')}</label>
                      <input className="epg-editor-input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder={t('programTitlePlaceholder')} />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">{t('subtitle')}</label>
                      <input className="epg-editor-input" value={newSubtitle} onChange={e => setNewSubtitle(e.target.value)} placeholder={t('optionalSubtitle')} />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">{t('description')}</label>
                      <textarea className="epg-editor-textarea" value={newDesc} rows={2} onChange={e => setNewDesc(e.target.value)} placeholder={t('optionalDescription')} />
                    </div>
                    <div>
                      <label className="epg-editor-label">{t('startRequired')}</label>
                      <input type="datetime-local" className="epg-editor-input" value={newStart} onChange={e => setNewStart(e.target.value)} />
                    </div>
                    <div>
                      <label className="epg-editor-label">{t('endRequired')}</label>
                      <input type="datetime-local" className="epg-editor-input" value={newEnd} onChange={e => setNewEnd(e.target.value)} />
                    </div>
                    <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        className="epg-editor-btn epg-editor-btn-primary"
                        onClick={handleAddCustomProgram}
                        disabled={!newTitle.trim() || !newStart || !newEnd}
                      >
                        ✓ {t('addProgram')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {programsLoading ? (
                <div className="epg-editor-loading">{t('loadingPrograms')}</div>
              ) : programs.length === 0 ? (
                <div className="epg-editor-empty">
                  {t('noProgramsRange')}<br />
                  <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{t('syncSourceHint')}</span>
                </div>
              ) : (
                <div className="epg-programs-list">
                  {programs.map(prog => (
                    <ProgramRow
                      key={prog.id}
                      prog={prog}
                      onSave={changes => handleProgramSave(prog, changes)}
                      onDelete={() => handleProgramDelete(prog)}
                      onRestore={() => handleProgramRestore(prog)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ═══ EPG SEARCH TAB ═══ */}
          {activeTab === 'search' && (
            <div>
              <div style={{ marginBottom: 10, fontSize: '0.82rem', color: 'var(--text-secondary, #888)' }}>
                {searchMode === 'epg'
                  ? <>{t('searchEpgHint1')} <strong>{t('apply')}</strong> {t('toLinkIt')}{' '}</>
                  : <>{t('searchEpgHint2')} <strong>{t('apply')}</strong> {t('toLinkIt')}{' '}</>
                }
                <strong>{channel?.name ?? t('theSelectedChannel')}</strong>.
                {searchMode === 'epg' && (
                  <span style={{ display: 'block', marginTop: 4, fontSize: '0.78rem', color: 'var(--text-secondary, #888)', opacity: 0.8 }}>
                    {t('searchEpgHintExtra')}
                  </span>
                )}
              </div>
              <div className="epg-search-toolbar">
                <div className="epg-search-input-wrap">
                  <span className="epg-search-icon">🔍</span>
                  <input
                    className="epg-editor-input"
                    placeholder={t('searchPlaceholder')}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="epg-search-scope-toggle">
                  <button
                    className={`epg-search-scope-btn${searchScope === 'source' ? ' active' : ''}`}
                    onClick={() => setSearchScope('source')}
                  >{t('thisSource')}</button>
                  <button
                    className={`epg-search-scope-btn${searchScope === 'all' ? ' active' : ''}`}
                    onClick={() => setSearchScope('all')}
                  >{t('allSources')}</button>
                </div>
                <div className="epg-search-scope-toggle">
                  <button
                    className={`epg-search-scope-btn${searchMode === 'm3u' ? ' active' : ''}`}
                    onClick={() => setSearchMode('m3u')}
                    title={t('searchM3uTitle')}
                  >{t('m3uNames')}</button>
                  <button
                    className={`epg-search-scope-btn${searchMode === 'epg' ? ' active' : ''}`}
                    onClick={() => setSearchMode('epg')}
                    title={t('searchEpgNamesTitle')}
                  >{t('epgNames')}</button>
                </div>
                {channel && (
                  <button
                    className="epg-search-auto-btn"
                    onClick={handleAutoSuggest}
                    disabled={autoSearching}
                    title={t('scoreAllTitle')}
                  >
                    {autoSearching ? '…' : `✨ ${t('autoMatch')}`}
                  </button>
                )}
              </div>

              {!channel && (
                <div style={{
                  padding: '10px 14px', borderRadius: 8, marginBottom: 12,
                  background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.2)',
                  fontSize: '0.82rem', color: '#ffaa44',
                }}>
                  {t('openChannelFirst')}
                </div>
              )}

              {searchLoading && <div className="epg-editor-loading">{t('searching')}</div>}

              {!searchLoading && searchQuery && searchResults.length === 0 && (
                <div className="epg-editor-empty">{t('noEpgMatched', { query: searchQuery })}</div>
              )}

              {!searchLoading && searchResults.length > 0 && (
                <div className="epg-search-results">
                  {searchResults.map((r, i) => {
                    const isPreviewOpen = previewResult?.id === r.id && previewResult?.source_id === r.source_id;
                    return (
                      <div key={r.id + r.source_id}>
                        <div
                          className={`epg-search-result-row${i === 0 && r.score > 0.5 ? ' best-match' : ''}${isPreviewOpen ? ' selected-preview' : ''}`}
                          onClick={() => setPreviewResult(isPreviewOpen ? null : r)}
                          style={{ cursor: 'pointer' }}
                        >
                          {r.icon_url ? (
                            <img src={r.icon_url} alt="" className="epg-search-result-icon"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          ) : (
                            <div className="epg-search-result-placeholder">📡</div>
                          )}
                          <div className="epg-search-result-info">
                            <div className="epg-search-result-name">{r.display_name}</div>
                            <div className="epg-search-result-id">{r.id}</div>
                            {searchScope === 'all' && (
                              <div className="epg-search-result-source">{t('sourceLabel2', { name: sourceNameMap.get(r.source_id) ?? r.source_id })}</div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap' }}>
                              {isPreviewOpen ? `▲ ${t('hide')}` : `▼ ${t('programs')}`}
                            </span>
                            <div className="epg-score-bar" title={t('matchScore', { score: (r.score * 100).toFixed(0) })}>
                              <div className="epg-score-pip" style={{ width: `${Math.min(100, r.score / 1.2 * 100)}%` }} />
                            </div>
                            {channel && (
                              <button
                                className="epg-search-apply-btn"
                                disabled={applyingId === r.id}
                                onClick={e => { e.stopPropagation(); handleApplyMatch(r); }}
                              >
                                {applyingId === r.id ? '…' : t('apply')}
                              </button>
                            )}
                          </div>
                        </div>
                        
                        {/* Inline program preview panel for THIS search result */}
                        {isPreviewOpen && (
                          <div style={{
                            margin: '4px 0 10px 0', border: '1px solid rgba(0,212,255,0.2)',
                            borderRadius: 6, overflow: 'hidden',
                            background: 'rgba(0,0,0,0.2)',
                          }}>
                            <div style={{
                              padding: '6px 14px', background: 'rgba(0,212,255,0.07)',
                              fontSize: '0.8rem', color: '#fff'
                            }}>
                              {t('programsFor')} <strong>{r.display_name}</strong>
                            </div>
                            {previewLoading ? (
                              <div className="epg-editor-loading" style={{ margin: '10px 0' }}>{t('loadingPrograms')}</div>
                            ) : previewPrograms.length === 0 ? (
                              <div className="epg-editor-empty" style={{ padding: '12px 14px' }}>
                                {t('noProgramsFound')}
                              </div>
                            ) : (
                              <div style={{ maxHeight: 200, overflowY: 'auto', padding: '4px 0' }}>
                                {previewPrograms.map(p => (
                                  <div key={p.id} style={{
                                    display: 'flex', gap: 12, padding: '4px 14px',
                                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                                    fontSize: '0.81rem',
                                  }}>
                                    <span style={{ color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                      {formatShortDatetime(p.start, epgClockFormat)}
                                    </span>
                                    <span style={{ color: '#fff' }}>{p.title}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!searchQuery && !searchLoading && (
                <div className="epg-editor-empty">
                  {t('typeToSearch')} <strong>✨ {t('autoMatch')}</strong> {t('toFindBestMatch')} <strong>{channel?.name ?? t('yourChannel')}</strong>.
                </div>
              )}
            </div>
          )}

          {/* ═══ SOURCE / ALL CHANNELS TAB ═══ */}
          {activeTab === 'source' && (
            <div>
              <div className="epg-source-filter">
                <input
                  className="epg-editor-input"
                  placeholder={t('filterChannels', {
                    source: channelList ? `${channelListName ?? ''} ` : (resolvedSourceId ? `${sourceName ?? ''} ` : ''),
                  })}
                  value={sourceFilter}
                  onChange={e => setSourceFilter(e.target.value)}
                />
              </div>
              {sourceLoading ? (
                <div className="epg-editor-loading">{t('loadingChannels')}</div>
              ) : filteredSourceChannels.length === 0 ? (
                <div className="epg-editor-empty">{t('noChannelsFound')}</div>
              ) : (
                <div className="epg-source-channel-list">
                  {filteredSourceChannels.map(ch => (
                    <div
                      key={ch.stream_id}
                      className="epg-source-channel-row"
                      onClick={() => handleOpenSourceChannel(ch)}
                      title={t('clickToEdit')}
                    >
                      {ch.stream_icon ? (
                        <img 
                          key={ch.stream_icon}
                          src={ch.stream_icon} 
                          alt="" 
                          className="epg-source-channel-icon"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} 
                        />
                      ) : (
                        <div style={{ width: 32, height: 32, borderRadius: 6, background: 'var(--bg-tertiary, rgba(255,255,255,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>📡</div>
                      )}
                      <div className="epg-source-channel-name">{ch.name}</div>
                      <div className="epg-source-channel-tvgid">{ch.epg_channel_id || '—'}</div>
                      {overriddenIds.has(ch.stream_id) && (
                        <div className="epg-override-dot" title={t('hasOverrides')} />
                      )}
                      <span style={{ color: 'var(--text-secondary,#666)', fontSize: '0.85rem' }}>›</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ═══ AUTOMATCH MISSING TAB ═══ */}
          {activeTab === 'automatch' && (
            <div>
              <div style={{ marginBottom: 16, fontSize: '0.82rem', color: 'var(--text-secondary, #888)' }}>
                {t('automatchHint')}
              </div>

              {/* Source selection */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('sourceLabel')}</label>
                <select
                  className="epg-editor-input"
                  value={automatchSourceId}
                  onChange={e => setAutomatchSourceId(e.target.value)}
                  disabled={automatchScope === 'all' || automatchRunning}
                  style={{ cursor: 'pointer' }}
                >
                  {automatchSources.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Scope toggle */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('scope')}</label>
                <div className="epg-search-scope-toggle">
                  <button
                    className={`epg-search-scope-btn${automatchScope === 'source' ? ' active' : ''}`}
                    onClick={() => setAutomatchScope('source')}
                    disabled={automatchRunning}
                  >{t('thisSource')}</button>
                  <button
                    className={`epg-search-scope-btn${automatchScope === 'all' ? ' active' : ''}`}
                    onClick={() => setAutomatchScope('all')}
                    disabled={automatchRunning}
                  >{t('allSources')}</button>
                </div>
              </div>

              {/* Search mode toggle */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('matchAgainst')}</label>
                <div className="epg-search-scope-toggle">
                  <button
                    className={`epg-search-scope-btn${automatchMode === 'm3u' ? ' active' : ''}`}
                    onClick={() => setAutomatchMode('m3u')}
                    disabled={automatchRunning}
                    title={t('searchM3uTitle')}
                  >{t('m3uNames')}</button>
                  <button
                    className={`epg-search-scope-btn${automatchMode === 'epg' ? ' active' : ''}`}
                    onClick={() => setAutomatchMode('epg')}
                    disabled={automatchRunning}
                    title={t('searchEpgNamesTitle')}
                  >{t('epgNames')}</button>
                </div>
              </div>

              {/* Category selection */}
              {automatchScope === 'source' && sourceCategories.length > 0 && (
                <div className="epg-editor-field">
                  <label className="epg-editor-label">{t('categories')}</label>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary, #e0e0e0)' }}>
                      <input
                        type="checkbox"
                        checked={automatchAllCategories}
                        onChange={e => setAutomatchAllCategories(e.target.checked)}
                        disabled={automatchRunning}
                      />
                      {t('allCategoriesInSource')}
                    </label>
                  </div>
                  {!automatchAllCategories && (
                    <div className="epg-automatch-category-grid">
                      {sourceCategories.map(cat => (
                        <label key={cat.category_id} className="epg-automatch-category-item">
                          <input
                            type="checkbox"
                            checked={automatchCategories.includes(cat.category_id)}
                            onChange={e => {
                              if (e.target.checked) {
                                setAutomatchCategories(prev => [...prev, cat.category_id]);
                              } else {
                                setAutomatchCategories(prev => prev.filter(id => id !== cat.category_id));
                              }
                            }}
                            disabled={automatchRunning}
                          />
                          <span>{cat.category_name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Enabled-only scope */}
              <div className="epg-editor-field">
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: automatchRunning ? 'default' : 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={enabledOnly}
                    onChange={e => setEpgAutomatchEnabledOnly(e.target.checked)}
                    disabled={automatchRunning}
                  />
                  <span className="epg-editor-label" style={{ margin: 0 }}>{t('enabledOnlyLabel')}</span>
                </label>
                <div className="epg-editor-hint">
                  {t('enabledOnlyHint')}
                </div>
              </div>

              {/* Threshold slider */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">
                  {t('minMatchThreshold')} <strong>{automatchThreshold}%</strong>
                </label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={automatchThreshold}
                  onChange={e => setAutomatchThreshold(Number(e.target.value))}
                  disabled={automatchRunning}
                  className="epg-automatch-slider"
                />
                <div className="epg-editor-hint">
                  {t('thresholdHint')}
                </div>
              </div>

              {/* Opt-in decorated-name handling */}
              <div className="epg-editor-field">
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: automatchRunning ? 'default' : 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={epgAutomatchCleanNames}
                    onChange={e => setEpgAutomatchCleanNames(e.target.checked)}
                    disabled={automatchRunning}
                  />
                  <span className="epg-editor-label" style={{ margin: 0 }}>{t('cleanNamesLabel')}</span>
                </label>
                <div className="epg-editor-hint">
                  {t('cleanNamesHint')}
                </div>
                {epgAutomatchCleanNames && (
                  <>
                    <label className="epg-editor-label" style={{ marginTop: 10 }}>
                      {t('stripTagsLabel')}
                    </label>
                    <input
                      className="epg-editor-input"
                      value={stripTagsInput}
                      onChange={e => {
                        setStripTagsInput(e.target.value);
                        setEpgAutomatchStripTags(parseStripTags(e.target.value));
                      }}
                      placeholder={t('stripTagsPlaceholder')}
                      disabled={automatchRunning}
                    />
                    <div className="epg-editor-hint">
                      {t('stripTagsHint')}
                    </div>
                  </>
                )}
              </div>

              {/* Action button */}
              <div style={{ marginTop: 20, marginBottom: 16 }}>
                <button
                  className="epg-editor-btn epg-editor-btn-primary"
                  onClick={handleAutoMatchMissing}
                  disabled={automatchRunning || (automatchScope === 'source' && !automatchSourceId) || (!automatchAllCategories && automatchCategories.length === 0)}
                  style={{ width: '100%', padding: '12px 22px', fontSize: '0.95rem' }}
                >
                  {automatchRunning && automatchProgress
                    ? t('matchingProgress', { matched: automatchProgress.matched, total: automatchProgress.total })
                    : `🤖 ${t('automatchMissingBtn')}`}
                </button>
              </div>

              {/* Progress bar */}
              {automatchRunning && automatchProgress && automatchProgress.total > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{
                    height: 6,
                    background: 'var(--bg-tertiary, rgba(255,255,255,0.05))',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${(automatchProgress.matched / automatchProgress.total) * 100}%`,
                      background: 'var(--accent-primary, #00d4ff)',
                      borderRadius: 3,
                      transition: 'width 0.2s ease-out',
                    }} />
                  </div>
                  <div style={{ textAlign: 'center', marginTop: 6, fontSize: '0.8rem', color: 'var(--text-secondary, #888)' }}>
                    {t('channelsProcessed', { matched: automatchProgress.matched, total: automatchProgress.total })}
                  </div>
                </div>
              )}

              {/* Results */}
              {automatchResults && (
                <div style={{
                  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                  borderRadius: 10,
                  background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '10px 14px',
                    background: 'rgba(255,255,255,0.03)',
                    borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.07))',
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 16,
                    fontSize: '0.82rem',
                  }}>
                    <span style={{ color: '#4caf50' }}><strong>{automatchResults.matched}</strong> {t('matched')}</span>
                    <span style={{ color: 'var(--text-secondary, #888)' }}><strong>{automatchResults.skipped}</strong> {t('skipped')}</span>
                    {automatchResults.errors > 0 && (
                      <span style={{ color: '#ff6b6b' }}><strong>{automatchResults.errors}</strong> {t('errors')}</span>
                    )}
                    {automatchResults.cleaned > 0 && (
                      <span style={{ color: '#4caf50' }} title={t('automatchViaCleaned')}>
                        <strong>{automatchResults.cleaned}</strong> {t('automatchViaCleaned')}
                      </span>
                    )}
                    {automatchResults.ambiguous > 0 && (
                      <span style={{ color: '#ffaa44' }} title={t('automatchAmbiguousHint')}>
                        <strong>{automatchResults.ambiguous}</strong> {t('ambiguous')}
                      </span>
                    )}
                    {automatchResults.filtered > 0 && (
                      <span style={{ color: 'var(--text-secondary, #888)' }} title={t('enabledOnlyHint')}>
                        <strong>{automatchResults.filtered.toLocaleString()}</strong> {t('enabledOnlyFiltered')}
                      </span>
                    )}
                    {automatchResults.unmatched > 0 && (
                      <span style={{ color: 'var(--text-secondary, #888)' }}>
                        <strong>{automatchResults.unmatched}</strong> {t('automatchUnmatched')}
                      </span>
                    )}
                    {automatchUndoCount > 0 && (
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {confirmUndoAll ? (
                          <>
                            <button
                              className="epg-automatch-unmatch epg-automatch-undo-all"
                              onClick={() => setConfirmUndoAll(false)}
                              disabled={undoingAll}
                            >
                              {i18n.t('common:cancel')}
                            </button>
                            <button
                              className="epg-automatch-unmatch epg-automatch-undo-all epg-automatch-undo-all-confirm"
                              onClick={handleUndoAllMatches}
                              disabled={undoingAll}
                            >
                              {undoingAll ? '…' : t('automatchUndoAllConfirm', { count: automatchUndoCount })}
                            </button>
                          </>
                        ) : (
                          <button
                            className="epg-automatch-unmatch epg-automatch-undo-all"
                            onClick={() => setConfirmUndoAll(true)}
                            disabled={unmatchingId !== null || undoingAll}
                            title={t('automatchUndoAllHint')}
                          >
                            {t('automatchUndoAll')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {undoAllError && (
                    <div className="epg-automatch-undo-error">{undoAllError}</div>
                  )}
                  {/*
                    A run touches up to every channel in scope and logs a line per
                    channel, so this list is virtualized — mounting tens of
                    thousands of rows is what would make the modal stutter after a
                    big run. Rows wrap, so heights are measured rather than assumed.
                  */}
                  <div
                    ref={automatchListRef}
                    style={{ maxHeight: 280, overflowY: 'auto', padding: '6px 0' }}
                  >
                    <VirtualList
                      scrollRef={automatchListRef}
                      items={automatchResults.details}
                      estimateItemHeight={26}
                      overscan={10}
                      getKey={(_, index) => index}
                      renderItem={(detail) => {
                        const match = detail.match;
                        const busy = match ? unmatchingId === match.streamId : false;
                        const notice = match ? unmatchNotices[match.streamId] : undefined;
                        return (
                          <div className="epg-automatch-detail">
                            <span
                              className="epg-automatch-detail-text"
                              style={{
                                color: detail.text.startsWith('✓') ? '#4caf50'
                                  : detail.text.startsWith('⚠') ? '#ffaa44'
                                  : 'var(--text-secondary, #888)',
                              }}
                            >
                              {detail.text}
                            </span>
                            {match && !match.unmatched && (
                              <button
                                className="epg-automatch-unmatch"
                                onClick={() => handleUnmatchMatch(match)}
                                disabled={unmatchingId !== null || undoingAll}
                                title={t('automatchUnmatchHint')}
                              >
                                {busy ? '…' : t('automatchUnmatch')}
                              </button>
                            )}
                            {match?.unmatched && (
                              <span className="epg-automatch-unmatched">{t('automatchUnmatched')}</span>
                            )}
                            {notice && <span className="epg-automatch-notice">{notice}</span>}
                          </div>
                        );
                      }}
                    />
                  </div>
                </div>
              )}

              {/*
                Ambiguity worklist. Every channel the run refused to guess at is
                a row you can settle here: pick the feed channel that should
                supply the guide, or dismiss the row for later.
              */}
              {automatchRefusals.length > 0 && (
                <div className="epg-refusal-panel">
                  <div className="epg-refusal-header">
                    <span className="epg-refusal-title">
                      {t('ambiguousWorklistTitle', { count: automatchRefusals.length })}
                    </span>
                    <button
                      className="epg-refusal-dismiss-all"
                      onClick={() => setAutomatchRefusals([])}
                      disabled={resolvingRefusal !== null}
                    >
                      {t('ambiguousDismissAll')}
                    </button>
                  </div>
                  <div className="epg-editor-hint" style={{ marginBottom: 8 }}>
                    {t('ambiguousWorklistHint')}
                  </div>
                  <div className="epg-refusal-list">
                    {automatchRefusals.map(refusal => {
                      const busy = resolvingRefusal === refusal.streamId;
                      const hidden = refusal.totalChoices - refusal.choices.length;
                      return (
                        <div key={refusal.streamId} className="epg-refusal-row">
                          <div className="epg-refusal-row-head">
                            <span className="epg-refusal-channel" title={refusal.channelName}>
                              {refusal.channelName}
                            </span>
                            <span className="epg-refusal-cleaned">
                              {t('ambiguousCleanedAs', { name: refusal.cleanedName })}
                              {hidden > 0 ? ` +${hidden}` : ''}
                            </span>
                            <button
                              className="epg-refusal-dismiss"
                              onClick={() => dismissRefusal(refusal.streamId)}
                              title={t('ambiguousDismiss')}
                              aria-label={t('ambiguousDismiss')}
                              disabled={busy}
                            >
                              ✕
                            </button>
                          </div>
                          <div className="epg-refusal-choices">
                            {refusal.choices.map(choice => {
                              const feed = sourceNameMap.get(choice.source_id) || choice.source_id;
                              return (
                                <button
                                  key={`${choice.source_id}:${choice.id}`}
                                  className="epg-refusal-choice"
                                  onClick={() => handleResolveRefusal(refusal, choice)}
                                  disabled={busy}
                                  title={`${feed} — ${choice.display_name}`}
                                >
                                  <span className="epg-refusal-choice-name">
                                    {busy ? '…' : choice.display_name}
                                  </span>
                                  <span className="epg-refusal-choice-feed">{feed}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="epg-editor-footer">
          {channelSaved && (
            <div className="epg-editor-saved-notice">✓ {t('saved')}</div>
          )}
          <button className="epg-editor-btn epg-editor-btn-secondary" onClick={onClose}>{i18n.t('common:close')}</button>
          {activeTab === 'channel' && channel && (
            <button
              className="epg-editor-btn epg-editor-btn-primary"
              onClick={handleSaveChannel}
              disabled={channelSaving}
            >
              {channelSaving ? t('saving') : `💾 ${t('saveChannelOverride')}`}
            </button>
          )}
        </div>
      </div>

      {/* Reset Confirmation Modal Overlay */}
      {showResetConfirm && channel && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, borderRadius: 16
        }}>
          <div style={{
            background: 'var(--bg-elevated, #1a1a1a)',
            border: '1px solid rgba(255,50,50,0.3)',
            padding: 24, borderRadius: 12, maxWidth: 360, width: '100%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)'
          }}>
            <h3 style={{ margin: '0 0 12px 0', color: '#ff5555', fontSize: '1.2rem' }}>⚠ {t('resetChannel')}</h3>
            <p style={{ margin: '0 0 24px 0', fontSize: '0.9rem', color: '#ccc', lineHeight: 1.5 }}>
              {t('resetConfirm')} <strong>"{channel.name}"</strong>?
              <br/><br/>
              {t('resetConfirmDesc')}
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="epg-editor-btn"
                style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: 'none', padding: '8px 16px' }}
                onClick={() => setShowResetConfirm(false)}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                className="epg-editor-btn"
                style={{ background: 'rgba(255,50,50,0.15)', color: '#ffaaaa', border: '1px solid rgba(255,50,50,0.4)', padding: '8px 16px' }}
                onClick={executeResetToDefault}
              >
                {t('yesReset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
