import { describe, it, expect, vi } from 'vitest';
import { StalkerClient } from '../stalker-client';

/**
 * Portal-side search semantics, as measured against two live middlewares:
 * `search` rides on `get_ordered_list`, is a literal case-insensitive substring
 * test, and `p=0`/`p=1` can both mean the first page.
 */

function mockClient(sourceId: string) {
    const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:01' }, sourceId);
    // Search always establishes a session first; stub it so these tests exercise the
    // walk itself rather than the handshake.
    vi.spyOn(client as any, 'ensureToken').mockResolvedValue(undefined);
    return client;
}

/** Every mock must answer the session calls the client makes before a list request. */
function sessionResponse(action: string) {
    if (action === 'handshake') return { js: { token: 'test-token' } };
    if (action === 'get_profile') return { js: {} };
    return null;
}

function page(items: any[], total: number, pageSize = 14) {
    return { js: { data: items, total_items: total, max_page_items: pageSize } };
}

const itemsFrom = (prefix: string, from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
        id: `${from + i}`,
        name: `${prefix} ${from + i}`,
        screenshot_uri: `http://img/${from + i}.jpg`,
        cmd: `/media/${from + i}.mpg`,
    }));

/** Inclusive id range, as string ids, for the page-shape tests. */
const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

describe('StalkerClient.searchVod', () => {
    it('sends the query verbatim and maps hits like getVodStreams', async () => {
        const client = mockClient('src');
        const listRequests: any[] = [];

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            listRequests.push(params);
            return page(
                [
                    { id: '1', name: 'Avatar', screenshot_uri: 'http://img/1.jpg', cmd: '/media/1.mpg', year: '2009' },
                    { id: '2', name: 'Avatar 2', screenshot_uri: 'http://img/2.jpg', cmd: '/media/2.mpg' },
                ],
                2,
                14
            );
        });

        const result = await client.searchVod('Avatar');

        expect(listRequests).toHaveLength(1);
        expect(listRequests[0].search).toBe('Avatar');
        expect(listRequests[0].category).toBe('*');
        expect(result.total).toBe(2);
        expect(result.phrase).toBe('Avatar');
        expect(result.hasMore).toBe(false);
        expect(result.unsupported).toBe(false);
        expect(result.items.map(i => i.stream_id)).toEqual(['src_vod_1', 'src_vod_2']);
        expect(result.items[0].direct_url).toBe('stalker_vod:1:/media/1.mpg');
        expect(result.items[0].source_id).toBe('src');
        expect(result.items[0].epg_channel_id).toBe('');
    });

    it('gives a hit the category the portal reports, so it is browsable outside the search', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            return page(
                [
                    // Ministra answers each row with its own category_id / category_id_1
                    { id: '1', name: 'Avatar', category_id: '13', category_id_1: '103' },
                    // "0" means "none" on these portals and must not become a category
                    { id: '2', name: 'Avatar 2', category_id: '0', category_id_1: '0' },
                ],
                2,
                14
            );
        });

        const wholeLibrary = await client.searchVod('Avatar');
        expect(wholeLibrary.items[0].category_ids).toEqual(['src_vod_13', 'src_vod_103']);
        expect(wholeLibrary.items[1].category_ids).toEqual([]);

        const scoped = await client.searchVod('Avatar', { categoryId: 'src_vod_5' });
        expect(scoped.items[0].category_ids).toEqual(['src_vod_5', 'src_vod_13', 'src_vod_103']);
    });

    it('namespaces a series hit into the series category list', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            return page([{ id: '9', name: 'Avatar the Last Airbender', is_series: '1', category_id: '7' }], 1, 14);
        });

        const result = await client.searchSeries('avatar');
        expect(result.items[0].category_ids).toEqual(['src_series_7']);
    });

    it('strips the app source prefix so the portal sees its own category id', async () => {
        const client = mockClient('src');
        const listRequests: any[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            listRequests.push(params);
            return page([{ id: '7', name: 'Alien', screenshot_uri: '' }], 1, 14);
        });

        await client.searchVod('Alien', { categoryId: 'src_vod_5' });
        expect(listRequests[0].category).toBe('5');

        await client.searchVod('Alien', { categoryId: 'src_series_9' });
        expect(listRequests[1].category).toBe('9');
    });

    it('retries a multi-word query as its longest word and narrows to items carrying every word', async () => {
        const client = mockClient('src');
        const searched: string[] = [];

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            if (params.search === 'avatar way') {
                // The portal matches the string literally, so the full phrase finds nothing.
                return page([], 0, 14);
            }
            // ...and this one treats a typed % literally too, so the wildcard form is a miss
            // and the oldest fallback is the one that answers.
            if (params.search.includes('%')) return page([], 0, 14);
            if (params.search === 'avatar') {
                return page(
                    [
                        { id: '1', name: 'Avatar' },
                        { id: '2', name: 'Avatar: The Way of Water' },
                        { id: '3', name: 'Avatar 4K' },
                    ],
                    3,
                    14
                );
            }
            return page([], 0, 14);
        });

        const result = await client.searchVod('avatar way');

        // Verbatim, the wildcard form, the longest word — then one discovery request for the
        // trailing `%avatar%`, which is what tells the client not to bother next time.
        expect(searched).toEqual(['avatar way', 'avatar%way', 'avatar', '%avatar%']);
        expect(result.phrase).toBe('avatar');
        expect(result.matchKind).toBe('word');
        expect(result.items.map(i => i.stream_id)).toEqual(['src_vod_2']);
        // The walk consumed every page, so the narrowed count is the real answer — the
        // provider's 3 (which included the two words that no longer match) is not.
        expect(result.total).toBe(1);
        expect(result.hasMore).toBe(false);
    });

    /**
     * Local narrowing has to survive a non-Latin alphabet or it silently stops narrowing.
     *
     * An ASCII-only character class (`[^a-z0-9]`) reduces a Cyrillic, Greek, Arabic or CJK
     * query to an empty needle, which matches nothing — so a fallback walk kept its broad
     * list and every item looked like it failed the word check.
     */
    it('narrows a non-Latin query by its words instead of erasing them', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            if (params.search === 'думки вголос') return page([], 0, 14);
            if (params.search.includes('%')) return page([], 0, 14);
            return page(
                [
                    { id: '1', name: 'Думки вголос' },
                    { id: '2', name: 'Інший фільм' },
                ],
                2,
                14
            );
        });

        const result = await client.searchVod('думки вголос');

        expect(result.phrase).toBe('вголос');
        expect(result.items.map(i => i.stream_id)).toEqual(['src_vod_1']);
    });

    it('folds accents, so a typed query and a title agree without the diacritic', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            if (params.search === 'amelie paris') return page([], 0, 14);
            if (params.search.includes('%')) return page([], 0, 14);
            return page(
                [
                    { id: '1', name: 'Amélie à Paris' },
                    { id: '2', name: 'Amélie' },
                ],
                2,
                14
            );
        });

        const result = await client.searchVod('amelie paris');

        expect(result.phrase).toBe('amelie');
        expect(result.items.map(i => i.stream_id)).toEqual(['src_vod_1']);
    });

    /**
     * The wildcard tier, as measured on a real portal: `search` is interpolated raw into the
     * middleware's own `LIKE '%…%'`, so `%` reaches the query as a wildcard and `avatar%way`
     * finds "Avatar: The Way of Water" where the literal pair finds nothing — 7 rows instead
     * of 0, filtered server-side rather than by walking a wider set and narrowing locally.
     *
     * The joined set is a subset of what the longest-word path would have returned (every
     * match carries the longest word by construction), so this can only remove noise — it
     * never drops a row the older path would have shown for the same word order.
     */
    it('finds a multi-word query through the portal’s own % wildcard', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            if (params.search === 'avatar%way') {
                return page(
                    [
                        { id: '7', name: 'Avatar: The Way of Water' },
                        { id: '8', name: 'Avatar: The Way of Water (Hindi)' },
                    ],
                    2,
                    14
                );
            }
            return page([], 0, 14);
        });

        const result = await client.searchVod('avatar way');

        // The literal pair, then the wildcard form — the longest word is never needed.
        expect(searched).toEqual(['avatar way', 'avatar%way']);
        expect(result.phrase).toBe('avatar%way');
        expect(result.matchKind).toBe('all-words');
        expect(result.items.map(i => i.name)).toEqual([
            'Avatar: The Way of Water',
            'Avatar: The Way of Water (Hindi)',
        ]);
        expect((client as any).searchWildcards).toBe(true);
    });

    it('keeps using the longest word when the portal treats % literally, and stops asking', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            // Literal substring matching: anything containing % finds nothing at all.
            if (params.search.includes('%')) return page([], 0, 14);
            if (params.search === 'avatar') {
                return page(
                    [
                        { id: '1', name: 'Avatar' },
                        { id: '2', name: 'Avatar: The Way of Water' },
                    ],
                    2,
                    14
                );
            }
            return page([], 0, 14);
        });

        const result = await client.searchVod('avatar way');

        expect(result.phrase).toBe('avatar');
        expect(result.matchKind).toBe('word');
        // Narrowed locally, because the portal could not do it: only the row that carries
        // both words survives, and the broad list is what the portal actually returned.
        expect(result.items.map(i => i.stream_id)).toEqual(['src_vod_2']);
        expect((client as any).searchWildcards).toBe(false);

        // One discovery request ever: the next multi-word search skips the wildcard form.
        searched.length = 0;
        await client.searchVod('avatar way');
        expect(searched).toEqual(['avatar way', 'avatar']);
    });

    it('settles wildcard support once, against a phrase already known to match', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            if (params.search === 'avatar') {
                return page([{ id: '1', name: 'Avatar' }], 1, 14);
            }
            if (params.search === '%avatar%') {
                // Same query once the wildcard expands — proof the portal honours it.
                return page([{ id: '1', name: 'Avatar' }], 1, 14);
            }
            return page([], 0, 14);
        });

        // The words exist, but not in that order anywhere on this portal.
        await client.searchVod('way avatar');
        expect(searched).toEqual(['way avatar', 'way%avatar', 'avatar', '%avatar%']);
        expect((client as any).searchWildcards).toBe(true);

        // Now the tier is known to be live, a later query tries it again — and does not probe.
        searched.length = 0;
        await client.searchVod('water avatar');
        expect(searched).toEqual(['water avatar', 'water%avatar', 'avatar']);
    });

    it('reads a count-less portal as honouring the wildcard when the probe returns rows', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            // A middleware that answers with a bare array, so `extractOrderedList` has no
            // `total_items` to read — and a count read as zero would latch the wildcard off.
            if (params.search === '%avatar%') return [{ id: '1', name: 'Avatar' }];
            if (params.search === 'avatar') return [{ id: '1', name: 'Avatar' }];
            return [];
        });

        // The words exist, but not in that order; the wildcard form is answered by a row that
        // does not carry both words, so the longest word wins and the probe then runs.
        const result = await client.searchVod('way avatar');
        expect(result.matchKind).toBe('word');
        expect(searched).toEqual(['way avatar', 'way%avatar', 'avatar', '%avatar%']);
        expect((client as any).searchWildcards).toBe(true);
    });

    /**
     * A wider form is only an answer if the list being searched can show it.
     *
     * Measured on a portal tested here: `water%avatar` is answered by one row, and that row
     * is an `is_series` entry — so a movie search that stopped there would show nothing at
     * all, where the longest-word form still reaches the titles whose words are in the other
     * order ("Avatar: The Way of Water"). The wildcard is also only trusted when a title's
     * own name carries every typed word, because this portal tests plot summaries too.
     */
    it('keeps looking when the wildcard form only found rows this list filters out', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            if (params.search === 'water%avatar') {
                // A real in-order match — but it is a series entry, which a movie list drops.
                return page([{ id: '9', name: 'Fire and Water: Making the Avatar Films', is_series: '1' }], 1, 14);
            }
            if (params.search === 'avatar') {
                return page(
                    [
                        { id: '1', name: 'Avatar' },
                        { id: '2', name: 'Avatar: The Way of Water' },
                    ],
                    2,
                    14
                );
            }
            return page([], 0, 14);
        });

        const result = await client.searchVod('water avatar');

        expect(searched).toEqual(['water avatar', 'water%avatar', 'avatar', '%avatar%']);
        expect(result.phrase).toBe('avatar');
        expect(result.matchKind).toBe('word');
        // The row that actually carries both words, whichever order they were typed in.
        expect(result.items.map(i => i.name)).toEqual(['Avatar: The Way of Water']);
    });

    it('ignores a wildcard hit whose title carries only some of the words', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            if (params.search === 'water%avatar') {
                // Matched on a plot summary, not on the title: not an answer to this query.
                return page([{ id: '9', name: 'Blue Planet' }], 1, 14);
            }
            if (params.search === 'avatar') {
                return page([{ id: '2', name: 'Avatar: The Way of Water' }], 1, 14);
            }
            return page([], 0, 14);
        });

        const result = await client.searchVod('water avatar');

        expect(searched).toEqual(['water avatar', 'water%avatar', 'avatar', '%avatar%']);
        expect(result.matchKind).toBe('word');
        expect(result.items.map(i => i.stream_id)).toEqual(['src_vod_2']);
    });

    it('never lets a typed % or _ widen the query into the whole catalogue', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            return page([], 0, 14);
        });

        // A bare % returns every title on a portal that interpolates it (100,560 measured),
        // so the wildcard form is built from the words only, with any typed wildcard dropped.
        await client.searchVod('100% wolf');
        expect(searched).toEqual(['100% wolf', '100%wolf', '100%']);

        // A query made only of wildcards cannot produce a wildcard candidate at all — the
        // words leave nothing behind once they are stripped.
        searched.length = 0;
        await client.searchVod('%% __');
        expect(searched).toEqual(['%% __']);

        // The longest word must not be a bare wildcard either: '%%' on a portal that
        // interpolates it is the same query as '%', i.e. the whole catalogue.
        searched.length = 0;
        await client.searchVod('a %%');
        expect(searched).toEqual(['a %%', 'a']);
    });

    it('keeps the broad results and reports the phrase actually searched when no loaded item carries every word', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            if (params.search === 'avatar zzz') return page([], 0, 14);
            if (params.search.includes('%')) return page([], 0, 14);
            return page(
                [
                    { id: '1', name: 'Avatar' },
                    { id: '2', name: 'Avatar 2' },
                ],
                2,
                14
            );
        });

        const result = await client.searchVod('avatar zzz');
        expect(result.phrase).toBe('avatar');
        expect(result.items).toHaveLength(2);
    });

    /**
     * The resuming caller is what makes a multi-word search paginate.
     *
     * The verbatim→longest-word retry runs on page 0 only, so "Show more" has to hand
     * back the phrase that page settled on. Sending the user's own words again asks the
     * portal for the string it has already answered with nothing: an empty page, no
     * `hasMore`, and a result set that can never be extended.
     */
    it('resumes a multi-word search on the phrase the first page settled on', async () => {
        const client = mockClient('src');
        const searched: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            searched.push(params.search);
            // Literal substring matching: the two-word phrase is in no title, any page.
            if (params.search !== 'avatar') return page([], 0, 2);
            const p = Number(params.p);
            return p <= 1 ? page(itemsFrom('Avatar', 1, 2), 6, 2) : page(itemsFrom('Avatar', 3, 2), 6, 2);
        });

        const first = await client.searchVod('avatar way', { maxPages: 1 });
        // Verbatim, the wildcard form (a miss on this literal portal), then the fallback word
        // twice — the page itself, then the probe that learns the page numbering — and one
        // discovery request for the trailing %avatar%.
        expect(searched).toEqual(['avatar way', 'avatar%way', 'avatar', 'avatar', '%avatar%']);
        expect(first.phrase).toBe('avatar');
        expect(first.items.map(i => i.stream_id)).toEqual(['src_vod_1', 'src_vod_2']);
        expect(first.hasMore).toBe(true);

        // What the view does now: resume with the phrase that was actually searched.
        searched.length = 0;
        const resumed = await client.searchVod('avatar way', {
            fromPage: first.nextPage,
            maxPages: 1,
            phrase: first.phrase,
        });
        expect(searched).toEqual(['avatar']);
        expect(resumed.items.map(i => i.stream_id)).toEqual(['src_vod_3', 'src_vod_4']);

        // And the shape of the bug this guards: a resume that omits the phrase can only
        // repeat the user's words, which comes back empty and ends the walk.
        searched.length = 0;
        const naive = await client.searchVod('avatar way', { fromPage: first.nextPage, maxPages: 1 });
        expect(searched).toEqual(['avatar way']);
        expect(naive.items).toEqual([]);
        expect(naive.hasMore).toBe(false);
    });

    it('walks a 1-based portal by detecting that p=1 repeats p=0', async () => {
        const client = mockClient('src');
        const pagesRequested: string[] = [];
        const firstPage = itemsFrom('X', 1, 14);
        const secondPage = itemsFrom('X', 15, 14);

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            pagesRequested.push(params.p);
            if (params.p === '0' || params.p === '1') return page(firstPage, 28, 14);
            if (params.p === '2') return page(secondPage, 28, 14);
            return page([], 28, 14);
        });

        const result = await client.searchVod('X', { maxPages: 3 });

        expect((client as any).pageOffset).toBe(1);
        expect(pagesRequested).toEqual(['0', '1', '2', '3']);
        expect(result.items).toHaveLength(28);
        expect(result.items[0].stream_id).toBe('src_vod_1');
        expect(result.items[27].stream_id).toBe('src_vod_28');
        // Data pages 1-3 were consumed, so a resumed walk must ask for p=4 next.
        expect(result.nextPage).toBe(3);
    });

    it('resumes a searched walk and reconciles the provider total to what the list can hold', async () => {
        // The shape a real portal returns for a 61-row search, measured live: the searched
        // pages overlap (so a batch of 4 pages holds 46 distinct rows, not 56), page 1
        // repeats page 0, and `total_items` counts rows this movie list filters out
        // (`is_series` entries) — 61 raw, 49 movies. So the first batch must report 46 of
        // 61 with more to come, and finishing the walk must land on 49, not 61.
        const client = mockClient('src');
        const pageIds: Record<string, string[]> = {
            '0': range(1, 14),
            '1': range(1, 14),   // the 1-based portal repeats page 0 at p=1
            '2': range(11, 24),
            '3': range(21, 34),
            '4': range(33, 46),
            '5': range(47, 49),
        };
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            const ids = pageIds[params.p] ?? [];
            return page(ids.map(id => ({ id, name: `Avatar ${id}` })), 61, 14);
        });

        const first = await client.searchVod('avatar', { maxPages: 4 });
        expect(first.items).toHaveLength(46);
        expect(first.total).toBe(61);
        expect(first.hasMore).toBe(true);
        expect(first.nextPage).toBe(4);

        // "Load all": one call spending the rest of the budget, which is what the button
        // does now — a page count derived from `total` would ask for one page (or none).
        const rest = await client.searchVod('avatar', { fromPage: first.nextPage, maxPages: 11 });
        expect(rest.items).toHaveLength(3);
        expect(rest.hasMore).toBe(false);
        expect(rest.total).toBe(3);

        const ids = new Set([...first.items, ...rest.items].map(i => i.stream_id));
        expect(ids.size).toBe(49);
    });

    it('never fetches more pages than the caller asked for', async () => {
        const client = mockClient('src');
        const pagesRequested: string[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            pagesRequested.push(params.p);
            const p = parseInt(params.p, 10);
            return page(itemsFrom('X', p * 14 + 1, 14), 140, 14);
        });

        const result = await client.searchVod('X', { maxPages: 2 });
        expect(result.items).toHaveLength(28);
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(2);
        // page 0 + the page-numbering probe + page 1, and nothing beyond the bound
        expect(pagesRequested.filter(p => p === '3')).toHaveLength(0);
    });

    it('reports a portal that ignores the search parameter', async () => {
        const client = mockClient('src');
        const bySearch: Array<string | undefined> = [];

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            bySearch.push(params.search);
            // Same catalogue, same total, whether or not `search` was sent.
            return page(
                [
                    { id: '1', name: 'Movie Channel One' },
                    { id: '2', name: 'Movie Channel Two' },
                ],
                6477,
                14
            );
        });

        const result = await client.searchVod('sky');

        expect(bySearch).toEqual(['sky', undefined]);
        expect(result.unsupported).toBe(true);
        // The rows are still returned: the caller decides how to present them.
        expect(result.items).toHaveLength(2);
    });

    it('does not claim a portal ignores search when the term matches what it returned', async () => {
        const client = mockClient('src');
        const bySearch: Array<string | undefined> = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            bySearch.push(params.search);
            return page([{ id: '1', name: 'Sky Sports 1' }], 1, 14);
        });

        const result = await client.searchVod('sky');
        expect(result.unsupported).toBe(false);
        expect(bySearch).toEqual(['sky']);
    });
});

describe('StalkerClient.searchSeries', () => {
    it('filters series out of a VOD search', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            if (params.search === 'avatar') {
                return page(
                    [
                        { id: '1', name: 'Avatar', is_series: '0' },
                        { id: '2', name: 'Avatar: The Last Airbender', is_series: '1' },
                    ],
                    2,
                    14
                );
            }
            return page([], 0, 14);
        });

        const movies = await client.searchVod('avatar');
        expect(movies.items.map(i => i.stream_id)).toEqual(['src_vod_1']);
        // The portal counted 2 matches (one of them a series); the movie list must not
        // claim there are two films on the server.
        expect(movies.total).toBe(1);
    });

    it('keeps the provider total as an upper bound while pages remain', async () => {
        const client = mockClient('src');
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, _type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            const p = parseInt(params.p, 10);
            return page(itemsFrom('Avatar', p * 14 + 1, 14), 140, 14);
        });

        const result = await client.searchVod('Avatar', { maxPages: 2 });
        expect(result.items).toHaveLength(28);
        expect(result.total).toBe(140);
        expect(result.hasMore).toBe(true);
    });

    it('falls back to the VOD endpoint when the portal serves no type=series list', async () => {
        const client = mockClient('src');
        const types: string[] = [];

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            types.push(type);
            // Portals that serve no `type=series` list at all (only a VOD list to filter)
            if (type === 'series') return page([], 0, 14);
            return page(
                [
                    { id: '9', name: 'Avatar the Last Airbender', is_series: '1' },
                    { id: '10', name: 'Avatar Movie', is_series: '0' },
                ],
                2,
                14
            );
        });

        const result = await client.searchSeries('avatar');

        expect(types).toEqual(['series', 'vod']);
        expect(result.endpoint).toBe('vod');
        expect(result.items.map(i => i.stream_id)).toEqual(['src_series_9']);
        expect(result.items[0].direct_url).toBe('stalker_series:9:/media/9.mpg');
        expect(result.items[0].source_id).toBe('src');
    });

    it('keeps the endpoint it settled on when a series walk resumes, and stays series-only', async () => {
        const client = mockClient('src');
        const types: string[] = [];
        // As on a client that has already served a category: the page-numbering probe is a
        // first-page-of-the-session cost, and it spends one page of the batch's budget.
        (client as any).pageOffset = 0;
        // The VOD list carries films and `is_series` entries side by side, so the fixture is
        // deliberately mixed — one row in four is a film. A fixture of pure series would hide
        // a resume that forgot to filter them out, and those films would be stored as series.
        const mixedPage = (from: number) =>
            itemsFrom('Avatar', from, 14).map((item, index) => ({
                ...item,
                is_series: index % 4 === 3 ? '0' : '1',
            }));
        const seriesIdsOnPage = (from: number) =>
            mixedPage(from).filter(i => i.is_series === '1').map(i => `src_series_${i.id}`);

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            types.push(type);
            // A portal with no `type=series` list at all: only the VOD endpoint has the titles.
            if (type === 'series') return page([], 0, 14);
            const p = parseInt(params.p, 10);
            return page(mixedPage(p * 14 + 1), 28, 14);
        });

        const first = await client.searchSeries('avatar', { maxPages: 1 });
        expect(types).toEqual(['series', 'vod']);
        expect(first.endpoint).toBe('vod');
        expect(first.hasMore).toBe(true);
        expect(first.items.map(i => i.stream_id)).toEqual(seriesIdsOnPage(1));

        const rest = await client.searchSeries('avatar', {
            fromPage: first.nextPage,
            maxPages: 1,
            phrase: first.phrase,
            endpoint: first.endpoint,
        });

        // Settled on page 0: a resume must not spend a request proving `type=series` empty again.
        expect(types).toEqual(['series', 'vod', 'vod']);
        expect(rest.endpoint).toBe('vod');
        expect(rest.items.map(i => i.stream_id)).toEqual(seriesIdsOnPage(15));
    });

    it('does not switch endpoints when a resumed series page comes back empty', async () => {
        const client = mockClient('src');
        const types: string[] = [];
        (client as any).pageOffset = 0;

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const session = sessionResponse(action);
            if (session) return session;
            types.push(type);
            // The trap the endpoint commit exists for: this offset of the *VOD* list does hold
            // `is_series` rows, so a resume that re-ran the fallback would splice them into a
            // walk that was already using `type=series` (and quote their page numbers).
            if (type === 'vod') return page([{ id: '1', name: 'Avatar', is_series: '1' }], 1, 14);
            const p = parseInt(params.p, 10);
            return p === 0
                ? page(itemsFrom('Avatar', 1, 14).map(i => ({ ...i, is_series: '1' })), 20, 14)
                : page([], 20, 14);
        });

        const first = await client.searchSeries('avatar', { maxPages: 1 });
        expect(first.endpoint).toBe('series');
        expect(first.hasMore).toBe(true);

        const rest = await client.searchSeries('avatar', {
            fromPage: first.nextPage,
            maxPages: 1,
            phrase: first.phrase,
            endpoint: first.endpoint,
        });

        expect(types).toEqual(['series', 'series']);
        expect(rest.endpoint).toBe('series');
        expect(rest.items).toEqual([]);
    });
});
