import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XtreamClient } from '../xtream-client';

const makeClient = (sourceId = 'src_1') =>
    new XtreamClient({ baseUrl: 'http://test.tv', username: 'u', password: 'p' }, sourceId);

const cacheOf = () => (XtreamClient as any).responseCache as Map<string, { data: any; expiresAt: number }>;
const maxEntries = () => (XtreamClient as any).RESPONSE_CACHE_MAX_ENTRIES as number;

describe('XtreamClient metadata response cache', () => {
    beforeEach(() => {
        cacheOf().clear();
        ((XtreamClient as any).inFlightRequests as Map<string, unknown>).clear();
        vi.restoreAllMocks();
    });

    it('serves a repeated get_vod_info call from cache without refetching', async () => {
        const client = makeClient();
        const fetchSpy = vi.spyOn(client as any, 'doFetchJson').mockResolvedValue({
            info: { video: { width: 1920, height: 1080 } },
            movie_data: { container_extension: 'mkv' },
        });

        const first = await client.getVodFullInfo('src_1_123');
        const second = await client.getVodFullInfo('src_1_123');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
        expect(second?.movie_data?.container_extension).toBe('mkv');
    });

    it('shares one in-flight request between concurrent identical callers', async () => {
        const client = makeClient();
        let resolveFetch: (value: any) => void = () => {};
        const fetchSpy = vi.spyOn(client as any, 'doFetchJson').mockImplementation(
            () => new Promise(resolve => { resolveFetch = resolve; })
        );

        const first = client.getVodFullInfo('src_1_123');
        const second = client.getVodFullInfo('src_1_123');
        resolveFetch({ info: { bitrate: 4500 } });

        const [a, b] = await Promise.all([first, second]);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(a).toEqual(b);
        expect(a?.info?.bitrate).toBe(4500);
    });

    it('drops expired entries when caching a new response', async () => {
        const client = makeClient();
        const cache = cacheOf();
        const now = Date.now();
        cache.set('expired-1', { data: {}, expiresAt: now - 1 });
        cache.set('expired-2', { data: {}, expiresAt: now - 5000 });
        cache.set('still-alive', { data: {}, expiresAt: now + 60000 });

        vi.spyOn(client as any, 'doFetchJson').mockResolvedValue({ info: {} });
        await client.getVodFullInfo('src_1_9');

        expect(cache.has('expired-1')).toBe(false);
        expect(cache.has('expired-2')).toBe(false);
        expect(cache.has('still-alive')).toBe(true);
        expect(cache.size).toBe(2);
    });

    it('caps the cache so a long browsing session cannot retain every payload', async () => {
        const client = makeClient();
        const cache = cacheOf();
        const now = Date.now();
        for (let i = 0; i < maxEntries() + 50; i++) {
            cache.set(`bulk-${i}`, { data: { i }, expiresAt: now + 60000 });
        }

        vi.spyOn(client as any, 'doFetchJson').mockResolvedValue({ info: {} });
        await client.getVodFullInfo('src_1_1');

        expect(cache.size).toBe(maxEntries());
    });

    it('clears the in-flight entry after a failure so a retry can refetch', async () => {
        const client = makeClient();
        const inFlight = (XtreamClient as any).inFlightRequests as Map<string, unknown>;
        const fetchSpy = vi
            .spyOn(client as any, 'doFetchJson')
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ info: { video: { width: 1280, height: 720 } } });

        await expect(client.getVodFullInfo('src_1_5')).rejects.toThrow('boom');
        expect(inFlight.size).toBe(0);

        const retry = await client.getVodFullInfo('src_1_5');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(retry?.info?.video?.height).toBe(720);
    });
});
