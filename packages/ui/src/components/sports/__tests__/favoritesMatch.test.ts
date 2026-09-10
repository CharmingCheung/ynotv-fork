import { describe, it, expect } from 'vitest';
import type { SportsEvent } from '@ynotv/core';
import { eventInvolvesTeam } from '../favoritesMatch';

function makeEvent(homeId: string, awayId: string, leagueId: string): SportsEvent {
  return {
    id: `ev_${homeId}_${awayId}`,
    title: 'Game',
    homeTeam: { id: homeId, name: `Home ${homeId}`, shortName: `H${homeId}` },
    awayTeam: { id: awayId, name: `Away ${awayId}`, shortName: `A${awayId}` },
    league: { id: leagueId, name: leagueId.toUpperCase(), sport: leagueId },
    startTime: new Date(),
    status: 'scheduled',
  } as SportsEvent;
}

describe('eventInvolvesTeam', () => {
  it('matches when the favorite team is home in its own league', () => {
    const event = makeEvent('18', '137', 'nfl'); // Saints home vs someone
    expect(eventInvolvesTeam(event, { id: '18', leagueId: 'nfl' })).toBe(true);
  });

  it('matches when the favorite team is away in its own league', () => {
    const event = makeEvent('137', '18', 'nfl');
    expect(eventInvolvesTeam(event, { id: '18', leagueId: 'nfl' })).toBe(true);
  });

  it('rejects a same-id team from a different league (Saints id 18 vs MLB Astros id 18)', () => {
    // Favorite: New Orleans Saints (NFL id 18). Event: SF @ HOU — MLB, where
    // id 18 is the Houston Astros, not the Saints.
    const event = makeEvent('137', '18', 'mlb');
    expect(eventInvolvesTeam(event, { id: '18', leagueId: 'nfl' })).toBe(false);
  });

  it('rejects a game that does not involve the favorite at all', () => {
    const event = makeEvent('137', '117', 'mlb');
    expect(eventInvolvesTeam(event, { id: '18', leagueId: 'nfl' })).toBe(false);
  });

  it('fails closed and rejects matching for unresolved legacy favorites without a leagueId', () => {
    const event = makeEvent('137', '18', 'mlb');
    expect(eventInvolvesTeam(event, { id: '18', leagueId: undefined })).toBe(false);
  });

  it('fails closed and rejects matching when the event has no league info', () => {
    const event = makeEvent('137', '18', 'mlb');
    const noLeague = { ...event, league: undefined as any };
    expect(eventInvolvesTeam(noLeague, { id: '18', leagueId: 'nfl' })).toBe(false);
  });
});
