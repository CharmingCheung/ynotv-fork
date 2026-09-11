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
});
