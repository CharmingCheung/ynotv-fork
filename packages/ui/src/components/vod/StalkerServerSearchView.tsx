import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from '../../i18n';
import type { StoredMovie, StoredSeries } from '../../db';
import { MediaCard } from './MediaCard';
import { VirtualGrid } from '../common/VirtualGrid';
import { useStalkerSearchStore, type StalkerSearchType } from '../../stores/stalkerSearchStore';
import {
    categoryLabelsFor,
    getStalkerSearchCategories,
    getStalkerSearchCategoryNames,
    getStalkerSearchSources,
    searchStalkerServer,
    SEARCH_BATCH_PAGES,
    SEARCH_CATEGORY_LINE_PX,
    SEARCH_HARD_MAX_PAGES,
    SEARCH_LOAD_ALL_MAX_PAGES,
    STALKER_PAGE_SIZE,
    type StalkerSearchCategory,
    type StalkerSearchSource,
    type StalkerServerSearchPage,
} from '../../services/stalkerServerSearch';
import './StalkerServerSearchView.css';

interface StalkerServerSearchViewProps {
    type: StalkerSearchType;
    onOpenItem: (item: StoredMovie | StoredSeries) => void;
}

const rowId = (row: StoredMovie | StoredSeries) =>
    (row as StoredSeries).series_id ?? (row as StoredMovie).stream_id;


/** A portal that ignored `search` returned its normal catalogue — never present that as matches. */
function unsupportedResult(result: StalkerServerSearchPage): boolean {
    return result.unsupported;
}

/**
 * Search a Stalker portal's own catalogue, rendered inline on the Movies/Series page.
 *
 * Deliberately separate from the normal search box: that one is an instant local DB query
 * whose result set the browse grid treats as its identity (and remembers scroll for), while
 * this is a paginated network walk with its own progress, count and failure states — and it
 * only exists for MAC portals, so it is opt-in per install.
 *
 * Selection and results live in `useStalkerSearchStore` (session-scoped), so opening a
 * detail page, playing and stopping, or switching categories and coming back all restore
 * the exact result set instead of re-walking the portal.
 */
export function StalkerServerSearchView({ type, onOpenItem }: StalkerServerSearchViewProps) {
    const slice = useStalkerSearchStore((s) => s.byType[type]);
    const patch = useStalkerSearchStore((s) => s.patch);

    const [sources, setSources] = useState<StalkerSearchSource[] | null>(null);
    const [categories, setCategories] = useState<StalkerSearchCategory[]>([]);
    /** Every category name this source has (disabled ones included) — see the loader. */
    const [categoryNames, setCategoryNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    /** Newest search wins; a slower in-flight one can no longer patch the store over it. */
    const requestIdRef = useRef(0);

    const { sourceId, categoryId, query, result, pagesLoaded } = slice;
    const source = useMemo(() => sources?.find(s => s.id === sourceId) ?? null, [sources, sourceId]);

    // Load the portal list once; keep the last pick so a reopen lands where the user left off.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = await getStalkerSearchSources();
            if (cancelled) return;
            setSources(list);
            if (list.length > 0) {
                const current = useStalkerSearchStore.getState().byType[type].sourceId;
                const next = current && list.some(s => s.id === current) ? current : list[0].id;
                if (next !== current) patch(type, { sourceId: next });
            }
        })();
        return () => { cancelled = true; };
    }, [type, patch]);

    // Categories for the chosen portal, scoped to movies or series.
    useEffect(() => {
        let cancelled = false;
        if (!sourceId) {
            setCategories([]);
            return;
        }
        (async () => {
            const list = await getStalkerSearchCategories(sourceId, type);
            if (cancelled) return;
            setCategories(list);
            const current = useStalkerSearchStore.getState().byType[type].categoryId;
            if (current !== '*' && !list.some(c => c.id === current)) {
                patch(type, { categoryId: '*' });
            }
        })().catch(e => {
            console.warn('[StalkerServerSearch] Could not list categories:', e);
            if (!cancelled) setCategories([]);
        });
        return () => { cancelled = true; };
    }, [sourceId, type, patch]);

    // Names for the labels under each result. Unlike the picker's list this keeps disabled
    // categories: a result can legitimately come from one, and an unnamed card would read
    // as the feature being broken rather than the category being hidden.
    useEffect(() => {
        let cancelled = false;
        if (!sourceId) {
            setCategoryNames({});
            return;
        }
        getStalkerSearchCategoryNames(sourceId, type)
            .then(names => { if (!cancelled) setCategoryNames(names); })
            .catch(e => {
                console.warn('[StalkerServerSearch] Could not read category names:', e);
                if (!cancelled) setCategoryNames({});
            });
        return () => { cancelled = true; };
    }, [sourceId, type]);

    const runSearch = useCallback(
        async (opts: { fromPage: number; maxPages: number; append: boolean }) => {
            const current = useStalkerSearchStore.getState().byType[type];
            const activeSource = sources?.find(s => s.id === current.sourceId) ?? null;
            const q = current.query.trim();
            if (!activeSource || !q) return;
            // Two searches can be in flight at once (a slow "Load all" and a new query).
            // Only the newest one may touch the store or the loading flags, otherwise the
            // slower answer overwrites the newer result set on arrival.
            const requestId = ++requestIdRef.current;
            setLoading(true);
            setError(null);
            setProgress(i18n.t('common:searching'));
            try {
                const page = await searchStalkerServer({
                    source: activeSource,
                    type,
                    query: q,
                    // Resuming has to stay on the phrase the first page settled on: the
                    // verbatim→longest-word retry only runs on page 0, so sending the raw
                    // query again would ask for the phrase that already returned nothing.
                    phrase: opts.append ? current.result?.phrase : undefined,
                    // Same reasoning as `phrase`: a series search decides between the
                    // `series` and `vod` endpoints on page 0, so a resume that let it
                    // decide again could splice the other endpoint's page into the walk.
                    endpoint: opts.append ? current.result?.endpoint : undefined,
                    categoryId: current.categoryId === '*' ? null : current.categoryId,
                    fromPage: opts.fromPage,
                    maxPages: opts.maxPages,
                    onProgress: info => {
                        if (requestId !== requestIdRef.current) return;
                        setProgress(
                            info.total != null
                                ? i18n.t('vod:loadingPageOf', { current: info.page, total: Math.max(1, Math.ceil(info.total / STALKER_PAGE_SIZE)) })
                                : i18n.t('vod:loadingPage', { current: info.page })
                        );
                    },
                });

                if (requestId !== requestIdRef.current) return;

                const prev = useStalkerSearchStore.getState().byType[type].result;
                let nextResult = page;
                let nextPages = opts.maxPages;
                if (opts.append && prev) {
                    const seen = new Set(prev.rows.map(rowId));
                    const rows = [...prev.rows, ...page.rows.filter(r => !seen.has(rowId(r)))];
                    nextResult = { ...page, rows, shown: rows.length };
                    nextPages = useStalkerSearchStore.getState().byType[type].pagesLoaded + opts.maxPages;
                }
                patch(type, { result: nextResult, pagesLoaded: nextPages });
            } catch (e: any) {
                if (requestId !== requestIdRef.current) return;
                setError(e?.message || i18n.t('common:noResultsFound'));
            } finally {
                if (requestId === requestIdRef.current) {
                    setLoading(false);
                    setProgress(null);
                }
            }
        },
        [sources, type, patch]
    );

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        patch(type, { result: null, pagesLoaded: 0 });
        void runSearch({ fromPage: 0, maxPages: SEARCH_BATCH_PAGES, append: false });
    };

    const showMore = () => {
        if (!result) return;
        void runSearch({ fromPage: result.nextPage, maxPages: SEARCH_BATCH_PAGES, append: true });
    };

    /**
     * Walk the rest of the result set in one go — offered only when that is a bounded
     * amount of requests. A search for "the" is 26,090 titles on a portal we measured,
     * which is ~1,800 page requests; that is not a button, it is a rate limit.
     *
     * Spends the whole remaining budget rather than estimating pages-left from the
     * provider's total: `total` counts rows the movie list filters out (`is_series`
     * entries), so `ceil(total / pageSize) - pagesLoaded` under-counts and could ask for
     * a single page — or, once the two numbers met, ask for none at all and make the
     * button silently do nothing while more pages remained. The walker ends itself on a
     * short page, so a bounded "keep going" is both safe and honest.
     */
    const loadAll = () => {
        if (!result) return;
        const budget = SEARCH_LOAD_ALL_MAX_PAGES - pagesLoaded;
        if (budget <= 0) return;
        void runSearch({ fromPage: result.nextPage, maxPages: budget, append: true });
    };

    const loadAllOfferable =
        !!result && result.hasMore && !loading && pagesLoaded < SEARCH_LOAD_ALL_MAX_PAGES &&
        Math.ceil(result.total / STALKER_PAGE_SIZE) <= SEARCH_LOAD_ALL_MAX_PAGES;

    const tooManyToLoad =
        !!result && result.hasMore && !unsupportedResult(result) &&
        Math.ceil(result.total / STALKER_PAGE_SIZE) > SEARCH_LOAD_ALL_MAX_PAGES;

    const hitHardCap = pagesLoaded >= SEARCH_HARD_MAX_PAGES;

    if (sources !== null && sources.length === 0) {
        return (
            <div className="stalker-search-view">
                <div className="stalker-search-empty">{i18n.t('vod:stalkerServerSearchNoSources')}</div>
            </div>
        );
    }

    return (
        <div className="stalker-search-view">
            <form className="stalker-search-controls" onSubmit={onSubmit}>
                <label className="stalker-search-field">
                    <span>{i18n.t('vod:stalkerServerSearchSource')}</span>
                    <select
                        value={sourceId}
                        onChange={e => patch(type, { sourceId: e.target.value, result: null, pagesLoaded: 0 })}
                    >
                        {(sources ?? []).map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </label>

                <label className="stalker-search-field">
                    <span>{i18n.t('vod:stalkerServerSearchCategory')}</span>
                    <select
                        value={categoryId}
                        onChange={e => patch(type, { categoryId: e.target.value, result: null, pagesLoaded: 0 })}
                    >
                        <option value="*">{i18n.t('common:all')}</option>
                        {categories.map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </label>

                <label className="stalker-search-field stalker-search-query">
                    <span>{i18n.t('vod:stalkerServerSearchQuery')}</span>
                    <input
                        type="text"
                        value={query}
                        onChange={e => patch(type, { query: e.target.value })}
                        placeholder={type === 'movies' ? i18n.t('vod:searchMovies') : i18n.t('vod:searchSeries')}
                        autoFocus
                    />
                </label>

                <button type="submit" className="stalker-search-go" disabled={loading || !query.trim() || !source}>
                    {loading ? progress ?? i18n.t('common:searching') : i18n.t('vod:editMetadataTmdbSearchBtn')}
                </button>
            </form>

            <div className="stalker-search-status">
                {error && <span className="stalker-search-error">{error}</span>}
                {!error && result && unsupportedResult(result) && (
                    <span className="stalker-search-warning">{i18n.t('vod:stalkerServerSearchUnsupported')}</span>
                )}
                {!error && result && !unsupportedResult(result) && (
                    <>
                        {/* Only ever one count, and it is the rows the grid holds. Quoting the
                            provider's own total alongside it is what made this confusing: that
                            number counts every matching row, including the `is_series` entries a
                            movie list filters out, so it is an upper bound the grid can never
                            reach (61 against a real 49 on the portal this was measured on).
                            "More matches" says the same thing without a figure to reconcile. */}
                        <span>{i18n.t('common:resultsCount', { count: result.shown })}</span>
                        {result.hasMore && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchMoreOnServer')}
                            </span>
                        )}
                        {/* The words as typed matched nothing, so say which wider form answered:
                            the same words with anything between them (server-side), or just the
                            longest one with the rest applied here. */}
                        {result.matchKind === 'all-words' && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchMatchingAllWords')}
                            </span>
                        )}
                        {result.matchKind === 'word' && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchMatchingPhrase', { phrase: result.phrase })}
                            </span>
                        )}
                        {result.shown === 0 && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchNoMatches', { query: query.trim() })}
                            </span>
                        )}
                        {(tooManyToLoad || hitHardCap) && (
                            <span className="stalker-search-note">{i18n.t('vod:stalkerServerSearchTooMany')}</span>
                        )}
                    </>
                )}
            </div>

            <div className="stalker-search-results" ref={scrollRef}>
                {result && !unsupportedResult(result) && result.rows.length > 0 && (
                    <VirtualGrid
                        items={result.rows}
                        scrollRef={scrollRef}
                        minColumnWidth={150}
                        // The category line makes a card one line taller, and rows are sized
                        // from this number: see SEARCH_CATEGORY_LINE_PX.
                        estimateRowHeight={280 + SEARCH_CATEGORY_LINE_PX}
                        getKey={item => rowId(item)}
                        surface="stalker-server-search"
                        renderItem={(item, index) => (
                            <MediaCard
                                item={item}
                                type={type === 'movies' ? 'movie' : 'series'}
                                index={index}
                                onClick={onOpenItem}
                                size="medium"
                                sourceName={source?.name}
                                // The scoped category is preferred so a card agrees with the
                                // picker above it when the row is also in other categories.
                                categoryLabels={categoryLabelsFor(
                                    (item as StoredMovie).category_ids,
                                    categoryNames,
                                    categoryId === '*' ? null : categoryId
                                )}
                            />
                        )}
                    />
                )}
            </div>

            <div className="stalker-search-footer">
                {/* No count here on purpose: while pages remain the provider's total is an
                    over-count (it includes rows this list filters out), so naming it would
                    promise a number the results can never reach. */}
                {loadAllOfferable && (
                    <button className="stalker-search-more" onClick={loadAll} disabled={loading}>
                        {i18n.t('vod:stalkerServerSearchLoadAllResults')}
                    </button>
                )}
                {!!result && result.hasMore && !hitHardCap && (
                    <button className="stalker-search-more" onClick={showMore} disabled={loading}>
                        {i18n.t('vod:stalkerServerSearchMore')}
                    </button>
                )}
            </div>
        </div>
    );
}

export default StalkerServerSearchView;
