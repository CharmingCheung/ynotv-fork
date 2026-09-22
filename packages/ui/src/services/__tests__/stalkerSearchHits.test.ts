/**
 * A Stalker server-search hit is written back into `vodMovies` / `vodSeries`, and the
 * row it lands on may already be cached — with its own category membership from whatever
 * category the user opened earlier.
 *
 * `category_ids` is what both the per-category list and "All Movies" filter on (the latter
 * via `json_each(category_ids)` intersected with the enabled categories), so letting a
 * search write its own list straight through would drop the title out of every list it was
 * in; a whole-library search, which has no category of its own, would leave it in none.
 *
 * The invariant under test: the merge never removes a category, and never yields an empty
 * list for a row that had one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbInstance, vodMovies, vodSeries } = vi.hoisted(() => ({
    dbInstance: { select: vi.fn() },
    vodMovies: { bulkPut: vi.fn() },
    vodSeries: { bulkPut: vi.fn() },
}));

vi.mock('../../db', () => ({
    db: { dbPromise: Promise.resolve(dbInstance), vodMovies, vodSeries },
}));

import { mergeSearchCategoryIds, storeStalkerServerSearchHits } from '../../db/sync';

const parse = (value: string) => JSON.parse(value) as string[];

describe('mergeSearchCategoryIds', () => {
    it('keeps the categories a cached row already had when the search has none', () => {
        const merged = mergeSearchCategoryIds('["src_vod_13","src_vod_103"]', '[]');
        expect(parse(merged).sort()).toEqual(['src_vod_103', 'src_vod_13']);
    });

    it('keeps them when the search ran inside a single category', () => {
        const merged = mergeSearchCategoryIds('["src_vod_13"]', '["src_vod_103"]');
        expect(parse(merged).sort()).toEqual(['src_vod_103', 'src_vod_13']);
    });

    it('does not duplicate a category both sides agree on', () => {
        const merged = mergeSearchCategoryIds('["src_vod_13"]', '["src_vod_13","src_vod_103"]');
        expect(parse(merged)).toHaveLength(2);
    });

    it('passes through hits that were never cached', () => {
        expect(parse(mergeSearchCategoryIds(undefined, '["src_vod_13"]'))).toEqual(['src_vod_13']);
        expect(parse(mergeSearchCategoryIds(null, '[]'))).toEqual([]);
    });

    it('tolerates the shapes a raw column can be read in', () => {
        // The SQLite adapter hands `category_ids` back stringified, but a caller further up
        // the stack may still hold the array form.
        expect(parse(mergeSearchCategoryIds(['src_vod_13'], ['src_vod_103'])).sort())
            .toEqual(['src_vod_103', 'src_vod_13']);
        expect(parse(mergeSearchCategoryIds('', '[]'))).toEqual([]);
        // A non-JSON string is a single category name, not a parse failure to swallow.
        expect(parse(mergeSearchCategoryIds('', 'src_vod_9'))).toEqual(['src_vod_9']);
    });

    it('drops empty entries rather than storing them as categories', () => {
        expect(parse(mergeSearchCategoryIds('["src_vod_13",""]', '[]'))).toEqual(['src_vod_13']);
    });
});

/**
 * The write itself, against a cached row.
 *
 * `bulkPut` upserts every column it is handed, so a hit carrying no `tmdb_id` of its own
 * writes NULL over one the user already had — the search is a read of the same catalogue,
 * not a fresh sync, so it must never look like the title lost its match. Series needed the
 * same `sanitizeSeries` call the series sync already makes; movies already went through
 * `sanitizeMovie`. This is what keeps a search hit and a synced row identical.
 */
describe('storeStalkerServerSearchHits', () => {
    const mappedSeries = (over: Record<string, unknown> = {}) => ({
        series_id: 'src_series_77',
        source_id: 'src',
        name: 'Game of Thrones',
        cover: 'http://img/77.jpg',
        plot: 'Nine noble families fight for control.',
        genre: 'Drama',
        year: 2011,
        releaseDate: '2011-04-17',
        category_ids: ['src_series_9'],
        direct_url: 'stalker_series:77:/media/77.mpg',
        _stalker_raw_id: '77',
        ...over,
    });

    const cachedSeries = {
        series_id: 'src_series_77',
        source_id: 'src',
        category_ids: '["src_series_5"]',
        tmdb_id: 1399,
        imdb_id: 'tt0944947',
        backdrop_path: '/gott.jpg',
        popularity: 412.3,
        match_attempted: 1,
        _stalker_category: 'src_series_5',
        category_id: 'src_series_5',
        year: 2011,
    };

    beforeEach(() => {
        dbInstance.select.mockReset().mockResolvedValue([]);
        vodMovies.bulkPut.mockReset().mockResolvedValue(undefined);
        vodSeries.bulkPut.mockReset().mockResolvedValue(undefined);
    });

    const writtenSeries = () => vodSeries.bulkPut.mock.calls[0][0][0];

    it('keeps a cached series\u2019 TMDB match when the hit carries none', async () => {
        dbInstance.select.mockResolvedValue([cachedSeries]);

        await storeStalkerServerSearchHits([mappedSeries()], 'series', null);

        const row = writtenSeries();
        expect(row.tmdb_id).toBe(1399);
        expect(row.imdb_id).toBe('tt0944947');
        expect(row.backdrop_path).toBe('/gott.jpg');
        expect(row.popularity).toBe(412.3);
        expect(row.match_attempted).toBe(1);
        // Still what the portal says it is: the hit is the newer truth for these.
        expect(row.name).toBe('Game of Thrones');
        expect(row.plot).toBe('Nine noble families fight for control.');
    });

    it('keeps the membership the hit cannot carry, and adds the one it brought', async () => {
        dbInstance.select.mockResolvedValue([cachedSeries]);

        await storeStalkerServerSearchHits([mappedSeries()], 'series', null);

        const row = writtenSeries();
        // `useVod` matches a series on any of these three, so a search write must not clear
        // the two the portal's own rows never include.
        expect(row._stalker_category).toBe('src_series_5');
        expect(row.category_id).toBe('src_series_5');
        expect(parse(row.category_ids).sort()).toEqual(['src_series_5', 'src_series_9']);
    });

    it('writes a hit that was never cached as a plain new row', async () => {
        dbInstance.select.mockResolvedValue([]);

        const rows = await storeStalkerServerSearchHits([mappedSeries()], 'series', null);

        expect(rows).toHaveLength(1);
        expect(parse(rows[0].category_ids as string)).toEqual(['src_series_9']);
        expect(rows[0].tmdb_id == null).toBe(true);
    });

    it('keeps a cached movie\u2019s match on the same terms', async () => {
        dbInstance.select.mockResolvedValue([{
            stream_id: 'src_vod_13',
            category_ids: '["src_vod_5"]',
            tmdb_id: 76600,
            imdb_id: 'tt1630029',
            backdrop_path: '/avatar.jpg',
            popularity: 900.1,
            match_attempted: 1,
        }]);

        await storeStalkerServerSearchHits([{
            stream_id: 'src_vod_13',
            source_id: 'src',
            name: 'Avatar: The Way of Water',
            title: 'Avatar: The Way of Water',
            category_ids: ['src_vod_9'],
            year: '2022',
            release_date: '2022-01-01',
            direct_url: 'stalker_vod:13:/media/13.mpg',
        }], 'movies', null);

        const row = vodMovies.bulkPut.mock.calls[0][0][0];
        expect(row.tmdb_id).toBe(76600);
        expect(row.imdb_id).toBe('tt1630029');
        expect(row.backdrop_path).toBe('/avatar.jpg');
        expect(row.popularity).toBe(900.1);
        expect(parse(row.category_ids).sort()).toEqual(['src_vod_5', 'src_vod_9']);
    });
});
