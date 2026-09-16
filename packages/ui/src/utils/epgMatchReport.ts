/**
 * Tree for the EPG editor's Matches report.
 *
 * The report is one collapsible tree — source → category → channel — that opens
 * collapsed, so the first thing the user sees is which playlists hold matches and
 * how many of those are locked to somebody else's feed, rather than a list of the
 * whole library. Kept out of the modal so the parts with real logic — which
 * channels a lock filter keeps, where an uncategorised channel lands, and what
 * the per-node counts and release scopes mean — are unit-testable without a DOM.
 */

import type { EpgMatchRow } from '../services/epg-overrides';

/** Category key for channels that belong to no category at all. */
export const NO_CATEGORY = '__none__';

/** What the lock filter narrows the tree down to. */
export type MatchLockFilter = 'all' | 'locked' | 'elsewhere';

/**
 * Where a channel's guide comes from, relative to the channel itself:
 *
 *   none       nothing pinned — the sync's waterfall picks the feed each round
 *   own        pinned to its own playlist's feed
 *   elsewhere  pinned to another playlist's feed or to a global EPG link
 *
 * "Elsewhere" is the audit case: a feed other than the channel's own is the only
 * writer, so a stale or thin feed there leaves the channel thin or blank.
 */
export type MatchLockTarget = 'none' | 'own' | 'elsewhere';

export function lockTarget(row: Pick<EpgMatchRow, 'feedRef' | 'sourceId'>): MatchLockTarget {
  const feed = row.feedRef?.trim();
  if (!feed) return 'none';
  if (feed.startsWith('global_epg_')) return 'elsewhere';
  return feed === row.sourceId ? 'own' : 'elsewhere';
}

export function matchesLockFilter(row: EpgMatchRow, filter: MatchLockFilter): boolean {
  if (filter === 'all') return true;
  const target = lockTarget(row);
  return filter === 'locked' ? target !== 'none' : target === 'elsewhere';
}

export interface MatchCategoryNode {
  /** Expansion key — unique across the tree, so one Set holds every open node. */
  key: string;
  /** The category's own key, e.g. a category name or NO_CATEGORY. */
  categoryKey: string;
  label: string;
  channels: EpgMatchRow[];
  locked: number;
  elsewhere: number;
  /** Stream ids of the locked channels inside this node — the release scope. */
  releaseIds: string[];
}

export interface MatchSourceNode {
  key: string;
  sourceId: string | null;
  label: string;
  /** Every filtered channel of this source — what the counts are computed from. */
  channels: EpgMatchRow[];
  categories: MatchCategoryNode[];
  locked: number;
  elsewhere: number;
  releaseIds: string[];
}

export interface BuildMatchTreeOptions {
  /**
   * Free text over channel name, tvg-id, feed name, source name and the names of
   * the categories a channel sits in — in a tree, searching a folder's name is
   * as natural as searching a channel's.
   */
  filter: string;
  lockFilter: MatchLockFilter;
  /** Friendly name of the playlist a channel belongs to. */
  sourceLabel: (sourceId: string | null) => string;
  /** Friendly name of the feed a lock names (searched, not displayed here). */
  feedLabel: (feedRef: string | null) => string | null;
  /** Category names per channel, one row per membership. */
  categories: Map<string, string[]>;
  labels: { noCategory: string };
}

/** Expansion key of a source node (its own key, so callers can reuse it). */
export function sourceNodeKey(sourceKey: string): string {
  return sourceKey;
}

/** Expansion key of a category node, namespaced by its source. */
export function categoryNodeKey(sourceKey: string, categoryKey: string): string {
  return `${sourceKey}|${categoryKey}`;
}

/**
 * Build the filtered source → category tree.
 *
 * Sources, categories and channels are all sorted by name so a reload or a
 * filter can never reshuffle the list the user is reading. A channel in several
 * categories appears under each of them, but a source's counts are computed from
 * its channels, not from the sum of its categories, so nothing is double counted.
 */
export function buildMatchTree(
  rows: EpgMatchRow[],
  { filter, lockFilter, sourceLabel, feedLabel, categories, labels }: BuildMatchTreeOptions
): MatchSourceNode[] {
  const needle = filter.trim().toLowerCase();
  const visible = rows.filter(row => {
    if (!matchesLockFilter(row, lockFilter)) return false;
    if (!needle) return true;
    const haystack = [
      row.channelName,
      row.epgChannelId ?? '',
      row.feedRef ? feedLabel(row.feedRef) ?? '' : '',
      sourceLabel(row.sourceId),
      ...(categories.get(row.streamId) ?? []),
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });

  const sources = new Map<string, MatchSourceNode & { categoryMap: Map<string, MatchCategoryNode> }>();

  for (const row of visible) {
    const sourceKey = row.sourceId ?? '__none__';
    let source = sources.get(sourceKey);
    if (!source) {
      source = {
        key: `source:${sourceKey}`,
        sourceId: row.sourceId,
        label: sourceLabel(row.sourceId),
        channels: [],
        categories: [],
        locked: 0,
        elsewhere: 0,
        releaseIds: [],
        categoryMap: new Map(),
      };
      sources.set(sourceKey, source);
    }
    source.channels.push(row);

    const names = categories.get(row.streamId) ?? [];
    const keys = names.length > 0
      ? names.map(name => ({ key: name, label: name }))
      : [{ key: NO_CATEGORY, label: labels.noCategory }];

    for (const { key, label } of keys) {
      let category = source.categoryMap.get(key);
      if (!category) {
        category = {
          key: categoryNodeKey(source.key, key),
          categoryKey: key,
          label,
          channels: [],
          locked: 0,
          elsewhere: 0,
          releaseIds: [],
        };
        source.categoryMap.set(key, category);
      }
      category.channels.push(row);
    }
  }

  const tree: MatchSourceNode[] = [];
  for (const source of [...sources.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    source.categories = [...source.categoryMap.values()]
      .map(category => {
        category.channels.sort((a, b) => a.channelName.localeCompare(b.channelName));
        category.locked = category.channels.filter(row => lockTarget(row) !== 'none').length;
        category.elsewhere = category.channels.filter(row => lockTarget(row) === 'elsewhere').length;
        category.releaseIds = category.channels.filter(row => row.feedRef).map(row => row.streamId);
        return category;
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    source.channels.sort((a, b) => a.channelName.localeCompare(b.channelName));
    source.locked = source.channels.filter(row => lockTarget(row) !== 'none').length;
    source.elsewhere = source.channels.filter(row => lockTarget(row) === 'elsewhere').length;
    source.releaseIds = source.channels.filter(row => row.feedRef).map(row => row.streamId);

    const { categoryMap: _categoryMap, ...node } = source;
    tree.push(node);
  }
  return tree;
}

/**
 * One row of the rendered tree. The virtualizer walks this projection, so what
 * is mounted is decided by the same Set that decides what is expanded.
 */
export type MatchTreeRow =
  | {
      kind: 'source';
      key: string;
      depth: 0;
      label: string;
      count: number;
      locked: number;
      elsewhere: number;
      expanded: boolean;
      releaseIds: string[];
    }
  | {
      kind: 'category';
      key: string;
      depth: 1;
      label: string;
      count: number;
      locked: number;
      elsewhere: number;
      expanded: boolean;
      releaseIds: string[];
      sourceKey: string;
    }
  | {
      kind: 'channel';
      key: string;
      depth: 2;
      channel: EpgMatchRow;
      sourceKey: string;
      categoryKey: string;
    };

export interface FlattenMatchTreeOptions {
  /** Expansion keys currently open (source keys and category keys). */
  expanded: ReadonlySet<string>;
  /**
   * Open every node regardless of `expanded` — used while a search filter is
   * active, so a hit is never hidden behind a collapsed parent.
   */
  expandAll?: boolean;
}

/**
 * Project the tree into the rows to render: a source row always, its categories
 * only when it is open, and a category's channels only when that is open too.
 */
export function flattenMatchTree(
  tree: MatchSourceNode[],
  { expanded, expandAll = false }: FlattenMatchTreeOptions
): MatchTreeRow[] {
  const rows: MatchTreeRow[] = [];

  for (const source of tree) {
    const sourceOpen = expandAll || expanded.has(source.key);
    rows.push({
      kind: 'source',
      key: source.key,
      depth: 0,
      label: source.label,
      count: source.channels.length,
      locked: source.locked,
      elsewhere: source.elsewhere,
      expanded: sourceOpen,
      releaseIds: source.releaseIds,
    });
    if (!sourceOpen) continue;

    for (const category of source.categories) {
      const categoryOpen = expandAll || expanded.has(category.key);
      rows.push({
        kind: 'category',
        key: category.key,
        depth: 1,
        label: category.label,
        count: category.channels.length,
        locked: category.locked,
        elsewhere: category.elsewhere,
        expanded: categoryOpen,
        releaseIds: category.releaseIds,
        sourceKey: source.key,
      });
      if (!categoryOpen) continue;

      for (const channel of category.channels) {
        rows.push({
          kind: 'channel',
          key: `${category.key}|${channel.streamId}`,
          depth: 2,
          channel,
          sourceKey: source.key,
          categoryKey: category.key,
        });
      }
    }
  }
  return rows;
}

/** Every expansion key in the tree — what the "Expand all" action opens. */
export function matchNodeKeys(tree: MatchSourceNode[]): string[] {
  const keys: string[] = [];
  for (const source of tree) {
    keys.push(source.key);
    for (const category of source.categories) keys.push(category.key);
  }
  return keys;
}
