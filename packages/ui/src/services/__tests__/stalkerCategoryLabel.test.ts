/**
 * Which category a Stalker Server Search result came from.
 *
 * The results grid labels each card with its category, because a search can span every
 * category the portal has and nothing else on a card says where a title lives. Two things
 * that look like details but are the whole point:
 *
 * - The label comes from the local category table, so it has to keep **disabled**
 *   categories. A whole-library search is not filtered by enabled state either, and a hit
 *   from a disabled category with no label reads as the feature being broken.
 * - A row's membership is a union of what the portal reported and what the cached row
 *   already had, so the id order is history rather than this search's intent — hence the
 *   scoped category, when it is one of them, is the one named.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { vodCategories, toArray, equals } = vi.hoisted(() => ({
  vodCategories: { where: vi.fn() },
  toArray: vi.fn(async () => [] as any[]),
  equals: vi.fn(),
}));

vi.mock('@ynotv/local-adapter', () => ({ StalkerClient: class {} }));
vi.mock('../../db', () => ({ db: { vodCategories } }));
vi.mock('../../db/sync', () => ({ storeStalkerServerSearchHits: vi.fn() }));

import {
  categoryLabelsFor,
  getStalkerSearchCategoryNames,
  SEARCH_CATEGORY_LINE_PX,
} from '../stalkerServerSearch';

/** Make `db.vodCategories.where(...).equals(...).toArray()` answer with `rows`. */
const categoriesAnswer = (rows: any[]) => {
  toArray.mockResolvedValue(rows);
  equals.mockReset().mockReturnValue({ toArray });
  vodCategories.where.mockReset().mockReturnValue({ equals });
};

beforeEach(() => {
  vodCategories.where.mockReset();
  equals.mockReset();
  toArray.mockReset().mockResolvedValue([]);
});

describe('getStalkerSearchCategoryNames', () => {
  const rows = [
    { source_id: 'srcA', category_id: 'srcA_vod_150', name: 'DRAMA/ROMANCE', type: 'movie', enabled: true },
    // Disabled in Manage VOD Categories: still has to name a card it can return a hit for.
    { source_id: 'srcA', category_id: 'srcA_vod_145', name: 'COMEDY', type: 'movie', enabled: false },
    // Never given an `enabled` flag at all — the state most synced rows are in.
    { source_id: 'srcA', category_id: 'srcA_vod_12', name: 'ACTION & ADVENTURE', type: 'movie' },
    // Another source's category must not name this source's rows.
    { source_id: 'srcB', category_id: 'srcB_vod_150', name: 'DRAMA', type: 'movie' },
    // Nothing to name it with.
    { source_id: 'srcA', category_id: 'srcA_vod_99', name: '', type: 'movie' },
  ];

  it('names every category of the source, disabled ones included', async () => {
    categoriesAnswer(rows);
    const names = await getStalkerSearchCategoryNames('srcA', 'movies');

    expect(names).toEqual({
      srcA_vod_150: 'DRAMA/ROMANCE',
      srcA_vod_145: 'COMEDY',
      srcA_vod_12: 'ACTION & ADVENTURE',
    });
    expect(names.srcB_vod_150).toBeUndefined();
  });

  it('asks for the movie table for movies and the series table for series', async () => {
    categoriesAnswer([]);
    await getStalkerSearchCategoryNames('srcA', 'movies');
    expect(equals).toHaveBeenCalledWith('movie');

    categoriesAnswer([]);
    await getStalkerSearchCategoryNames('srcA', 'series');
    expect(equals).toHaveBeenCalledWith('series');
  });
});

describe('categoryLabelsFor', () => {
  const names = {
    srcA_vod_150: 'DRAMA/ROMANCE',
    srcA_vod_145: 'COMEDY',
    srcB_vod_150: 'DRAMA',
  };

  it('names a row stored as JSON, in the order it was stored', () => {
    expect(categoryLabelsFor('["srcA_vod_150","srcA_vod_145"]', names)).toEqual([
      'DRAMA/ROMANCE',
      'COMEDY',
    ]);
  });

  it('names a row still in memory as an array', () => {
    expect(categoryLabelsFor(['srcB_vod_150'], names)).toEqual(['DRAMA']);
  });

  it('drops ids it cannot name instead of printing the raw id', () => {
    expect(categoryLabelsFor('["srcA_vod_150","srcZ_vod_7"]', names)).toEqual(['DRAMA/ROMANCE']);
  });

  it('has no label for missing, empty or unparseable membership', () => {
    expect(categoryLabelsFor(undefined, names)).toEqual([]);
    expect(categoryLabelsFor(null, names)).toEqual([]);
    expect(categoryLabelsFor('', names)).toEqual([]);
    expect(categoryLabelsFor('[]', names)).toEqual([]);
    expect(categoryLabelsFor('not json', names)).toEqual([]);
  });

  it('lists a name once when two ids resolve to it', () => {
    expect(categoryLabelsFor('["srcA_vod_150","srcB_vod_150"]', {
      ...names,
      srcB_vod_150: 'DRAMA/ROMANCE',
    })).toEqual(['DRAMA/ROMANCE']);
  });

  it('puts the scoped category first, since that is the one the search was about', () => {
    expect(categoryLabelsFor('["srcA_vod_145","srcA_vod_150"]', names, 'srcA_vod_150')).toEqual([
      'DRAMA/ROMANCE',
      'COMEDY',
    ]);
  });

  it('leaves the order alone when the scoped category is not one of the row\'s', () => {
    expect(categoryLabelsFor('["srcA_vod_145"]', names, 'srcA_vod_150')).toEqual(['COMEDY']);
  });
});

describe('the row estimate and the card agree', () => {
  it('adds exactly the height the category line does', () => {
    // Cross-file invariant with nothing else relating the two: the grid sizes rows from
    // SEARCH_CATEGORY_LINE_PX while the extra height comes from CSS, and a mismatch shows
    // up as rows that shrink or overlap until the user scrolls.
    const css = readFileSync(new URL('../../components/vod/MediaCard.css', import.meta.url), 'utf8');
    const heightOf = (selector: string) => {
      const block = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
      const height = block?.[1].match(/height:\s*(\d+)px/);
      if (!height) throw new Error(`no pixel height for ${selector}`);
      return Number(height[1]);
    };

    const base = heightOf('.media-card__info');
    const withCategory = heightOf('.media-card--with-category .media-card__info');
    expect(withCategory - base).toBe(SEARCH_CATEGORY_LINE_PX);
  });
});
