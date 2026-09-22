import { describe, it, expect, vi } from 'vitest';
import { StalkerClient } from '../stalker-client';

/**
 * The portal in the report pages every `get_ordered_list` response at 14 items
 * (`max_page_items: 14`) and only ever answered for one page, so a season with 24 episodes
 * came back as its first 14 and looked complete.
 */
const PAGE_SIZE = 14;

interface OrderedListRequest {
    type: string;
    p: number;
    movieId: string;
    seasonId: string;
}

interface PortalConfig {
    seasons: Array<Record<string, any>>;
    episodesBySeasonId: Record<string, Array<Record<string, any>>>;
    /** This portal answered `type=series` with `{"js":false,"text":"generated in..."}`. */
    seriesTypeReturnsEmptyJson?: boolean;
    /** Pages (`${seasonId}:${p}`) that fail on every attempt. */
    failPages?: Set<string>;
    /** Portals that ignore paging return everything on p=0. */
    ignoresPaging?: boolean;
    /** Portals that omit total_items for these responses. */
    omitsTotalItems?: boolean;
    requests: OrderedListRequest[];
}

function createPortal(config: PortalConfig) {
    return async (_action: any, type: any, params: any) => {
        const p = parseInt(params.p, 10);
        const seasonId = params.season_id ?? '0';
        config.requests.push({ type, p, movieId: params.movie_id, seasonId });

        if (type === 'series' && seasonId === '0' && config.seriesTypeReturnsEmptyJson) {
            return { js: false, text: 'generated in: 0.02s; query counter: 2; cache hits: 0;' };
        }

        if (config.failPages?.has(`${seasonId}:${p}`)) {
            throw new Error(`Timeout on season ${seasonId} page ${p}`);
        }

        const all = seasonId === '0'
            ? config.seasons
            : (config.episodesBySeasonId[seasonId] ?? []);
        const items = config.ignoresPaging ? all : all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

        return {
            ...(config.omitsTotalItems ? {} : { total_items: String(all.length) }),
            max_page_items: PAGE_SIZE,
            selected_item: 0,
            cur_page: p,
            data: items,
        };
    };
}

/** A 24-episode season, the shape the report came from. */
function season137(episodeCount: number) {
    return {
        id: '137',
        video_id: '5184',
        season_number: '1',
        season_name: '24 - Season 1',
        season_original_name: '24 - Season 1',
        season_series: '24',
        date_add: '2016-09-23 14:55:03',
        date_modify: '2016-09-23 14:55:03',
        name: 'Season 1. 24 - Season 1',
        is_season: true,
    };
}

function episodes(seasonId: string, count: number) {
    return Array.from({ length: count }, (_, i) => ({
        id: `${seasonId}_ep_${i + 1}`,
        video_id: '5184',
        series_number: String(i + 1),
        name: `Episode ${i + 1}`,
        cmd: `/media/file_${seasonId}_${i + 1}.mpg`,
    }));
}

function createClient(sourceId: string) {
    const client = new StalkerClient(
        { baseUrl: 'http://test.portal/stalker_portal/c/', mac: '00:1A:79:00:00:01' },
        sourceId
    );
    vi.spyOn(client as any, 'ensureToken').mockResolvedValue(undefined);
    return client;
}

describe('StalkerClient season/episode pagination', () => {
    it('returns every episode of a season that spills onto a second page', async () => {
        const requests: OrderedListRequest[] = [];
        const client = createClient('source_pages');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            requests,
        }));

        const seasons = await client.getSeriesInfo('5184');

        expect(seasons).toHaveLength(1);
        expect(seasons[0].season_number).toBe(1);
        expect(seasons[0].episodes).toHaveLength(24);
        expect(seasons[0].episodes.map(e => e.episode_num)).toEqual(
            Array.from({ length: 24 }, (_, i) => i + 1)
        );
        // The second page must have been requested rather than the first page being taken as
        // the whole season.
        expect(requests.some(r => r.seasonId === '137' && r.p === 1)).toBe(true);
    });

    it('keeps the episode ids and commands of the episodes it recovers from page 2', async () => {
        const client = createClient('source_ids');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            requests: [],
        }));

        const [season] = await client.getSeriesInfo('5184');
        const last = season.episodes[23];

        expect(last.id).toBe('source_ids_episode_137_ep_24');
        expect(last.direct_url).toContain('"episodeId":"137_ep_24"');
        expect(last.direct_url).toContain('/media/file_137_24.mpg');
    });

    it('falls back to type=vod when type=series returns {"js":false}, still paging the episodes', async () => {
        const requests: OrderedListRequest[] = [];
        const client = createClient('source_fallback');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            seriesTypeReturnsEmptyJson: true,
            requests,
        }));

        const seasons = await client.getSeriesInfo('5184');

        expect(seasons).toHaveLength(1);
        expect(seasons[0].episodes).toHaveLength(24);
        expect(requests.some(r => r.type === 'vod' && r.seasonId === '0')).toBe(true);
    });

    it('returns every season when the season list itself needs a second page', async () => {
        const requests: OrderedListRequest[] = [];
        const client = createClient('source_seasons');
        const manySeasons = Array.from({ length: 20 }, (_, i) => ({
            ...season137(0),
            id: `season_${i + 1}`,
            season_number: String(i + 1),
            name: `Season ${i + 1}`,
        }));
        const episodesBySeasonId: Record<string, Array<Record<string, any>>> = {};
        for (const season of manySeasons) episodesBySeasonId[season.id] = episodes(season.id, 2);

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: manySeasons,
            episodesBySeasonId,
            requests,
        }));

        const seasons = await client.getSeasons('5184');

        expect(seasons).toHaveLength(20);
        expect(seasons[0].episodes).toHaveLength(2);
        expect(seasons[19].season_number).toBe(20);
    });

    it('pages the episodes returned by getEpisodes too', async () => {
        const client = createClient('source_get');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            requests: [],
        }));

        const result = await client.getEpisodes('source_get_series_5184', '137');

        expect(result).toHaveLength(24);
        expect(result.map(e => e.episode_num)).toEqual(
            Array.from({ length: 24 }, (_, i) => i + 1)
        );
    });

    it('keeps the first page of a season when a later page can never be retrieved', async () => {
        const client = createClient('source_partial');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            failPages: new Set(['137:1']),
            requests: [],
        }));

        const seasons = await client.getSeriesInfo('5184');

        // A missing page must not cost the episodes that were already reachable.
        expect(seasons).toHaveLength(1);
        expect(seasons[0].episodes).toHaveLength(PAGE_SIZE);
    });

    it('makes a single request for a season that fits on one page', async () => {
        const requests: OrderedListRequest[] = [];
        const client = createClient('source_single');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(5)],
            episodesBySeasonId: { '137': episodes('137', 5) },
            requests,
        }));

        const seasons = await client.getSeriesInfo('5184');
        const episodeRequests = requests.filter(r => r.seasonId === '137');

        expect(seasons[0].episodes).toHaveLength(5);
        expect(episodeRequests).toHaveLength(1);
        expect(episodeRequests[0].p).toBe(0);
    });

    it('pages a season on a portal that reports no total_items', async () => {
        const client = createClient('source_nometa');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            omitsTotalItems: true,
            requests: [],
        }));

        const seasons = await client.getSeriesInfo('5184');

        expect(seasons[0].episodes).toHaveLength(24);
    });

    it('returns the whole list from a portal that ignores p and stops instead of looping', async () => {
        const requests: OrderedListRequest[] = [];
        const client = createClient('source_flat');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createPortal({
            seasons: [season137(24)],
            episodesBySeasonId: { '137': episodes('137', 24) },
            ignoresPaging: true,
            requests,
        }));

        const seasons = await client.getSeriesInfo('5184');
        const episodePages = requests.filter(r => r.seasonId === '137').map(r => r.p);

        // Every episode is returned, and the repeated-page guard ends the walk after its
        // offset probe rather than asking for page after page of the same items.
        expect(seasons[0].episodes).toHaveLength(24);
        expect(episodePages[0]).toBe(0);
        expect(episodePages.length).toBeLessThan(5);
    });
});
