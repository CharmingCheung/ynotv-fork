/**
 * Bulk EPG match ranking (epg-overrides.rankEpgMatchCandidates /
 * bestEpgMatchCandidate).
 *
 * The Automatch Missing run loads the candidate list once and scores every
 * channel against it, so the two shapes of that scoring — the ranked list the
 * single-channel search uses, and the winner-only scan the run uses — have to
 * agree exactly. Otherwise a bulk run would attribute different channels than
 * clicking Auto-match on each one, which is the kind of drift where the guide
 * changes after a run nobody can explain.
 *
 * The winner-only scan exists because a run over a large scope would otherwise
 * allocate and sort a scored copy of every candidate for every channel; these
 * tests pin the equivalence, not the implementation.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { dbPromise: Promise.resolve({ select: vi.fn(), execute: vi.fn() }) },
}));
vi.mock('../../db/sqlite-adapter', () => ({ dbEvents: { notify: vi.fn() } }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ globalEpgLinks: [] }) },
}));

import { rankEpgMatchCandidates, bestEpgMatchCandidate } from '../epg-overrides';
import type { EpgMatchCandidate } from '../epg-overrides';

const candidate = (id: string, display_name: string, source_id = 'source_a'): EpgMatchCandidate => ({
  id,
  display_name,
  source_id,
});

const NAMES = [
  'Nickelodeon',
  'BBC One',
  'USA: A & E HD',
  'Tagesschau 24',
  'ZZZ Unknown 99',
  'ARD-ALPHA',
];

const LISTS: EpgMatchCandidate[][] = [
  [
    candidate('nickelodeon.us', 'Nickelodeon HD'),
    candidate('nickjr.us', 'Nick Jr'),
    candidate('bbcone.uk', 'BBC One'),
    candidate('bbctwo.uk', 'BBC Two'),
    candidate('aande.us', 'A&E'),
    candidate('tagesschau.de', 'Tagesschau 24'),
    candidate('ard.de', 'ARD-ALPHA HD', 'global_epg_link1'),
  ],
  [candidate('nickelodeon.us', 'Nickelodeon HD')],
  [],
];

describe('EPG match ranking', () => {
  it('agrees with the ranked list for every name and candidate list', () => {
    for (const name of NAMES) {
      for (const list of LISTS) {
        expect(bestEpgMatchCandidate(name, list)).toEqual(
          rankEpgMatchCandidates(name, list, 1)[0] ?? null
        );
      }
    }
  });

  it('reports no match when nothing clears the score floor', () => {
    const weak = [candidate('x', 'Completely Unrelated Channel')];
    expect(bestEpgMatchCandidate('ZZZ Unknown 99', weak)).toBeNull();
    expect(rankEpgMatchCandidates('ZZZ Unknown 99', weak, 1)).toEqual([]);
  });

  it('keeps the first candidate when scores tie, like the stable sort', () => {
    const tied = [candidate('first', 'BBC One'), candidate('second', 'BBC One')];
    const ranked = rankEpgMatchCandidates('BBC One', tied, 2);
    expect(ranked.map(r => r.id)).toEqual(['first', 'second']);
    expect(bestEpgMatchCandidate('BBC One', tied)?.id).toBe('first');
  });

  it('orders by score and honours the limit', () => {
    const list = [
      candidate('partial', 'BBC Two'),
      candidate('exact', 'BBC One'),
      candidate('unrelated', 'Nick Jr'),
    ];
    const ranked = rankEpgMatchCandidates('BBC One', list);
    expect(ranked[0].id).toBe('exact');
    expect(ranked.map(r => r.id)).not.toContain('unrelated');
    expect(rankEpgMatchCandidates('BBC One', list, 1)).toHaveLength(1);
  });

  it('keeps the matched candidate fields intact, feed pin included', () => {
    const list = [candidate('ard.de', 'ARD-ALPHA', 'global_epg_link1')];
    const best = bestEpgMatchCandidate('ARD-ALPHA', list);
    expect(best).toMatchObject({ id: 'ard.de', display_name: 'ARD-ALPHA', source_id: 'global_epg_link1' });
    expect(best?.score).toBeGreaterThan(0.4);
  });

  it('scores each name against the same preloaded list independently', () => {
    // The list is shared across a run; a name must never inherit a previous
    // name's winner.
    const list = LISTS[0];
    const nickelodeon = bestEpgMatchCandidate('Nickelodeon', list);
    const bbc = bestEpgMatchCandidate('BBC One', list);
    expect(nickelodeon?.id).toBe('nickelodeon.us');
    expect(bbc?.id).toBe('bbcone.uk');
    expect(bestEpgMatchCandidate('Nickelodeon', list)?.id).toBe('nickelodeon.us');
  });
});
