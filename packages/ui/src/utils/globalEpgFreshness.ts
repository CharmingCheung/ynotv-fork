/**
 * Freshness rules for global EPG links ("EPG sources" attached to playlists).
 *
 * A link fills the *gaps* in its attached sources' guides: it downloads one feed
 * and only writes programmes for channels that have no upcoming programme. That
 * means eligibility has to be decided per (link, source), not per link:
 *
 *  - `lastSynced` is a single field on the link, so judging the whole link by it
 *    let one source's no-match pass back off the gap-fill for every other
 *    attached source. Source B could be wiped by its own sync and still be
 *    skipped for the whole freshness window because the link had "just" run for
 *    source A.
 *  - A source that has just been resynced had its programmes rewritten, so its
 *    stamp is cleared and the link is reconsidered in the same round.
 */
import type { GlobalEpgLink } from '../types/app';

/** How long a link's pass for one source counts as fresh. */
export const GLOBAL_EPG_FRESH_MS = 30 * 60 * 1000; // 30 minutes

/** The attached source ids to consider for a link (optionally filtered). */
export function attachedEpgSourceIds(
  link: GlobalEpgLink,
  only?: Set<string> | null
): string[] {
  return only ? link.sourceIds.filter(id => only.has(id)) : [...link.sourceIds];
}

/**
 * Whether a link should run for one of its sources. True when it has never been
 * attempted for that source, when it last filled programmes there (so it can
 * fill more), or when its pass for that source is older than the window.
 */
export function linkNeedsSyncForSource(
  link: GlobalEpgLink,
  sourceId: string,
  now: number = Date.now()
): boolean {
  const syncedAt = link.lastSyncResult?.perSourceSyncedAt?.[sourceId];
  // Never attempted for this source — a new link, a newly attached source, or a
  // stamp cleared because the source was just resynced. Always reconsider.
  if (!syncedAt) return true;
  // It filled programmes for this source last time, so it can fill more.
  if ((link.lastSyncResult?.perSource?.[sourceId] ?? 0) > 0) return true;
  return now - syncedAt >= GLOBAL_EPG_FRESH_MS;
}

/** Whether a link should be attempted for any of the given sources. */
export function linkNeedsSyncForAnySource(
  link: GlobalEpgLink,
  sourceIds: Iterable<string>,
  now: number = Date.now()
): boolean {
  for (const sourceId of sourceIds) {
    if (linkNeedsSyncForSource(link, sourceId, now)) return true;
  }
  return false;
}

/**
 * Drop the freshness stamp for the given sources from every link that uses them.
 *
 * Called with the sources that just finished syncing: their programmes were
 * rewritten by their primary EPG pass, so their gap-fill must be reconsidered
 * even if the link ran moments ago. Links with no stamp to clear are returned
 * untouched (same object) so callers can skip persisting.
 */
export function clearGlobalEpgSourceStamps(
  links: GlobalEpgLink[],
  syncedSourceIds: Set<string> | Iterable<string>
): { links: GlobalEpgLink[]; changed: boolean } {
  const ids = syncedSourceIds instanceof Set ? syncedSourceIds : new Set(syncedSourceIds);
  if (ids.size === 0) return { links, changed: false };

  let changed = false;
  const next = links.map(link => {
    if (!link.sourceIds.some(id => ids.has(id))) return link;
    const stamps = link.lastSyncResult?.perSourceSyncedAt;
    if (!stamps) return link;
    const kept = { ...stamps };
    let removed = false;
    for (const id of ids) {
      if (id in kept) {
        delete kept[id];
        removed = true;
      }
    }
    if (!removed) return link;
    changed = true;
    return { ...link, lastSyncResult: { ...link.lastSyncResult!, perSourceSyncedAt: kept } };
  });

  return { links: changed ? next : links, changed };
}
