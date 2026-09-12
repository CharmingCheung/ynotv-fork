import { describe, it, expect, vi } from 'vitest';
import { StalkerClient } from '../stalker-client';

describe('StalkerClient fetchOrderedListPages', () => {
    it('assembles items across multiple pages in correct numerical order', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:01' }, 'source_1');

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            return {
                js: {
                    total_items: 4,
                    max_page_items: 2,
                    data: [
                        { id: `item_${pageNum}_0`, name: `Item ${pageNum}-0` },
                        { id: `item_${pageNum}_1`, name: `Item ${pageNum}-1` },
                    ]
                }
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '1' }, 2);
        expect(items.length).toBe(4);
        expect(items[0].id).toBe('item_0_0');
        expect(items[1].id).toBe('item_0_1');
        expect(items[2].id).toBe('item_1_0');
        expect(items[3].id).toBe('item_1_1');
    });

    it('retries failed pages at the end and preserves ordering', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:02' }, 'source_2');

        let page1Attempts = 0;
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            if (pageNum === 1) {
                page1Attempts++;
                if (page1Attempts === 1) {
                    throw new Error('Network glitch on page 1');
                }
            }
            return {
                js: {
                    total_items: 6,
                    max_page_items: 2,
                    data: [
                        { id: `item_${pageNum}_0`, name: `Item ${pageNum}-0` },
                        { id: `item_${pageNum}_1`, name: `Item ${pageNum}-1` },
                    ]
                }
            };
        });

        // Batch 1 fetches page 0, 1 (page 1 fails). Batch 2 fetches page 2.
        const items = await (client as any).fetchOrderedListPages('vod', { category: '1' }, 2);
        expect(page1Attempts).toBe(2); // Failed once in batch, succeeded in retry pass
        expect(items.length).toBe(6);
        // Order should be natural: page 0, page 1, page 2
        expect(items[0].id).toBe('item_0_0');
        expect(items[1].id).toBe('item_0_1');
        expect(items[2].id).toBe('item_1_0');
        expect(items[3].id).toBe('item_1_1');
        expect(items[4].id).toBe('item_2_0');
        expect(items[5].id).toBe('item_2_1');
    });

    it('throws an error if 100% of pages fail', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:03' }, 'source_3');

        vi.spyOn(client as any, 'fetchStalker').mockRejectedValue(new Error('Portal offline'));

        // Page 0 is probed first, so a total outage surfaces as a missing page 0.
        await expect(
            (client as any).fetchOrderedListPages('vod', { category: '1' }, 4)
        ).rejects.toThrow('Failed to load vod category: page 0 could not be retrieved');
    });

    it('throws when a trailing page fails permanently instead of silently caching a truncated category', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:03' }, 'source_tail');

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            if (pageNum === 2) {
                throw new Error('Timeout on final page');
            }
            return {
                js: {
                    total_items: 42, // 3 pages of 14
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${pageNum}_${i}` })),
                },
            };
        });

        // Pages 0 and 1 succeed and page 2 (the last) fails both initially and on retry:
        // the partial result must be rejected, never returned as a complete category.
        await expect(
            (client as any).fetchOrderedListPages('vod', { category: '1' }, 2)
        ).rejects.toThrow('Failed to load vod category: page 2 could not be retrieved after retries');
    });

    it('never requests pages beyond the provider total_pages, even on the first batch', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:03' }, 'source_bound');

        const fetchedPages: number[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            fetchedPages.push(pageNum);
            return {
                js: {
                    total_items: 42, // 3 pages of 14
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${pageNum}_${i}` })),
                },
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '1' }, 12);

        // Concurrency 12 must not overshoot the 3 real pages.
        expect(fetchedPages).toEqual([0, 1, 2]);
        expect(items.length).toBe(42);
    });

    it('clamps batch size to remaining pages so no extra requests are made', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:04' }, 'source_4');

        const fetchedPages: number[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            fetchedPages.push(pageNum);
            return {
                js: {
                    total_items: 42, // 3 pages of 14 items
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${pageNum}_${i}` }))
                }
            };
        });

        // Concurrency 2:
        // Batch 1 fetches page 0, 1. From response, totalPages = 3.
        // Batch 2: page = 2. Remaining pages = 3 - 2 = 1. Even with BATCH_SIZE=2, it only fetches 1 page (page 2).
        await (client as any).fetchOrderedListPages('vod', { category: '1' }, 2);

        expect(fetchedPages).toEqual([0, 1, 2]);
    });

    it('stops pagination cleanly when a metadata-free portal loops repeated items for out-of-range pages', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:05' }, 'source_5');

        const fetchedPages: number[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            fetchedPages.push(pageNum);

            // Portal omits total_items and pages completely
            // Page 0 has items 1..14
            // Page 1 has items 15..28
            // Page 2+ repeats items 1..14 (a buggy offset clamp behavior)
            const isRepeat = pageNum >= 2;
            const prefix = isRepeat ? 0 : pageNum;
            return {
                js: {
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `movie_${prefix}_${i}` }))
                }
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '1' }, 1);

        // Should stop as soon as page 2 repeats all items from page 0
        expect(items.length).toBe(28);
        expect(fetchedPages).toContain(0);
        expect(fetchedPages).toContain(1);
        expect(fetchedPages).toContain(2);
        expect(fetchedPages.includes(3)).toBe(false); // Did not loop endlessly!
    });

    it('throws when page 0 fails permanently even if other pages succeed', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:06' }, 'source_6');

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            if (pageNum === 0) {
                throw new Error('500 Internal Error on page 0');
            }
            return {
                js: {
                    total_items: 28,
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${pageNum}_${i}` }))
                }
            };
        });

        await expect(
            (client as any).fetchOrderedListPages('vod', { category: '1' }, 2)
        ).rejects.toThrow('Failed to load vod category: page 0 could not be retrieved');
    });

    it('throws when an intermediate page has a permanent gap', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:07' }, 'source_7');

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            if (pageNum === 1) {
                throw new Error('Timeout on page 1');
            }
            return {
                js: {
                    total_items: 42,
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${pageNum}_${i}` }))
                }
            };
        });

        await expect(
            (client as any).fetchOrderedListPages('vod', { category: '1' }, 3)
        ).rejects.toThrow('Failed to load vod category: page 1 could not be retrieved after retries');
    });

    it('paginates arbitrarily large categories without hard limit as long as items are unique', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:08' }, 'source_8');

        // Test with 501 pages (7,001 items) to prove no 500-page limit cuts it off
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (action: any, type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            return {
                js: {
                    total_items: 7001,
                    max_page_items: 14,
                    data: Array.from({ length: pageNum === 500 ? 1 : 14 }, (_, i) => ({
                        id: `item_${pageNum}_${i}`
                    }))
                }
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '*' }, 12);
        expect(items.length).toBe(7001);
    });

    /**
     * 1-based portals (the Stalker default) coerce p=0 into page 1, so p=0 and p=1 return the
     * same items. Cycle detection used to treat that as the end of the category, which made a
     * whole category load as a single page of 14 items.
     */
    const createOneBasedPortalMock = (pageCount: number, fetchedPages: number[]) => {
        return async (_action: any, _type: any, params: any) => {
            const requested = parseInt(params.p, 10);
            fetchedPages.push(requested);
            const page = Math.max(1, Math.min(requested, pageCount));
            return {
                js: {
                    total_items: pageCount * 14,
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${page}_${i}` })),
                },
            };
        };
    };

    it('loads the whole category on 1-based portals that repeat p=0 as p=1', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:09' }, 'source_1based');

        const fetchedPages: number[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createOneBasedPortalMock(3, fetchedPages));

        const items = await (client as any).fetchOrderedListPages('vod', { category: '63' }, 4);

        expect(items.length).toBe(42);
        expect(items.map((i: any) => i.id)).toEqual([
            ...Array.from({ length: 14 }, (_, i) => `item_1_${i}`),
            ...Array.from({ length: 14 }, (_, i) => `item_2_${i}`),
            ...Array.from({ length: 14 }, (_, i) => `item_3_${i}`),
        ]);
        // Real pages 2 and 3 must have been requested instead of stopping at the repeat of page 1.
        expect(fetchedPages).toContain(2);
        expect(fetchedPages).toContain(3);
        expect((client as any).pageOffset).toBe(1);
    });

    it('reuses the learned page offset for later categories instead of re-probing', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:10' }, 'source_cached');

        const fetchedPages: number[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(createOneBasedPortalMock(3, fetchedPages));

        await (client as any).fetchOrderedListPages('vod', { category: '63' }, 4);
        fetchedPages.length = 0;
        const items = await (client as any).fetchOrderedListPages('vod', { category: '64' }, 4);

        expect(items.length).toBe(42);
        // The second category skips p=0 entirely and goes straight to pages 1, 2, 3.
        expect(fetchedPages).toEqual([1, 2, 3]);
    });

    it('falls back to p=1 when a strictly 1-based portal rejects p=0', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:11' }, 'source_strict');

        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const requested = parseInt(params.p, 10);
            if (requested === 0) {
                return { js: { data: [] } };
            }
            return {
                js: {
                    total_items: 28,
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${requested}_${i}` })),
                },
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '63' }, 4);

        expect(items.length).toBe(28);
        expect(items[0].id).toBe('item_1_0');
        expect(items[14].id).toBe('item_2_0');
        expect((client as any).pageOffset).toBe(1);
    });

    it('recovers the offset during the walk when the page 1 probe fails, without duplicating or dropping items', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:12' }, 'source_late_shift');

        const fetchedPages: number[] = [];
        let page1Calls = 0;
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const requested = parseInt(params.p, 10);
            fetchedPages.push(requested);
            if (requested === 1) {
                page1Calls++;
                // The two probe attempts fail; the walk's own request then succeeds and reveals the repeat.
                if (page1Calls <= 2) {
                    throw new Error('Transient probe failure');
                }
                // Any further request for page 1 is the redundant retry this test exists to rule out.
                // Failing it (rather than answering with the duplicate page) means a regression can't
                // be hidden by a lucky mock response: it would leave the page pending and abort.
                if (page1Calls > 3) {
                    throw new Error('Unexpected extra request for page 1');
                }
            }
            const page = Math.max(1, Math.min(requested, 3));
            return {
                js: {
                    total_items: 42,
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${page}_${i}` })),
                },
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '63' }, 2);

        // Two probe attempts plus the walk's own read of page 1. The walk resolving the page
        // must clear the failure the probe recorded, so the retry pass does not re-request it.
        expect(page1Calls).toBe(3);
        expect(items.length).toBe(42);
        expect(new Set(items.map((i: any) => i.id)).size).toBe(42);
        expect(items[0].id).toBe('item_1_0');
        expect(items[41].id).toBe('item_3_13');
    });

    it('does not abort a category whose page 1 probe failed but which the walk then fetched', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:16' }, 'source_probe_then_walk');

        let page1Calls = 0;
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const requested = parseInt(params.p, 10);
            if (requested === 1) {
                page1Calls++;
                // Both probe attempts fail (transient outage), then this portal is 0-based so the
                // walk's own request for p=1 is a genuine page and succeeds.
                if (page1Calls <= 2) {
                    throw new Error('Transient probe failure');
                }
                // A second request for the walk's page would be the redundant retry, and it fails:
                // without the walk clearing the probe's failure this aborts the whole category.
                if (page1Calls > 3) {
                    throw new Error('Unexpected extra request for page 1');
                }
            }
            // Genuinely 0-based: p=0 is page 1, so p=1 is a real second page, not a repeat.
            const page = Math.min(requested + 1, 3);
            return {
                js: {
                    total_items: 42,
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${page}_${i}` })),
                },
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '63' }, 2);

        expect(page1Calls).toBe(3);
        expect(items.length).toBe(42);
        expect(items.map((i: any) => i.id)).toEqual([
            ...Array.from({ length: 14 }, (_, i) => `item_1_${i}`),
            ...Array.from({ length: 14 }, (_, i) => `item_2_${i}`),
            ...Array.from({ length: 14 }, (_, i) => `item_3_${i}`),
        ]);
    });

    it('walks the whole category on a metadata-free 1-based portal (no total_items)', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:14' }, 'source_1based_nometa');

        const fetchedPages: number[] = [];
        // Pages 1 and 2 are full, page 3 is short (end of category). No total_items/pages metadata.
        const pageSizes: Record<number, number> = { 1: 14, 2: 14, 3: 5 };
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const requested = parseInt(params.p, 10);
            fetchedPages.push(requested);
            const page = Math.max(1, requested);
            const size = pageSizes[page];
            return {
                js: {
                    max_page_items: 14,
                    data: size == null
                        ? []
                        : Array.from({ length: size }, (_, i) => ({ id: `item_${page}_${i}` })),
                },
            };
        });

        // Concurrency 2 keeps each batch to two pages, so the end of the category is hit exactly.
        const items = await (client as any).fetchOrderedListPages('vod', { category: '63' }, 2);

        expect(items.length).toBe(33);
        expect(items[0].id).toBe('item_1_0');
        expect(items[14].id).toBe('item_2_0');
        expect(items[32].id).toBe('item_3_4');
        // Probe p=0 (which the portal answers with page 1), the p=1 repeat, then real pages 2 and 3.
        // The short page ends the walk without another batch being fired.
        expect(fetchedPages).toEqual([0, 1, 2, 3]);
    });

    it('stops cleanly when every page repeats the first one instead of looping forever', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:13' }, 'source_allrepeats');

        const fetchedPages: number[] = [];
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const requested = parseInt(params.p, 10);
            fetchedPages.push(requested);
            return {
                js: {
                    max_page_items: 14,
                    data: Array.from({ length: 14 }, (_, i) => ({ id: `item_${i}` })),
                },
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '63' }, 4);

        expect(items.length).toBe(14);
        expect(fetchedPages.length).toBeLessThan(10);
    });

    it('treats an empty retry response as the end of the category, not as a missing page', async () => {
        const client = new StalkerClient({ baseUrl: 'http://test.portal/c/', mac: '00:1A:79:00:00:15' }, 'source_empty_retry');

        // No total_items/pages metadata, so the walk can't know where the category ends and
        // speculatively requests one page past it.
        let page3Calls = 0;
        vi.spyOn(client as any, 'fetchStalker').mockImplementation(async (_action: any, _type: any, params: any) => {
            const pageNum = parseInt(params.p, 10);
            if (pageNum === 3) {
                page3Calls++;
                // The speculative request past the end fails; the retry gets the empty list the
                // portal serves for an out-of-range page.
                if (page3Calls === 1) {
                    throw new Error('Transient error past the end of the category');
                }
                return { js: { max_page_items: 14, data: [] } };
            }
            return {
                js: {
                    max_page_items: 14,
                    data: pageNum <= 2
                        ? Array.from({ length: 14 }, (_, i) => ({ id: `item_${pageNum}_${i}` }))
                        : [],
                },
            };
        });

        const items = await (client as any).fetchOrderedListPages('vod', { category: '1' }, 2);

        // The three real pages (p=0, 1, 2) are returned whole; the empty answer for the page the
        // speculative request failed on is treated as past-the-end instead of aborting the load.
        expect(page3Calls).toBe(2);
        expect(items.length).toBe(42);
        expect(items[0].id).toBe('item_0_0');
        expect(items[14].id).toBe('item_1_0');
        expect(items[28].id).toBe('item_2_0');
    });
});
