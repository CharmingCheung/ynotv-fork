import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { db, type StoredChannel, updateChannelsBatch } from '../../db';
import { normalizeBoolean } from '../../utils/db-helpers';
import { logErrorAlways } from '../../utils/logger';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './ChannelManager.css';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { guardRowKeys } from '../../utils/dndRowKeys';

interface ChannelManagerProps {
    categoryId: string;
    categoryName: string;
    sourceId: string;
    onClose: () => void;
    onChange?: () => void;
    sortOrder?: 'alphabetical' | 'number' | 'provider';
}

const PencilIcon = ({ size = 14 }: { size?: number }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
);

const ResetIcon = ({ size = 14 }: { size?: number }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
        <path d="M3 2v6h6" />
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 8" />
    </svg>
);

function SortableChannelRow({ id, className, children, dropIndicator = null }: { id: string; className: string; children: React.ReactNode; dropIndicator?: 'above' | 'below' | null }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 99 : 1,
        touchAction: 'none',
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${className}${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
            {...attributes}
            {...guardRowKeys(listeners)}
        >
            {children}
        </div>
    );
}


export function ChannelManager({ categoryId, categoryName, sourceId, onClose, onChange, sortOrder = 'number' }: ChannelManagerProps) {
    useTranslation();
    const [channels, setChannels] = useState<StoredChannel[]>([]);
    const [isDirty, setIsDirty] = useState(false);
    // Separate from isDirty: only reordering should rewrite the manual order in
    // playlist_individual_channels. Toggling visibility or renaming must not
    // silently pin the whole category into a custom order. A ref, not state —
    // it is read inside the save handler and the load effect, and must survive
    // a live-query refresh without re-running that effect (which would undo the
    // pending reorder).
    const orderDirtyRef = useRef(false);
    const [hideDisabled, setHideDisabled] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterWords, setFilterWords] = useState<string[]>([]);
    const [newFilterWord, setNewFilterWord] = useState('');
    const [showFilterPanel, setShowFilterPanel] = useState(false);
    const isSavingRef = useRef(false);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
    const [aliasDraft, setAliasDraft] = useState('');
    // Guards against a commit firing twice (Enter blurs the input) or firing
    // after an Escape cancel. Holds the stream_id currently being edited.
    const aliasEditingRef = useRef<string | null>(null);
    // Channel ids whose alias the user changed here, mapped to the value to
    // write (null = clear the override). Only these are written on save, so
    // untouched channels are never rewritten.
    const aliasEditsRef = useRef<Map<string, string | null>>(new Map());



    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const targetPlaylistId = sourceId.startsWith('playlist:') ? sourceId.replace('playlist:', '') : sourceId;
    const isLink = categoryId.startsWith('link:');
    const linkId = isLink ? parseInt(categoryId.replace('link:', ''), 10) : null;

    // Load category link details if category is a link
    const categoryLink = useLiveQuery(
        () => linkId !== null ? db.playlistCategoryLinks.get(linkId) : Promise.resolve(null),
        [linkId]
    );

    // Resolve where the channels come from
    const targetSourceId = categoryLink ? categoryLink.source_id : (isLink ? null : targetPlaylistId);
    const targetCategoryId = categoryLink ? categoryLink.category_id : (isLink ? null : categoryId);
    const targetParentId = categoryId;

    // Load dynamic channels in the category
    const dynamicChannels = useLiveQuery(
        async () => {
            if (!targetSourceId || !targetCategoryId) return [];
            return db.channels.whereRaw(
                `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?)`,
                [targetSourceId, targetCategoryId]
            ).toArray();
        },
        [targetSourceId, targetCategoryId],
        []
    );

    // Load manual mappings from playlist_individual_channels
    const manualMappings = useLiveQuery(
        async () => {
            const current = await db.playlistIndividualChannels
                .whereRaw('playlist_id = ? AND parent_category_id = ?', [targetPlaylistId, targetParentId])
                .sortBy('display_order');
            
            if (current && current.length > 0) {
                return current;
            }

            if (isLink && categoryLink) {
                const targetPlaylist = categoryLink.source_id;
                const targetParent = categoryLink.category_id;
                return db.playlistIndividualChannels
                    .whereRaw('playlist_id = ? AND parent_category_id = ?', [targetPlaylist, targetParent])
                    .sortBy('display_order');
            }

            return [];
        },
        [targetPlaylistId, targetParentId, isLink, categoryLink],
        []
    );

    // Load manual channel metadata
    const manualChannels = useLiveQuery(
        async () => {
            if (!manualMappings || manualMappings.length === 0) return [];
            const ids = manualMappings.map(m => m.stream_id);
            const chans = await db.channels.where('stream_id').anyOf(ids).toArray();
            const channelMap = new Map(chans.map(ch => [ch.stream_id, ch]));
            return manualMappings
                .map(m => channelMap.get(m.stream_id))
                .filter((ch): ch is StoredChannel => ch !== undefined);
        },
        [manualMappings],
        []
    );

    // Load category data including filter words
    useEffect(() => {
        async function loadCategoryData() {
            if (isLink) return; // linked categories don't support filter words locally
            const category = await db.categories.get(categoryId);
            if (category?.filter_words) {
                setFilterWords(category.filter_words);
            }
        }
        loadCategoryData();
    }, [categoryId, isLink]);

    // Initialize channels from database (but not while saving)
    useEffect(() => {
        if (dynamicChannels && manualMappings && manualChannels && !isSavingRef.current) {
            // Wait for category link to resolve if it is a link category
            if (isLink && !categoryLink) return;

            const manualStreamIds = new Set(manualMappings.map(m => m.stream_id));
            const manualMap = new Map(manualMappings.map(m => [m.stream_id, m.display_order]));

            // Sort manual channels by display order in overlay table
            const orderedManual = manualChannels
                .filter(ch => manualStreamIds.has(ch.stream_id))
                .sort((a, b) => (manualMap.get(a.stream_id) ?? 0) - (manualMap.get(b.stream_id) ?? 0));

            // Sort dynamic channels using legacy fallback order
            const remainingDynamic = dynamicChannels.filter(ch => !manualStreamIds.has(ch.stream_id));
            remainingDynamic.sort((a, b) => {
                if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
                if (a.display_order != null) return -1;
                if (b.display_order != null) return 1;
                
                // Fall back to preferred sortOrder
                if (sortOrder === 'provider') {
                    const aOrder = a.provider_order;
                    const bOrder = b.provider_order;
                    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
                    if (aOrder !== undefined) return -1;
                    if (bOrder !== undefined) return 1;
                } else if (sortOrder === 'number') {
                    const numA = a.channel_num;
                    const numB = b.channel_num;
                    if (numA !== undefined && numB !== undefined) return numA - numB;
                    if (numA !== undefined) return -1;
                    if (numB !== undefined) return 1;
                }

                return (a.alias || a.name).localeCompare(b.alias || b.name);
            });

            // Re-apply any alias edits still pending a save: this effect also
            // runs when the live query refreshes, and dropping an unsaved
            // rename there would look like the edit silently reverted.
            const pendingAliasEdits = aliasEditsRef.current;
            const combined = [...orderedManual, ...remainingDynamic].map(ch => {
                const base = {
                    ...ch,
                    enabled: ch.enabled !== false,
                };
                return pendingAliasEdits.has(ch.stream_id)
                    ? { ...base, alias: pendingAliasEdits.get(ch.stream_id) ?? undefined }
                    : base;
            });

            setChannels(combined);
            // Keep Save enabled while an alias edit or a reorder is still pending.
            setIsDirty(aliasEditsRef.current.size > 0 || orderDirtyRef.current);
        }
    }, [dynamicChannels, manualMappings, manualChannels, categoryLink, isLink, sortOrder]);

    // Toggle enable/disable
    const toggleChannel = useCallback((channelId: string) => {
        setChannels(chs => chs.map(ch =>
            ch.stream_id === channelId ? { ...ch, enabled: !ch.enabled } : ch
        ));
        setIsDirty(true);
    }, []);

    // ── Inline alias editing ──
    const startAliasEdit = useCallback((ch: StoredChannel) => {
        aliasEditingRef.current = ch.stream_id;
        setEditingAliasId(ch.stream_id);
        setAliasDraft(ch.alias || ch.name);
    }, []);

    const cancelAliasEdit = useCallback(() => {
        aliasEditingRef.current = null;
        setEditingAliasId(null);
        setAliasDraft('');
    }, []);

    const applyAlias = useCallback((ch: StoredChannel, nextAlias: string | null) => {
        if ((ch.alias || null) === nextAlias) return;
        aliasEditsRef.current.set(ch.stream_id, nextAlias);
        setChannels(chs => chs.map(c => c.stream_id === ch.stream_id
            ? { ...c, alias: nextAlias ?? undefined }
            : c));
        setIsDirty(true);
    }, []);

    /** Commit the draft. An empty value — or one that merely repeats the
     *  provider name — clears the alias, restoring the source name. */
    const commitAliasEdit = useCallback((ch: StoredChannel) => {
        if (aliasEditingRef.current !== ch.stream_id) return;
        aliasEditingRef.current = null;
        const trimmed = aliasDraft.trim();
        setEditingAliasId(null);
        setAliasDraft('');
        applyAlias(ch, !trimmed || trimmed === ch.name ? null : trimmed);
    }, [aliasDraft, applyAlias]);

    /** Drop the alias entirely so the channel shows its source name again. */
    const resetAlias = useCallback((ch: StoredChannel) => {
        if (!ch.alias) return;
        applyAlias(ch, null);
    }, [applyAlias]);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    }, []);

    const handleDragOver = useCallback((event: DragOverEvent) => {
        if (event.over && event.active.id !== event.over.id) {
            setOverId(String(event.over.id));
        } else {
            setOverId(null);
        }
    }, []);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);
        setOverId(null);
        if (!over || active.id === over.id) return;
        setChannels(chs => {
            const oldIndex = chs.findIndex(c => c.stream_id === active.id);
            const newIndex = chs.findIndex(c => c.stream_id === over.id);
            if (oldIndex === -1 || newIndex === -1) return chs;
            const reordered = arrayMove(chs, oldIndex, newIndex);
            return reordered.map((c, idx) => ({ ...c, display_order: idx }));
        });
        setIsDirty(true);
        orderDirtyRef.current = true;
    }, []);

    const handleDragCancel = useCallback(() => {
        setActiveId(null);
        setOverId(null);
    }, []);

    // Select all
    const handleSelectAll = useCallback(() => {
        setChannels(chs => chs.map(ch => ({ ...ch, enabled: true })));
        setIsDirty(true);
    }, []);

    // Select none
    const handleSelectNone = useCallback(() => {
        setChannels(chs => chs.map(ch => ({ ...ch, enabled: false })));
        setIsDirty(true);
    }, []);

    // Helper function to apply filter words to a channel name
    const applyFilterWords = useCallback((name: string) => {
        let filteredName = name;
        filterWords.forEach(word => {
            if (word.trim()) {
                filteredName = filteredName.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
            }
        });
        return filteredName;
    }, [filterWords]);

    // Add a new filter word
    const handleAddFilterWord = useCallback(() => {
        if (newFilterWord.trim() && !filterWords.includes(newFilterWord.trim())) {
            setFilterWords(prev => [...prev, newFilterWord.trim()]);
            setNewFilterWord('');
            setIsDirty(true);
        }
    }, [newFilterWord, filterWords]);

    // Remove a filter word
    const handleRemoveFilterWord = useCallback((word: string) => {
        setFilterWords(prev => prev.filter(w => w !== word));
        setIsDirty(true);
    }, []);

    // Save changes
    // Save changes
    const handleSave = useCallback(async () => {
        try {
            isSavingRef.current = true;

            // 1. Bulk update channels (enabled state) in channels table
            const channelVisibilityUpdates = channels.map(ch => ({
                streamId: ch.stream_id,
                enabled: ch.enabled !== false,
            }));
            if (channelVisibilityUpdates.length > 0) {
                await updateChannelsBatch(channelVisibilityUpdates);
            }

            // 1b. Persist inline alias edits (rename / reset-to-source-name)
            const aliasUpdates = channels
                .filter(ch => aliasEditsRef.current.has(ch.stream_id))
                .map(ch => ({
                    streamId: ch.stream_id,
                    alias: aliasEditsRef.current.get(ch.stream_id) ?? null,
                }));
            if (aliasUpdates.length > 0) {
                await updateChannelsBatch(aliasUpdates);
            }

            // 2. Persist the manual order — only when the user actually reordered.
            // A rename or a visibility toggle must not rewrite (and thereby pin)
            // every row of the category into playlist_individual_channels: it is
            // a large write and it silently converts the category to a custom
            // order that stops tracking the provider's.
            if (orderDirtyRef.current) {
                await db.playlistIndividualChannels
                    .whereRaw('playlist_id = ? AND parent_category_id = ?', [targetPlaylistId, targetParentId])
                    .delete();

                const items = channels.map((ch, i) => ({
                    playlist_id: targetPlaylistId,
                    parent_category_id: targetParentId,
                    stream_id: ch.stream_id,
                    display_order: i,
                    added_at: Date.now()
                }));
                await db.playlistIndividualChannels.bulkPut(items);
            }

            // 3. Perform atomic operation for category filter words
            if (!isLink) {
                await db.categories.update(categoryId, {
                    filter_words: filterWords
                });
            }

            // Everything is committed. The remaining steps only refresh the UI,
            // so a failure there must not be reported as a failed save.
            aliasEditsRef.current.clear();
            orderDirtyRef.current = false;
            await new Promise(resolve => setTimeout(resolve, 300));
            try {
                if (onChange) await onChange();
            } catch (refreshErr) {
                console.error('[ChannelManager] Post-save refresh failed (changes were saved):', refreshErr);
                logErrorAlways('[ChannelManager] Post-save refresh failed (changes were saved):', refreshErr);
            }
            onClose();
        } catch (err) {
            console.error('[ChannelManager] Failed to save:', err);
            logErrorAlways('[ChannelManager] Failed to save:', err);
            const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            alert(`${i18n.t('settings:channelManager.errSave')}\n\n${detail}`);
        } finally {
            isSavingRef.current = false;
        }
    }, [channels, filterWords, categoryId, targetPlaylistId, targetParentId, isLink, onChange, onClose]);

    // Get visible channels based on filter and search
    const visibleChannels = useMemo(() => {
        let filtered = channels;

        // Filter by enabled status
        if (hideDisabled) {
            filtered = filtered.filter(c => c.enabled !== false);
        }

        // Filter by search query
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            // Match the alias too: after a rename the row shows the alias, so
            // searching for the name the user sees has to find it.
            filtered = filtered.filter(c =>
                c.name.toLowerCase().includes(query) ||
                (c.alias ? c.alias.toLowerCase().includes(query) : false)
            );
        }

        return filtered;
    }, [channels, hideDisabled, searchQuery]);

    // Move channel to top
    const moveToTop = useCallback((visibleIndex: number) => {
        if (visibleIndex === 0) return;
        setChannels(chs => {
            const ch = visibleChannels[visibleIndex];
            if (!ch) return chs;
            const actualIndex = chs.findIndex(c => c.stream_id === ch.stream_id);
            if (actualIndex === -1 || actualIndex === 0) return chs;
            
            const next = [...chs];
            const [moved] = next.splice(actualIndex, 1);
            next.unshift(moved);
            return next.map((c, idx) => ({ ...c, display_order: idx }));
        });
        setIsDirty(true);
        orderDirtyRef.current = true;
    }, [visibleChannels]);

    // Move channel up
    const moveUp = useCallback((visibleIndex: number) => {
        if (visibleIndex === 0) return;
        setChannels(chs => {
            const ch = visibleChannels[visibleIndex];
            const prevCh = visibleChannels[visibleIndex - 1];
            if (!ch || !prevCh) return chs;
            
            const indexA = chs.findIndex(c => c.stream_id === ch.stream_id);
            const indexB = chs.findIndex(c => c.stream_id === prevCh.stream_id);
            if (indexA === -1 || indexB === -1) return chs;
            
            const next = [...chs];
            [next[indexA], next[indexB]] = [next[indexB], next[indexA]];
            return next.map((c, idx) => ({ ...c, display_order: idx }));
        });
        setIsDirty(true);
        orderDirtyRef.current = true;
    }, [visibleChannels]);

    // Move channel down
    const moveDown = useCallback((visibleIndex: number) => {
        if (visibleIndex === visibleChannels.length - 1) return;
        setChannels(chs => {
            const ch = visibleChannels[visibleIndex];
            const nextCh = visibleChannels[visibleIndex + 1];
            if (!ch || !nextCh) return chs;
            
            const indexA = chs.findIndex(c => c.stream_id === ch.stream_id);
            const indexB = chs.findIndex(c => c.stream_id === nextCh.stream_id);
            if (indexA === -1 || indexB === -1) return chs;
            
            const next = [...chs];
            [next[indexA], next[indexB]] = [next[indexB], next[indexA]];
            return next.map((c, idx) => ({ ...c, display_order: idx }));
        });
        setIsDirty(true);
        orderDirtyRef.current = true;
    }, [visibleChannels]);

    // Sort channels alphabetically by display name (alias if available, otherwise original name)
    const handleSortABC = useCallback(() => {
        setChannels(chs => {
            const sorted = [...chs].sort((a, b) => {
                const nameA = (a.alias || a.name || '').trim();
                const nameB = (b.alias || b.name || '').trim();
                return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
            });
            return sorted.map((c, idx) => ({ ...c, display_order: idx }));
        });
        setIsDirty(true);
        orderDirtyRef.current = true;
    }, []);

    const enabledCount = channels.filter(c => c.enabled !== false).length;
    const totalCount = channels.length;

    const modalContent = (
        <div className="channel-manager-overlay" onClick={onClose}>
            <div className="channel-manager-modal" onClick={e => e.stopPropagation()}>
                <div className="channel-manager-header">
                    <h2>{i18n.t('settings:channelManager.manageTitle', { name: categoryName })}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="channel-manager-stats">
                    {i18n.t('settings:channelManager.channelsVisible', { enabled: enabledCount, total: totalCount })}
                </div>

                <div className="channel-manager-actions">
                    <button onClick={handleSelectAll}>✓ {i18n.t('settings:channelManager.enableAll')}</button>
                    <button onClick={handleSelectNone}>✗ {i18n.t('settings:channelManager.disableAll')}</button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={handleSortABC}
                        title={i18n.t('settings:channelManager.sortAZHint')}
                    >
                        🔤 {i18n.t('common:sortAZ')}
                    </button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={() => setHideDisabled(!hideDisabled)}
                        className={hideDisabled ? 'active-toggle' : ''}
                    >
                        {hideDisabled ? '👁 ' + i18n.t('common:showAll') : '👁‍🗨 ' + i18n.t('settings:channelManager.hideDisabled')}
                    </button>
                    {!isLink && (
                        <>
                            <div className="divider-vertical"></div>
                            <button
                                onClick={() => setShowFilterPanel(!showFilterPanel)}
                                className={showFilterPanel ? 'active-toggle' : ''}
                            >
                                🔤 {i18n.t('settings:channelManager.filterWords')}
                            </button>
                        </>
                    )}
                </div>

                {/* Filter Words Panel */}
                {showFilterPanel && (
                    <div className="filter-words-panel">
                        <div className="filter-words-header">
                            <span>{i18n.t('settings:channelManager.filterWordsTitle')}</span>
                            <span className="filter-words-hint">{i18n.t('settings:channelManager.filterWordsHint')}</span>
                        </div>
                        <div className="filter-words-input-row">
                            <input
                                type="text"
                                placeholder={i18n.t('settings:channelManager.filterWordPlaceholder')}
                                value={newFilterWord}
                                onChange={(e) => setNewFilterWord(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddFilterWord()}
                            />
                            <button onClick={handleAddFilterWord} className="filter-add-btn">{i18n.t('common:add')}</button>
                        </div>
                        <div className="filter-words-list">
                            {filterWords.length === 0 ? (
                                <span className="filter-words-empty">{i18n.t('settings:channelManager.noFilterWords')}</span>
                            ) : (
                                filterWords.map((word) => (
                                    <span key={word} className="filter-word-tag">
                                        "{word}"
                                        <button onClick={() => handleRemoveFilterWord(word)} className="filter-word-remove">✕</button>
                                    </span>
                                ))
                            )}
                        </div>
                    </div>
                )}

                <div className="channel-search">
                    <input
                        type="text"
                        placeholder={i18n.t('settings:channelManager.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                >
                    <SortableContext items={visibleChannels.map(ch => ch.stream_id)} strategy={verticalListSortingStrategy}>
                        <div className="channel-list">
                            {visibleChannels.length === 0 ? (
                                <div className="channel-empty">
                                    {searchQuery ? i18n.t('settings:channelManager.noSearchResults') : i18n.t('settings:channelManager.noChannels')}
                                </div>
                            ) : (
                                visibleChannels.map((ch, visibleIndex) => {
                                    const displayName = ch.alias || ch.name;
                                    const filteredName = applyFilterWords(displayName);
                                    const activeChannelIndex = activeId ? visibleChannels.findIndex(c => c.stream_id === activeId) : -1;
                                    const isOver = overId === ch.stream_id && activeId !== overId;
                                    const dropIndicator = isOver ? (activeChannelIndex < visibleIndex ? 'below' : 'above') : null;
                                    return (
                                        <SortableChannelRow
                                            key={ch.stream_id}
                                            id={ch.stream_id}
                                            className={`channel-item ${ch.enabled === false ? 'disabled' : ''}`}
                                            dropIndicator={dropIndicator}
                                        >
                                            {/* While the editor is open, clicking the row must not
                                                toggle enable/disable behind the commit. */}
                                            <label
                                                className="channel-checkbox"
                                                onClick={editingAliasId === ch.stream_id ? (e) => e.preventDefault() : undefined}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={ch.enabled !== false}
                                                    onChange={() => toggleChannel(ch.stream_id)}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                />
                                                {editingAliasId === ch.stream_id ? (
                                                    <span
                                                        className="channel-alias-editor"
                                                        onClick={(e) => e.preventDefault()}
                                                        onPointerDown={(e) => e.stopPropagation()}
                                                    >
                                                        <input
                                                            type="text"
                                                            className="channel-alias-input"
                                                            value={aliasDraft}
                                                            placeholder={ch.name}
                                                            autoFocus
                                                            title={i18n.t('settings:channelManager.nameHint')}
                                                            onChange={(e) => setAliasDraft(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    e.currentTarget.blur();
                                                                } else if (e.key === 'Escape') {
                                                                    e.preventDefault();
                                                                    cancelAliasEdit();
                                                                }
                                                            }}
                                                            onBlur={() => commitAliasEdit(ch)}
                                                        />
                                                    </span>
                                                ) : (
                                                    <span
                                                        className="channel-name"
                                                        onDoubleClick={(e) => { e.preventDefault(); startAliasEdit(ch); }}
                                                    >
                                                        <span className="channel-display-name">{filteredName}</span>
                                                        {ch.alias && (
                                                            <span className="channel-original-name" title={ch.name}>
                                                                ({ch.name})
                                                            </span>
                                                        )}
                                                        {!ch.alias && filteredName !== ch.name && (
                                                            <span className="channel-original-name" title={ch.name}>
                                                                ({ch.name})
                                                            </span>
                                                        )}
                                                    </span>
                                                )}
                                            </label>
                                            <div className="channel-row-actions">
                                                <button
                                                    type="button"
                                                    className="channel-icon-btn"
                                                    onClick={() => (editingAliasId === ch.stream_id ? cancelAliasEdit() : startAliasEdit(ch))}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    title={i18n.t('settings:channelManager.editNameHint')}
                                                >
                                                    <PencilIcon />
                                                </button>
                                                {ch.alias && (
                                                    <button
                                                        type="button"
                                                        className="channel-icon-btn reset"
                                                        onClick={() => resetAlias(ch)}
                                                        onPointerDown={(e) => e.stopPropagation()}
                                                        title={i18n.t('settings:channelManager.resetNameHint', { name: ch.name })}
                                                    >
                                                        <ResetIcon />
                                                    </button>
                                                )}
                                            </div>
                                            <div className="channel-reorder">
                                                <button
                                                    className="order-btn"
                                                    onClick={() => moveToTop(visibleIndex)}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    disabled={visibleIndex === 0}
                                                    title={i18n.t('common:moveToTop')}
                                                >
                                                    ↑↑
                                                </button>
                                                <button
                                                    className="order-btn"
                                                    onClick={() => moveUp(visibleIndex)}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    disabled={visibleIndex === 0}
                                                    title={i18n.t('common:moveUp')}
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    className="order-btn"
                                                    onClick={() => moveDown(visibleIndex)}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    disabled={visibleIndex === visibleChannels.length - 1}
                                                    title={i18n.t('common:moveDown')}
                                                >
                                                    ↓
                                                </button>
                                            </div>
                                        </SortableChannelRow>
                                    );
                                })
                            )}
                        </div>
                    </SortableContext>
                </DndContext>



                <div className="channel-manager-footer">
                    <button className="cancel-btn" onClick={onClose}>{i18n.t('common:cancel')}</button>
                    <button
                        className="save-btn"
                        onClick={handleSave}
                        disabled={!isDirty}
                    >
                        {i18n.t('common:saveChanges')}
                    </button>
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}
