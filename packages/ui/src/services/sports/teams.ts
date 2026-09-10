/**
 * Teams API
 *
 * Functions for fetching team information and schedules
 */

import type { 
  ESPTeam, 
  ESPNEvent, 
  SportsTeam, 
  SportsEvent,
  TeamDetails,
  TeamRecord,
  TeamAthlete,
  StandingTeam,
  StandingGroup,
  DepthChartGroup,
  DepthChartPosition,
  TeamInjury,
  TeamLeaderCategory,
  TeamLeader,
  TeamNewsArticle,
} from './types';
import { SPORT_CONFIG } from './config';
import { 
  fetchJson, 
  buildTeamsUrl, 
  buildTeamUrl, 
  buildTeamScheduleUrl,
  buildStandingsUrl,
} from './client';
import { mapESPNEvent, mapESPNTeam } from './mappers';

const MAJOR_SPORTS = ['nfl', 'nba', 'mlb', 'nhl'];

export async function searchTeams(query: string): Promise<SportsTeam[]> {
  const results: SportsTeam[] = [];
  const queryLower = query.toLowerCase();

  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{
      sports?: Array<{
        leagues?: Array<{
          teams?: Array<{ team?: ESPTeam }>;
        }>;
      }>;
    }>(buildTeamsUrl(config.sport, config.league));

    if (data?.sports) {
      for (const sport of data.sports) {
        for (const league of sport.leagues || []) {
          for (const teamWrapper of league.teams || []) {
            const team = teamWrapper.team;
            if (team && matchesTeamQuery(team, queryLower)) {
              results.push(mapESPNTeam(team, sportKey));
            }
          }
        }
      }
    }
  }

  console.log('[ESPN API] Team search results:', results.length, 'for', query);
  return results;
}

function matchesTeamQuery(team: ESPTeam, query: string): boolean {
  return (
    team.displayName?.toLowerCase().includes(query) ||
    team.location?.toLowerCase().includes(query) ||
    team.name?.toLowerCase().includes(query) ||
    team.shortDisplayName?.toLowerCase().includes(query) ||
    team.abbreviation?.toLowerCase() === query
  );
}

export async function getTeamById(id: string): Promise<SportsTeam | null> {
  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ team: ESPTeam }>(
      buildTeamUrl(config.sport, config.league, id)
    );

    if (data?.team) {
      return mapESPNTeam(data.team, sportKey);
    }
  }

  return null;
}

export async function getTeamNextEvents(teamId: string): Promise<SportsEvent[]> {
  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ team: ESPTeam }>(
      buildTeamUrl(config.sport, config.league, teamId)
    );

    if (data?.team?.nextEvent) {
      return data.team.nextEvent.map(e => mapESPNEvent(e, sportKey));
    }
  }

  return [];
}

export async function getTeamPastEvents(teamId: string, limit: number = 10): Promise<SportsEvent[]> {
  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ events?: ESPNEvent[] }>(
      buildTeamScheduleUrl(config.sport, config.league, teamId)
    );

    if (data?.events) {
      const now = new Date();
      return data.events
        .filter(e => new Date(e.date) < now)
        .slice(-limit)
        .map(e => mapESPNEvent(e, sportKey));
    }
  }

  return [];
}

export async function getTeamSchedule(teamId: string, leagueId: string): Promise<{ upcoming: SportsEvent[]; past: SportsEvent[] }> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return { upcoming: [], past: [] };

  const data = await fetchJson<{ events?: ESPNEvent[] }>(
    buildTeamScheduleUrl(config.sport, config.league, teamId)
  );

  if (!data?.events) return { upcoming: [], past: [] };

  const now = new Date();
  const allEvents = data.events.map(e => mapESPNEvent(e, leagueId));

  return {
    upcoming: allEvents.filter(e => e.status === 'scheduled' && e.startTime.getTime() > now.getTime()),
    past: allEvents.filter(e => e.status === 'finished' || e.startTime.getTime() <= now.getTime()).reverse(),
  };
}

export async function getTeamDetails(teamId: string, leagueId: string, includeRoster: boolean = true): Promise<TeamDetails | null> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return null;

  const rosterParam = includeRoster ? '?enable=roster' : '';
  const data = await fetchJson<{
    team: {
      id: string;
      location: string;
      name: string;
      displayName: string;
      shortDisplayName: string;
      abbreviation: string;
      color: string;
      alternateColor: string;
      logos?: Array<{ href: string }>;
      record?: {
        items?: Array<{
          type: string;
          summary: string;
          description?: string;
          stats?: Array<{ name: string; value: number }>;
        }>;
      };
      standingSummary?: string;
      nextEvent?: ESPNEvent[];
      athletes?: Array<{
        id: string;
        firstName: string;
        lastName: string;
        displayName: string;
        jersey?: string;
        position?: { displayName: string; abbreviation?: string };
        headshot?: { href: string };
        displayHeight?: string;
        displayWeight?: string;
        age?: number;
        experience?: { displayValue: string };
        college?: { name: string };
      }>;
    };
  }>(`${buildTeamUrl(config.sport, config.league, teamId)}${rosterParam}`);

  if (!data?.team) return null;

  const team = data.team;

  return {
    id: team.id,
    name: team.displayName,
    shortName: team.shortDisplayName,
    location: team.location,
    abbreviation: team.abbreviation,
    color: team.color,
    alternateColor: team.alternateColor,
    logo: team.logos?.[0]?.href,
    record: parseTeamRecord(team.record),
    standingSummary: team.standingSummary,
    nextEvent: team.nextEvent?.[0] && new Date(team.nextEvent[0].date).getTime() > Date.now() && team.nextEvent[0].status?.type?.state === 'pre' ? mapESPNEvent(team.nextEvent[0], leagueId) : undefined,
    athletes: (() => {
      const seenIds = new Set<string>();
      const athletesList: TeamAthlete[] = [];
      for (const a of team.athletes || []) {
        if (!a.id || seenIds.has(a.id)) continue;
        seenIds.add(a.id);
        athletesList.push({
          id: a.id,
          name: a.displayName,
          firstName: a.firstName,
          lastName: a.lastName,
          jersey: a.jersey,
          position: a.position?.displayName || '',
          positionAbbrev: a.position?.abbreviation,
          headshot: a.headshot?.href,
          height: a.displayHeight,
          weight: a.displayWeight,
          age: a.age,
          experience: a.experience?.displayValue,
          college: a.college?.name,
        });
      }
      return athletesList;
    })(),
  };
}

function parseTeamRecord(recordData?: { items?: Array<{ type: string; summary: string; stats?: Array<{ name: string; value: number }> }> }): TeamRecord | undefined {
  if (!recordData?.items) return undefined;

  const totalRecord = recordData.items.find(r => r.type === 'total');
  if (!totalRecord) return undefined;

  const stats = totalRecord.stats || [];
  const getStat = (name: string) => stats.find(s => s.name === name)?.value || 0;

  return {
    overall: totalRecord.summary,
    home: recordData.items.find(r => r.type === 'home')?.summary || '',
    away: recordData.items.find(r => r.type === 'road')?.summary || '',
    wins: getStat('wins'),
    losses: getStat('losses'),
    ties: getStat('ties') || undefined,
    winPercent: getStat('winPercent'),
    pointsFor: getStat('pointsFor'),
    pointsAgainst: getStat('pointsAgainst'),
    pointDifferential: getStat('pointDifferential') || getStat('differential'),
    avgPointsFor: getStat('avgPointsFor'),
    avgPointsAgainst: getStat('avgPointsAgainst'),
  };
}

const TEAMS_CACHE_KEY_PREFIX = 'sports_teams_cache_v2_';
const TEAMS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCachedTeams(leagueId: string): SportsTeam[] | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(TEAMS_CACHE_KEY_PREFIX + leagueId);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.data)) {
        // Honour the 7-day TTL. Payloads written without a usable timestamp
        // (older versions) are treated as expired and re-fetched.
        const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
        // Expire stale AFL cache if it contains ESPN ghost duplicate (id 19)
        if (leagueId === 'afl' && (parsed.data.length > 18 || parsed.data.some((t: any) => t.id === '19'))) {
          localStorage.removeItem(TEAMS_CACHE_KEY_PREFIX + leagueId);
          return null;
        }
        if (Date.now() - timestamp < TEAMS_CACHE_TTL_MS) {
          return parsed.data;
        }
        // Expired — remove so the next fetch writes a fresh entry.
        localStorage.removeItem(TEAMS_CACHE_KEY_PREFIX + leagueId);
      }
    }
  } catch {
    // Ignore storage parse errors
  }
  return null;
}

function saveCachedTeams(leagueId: string, teams: SportsTeam[]) {
  try {
    if (typeof window === 'undefined') return;
    const payload = {
      data: teams,
      timestamp: Date.now(),
    };
    localStorage.setItem(TEAMS_CACHE_KEY_PREFIX + leagueId, JSON.stringify(payload));
  } catch {
    // Ignore storage write errors
  }
}

export async function getLeagueTeams(leagueId: string): Promise<SportsTeam[]> {
  const cached = getCachedTeams(leagueId);
  if (cached && cached.length > 0) {
    return cached.map(t => ({ ...t, leagueId: t.leagueId || leagueId }));
  }

  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    sports?: Array<{
      leagues?: Array<{
        teams?: Array<{ team?: ESPTeam }>;
      }>;
    }>;
  }>(buildTeamsUrl(config.sport, config.league), { ttlMs: TEAMS_CACHE_TTL_MS });

  const teams: SportsTeam[] = [];

  if (data?.sports) {
    for (const sport of data.sports) {
      for (const league of sport.leagues || []) {
        for (const teamWrapper of league.teams || []) {
          const team = teamWrapper.team;
          if (team) {
            // ESPN AFL database includes an erroneous ghost duplicate (id 19) of Gold Coast FC mistakenly labeled Sydney Swans
            if (leagueId === 'afl' && team.id === '19') continue;
            teams.push(mapESPNTeam(team, leagueId));
          }
        }
      }
    }
  }

  if (teams.length > 0) {
    saveCachedTeams(leagueId, teams);
  }

  console.log('[ESPN API] League teams:', teams.length, 'for', leagueId);
  return teams;
}

const DIVISION_MAP: Record<string, Record<string, string>> = {
  nfl: {
    // AFC East
    'BUF': 'AFC East', 'MIA': 'AFC East', 'NE': 'AFC East', 'NYJ': 'AFC East',
    '2': 'AFC East', '15': 'AFC East', '17': 'AFC East', '20': 'AFC East',
    // AFC North
    'BAL': 'AFC North', 'CIN': 'AFC North', 'CLE': 'AFC North', 'PIT': 'AFC North',
    '33': 'AFC North', '4': 'AFC North', '5': 'AFC North', '23': 'AFC North',
    // AFC South
    'HOU': 'AFC South', 'IND': 'AFC South', 'JAX': 'AFC South', 'JAC': 'AFC South', 'TEN': 'AFC South',
    '34': 'AFC South', '11': 'AFC South', '30': 'AFC South', '10': 'AFC South',
    // AFC West
    'DEN': 'AFC West', 'KC': 'AFC West', 'LV': 'AFC West', 'LVR': 'AFC West', 'LAC': 'AFC West',
    '7': 'AFC West', '12': 'AFC West', '13': 'AFC West', '24': 'AFC West',

    // NFC East
    'DAL': 'NFC East', 'NYG': 'NFC East', 'PHI': 'NFC East', 'WAS': 'NFC East', 'WSH': 'NFC East',
    '6': 'NFC East', '19': 'NFC East', '21': 'NFC East', '28': 'NFC East',
    // NFC North
    'CHI': 'NFC North', 'DET': 'NFC North', 'GB': 'NFC North', 'MIN': 'NFC North',
    '3': 'NFC North', '8': 'NFC North', '9': 'NFC North', '16': 'NFC North',
    // NFC South
    'ATL': 'NFC South', 'CAR': 'NFC South', 'NO': 'NFC South', 'TB': 'NFC South',
    '1': 'NFC South', '29': 'NFC South', '18': 'NFC South', '27': 'NFC South',
    // NFC West
    'ARI': 'NFC West', 'LAR': 'NFC West', 'SF': 'NFC West', 'SEA': 'NFC West',
    '22': 'NFC West', '14': 'NFC West', '25': 'NFC West', '26': 'NFC West',
  },
  mlb: {
    // AL East
    'BAL': 'AL East', '1': 'AL East',
    'BOS': 'AL East', '2': 'AL East',
    'NYY': 'AL East', '10': 'AL East',
    'TB': 'AL East', '30': 'AL East',
    'TOR': 'AL East', '14': 'AL East',

    // AL Central
    'CHW': 'AL Central', 'CWS': 'AL Central', '4': 'AL Central',
    'CLE': 'AL Central', '5': 'AL Central',
    'DET': 'AL Central', '6': 'AL Central',
    'KC': 'AL Central', '7': 'AL Central',
    'MIN': 'AL Central', '9': 'AL Central',

    // AL West
    'ATH': 'AL West', 'OAK': 'AL West', '11': 'AL West',
    'HOU': 'AL West', '18': 'AL West',
    'LAA': 'AL West', '3': 'AL West',
    'SEA': 'AL West', '12': 'AL West',
    'TEX': 'AL West', '13': 'AL West',

    // NL East
    'ATL': 'NL East', '15': 'NL East',
    'MIA': 'NL East', '28': 'NL East',
    'NYM': 'NL East', '21': 'NL East',
    'PHI': 'NL East', '22': 'NL East',
    'WSH': 'NL East', 'WAS': 'NL East', '20': 'NL East',

    // NL Central
    'CHC': 'NL Central', '16': 'NL Central',
    'CIN': 'NL Central', '17': 'NL Central',
    'MIL': 'NL Central', '8': 'NL Central',
    'PIT': 'NL Central', '23': 'NL Central',
    'STL': 'NL Central', '24': 'NL Central',

    // NL West
    'ARI': 'NL West', '29': 'NL West',
    'COL': 'NL West', '27': 'NL West',
    'LAD': 'NL West', '19': 'NL West',
    'SD': 'NL West', '25': 'NL West',
    'SF': 'NL West', '26': 'NL West',
  },
  nba: {
    // Atlantic
    'BOS': 'Atlantic', '2': 'Atlantic',
    'BKN': 'Atlantic', 'NJN': 'Atlantic', '17': 'Atlantic',
    'NY': 'Atlantic', 'NYK': 'Atlantic', '18': 'Atlantic',
    'PHI': 'Atlantic', '20': 'Atlantic',
    'TOR': 'Atlantic', '28': 'Atlantic',

    // Central
    'CHI': 'Central', '4': 'Central',
    'CLE': 'Central', '5': 'Central',
    'DET': 'Central', '8': 'Central',
    'IND': 'Central', '11': 'Central',
    'MIL': 'Central', '15': 'Central',

    // Southeast
    'ATL': 'Southeast', '1': 'Southeast',
    'CHA': 'Southeast', 'CHH': 'Southeast', '30': 'Southeast',
    'MIA': 'Southeast', '14': 'Southeast',
    'ORL': 'Southeast', '19': 'Southeast',
    'WAS': 'Southeast', 'WSH': 'Southeast', '27': 'Southeast',

    // Northwest
    'DEN': 'Northwest', '7': 'Northwest',
    'MIN': 'Northwest', '16': 'Northwest',
    'OKC': 'Northwest', '25': 'Northwest',
    'POR': 'Northwest', '22': 'Northwest',
    'UTAH': 'Northwest', 'UTA': 'Northwest', '26': 'Northwest',

    // Pacific
    'GS': 'Pacific', 'GSW': 'Pacific', '9': 'Pacific',
    'LAC': 'Pacific', '12': 'Pacific',
    'LAL': 'Pacific', '13': 'Pacific',
    'PHX': 'Pacific', 'PHO': 'Pacific', '21': 'Pacific',
    'SAC': 'Pacific', '23': 'Pacific',

    // Southwest
    'DAL': 'Southwest', '6': 'Southwest',
    'HOU': 'Southwest', '10': 'Southwest',
    'MEM': 'Southwest', '29': 'Southwest',
    'NO': 'Southwest', 'NOP': 'Southwest', '3': 'Southwest',
    'SA': 'Southwest', 'SAS': 'Southwest', '24': 'Southwest',
  },
  nhl: {
    // Atlantic
    'BOS': 'Atlantic', '1': 'Atlantic',
    'BUF': 'Atlantic', '2': 'Atlantic',
    'DET': 'Atlantic', '5': 'Atlantic',
    'FLA': 'Atlantic', '26': 'Atlantic',
    'MTL': 'Atlantic', 'MON': 'Atlantic', '10': 'Atlantic',
    'OTT': 'Atlantic', '14': 'Atlantic',
    'TB': 'Atlantic', 'TBL': 'Atlantic', '20': 'Atlantic',
    'TOR': 'Atlantic', '21': 'Atlantic',

    // Metropolitan
    'CAR': 'Metropolitan', '7': 'Metropolitan',
    'CBJ': 'Metropolitan', '29': 'Metropolitan',
    'NJ': 'Metropolitan', 'NJD': 'Metropolitan', '11': 'Metropolitan',
    'NYI': 'Metropolitan', '12': 'Metropolitan',
    'NYR': 'Metropolitan', '13': 'Metropolitan',
    'PHI': 'Metropolitan', '15': 'Metropolitan',
    'PIT': 'Metropolitan', '16': 'Metropolitan',
    'WSH': 'Metropolitan', 'WAS': 'Metropolitan', '23': 'Metropolitan',

    // Central
    'CHI': 'Central', '4': 'Central',
    'COL': 'Central', '17': 'Central',
    'DAL': 'Central', '9': 'Central',
    'MIN': 'Central', '30': 'Central',
    'NSH': 'Central', '27': 'Central',
    'STL': 'Central', '19': 'Central',
    'UTA': 'Central', '129764': 'Central',
    'WPG': 'Central', '28': 'Central',

    // Pacific
    'ANA': 'Pacific', '25': 'Pacific',
    'CGY': 'Pacific', '3': 'Pacific',
    'EDM': 'Pacific', '6': 'Pacific',
    'LA': 'Pacific', 'LAK': 'Pacific', '8': 'Pacific',
    'SJ': 'Pacific', 'SJS': 'Pacific', '18': 'Pacific',
    'SEA': 'Pacific', '124292': 'Pacific',
    'VGK': 'Pacific', 'VEG': 'Pacific', '37': 'Pacific',
    'VAN': 'Pacific', '22': 'Pacific',
  }
};

const DIVISION_ORDER: Record<string, string[]> = {
  nfl: ['AFC East', 'AFC North', 'AFC South', 'AFC West', 'NFC East', 'NFC North', 'NFC South', 'NFC West'],
  mlb: ['AL East', 'AL Central', 'AL West', 'NL East', 'NL Central', 'NL West'],
  nba: ['Atlantic', 'Central', 'Southeast', 'Northwest', 'Pacific', 'Southwest'],
  nhl: ['Atlantic', 'Metropolitan', 'Central', 'Pacific'],
};

export async function getLeagueStandings(leagueId: string): Promise<StandingTeam[]> {
  const groups = await getLeagueStandingsGrouped(leagueId);
  return groups.flatMap(g => g.teams);
}

export async function getLeagueStandingsGrouped(leagueId: string): Promise<StandingGroup[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    name?: string;
    children?: Array<{
      name: string;
      abbreviation?: string;
      isConference?: boolean;
      standings?: {
        entries?: Array<{
          team: {
            id: string;
            displayName: string;
            abbreviation: string;
            logos?: Array<{ href: string }>;
          };
          stats?: Array<{
            name: string;
            value: number;
            displayValue: string;
          }>;
        }>;
      };
    }>;
    standings?: {
      entries?: Array<{
        team: {
          id: string;
          displayName: string;
          abbreviation: string;
          logos?: Array<{ href: string }>;
        };
        stats?: Array<{
          name: string;
          value: number;
          displayValue: string;
        }>;
      }>;
    };
  }>(buildStandingsUrl(config.sport, config.league));

  const groups: StandingGroup[] = [];
  const divMap = DIVISION_MAP[leagueId];

  const conferences = (data?.children && data.children.length > 0)
    ? data.children
    : (data?.standings?.entries ? [{ name: data.name || 'Ladder', isConference: false, standings: data.standings }] : []);

  for (const conference of conferences) {
    const entries = conference.standings?.entries || [];
    const teams: StandingTeam[] = [];

    for (const entry of entries) {
      const team = entry.team;
      const stats = entry.stats || [];
      
      const getStat = (name: string) => stats.find(s => s.name === name)?.value ?? 0;

      const wins = getStat('wins');
      const losses = getStat('losses');
      const ties = getStat('ties');
      const winPercent = getStat('winPercent');
      const gamesBehind = getStat('gamesBehind');
      const streak = getStat('streak');
      const rank = getStat('rank');

      const total = wins + losses + ties;
      const winPercentDisplay = winPercent > 0
        ? (winPercent * 100).toFixed(1)
        : total > 0
          ? ((wins / total) * 100).toFixed(1)
          : '0.0';

      const mappedDivision = divMap
        ? (divMap[team.id] || (team.abbreviation ? divMap[team.abbreviation] : undefined))
        : undefined;

      teams.push({
        id: team.id,
        name: team.displayName,
        shortName: team.abbreviation,
        logo: team.logos?.[0]?.href,
        wins,
        losses,
        ties,
        winPercent: winPercentDisplay,
        winPercentValue: winPercent || (total > 0 ? wins / total : 0),
        gamesBehind: gamesBehind ? String(gamesBehind) : undefined,
        streak: streak ? (streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`) : undefined,
        division: mappedDivision || (conference.isConference ? conference.name : undefined),
        rank: rank || 0,
      });
    }

    // Sort by rank if available, otherwise by win percentage within each group
    if (teams.some(t => t.rank > 0)) {
      teams.sort((a, b) => (a.rank || 999) - (b.rank || 999));
    } else {
      teams.sort((a, b) => b.winPercentValue - a.winPercentValue);
      teams.forEach((team, idx) => { team.rank = idx + 1; });
    }

    if (teams.length > 0) {
      groups.push({
        name: conference.name,
        isConference: !!conference.isConference,
        teams,
      });
    }
  }

  console.log('[ESPN API] Standings groups:', groups.length, 'for', leagueId);
  return groups;
}

export function getLeagueStandingsByDivision(leagueId: string, conferenceGroups: StandingGroup[]): StandingGroup[] {
  const allTeams = conferenceGroups.flatMap(g => g.teams);
  const divMap = DIVISION_MAP[leagueId];
  if (!divMap) return conferenceGroups;

  const divisionOrder = DIVISION_ORDER[leagueId] || [];
  const groupsByDiv: Record<string, StandingTeam[]> = {};

  for (const team of allTeams) {
    const divName = team.division || 'Other';
    if (!groupsByDiv[divName]) {
      groupsByDiv[divName] = [];
    }
    groupsByDiv[divName].push({ ...team });
  }

  const result: StandingGroup[] = [];

  const sortedDivNames = [
    ...divisionOrder.filter(d => groupsByDiv[d]),
    ...Object.keys(groupsByDiv).filter(d => !divisionOrder.includes(d)),
  ];

  for (const divName of sortedDivNames) {
    const teams = groupsByDiv[divName];
    teams.sort((a, b) => b.winPercentValue - a.winPercentValue || b.wins - a.wins);
    teams.forEach((t, idx) => { t.rank = idx + 1; });

    result.push({
      name: divName,
      isConference: false,
      teams,
    });
  }

  return result;
}

function formatDepthGroupName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('special')) return 'Special Teams';
  if (lower.includes('3wr') || lower.includes('offense') || lower.includes('personnel')) return 'Offense';
  if (lower.includes('3-4') || lower.includes('4-3') || lower.includes('defense') || lower.includes(' d') || lower.endsWith(' d')) return 'Defense';
  return name;
}

export async function getTeamDepthChart(teamId: string, leagueId: string): Promise<DepthChartGroup[]> {
  const config = SPORT_CONFIG[leagueId] || SPORT_CONFIG['nfl'];
  if (!config) return [];

  try {
    const data = await fetchJson<{
      depthchart?: Array<{
        id: string;
        name: string;
        positions?: Record<
          string,
          {
            position?: { displayName?: string; name?: string; abbreviation?: string };
            athletes?: Array<{
              id: string;
              displayName: string;
              shortName?: string;
              jersey?: string;
              rank?: number;
              headshot?: { href: string };
            }>;
          }
        >;
      }>;
    }>(`https://site.web.api.espn.com/apis/site/v2/sports/${config.sport}/${config.league}/teams/${teamId}/depthcharts`);

    const results: DepthChartGroup[] = [];

    for (const group of data?.depthchart || []) {
      const positions: DepthChartPosition[] = [];
      for (const [posKey, posObj] of Object.entries(group.positions || {})) {
        const posName = posObj.position?.displayName || posObj.position?.name || posKey.toUpperCase();
        const posAbbrev = posObj.position?.abbreviation || posKey.toUpperCase();
        const athletes = (posObj.athletes || []).map((a: any, idx) => {
          const ath = a.athlete || a;
          const athId = ath.id || a.id || '';
          const athName = ath.displayName || ath.fullName || a.displayName || 'Athlete';
          const athJersey = ath.jersey || a.jersey;
          const athHeadshot = ath.headshot?.href || a.headshot?.href || undefined;

          return {
            id: athId || `pos-${idx}`,
            name: athName,
            shortName: ath.shortName || a.shortName,
            jersey: athJersey,
            rank: a.rank || idx + 1,
            headshot: athHeadshot,
            position: posAbbrev,
          };
        });

        positions.push({
          name: posKey,
          displayName: posName,
          abbreviation: posAbbrev,
          athletes,
        });
      }

      if (positions.length > 0) {
        results.push({
          id: group.id,
          name: formatDepthGroupName(group.name),
          positions,
        });
      }
    }

    const groupOrder = ['Offense', 'Defense', 'Special Teams'];
    results.sort((a, b) => {
      const aIdx = groupOrder.indexOf(a.name);
      const bIdx = groupOrder.indexOf(b.name);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  } catch (err) {
    console.error('[ESPN API] Failed to fetch depth chart:', err);
    return [];
  }
}

export async function getTeamInjuries(teamId: string, leagueId: string): Promise<TeamInjury[]> {
  const config = SPORT_CONFIG[leagueId] || SPORT_CONFIG['nfl'];
  if (!config) return [];

  try {
    const data = await fetchJson<{
      team?: {
        athletes?: Array<{
          id: string;
          displayName: string;
          jersey?: string;
          position?: { abbreviation?: string; displayName?: string };
          headshot?: { href: string };
          injuries?: Array<{
            id?: string;
            status?: string;
            date?: string;
            longComment?: string;
            shortComment?: string;
            details?: {
              type?: string;
              location?: string;
              side?: string;
              returnDate?: string;
            };
          }>;
        }>;
      };
    }>(`${buildTeamUrl(config.sport, config.league, teamId)}?enable=roster`);

    const injuries: TeamInjury[] = [];
    const seenInjuryKeys = new Set<string>();

    for (const a of data?.team?.athletes || []) {
      if (a.injuries && a.injuries.length > 0) {
        for (const inj of a.injuries) {
          const injuryKey = `${a.id}-${inj.id || inj.status || inj.date || 'inj'}`;
          if (seenInjuryKeys.has(injuryKey)) continue;
          seenInjuryKeys.add(injuryKey);

          injuries.push({
            id: inj.id || `${a.id}-inj`,
            athleteId: a.id,
            athleteName: a.displayName,
            jersey: a.jersey,
            position: a.position?.abbreviation || a.position?.displayName,
            headshot: a.headshot?.href || `https://a.espncdn.com/i/headshots/${config.sport}/players/full/${a.id}.png`,
            status: inj.status || 'Injured',
            date: inj.date,
            comment: inj.longComment || inj.shortComment,
            shortComment: inj.shortComment,
            returnDate: inj.details?.returnDate,
            location: inj.details?.location,
            type: inj.details?.type,
          });
        }
      }
    }

    return injuries;
  } catch (err) {
    console.error('[ESPN API] Failed to fetch team injuries:', err);
    return [];
  }
}

export async function getTeamNews(teamId: string, leagueId: string): Promise<TeamNewsArticle[]> {
  const config = SPORT_CONFIG[leagueId] || SPORT_CONFIG['nfl'];
  if (!config) return [];

  try {
    const data = await fetchJson<{
      articles?: Array<{
        id: string;
        headline: string;
        description?: string;
        published?: string;
        images?: Array<{ url: string }>;
        links?: { web?: { href: string } };
      }>;
    }>(`https://site.web.api.espn.com/apis/site/v2/sports/${config.sport}/${config.league}/news?team=${teamId}`);

    return (data?.articles || []).map(art => ({
      id: art.id,
      headline: art.headline,
      description: art.description,
      published: art.published,
      imageUrl: art.images?.[0]?.url,
      link: art.links?.web?.href,
    }));
  } catch (err) {
    console.error('[ESPN API] Failed to fetch team news:', err);
    return [];
  }
}

export async function getTeamLeaders(teamId: string, leagueId: string): Promise<TeamLeaderCategory[]> {
  const config = SPORT_CONFIG[leagueId] || SPORT_CONFIG['nfl'];
  if (!config) return [];

  try {
    const currentYear = new Date().getFullYear();
    const rosterUrl = `${buildTeamUrl(config.sport, config.league, teamId)}?enable=roster`;
    let leadersUrl = `https://sports.core.api.espn.com/v2/sports/${config.sport}/leagues/${config.league}/seasons/${currentYear}/types/2/teams/${teamId}/leaders`;

    let [rosterData, leadersData] = await Promise.all([
      fetchJson<{
        team?: {
          athletes?: Array<{
            id: string;
            displayName?: string;
            fullName?: string;
            jersey?: string;
            headshot?: { href?: string };
            position?: { abbreviation?: string; displayName?: string };
          }>;
        };
      }>(rosterUrl),

      fetchJson<{
        categories?: Array<{
          name: string;
          displayName: string;
          shortDisplayName: string;
          abbreviation?: string;
          leaders?: Array<{
            displayValue?: string;
            value?: number;
            athlete?: {
              $ref?: string;
              id?: string;
              displayName?: string;
              fullName?: string;
              jersey?: string;
              headshot?: { href?: string };
              position?: { abbreviation?: string };
            };
          }>;
        }>;
      }>(leadersUrl, { suppressWarns: true }),
    ]);

    if (!leadersData?.categories || leadersData.categories.length === 0) {
      leadersUrl = `https://sports.core.api.espn.com/v2/sports/${config.sport}/leagues/${config.league}/seasons/${currentYear - 1}/types/2/teams/${teamId}/leaders`;
      leadersData = await fetchJson(leadersUrl);
    }

    const athleteMap = new Map<string, {
      name: string;
      jersey?: string;
      position?: string;
      headshot?: string;
    }>();

    for (const ath of rosterData?.team?.athletes || []) {
      athleteMap.set(ath.id, {
        name: ath.displayName || ath.fullName || 'Athlete',
        jersey: ath.jersey,
        position: ath.position?.abbreviation || ath.position?.displayName,
        headshot: ath.headshot?.href,
      });
    }

    // Collect any leader athlete IDs that are not present in current roster payload
    const missingIds = new Set<string>();
    for (const cat of leadersData?.categories || []) {
      for (const l of cat.leaders || []) {
        let athId = l.athlete?.id;
        const refStr = l.athlete?.$ref;
        if (!athId && refStr) {
          const match = refStr.match(/athletes\/(\d+)/);
          if (match) athId = match[1];
        }
        if (athId && !athleteMap.has(athId)) {
          missingIds.add(athId);
        }
      }
    }

    if (missingIds.size > 0) {
      await Promise.all(
        Array.from(missingIds).map(async (id) => {
          try {
            const bioRes = await fetchJson<{
              athlete?: {
                id: string;
                displayName?: string;
                fullName?: string;
                jersey?: string;
                headshot?: { href?: string };
                position?: { abbreviation?: string; displayName?: string };
              };
            }>(`https://site.web.api.espn.com/apis/common/v3/sports/${config.sport}/${config.league}/athletes/${id}`);

            if (bioRes?.athlete) {
              const ath = bioRes.athlete;
              athleteMap.set(id, {
                name: ath.displayName || ath.fullName || 'Athlete',
                jersey: ath.jersey,
                position: ath.position?.abbreviation || ath.position?.displayName,
                headshot: ath.headshot?.href || `https://a.espncdn.com/i/headshots/${config.sport}/players/full/${id}.png`,
              });
            }
          } catch {
            // Ignore single athlete resolution failure
          }
        })
      );
    }

    const results: TeamLeaderCategory[] = [];

    for (const cat of leadersData?.categories || []) {
      const leaders: TeamLeader[] = [];
      for (const l of cat.leaders || []) {
        let athId = l.athlete?.id;
        const refStr = l.athlete?.$ref;
        if (!athId && refStr) {
          const match = refStr.match(/athletes\/(\d+)/);
          if (match) athId = match[1];
        }
        if (athId) {
          const info = athleteMap.get(athId);
          const name = info?.name || l.athlete?.displayName || l.athlete?.fullName || 'Athlete';
          const jersey = info?.jersey || l.athlete?.jersey;
          const position = info?.position || l.athlete?.position?.abbreviation;
          const headshot = info?.headshot || l.athlete?.headshot?.href || `https://a.espncdn.com/i/headshots/${config.sport}/players/full/${athId}.png`;

          leaders.push({
            athleteId: athId,
            name,
            jersey,
            position,
            headshot,
            valueDisplay: l.displayValue || String(l.value || ''),
            statName: cat.abbreviation || cat.shortDisplayName,
          });
        }
      }

      if (leaders.length > 0) {
        results.push({
          name: cat.name,
          displayName: cat.displayName,
          shortDisplayName: cat.shortDisplayName,
          abbreviation: cat.abbreviation,
          leaders,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}


