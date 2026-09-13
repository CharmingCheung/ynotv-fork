/**
 * Pure (de)serialization helpers for the sports-related parts of a backup:
 * team → channel links (SQLite table) and favorite teams (localStorage mirror).
 *
 * Kept out of exportImport.ts so the shape conversions can be unit-tested
 * without importing the database or the Tauri bridge.
 */

import type { TeamChannelLink } from '../db';
import type { FavoriteTeam } from '../stores/sportsFavoritesStore';

/** localStorage key used by the sports favorites zustand store. */
export const SPORTS_FAVORITES_STORAGE_KEY = 'sports-favorites';

/**
 * Persist-middleware version the sports favorites store currently writes.
 * A restore uses the same version so the store's own migrate() doesn't re-run
 * and re-flag already-resolved favorites as needing league resolution.
 */
export const SPORTS_FAVORITES_STORE_VERSION = 2;

/** JSON shape written into a backup for `db.teamChannelLinks`. */
export interface TeamChannelLinkBackup {
  id: string;
  leagueId: string;
  teamId: string;
  streamId: string;
  channelName: string;
  sourceId?: string;
  priority?: number;
  auto: number;
  confidence: number;
  updatedAt: number;
}

/** JSON shape written into a backup for the sports favorites store. */
export interface SportsFavoritesBackup {
  favorites: FavoriteTeam[];
  repairPromptDismissed?: boolean;
}

/** Build a link id. Mirrors the store's `linkId()` so restored rows line up. */
export function teamChannelLinkId(leagueId: string, teamId: string, streamId: string): string {
  return `${leagueId}:${teamId}:${streamId}`;
}

export function serializeTeamChannelLinks(links: readonly TeamChannelLink[]): TeamChannelLinkBackup[] {
  return links.map((link) => ({
    id: link.id,
    leagueId: link.league_id,
    teamId: link.team_id,
    streamId: link.stream_id,
    channelName: link.channel_name,
    sourceId: link.source_id,
    priority: link.priority ?? 0,
    auto: link.auto ?? 0,
    confidence: link.confidence ?? 1,
    updatedAt: link.updated_at ?? Date.now(),
  }));
}

/**
 * Rebuild `TeamChannelLink` rows from a backup. Rows missing a league/team/
 * stream id are dropped — a half-written link can't be resolved to a channel
 * and would only show up as a broken entry in the team overlay.
 */
export function deserializeTeamChannelLinks(
  links: readonly Partial<TeamChannelLinkBackup>[] | undefined | null,
): TeamChannelLink[] {
  if (!Array.isArray(links)) return [];
  const out: TeamChannelLink[] = [];
  for (const link of links) {
    if (!link || !link.leagueId || !link.teamId || !link.streamId) continue;
    out.push({
      id: link.id || teamChannelLinkId(link.leagueId, link.teamId, link.streamId),
      league_id: link.leagueId,
      team_id: link.teamId,
      stream_id: link.streamId,
      channel_name: link.channelName ?? '',
      source_id: link.sourceId,
      priority: link.priority ?? 0,
      auto: link.auto ?? 0,
      confidence: link.confidence ?? 1,
      updated_at: link.updatedAt ?? Date.now(),
    });
  }
  return out;
}

/**
 * Read the sports favorites store's persisted zustand envelope. Returns
 * undefined for a missing/corrupt blob so an absence of favorites in an older
 * backup never wipes the current ones.
 */
export function parseSportsFavorites(raw: string | null | undefined): SportsFavoritesBackup | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const state = parsed?.state;
    if (!state || !Array.isArray(state.favorites)) return undefined;
    return {
      favorites: state.favorites,
      repairPromptDismissed: state.repairPromptDismissed ?? false,
    };
  } catch {
    return undefined;
  }
}

/** Rebuild the zustand persist envelope the sports favorites store expects. */
export function serializeSportsFavorites(backup: SportsFavoritesBackup): string {
  return JSON.stringify({
    state: {
      favorites: Array.isArray(backup.favorites) ? backup.favorites : [],
      repairPromptDismissed: backup.repairPromptDismissed ?? false,
    },
    version: SPORTS_FAVORITES_STORE_VERSION,
  });
}
