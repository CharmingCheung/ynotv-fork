/**
 * ESPN Data Mappers
 *
 * Transform ESPN API responses to domain models
 */

import type {
  ESPNEvent,
  ESPTeam,
  SportsEvent,
  SportsTeam,
  SportsLeague,
  SportConfig,
  SportsBroadcastChannel,
} from './types';
import { SPORT_CONFIG } from './config';

/**
 * Build a reliable ESPN CDN logo URL from a team ID and sport key.
 * The scoreboard API often omits logos, but the CDN serves them predictably.
 */
function buildESPNLogoUrl(teamId: string, sportKey: string): string | undefined {
  if (!teamId || teamId === 'TBD' || teamId === 'field' || teamId === 'session' || teamId === 'session2') {
    return undefined;
  }

  // Soccer leagues all share the same logo path
  if (sportKey.startsWith('soccer-')) {
    return `https://a.espncdn.com/i/teamlogos/soccer/500/${teamId}.png`;
  }

  const sportPathMap: Record<string, string> = {
    'nfl': 'nfl',
    'college-football': 'ncaa',
    'nba': 'nba',
    'mens-college-basketball': 'ncaa',
    'womens-college-basketball': 'ncaa',
    'wnba': 'wnba',
    'mlb': 'mlb',
    'nhl': 'nhl',
    'ufc': 'mma',
    'pga': 'golf',
    'lpga': 'golf',
    'atp': 'tennis',
    'wta': 'tennis',
    'f1': 'racing',
    'nascar': 'racing',
    'indycar': 'racing',
    'rugby-180659': 'rugby/teams',
    'rugby-164205': 'rugby/teams',
    'rugby-267979': 'rugby/teams',
    'rugby-242041': 'rugby/teams',
    'rugby-270559': 'rugby/teams',
    'rugby-league-3': 'rugby/teams',
    'afl': 'afl',
  };

  const sportPath = sportPathMap[sportKey];
  if (!sportPath) return undefined;

  // AFL logos on the ESPN CDN are keyed by the team's abbreviation slug, not numeric id
  // (https://a.espncdn.com/i/teamlogos/afl/500/coll.png), so the numeric-id template below
  // would 404. Map the ESPN team id to the CDN slug for the 18 AFL clubs.
  if (sportKey === 'afl') {
    const AFL_LOGO_SLUGS: Record<string, string> = {
      '1': 'fre', '2': 'melb', '3': 'wce', '4': 'syd', '5': 'nmfc', '6': 'wb',
      '7': 'port', '8': 'gws', '9': 'carl', '10': 'suns', '11': 'bl', '12': 'rich',
      '13': 'haw', '14': 'geel', '15': 'adel', '16': 'ess', '17': 'coll', '18': 'stk',
    };
    const slug = AFL_LOGO_SLUGS[teamId];
    return slug ? `https://a.espncdn.com/i/teamlogos/afl/500/${slug}.png` : undefined;
  }

  return `https://a.espncdn.com/i/teamlogos/${sportPath}/500/${teamId}.png`;
}

function getAthleteInfo(competitor: ESPNEvent['competitions'][0]['competitors'][0] | undefined, sportKey?: string): SportsTeam {
  if (competitor?.athlete) {
    return {
      id: competitor.athlete.id,
      name: competitor.athlete.displayName || competitor.athlete.fullName || 'Unknown',
      shortName: competitor.athlete.shortName,
      logo: competitor.athlete.headshot?.href,
      leagueId: sportKey,
    };
  }
  return { id: competitor?.id || '', name: 'TBD', shortName: undefined, logo: undefined, leagueId: sportKey };
}

function getTeamInfo(competitor: ESPNEvent['competitions'][0]['competitors'][0] | undefined, sportKey: string): SportsTeam {
  if (!competitor) {
    return { id: '', name: 'TBD', shortName: undefined, logo: undefined, leagueId: sportKey };
  }

  if (competitor.athlete) {
    return getAthleteInfo(competitor, sportKey);
  }

  if (competitor.team) {
    const apiLogo = competitor.team.logos?.[0]?.href || competitor.team.logo;
    const fallbackLogo = buildESPNLogoUrl(competitor.team.id, sportKey);
    return {
      id: competitor.team.id,
      name: competitor.team.displayName || 'Unknown',
      shortName: competitor.team.abbreviation,
      logo: apiLogo || fallbackLogo,
      leagueId: sportKey,
    };
  }

  return { id: competitor.id, name: 'Unknown', shortName: undefined, logo: undefined, leagueId: sportKey };
}

function getScore(competitor: ESPNEvent['competitions'][0]['competitors'][0] | undefined): number | undefined {
  const score = competitor?.score;
  if (score === undefined || score === null) {
    return undefined;
  }
  if (typeof score === 'number') {
    return score;
  }
  if (typeof score === 'object' && score?.value !== undefined) {
    return Math.round(score.value);
  }
  if (typeof score === 'string' && score !== '') {
    const parsed = parseInt(score, 10);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function extractChannels(event: ESPNEvent, competition?: ESPNEvent['competitions'][0]): SportsBroadcastChannel[] {
  const channels: SportsBroadcastChannel[] = [];
  if (competition?.broadcasts) {
    for (const broadcast of competition.broadcasts) {
      for (const name of broadcast.names || []) {
        channels.push({ name, country: broadcast.market });
      }
    }
  }
  if ((event as any).broadcasts) {
    for (const broadcast of (event as any).broadcasts) {
      for (const name of broadcast.names || []) {
        if (!channels.find(c => c.name === name)) {
          channels.push({ name, country: broadcast.market });
        }
      }
    }
  }
  return channels;
}

function mapUFCEvent(event: ESPNEvent, config: SportConfig): SportsEvent {
  const competitions = event.competitions || [];

  // Sort competitions by order ascending (first = early prelims, last = main event)
  const sortedComps = [...competitions].sort((a, b) => (a.order || 0) - (b.order || 0));

  // Main event is the last competition
  const mainEvent = sortedComps[sortedComps.length - 1];
  const mainCompetitors = mainEvent?.competitors || [];
  const mainSorted = [...mainCompetitors].sort((a, b) => (a.order || 0) - (b.order || 0));
  const mainAway = mainSorted[0];
  const mainHome = mainSorted[1];

  // Build matches list for all fights on the card
  const matches: NonNullable<SportsEvent['matches']> = sortedComps.map(comp => {
    const fighters = [...comp.competitors].sort((a, b) => (a.order || 0) - (b.order || 0));
    const away = getAthleteInfo(fighters[0]);
    const home = getAthleteInfo(fighters[1]);
    const compStatus = comp.status?.type?.state;
    let matchStatus: 'scheduled' | 'live' | 'finished' = 'scheduled';
    if (compStatus === 'in') matchStatus = 'live';
    else if (compStatus === 'post') matchStatus = 'finished';

    return {
      id: comp.id,
      awayName: away.name,
      homeName: home.name,
      awayLogo: away.logo,
      homeLogo: home.logo,
      awayRecord: fighters[0]?.records?.[0]?.summary,
      homeRecord: fighters[1]?.records?.[0]?.summary,
      subtitle: (comp as any).type?.abbreviation,
      status: matchStatus,
    };
  });

  // Event-level status
  const state = event.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  const homeTeam = getAthleteInfo(mainHome, 'ufc');
  const awayTeam = getAthleteInfo(mainAway, 'ufc');

  return {
    id: event.id,
    title: event.name,
    homeTeam,
    awayTeam,
    league: { id: 'ufc', name: config.name, sport: config.sport },
    startTime: new Date(event.date),
    status,
    homeScore: getScore(mainHome),
    awayScore: getScore(mainAway),
    period: event.status?.period?.toString(),
    timeElapsed: event.status?.displayClock,
    channels: extractChannels(event, mainEvent),
    venue: mainEvent?.venue?.fullName || (event as any).venues?.[0]?.fullName,
    matches,
  };
}

function mapRacingEvent(event: ESPNEvent, sportKey: string, config: SportConfig): SportsEvent {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const sessionType = (competition as any).type?.abbreviation || 'Race';

  // Sort competitors by finishing position (order)
  const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 999) - (b.order || 999));

  // Build results list from all competitors (drivers)
  const matches: NonNullable<SportsEvent['matches']> = sortedCompetitors.map((comp) => {
    const driver = comp.athlete;
    const team = comp.team;
    const pos = comp.order || 0;

    // Parse time/interval from score or status
    let timeStr = '';
    if (typeof comp.score === 'object' && comp.score?.displayValue) {
      timeStr = comp.score.displayValue;
    } else if (typeof comp.score === 'string') {
      timeStr = comp.score;
    }

    // Parse points
    let points: number | undefined;
    if (comp.records && comp.records.length > 0) {
      const pts = parseInt(comp.records[0].summary, 10);
      if (!isNaN(pts)) points = pts;
    }

    return {
      id: comp.id,
      awayName: driver?.displayName || driver?.fullName || 'Unknown',
      homeName: team?.displayName || team?.name || 'Unknown',
      awayLogo: driver?.headshot?.href,
      homeLogo: team?.logos?.[0]?.href,
      subtitle: timeStr,
      awayRecord: points !== undefined ? `${points} pts` : undefined,
      status: comp.winner ? 'finished' : 'finished',
      position: pos,
      points,
    };
  });

  // Top 2 drivers for card preview
  const p1 = sortedCompetitors[0];
  const p2 = sortedCompetitors[1];

  const homeTeam = p1
    ? {
        id: p1.id,
        name: p1.athlete?.displayName || p1.athlete?.fullName || 'TBD',
        shortName: p1.athlete?.shortName,
        logo: p1.athlete?.headshot?.href,
        leagueId: sportKey,
      }
    : { id: '', name: 'TBD', shortName: undefined, logo: undefined, leagueId: sportKey };

  const awayTeam = p2
    ? {
        id: p2.id,
        name: p2.athlete?.displayName || p2.athlete?.fullName || 'TBD',
        shortName: p2.athlete?.shortName,
        logo: p2.athlete?.headshot?.href,
        leagueId: sportKey,
      }
    : { id: '', name: 'TBD', shortName: undefined, logo: undefined, leagueId: sportKey };

  const state = event.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  return {
    id: event.id,
    title: event.name,
    homeTeam,
    awayTeam,
    league: { id: sportKey, name: config.name, sport: config.sport },
    startTime: new Date(event.date),
    status,
    homeScore: p1 && typeof p1.score === 'object' ? p1.score.value : undefined,
    awayScore: p2 && typeof p2.score === 'object' ? p2.score.value : undefined,
    period: event.status?.period?.toString(),
    timeElapsed: event.status?.displayClock,
    channels: extractChannels(event, competition),
    venue: competition?.venue?.fullName || (event as any).venues?.[0]?.fullName,
    matches,
  };
}

function mapGolfEvent(event: ESPNEvent, sportKey: string, config: SportConfig): SportsEvent {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];

  // Sort by leaderboard position (order = 1 is the leader)
  const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 999) - (b.order || 999));

  // Build leaderboard entries
  const matches: NonNullable<SportsEvent['matches']> = sortedCompetitors.map((comp) => {
    const athlete = comp.athlete;
    const scoreStr = typeof comp.score === 'object' ? comp.score.displayValue : (comp.score || '');
    const roundScores = (comp as any).linescores?.map((ls: any) => ls.displayValue || String(ls.value || '')) || [];

    return {
      id: comp.id,
      awayName: athlete?.displayName || athlete?.fullName || 'Unknown',
      homeName: '',
      awayLogo: athlete?.flag?.href,
      subtitle: scoreStr,
      position: comp.order,
      roundScores,
    };
  });

  const leader = sortedCompetitors[0];
  const leaderScore = typeof leader?.score === 'object' ? leader.score.displayValue : (leader?.score || '');

  const state = event.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  // Use tournament name as "home team" and leader as "away team" for card preview
  const homeTeam = {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    logo: undefined,
    leagueId: sportKey,
  };

  const awayTeam = leader?.athlete
    ? {
        id: leader.athlete.id,
        name: leader.athlete.displayName || leader.athlete.fullName || 'Leader',
        shortName: leader.athlete.shortName,
        logo: leader.athlete.flag?.href,
        leagueId: sportKey,
      }
    : { id: '', name: 'Leader TBD', shortName: undefined, logo: undefined, leagueId: sportKey };

  return {
    id: event.id,
    title: event.name,
    homeTeam,
    awayTeam,
    league: { id: sportKey, name: config.name, sport: config.sport },
    startTime: new Date(event.date),
    status,
    homeScore: undefined,
    awayScore: undefined,
    period: event.status?.period?.toString(),
    timeElapsed: event.status?.displayClock,
    channels: extractChannels(event, competition),
    venue: competition?.venue?.fullName || (event as any).venues?.[0]?.fullName,
    matches,
  };
}

function mapStandardEvent(event: ESPNEvent, sportKey: string, config: SportConfig): SportsEvent {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];

  const isTennis = sportKey.startsWith('atp') || sportKey.startsWith('wta') || sportKey.includes('tennis');

  let homeCompetitor = competitors.find(c => c.homeAway === 'home');
  let awayCompetitor = competitors.find(c => c.homeAway === 'away');

  // Tennis: Handle match pairings if available
  if (isTennis && competitors.length >= 2) {
    const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 0) - (b.order || 0));
    awayCompetitor = sortedCompetitors[0];
    homeCompetitor = sortedCompetitors[1];
  }

  const state = event.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  const homeTeam = getTeamInfo(homeCompetitor, sportKey);
  const awayTeam = getTeamInfo(awayCompetitor, sportKey);

  return {
    id: event.id,
    title: event.name,
    homeTeam,
    awayTeam,
    league: { id: sportKey, name: config.name, sport: config.sport },
    startTime: new Date(event.date),
    status,
    homeScore: getScore(homeCompetitor),
    awayScore: getScore(awayCompetitor),
    period: event.status?.period?.toString(),
    timeElapsed: event.status?.displayClock,
    channels: extractChannels(event, competition),
    venue: competition?.venue?.fullName || (event as any).venues?.[0]?.fullName,
  };
}

export function mapESPNEvent(event: ESPNEvent, sportKey: string): SportsEvent {
  const config = SPORT_CONFIG[sportKey] || { name: sportKey.toUpperCase() };

  if (sportKey === 'ufc') {
    return mapUFCEvent(event, config);
  }

  if (sportKey === 'f1' || sportKey === 'nascar' || sportKey === 'indycar') {
    return mapRacingEvent(event, sportKey, config);
  }

  if (sportKey === 'pga' || sportKey === 'lpga') {
    return mapGolfEvent(event, sportKey, config);
  }

  if (sportKey === 'atp' || sportKey === 'wta') {
    return mapTennisEvent(event, sportKey, config);
  }

  return mapStandardEvent(event, sportKey, config);
}

function mapTennisEvent(event: ESPNEvent, sportKey: string, config: SportConfig): SportsEvent {
  // Tennis: matches live in groups[].competitions[]
  const groups = event.groups || [];
  const tournamentStatus = event.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (tournamentStatus === 'in') status = 'live';
  else if (tournamentStatus === 'post') status = 'finished';

  // Flatten all matches from all groups
  const matches: NonNullable<SportsEvent['matches']> = [];
  for (const group of groups) {
    for (const comp of group.competitions) {
      const competitors = comp.competitors || [];
      if (competitors.length < 2) continue;

      const p1 = competitors[0];
      const p2 = competitors[1];

      const p1Name = p1.athlete?.displayName || p1.athlete?.shortName || 'TBD';
      const p2Name = p2.athlete?.displayName || p2.athlete?.shortName || 'TBD';

      const p1Score = typeof p1.score === 'object' ? p1.score.displayValue : (p1.score || '');
      const p2Score = typeof p2.score === 'object' ? p2.score.displayValue : (p2.score || '');

      // Build set scores from linescores
      const setScores: string[] = [];
      if (comp.linescores) {
        for (const ls of comp.linescores) {
          setScores.push(ls.displayValue || String(ls.value || ''));
        }
      }

      const matchState = comp.status?.type?.state || 'pre';
      let matchStatus: 'scheduled' | 'live' | 'finished' = 'scheduled';
      if (matchState === 'in') matchStatus = 'live';
      else if (matchState === 'post') matchStatus = 'finished';

      matches.push({
        id: comp.id,
        awayName: p1Name,
        homeName: p2Name,
        awayLogo: p1.athlete?.flag?.href,
        homeLogo: p2.athlete?.flag?.href,
        subtitle: comp.status?.type?.shortDetail || comp.status?.type?.detail || '',
        status: matchStatus,
        roundScores: setScores,
        groupName: group.grouping.displayName,
      });
    }
  }

  // Find a featured match for the card preview (first live, then first finished, then first scheduled)
  const featuredMatch = matches.find(m => m.status === 'live')
    || matches.find(m => m.status === 'finished')
    || matches[0];

  const awayTeam = featuredMatch
    ? { id: featuredMatch.id, name: featuredMatch.awayName, shortName: undefined, logo: featuredMatch.awayLogo, leagueId: sportKey }
    : { id: '', name: 'TBD', shortName: undefined, logo: undefined, leagueId: sportKey };

  const homeTeam = featuredMatch
    ? { id: featuredMatch.id, name: featuredMatch.homeName, shortName: undefined, logo: featuredMatch.homeLogo, leagueId: sportKey }
    : { id: '', name: 'TBD', shortName: undefined, logo: undefined, leagueId: sportKey };

  return {
    id: event.id,
    title: event.name,
    homeTeam,
    awayTeam,
    league: { id: sportKey, name: config.name, sport: config.sport },
    startTime: new Date(event.date),
    status,
    homeScore: undefined,
    awayScore: undefined,
    period: event.status?.period?.toString(),
    timeElapsed: event.status?.displayClock,
    channels: extractChannels(event, undefined),
    venue: (event as any).venue?.displayName || (event as any).venue?.fullName,
    matches,
  };
}

export function mapESPNTeam(team: ESPTeam, leagueId: string): SportsTeam {
  const teamAny = team as any;
  return {
    id: team.id,
    name: team.displayName,
    shortName: team.shortDisplayName || team.abbreviation,
    logo: team.logos?.[0]?.href || team.logo,
    leagueId,
    location: team.location,
    abbreviation: team.abbreviation,
    color: teamAny.color,
    alternateColor: teamAny.alternateColor,
    standingSummary: teamAny.standingSummary,
  } as any;
}

export function getSportConfig(sportKey: string): SportConfig | undefined {
  return SPORT_CONFIG[sportKey];
}

export function getCategoryDisplayName(categoryId: string): string {
  const categoryNames: Record<string, string> = {
    football: 'Football',
    basketball: 'Basketball',
    baseball: 'Baseball',
    hockey: 'Hockey',
    soccer: 'Soccer',
    mma: 'MMA & Combat',
    golf: 'Golf',
    tennis: 'Tennis',
    racing: 'Racing',
    rugby: 'Rugby Union',
    'rugby-league': 'Rugby League',
    'australian-football': 'Australian Football',
  };
  return categoryNames[categoryId] || categoryId;
}
