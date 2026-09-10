import type { SportsEvent, SportsTeam } from '@ynotv/core';
import { inferTeamLeagueResult } from '../../services/sports/leagueInference';

/**
 * True when an event involves the favorite team. ESPN team IDs are only
 * unique within a league — e.g. id "7" is both the NFL Broncos and NBA Nuggets,
 * and id "18" is the NFL Saints and MLB Astros.
 *
 * Matches ID and ensures league awareness, with fallback to inferTeamLeague
 * so that cross-league events (e.g. NFL Broncos vs Chiefs) NEVER match an NBA Nuggets favorite.
 */
export function eventInvolvesTeam(
  event: SportsEvent,
  team: { id: string; leagueId?: string; name?: string; logo?: string }
): boolean {
  const idMatch = event.homeTeam.id === team.id || event.awayTeam.id === team.id;
  if (!idMatch) return false;

  const teamLeague = team.leagueId?.trim().toLowerCase() || inferTeamLeagueResult(team).leagueId;
  const eventLeague = event.league?.id?.trim().toLowerCase()
    || event.homeTeam.leagueId?.trim().toLowerCase()
    || event.awayTeam.leagueId?.trim().toLowerCase();

  // An unresolved legacy ID must not match an event from an arbitrary league.
  if (!teamLeague || !eventLeague) return false;
  return teamLeague === eventLeague;
}
