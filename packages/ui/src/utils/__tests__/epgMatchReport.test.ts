import { describe, it, expect } from 'vitest';
import {
  NO_CATEGORY,
  buildMatchTree,
  categoryNodeKey,
  flattenMatchTree,
  lockTarget,
  matchNodeKeys,
  matchesLockFilter,
  type MatchTreeRow,
} from '../epgMatchReport';
import type { EpgMatchRow } from '../../services/epg-overrides';

const row = (
  streamId: string,
  channelName: string,
  overrides: Partial<EpgMatchRow> = {}
): EpgMatchRow => ({
  streamId,
  channelName,
  sourceId: 'alpha',
  epgChannelId: null,
  feedRef: null,
  matchByAlias: false,
  ...overrides,
});

const FEED_LABELS: Record<string, string> = {
  global_epg_1: 'Shared EPG (Cache)',
  beta: 'Playlist B',
};

const options = (overrides: Partial<Parameters<typeof buildMatchTree>[1]> = {}) => ({
  filter: '',
  lockFilter: 'all' as const,
  sourceLabel: (sourceId: string | null) => (sourceId ? sourceId.toUpperCase() : '—'),
  feedLabel: (feedRef: string | null) => (feedRef ? FEED_LABELS[feedRef] ?? feedRef : null),
  categories: new Map<string, string[]>(),
  labels: { noCategory: 'No category' },
  ...overrides,
});

/** Compact view of the rendered rows, for readable assertions. */
const shape = (rows: MatchTreeRow[]) =>
  rows.map(r => `${'  '.repeat(r.depth)}${r.kind}:${r.kind === 'channel' ? r.channel.channelName : r.label}`);

describe('lockTarget', () => {
  it('separates no lock, the channel\'s own feed, and someone else\'s feed', () => {
    expect(lockTarget({ feedRef: null, sourceId: 'alpha' })).toBe('none');
    expect(lockTarget({ feedRef: '  ', sourceId: 'alpha' })).toBe('none');
    expect(lockTarget({ feedRef: 'alpha', sourceId: 'alpha' })).toBe('own');
    expect(lockTarget({ feedRef: 'beta', sourceId: 'alpha' })).toBe('elsewhere');
    expect(lockTarget({ feedRef: 'global_epg_1', sourceId: 'alpha' })).toBe('elsewhere');
  });
});

describe('matchesLockFilter', () => {
  const none = row('c1', 'A');
  const own = row('c2', 'B', { feedRef: 'alpha' });
  const elsewhere = row('c3', 'C', { feedRef: 'global_epg_1' });

  it('keeps everything for all', () => {
    expect([none, own, elsewhere].filter(r => matchesLockFilter(r, 'all'))).toHaveLength(3);
  });

  it('keeps any pin for locked, and only foreign pins for elsewhere', () => {
    expect([none, own, elsewhere].filter(r => matchesLockFilter(r, 'locked')).map(r => r.streamId)).toEqual(['c2', 'c3']);
    expect([none, own, elsewhere].filter(r => matchesLockFilter(r, 'elsewhere')).map(r => r.streamId)).toEqual(['c3']);
  });
});

describe('buildMatchTree', () => {
  const rows = [
    row('a1', 'Bravo', { sourceId: 'alpha', feedRef: 'global_epg_1' }),
    row('a2', 'Alpha', { sourceId: 'alpha', feedRef: 'alpha' }),
    row('a3', 'Charlie', { sourceId: 'alpha' }),
    row('b1', 'Delta', { sourceId: 'beta', feedRef: 'global_epg_1' }),
  ];

  it('groups by source, sorted by name, with counts computed from channels', () => {
    const tree = buildMatchTree(rows, options({ categories: new Map([['a1', ['News', 'Sport']]]) }));
    expect(tree.map(s => [s.label, s.channels.length, s.locked, s.elsewhere])).toEqual([
      ['ALPHA', 3, 2, 1],
      ['BETA', 1, 1, 1],
    ]);
  });

  it('does not double count a channel that sits in two categories', () => {
    const tree = buildMatchTree(rows, options({ categories: new Map([['a1', ['News', 'Sport']]]) }));
    const alpha = tree[0];
    expect(alpha.categories.map(c => [c.label, c.channels.length])).toEqual([['News', 1], ['No category', 2], ['Sport', 1]]);
    expect(alpha.locked).toBe(2); // not 3, even though "News" + "Sport" both hold a1
  });

  it('sorts channels by name inside a source and inside a category', () => {
    const tree = buildMatchTree(rows, options());
    expect(tree[0].channels.map(c => c.channelName)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('puts a channel with no category under the no-category node', () => {
    const tree = buildMatchTree(rows, options({ categories: new Map([['a1', ['News']]]) }));
    const names = tree[0].categories.find(c => c.categoryKey === NO_CATEGORY);
    expect(names?.label).toBe('No category');
    expect(names?.channels.map(c => c.streamId)).toEqual(['a2', 'a3']);
  });

  it('drops sources that the lock filter empties out', () => {
    const tree = buildMatchTree(rows, options({ lockFilter: 'elsewhere' }));
    expect(tree.map(s => [s.label, s.channels.map(c => c.streamId)])).toEqual([
      ['ALPHA', ['a1']],
      ['BETA', ['b1']],
    ]);
  });

  it('scopes the release ids to the locked channels of each node', () => {
    const tree = buildMatchTree(rows, options());
    // Only the locked channels are in scope — an unlocked match has nothing to
    // release — and they keep the list's own name order.
    expect(tree[0].releaseIds).toEqual(['a2', 'a1']);
    expect(tree[0].categories[0].releaseIds).toEqual(['a2', 'a1']);
  });

  it('filters by channel name, tvg-id, feed name and source name', () => {
    const withIds = [
      row('a1', 'Example One', { sourceId: 'alpha', feedRef: 'global_epg_1', epgChannelId: 'exampleone.us' }),
      row('b1', 'Example Two', { sourceId: 'beta', epgChannelId: 'exampletwo.us' }),
    ];
    const ids = (filter: string) =>
      buildMatchTree(withIds, options({ filter })).flatMap(s => s.channels.map(c => c.streamId));

    expect(ids('example one')).toEqual(['a1']);
    expect(ids('exampletwo.us')).toEqual(['b1']);
    expect(ids('shared')).toEqual(['a1']);
    expect(ids('BETA')).toEqual(['b1']);
    expect(ids('nothing here')).toEqual([]);
  });

  it('finds a channel by the name of a category it sits in', () => {
    const tree = buildMatchTree(rows, options({
      filter: 'sport',
      categories: new Map([['a1', ['Sport']], ['a2', ['News']]]),
    }));
    expect(tree.flatMap(s => s.channels.map(c => c.streamId))).toEqual(['a1']);
  });
});

describe('flattenMatchTree', () => {
  const rows = [
    row('a1', 'Bravo', { sourceId: 'alpha', feedRef: 'global_epg_1' }),
    row('a2', 'Alpha', { sourceId: 'alpha' }),
    row('b1', 'Delta', { sourceId: 'beta' }),
  ];
  const tree = buildMatchTree(rows, options({
    categories: new Map([['a1', ['News']], ['a2', ['News']], ['b1', ['Movies']]]),
  }));

  const alpha = tree[0].key;
  const news = categoryNodeKey(tree[0].key, 'News');

  it('shows only the sources while everything is collapsed', () => {
    expect(shape(flattenMatchTree(tree, { expanded: new Set() }))).toEqual([
      'source:ALPHA',
      'source:BETA',
    ]);
  });

  it('opens one source to its categories, without opening the categories', () => {
    expect(shape(flattenMatchTree(tree, { expanded: new Set([alpha]) }))).toEqual([
      'source:ALPHA',
      '  category:News',
      'source:BETA',
    ]);
  });

  it('lists a category\'s channels only when its own key is open', () => {
    expect(shape(flattenMatchTree(tree, { expanded: new Set([alpha, news]) }))).toEqual([
      'source:ALPHA',
      '  category:News',
      '    channel:Alpha',
      '    channel:Bravo',
      'source:BETA',
    ]);
  });

  it('opens everything when the search filter asks it to', () => {
    expect(shape(flattenMatchTree(tree, { expanded: new Set(), expandAll: true }))).toEqual([
      'source:ALPHA',
      '  category:News',
      '    channel:Alpha',
      '    channel:Bravo',
      'source:BETA',
      '  category:Movies',
      '    channel:Delta',
    ]);
  });

  it('reports expansion state and keeps one key per rendered row', () => {
    const flat = flattenMatchTree(tree, { expanded: new Set([alpha, news]) });
    const sources = flat.filter(r => r.kind === 'source');
    expect(sources.map(r => [r.label, r.expanded])).toEqual([['ALPHA', true], ['BETA', false]]);
    expect(flat.filter(r => r.kind === 'category').map(r => r.expanded)).toEqual([true]);
    expect(new Set(flat.map(r => r.key)).size).toBe(flat.length);
  });

  it('carries the release scope of an open node', () => {
    const flat = flattenMatchTree(tree, { expanded: new Set([alpha]) });
    const source = flat.find(r => r.kind === 'source' && r.label === 'ALPHA');
    const category = flat.find(r => r.kind === 'category');
    expect(source && source.kind === 'source' ? source.releaseIds : null).toEqual(['a1']);
    expect(category && category.kind === 'category' ? category.releaseIds : null).toEqual(['a1']);
  });
});

describe('matchNodeKeys', () => {
  it('collects every source and category key for expand-all', () => {
    const tree = buildMatchTree(
      [row('a1', 'Alpha', { sourceId: 'alpha' }), row('b1', 'Delta', { sourceId: 'beta' })],
      options({ categories: new Map([['a1', ['News']]]) })
    );
    expect(matchNodeKeys(tree)).toEqual([
      tree[0].key,
      tree[0].categories[0].key,
      tree[1].key,
      tree[1].categories[0].key,
    ]);
  });
});
