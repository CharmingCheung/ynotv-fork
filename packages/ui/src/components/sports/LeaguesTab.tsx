import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEpgClockFormat } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';
import { formatTime, formatDate } from '../../utils/dateTime';
import type { SportsEvent, SportsLeague, SportsTeam } from '@ynotv/core';
import {
  getAvailableLeagues,
  getLeagueEvents,
  getLeagueTeams,
  getLeagueStandingsGrouped,
  getLeagueStandingsByDivision,
  getGolfRankings,
  getTennisRankings,
  getRacingStandings,
  getLeagueLogos,
  type StandingTeam,
  type StandingGroup,
  type GolfRanking,
  type TennisRanking,
  type RacingStanding,
  formatEventTime,
} from '../../services/sports';
import { TeamDetail } from './TeamDetail';
import { GameDetail } from './GameDetail';
import { SportsCalendarModal } from './SportsCalendarModal';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useSportsFavoritesStore, matchesFavorite } from '../../stores/sportsFavoritesStore';

interface LeaguesTabProps {
  onSearchChannels?: (channelName: string) => void;
  onPlayChannel?: (channel: import('../../db').StoredChannel) => void;
}

type LeagueView = 'teams' | 'schedule' | 'standings';

// Sports that are individual (no teams)
const INDIVIDUAL_SPORTS = ['ufc', 'pga', 'lpga', 'atp', 'wta', 'f1', 'nascar', 'indycar'];

const SPORT_DISPLAY_NAMES: Record<string, string> = {
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

const SPORT_GRADIENTS: Record<string, string> = {
  football: 'linear-gradient(135deg, rgba(27, 77, 62, 0.95) 0%, rgba(15, 42, 32, 0.95) 100%)',
  basketball: 'linear-gradient(135deg, rgba(234, 88, 12, 0.95) 0%, rgba(154, 52, 18, 0.95) 100%)',
  baseball: 'linear-gradient(135deg, rgba(244, 63, 94, 0.95) 0%, rgba(190, 18, 60, 0.95) 100%)',
  hockey: 'linear-gradient(135deg, rgba(2, 132, 199, 0.95) 0%, rgba(3, 105, 161, 0.95) 100%)',
  soccer: 'linear-gradient(135deg, rgba(22, 163, 74, 0.95) 0%, rgba(21, 128, 61, 0.95) 100%)',
  mma: 'linear-gradient(135deg, rgba(220, 38, 38, 0.95) 0%, rgba(153, 27, 27, 0.95) 100%)',
  golf: 'linear-gradient(135deg, rgba(5, 150, 105, 0.95) 0%, rgba(6, 95, 70, 0.95) 100%)',
  tennis: 'linear-gradient(135deg, rgba(101, 163, 13, 0.95) 0%, rgba(77, 124, 15, 0.95) 100%)',
  racing: 'linear-gradient(135deg, rgba(71, 85, 105, 0.95) 0%, rgba(30, 41, 59, 0.95) 100%)',
  rugby: 'linear-gradient(135deg, rgba(194, 65, 12, 0.95) 0%, rgba(124, 45, 18, 0.95) 100%)',
  'rugby-league': 'linear-gradient(135deg, rgba(234, 88, 12, 0.95) 0%, rgba(154, 52, 18, 0.95) 100%)',
  'australian-football': 'linear-gradient(135deg, rgba(185, 28, 28, 0.95) 0%, rgba(30, 58, 138, 0.95) 100%)',
};

const LEAGUE_TEAM_ID_DIVISIONS: Record<string, Record<string, string>> = {
  nba: {
    '1': 'Southeast Division',   // Atlanta Hawks
    '2': 'Atlantic Division',    // Boston Celtics
    '3': 'Southwest Division',   // New Orleans Pelicans
    '4': 'Central Division',     // Chicago Bulls
    '5': 'Central Division',     // Cleveland Cavaliers
    '6': 'Southwest Division',   // Dallas Mavericks
    '7': 'Northwest Division',   // Denver Nuggets
    '8': 'Central Division',     // Detroit Pistons
    '9': 'Pacific Division',     // Golden State Warriors
    '10': 'Southwest Division',  // Houston Rockets
    '11': 'Central Division',    // Indiana Pacers
    '12': 'Pacific Division',    // LA Clippers
    '13': 'Pacific Division',    // Los Angeles Lakers
    '14': 'Southeast Division',  // Miami Heat
    '15': 'Central Division',    // Milwaukee Bucks
    '16': 'Northwest Division',  // Minnesota Timberwolves
    '17': 'Atlantic Division',   // Brooklyn Nets
    '18': 'Atlantic Division',   // New York Knicks
    '19': 'Southeast Division',  // Orlando Magic
    '20': 'Atlantic Division',   // Philadelphia 76ers
    '21': 'Pacific Division',    // Phoenix Suns
    '22': 'Northwest Division',  // Portland Trail Blazers
    '23': 'Pacific Division',    // Sacramento Kings
    '24': 'Southwest Division',  // San Antonio Spurs
    '25': 'Northwest Division',  // Oklahoma City Thunder
    '26': 'Northwest Division',  // Utah Jazz
    '27': 'Southeast Division',  // Washington Wizards
    '28': 'Atlantic Division',   // Toronto Raptors
    '29': 'Southwest Division',  // Memphis Grizzlies
    '30': 'Southeast Division',  // Charlotte Hornets
  },
  mlb: {
    '1': 'AL East',     // Baltimore Orioles
    '2': 'AL East',     // Boston Red Sox
    '3': 'AL West',     // Los Angeles Angels
    '4': 'AL Central',  // Chicago White Sox
    '5': 'AL Central',  // Cleveland Guardians
    '6': 'AL Central',  // Detroit Tigers
    '7': 'AL Central',  // Kansas City Royals
    '8': 'NL Central',  // Milwaukee Brewers
    '9': 'AL Central',  // Minnesota Twins
    '10': 'AL East',    // New York Yankees
    '11': 'AL West',    // Oakland Athletics
    '12': 'AL West',    // Seattle Mariners
    '13': 'AL West',    // Texas Rangers
    '14': 'AL East',    // Toronto Blue Jays
    '15': 'NL East',    // Atlanta Braves
    '16': 'NL Central', // Chicago Cubs
    '17': 'NL Central', // Cincinnati Reds
    '18': 'AL West',    // Houston Astros
    '19': 'NL West',    // Los Angeles Dodgers
    '20': 'NL East',    // Washington Nationals
    '21': 'NL East',    // New York Mets
    '22': 'NL East',    // Philadelphia Phillies
    '23': 'NL Central', // Pittsburgh Pirates
    '24': 'NL Central', // St. Louis Cardinals
    '25': 'NL West',    // San Diego Padres
    '26': 'NL West',    // San Francisco Giants
    '27': 'NL West',    // Colorado Rockies
    '28': 'NL East',    // Miami Marlins
    '29': 'NL West',    // Arizona Diamondbacks
    '30': 'AL East',    // Tampa Bay Rays
  },
  nfl: {
    '1': 'NFC South', '2': 'AFC East', '3': 'NFC North', '4': 'AFC North',
    '5': 'AFC North', '6': 'NFC East', '7': 'AFC West', '8': 'NFC North',
    '9': 'NFC North', '10': 'AFC South', '11': 'AFC South', '12': 'AFC South',
    '13': 'AFC West', '14': 'AFC East', '15': 'NFC North', '16': 'AFC East',
    '17': 'NFC South', '18': 'NFC East', '19': 'AFC East', '20': 'AFC West',
    '21': 'NFC East', '22': 'AFC North', '23': 'AFC West', '24': 'NFC West',
    '25': 'NFC West', '26': 'NFC West', '27': 'NFC South', '28': 'AFC South',
    '29': 'NFC East', '30': 'NFC South', '33': 'AFC North', '34': 'NFC West',
  },
  nhl: {
    // Metropolitan (8)
    '1': 'Metropolitan Division',   // New Jersey Devils
    '2': 'Metropolitan Division',   // New York Islanders
    '3': 'Metropolitan Division',   // New York Rangers
    '4': 'Metropolitan Division',   // Philadelphia Flyers
    '5': 'Metropolitan Division',   // Pittsburgh Penguins
    '11': 'Metropolitan Division',  // Carolina Hurricanes
    '14': 'Metropolitan Division',  // Washington Capitals
    '29': 'Metropolitan Division',  // Columbus Blue Jackets

    // Atlantic (8)
    '6': 'Atlantic Division',       // Boston Bruins
    '7': 'Atlantic Division',       // Buffalo Sabres
    '8': 'Atlantic Division',       // Montreal Canadiens
    '9': 'Atlantic Division',       // Ottawa Senators
    '10': 'Atlantic Division',      // Toronto Maple Leafs
    '12': 'Atlantic Division',      // Florida Panthers
    '13': 'Atlantic Division',      // Tampa Bay Lightning
    '16': 'Atlantic Division',      // Detroit Red Wings

    // Central (8)
    '15': 'Central Division',       // Chicago Blackhawks
    '17': 'Central Division',       // Nashville Predators
    '18': 'Central Division',       // St. Louis Blues
    '21': 'Central Division',       // Colorado Avalanche
    '25': 'Central Division',       // Dallas Stars
    '27': 'Central Division',       // Utah Hockey Club / Utah Mammoth
    '28': 'Central Division',       // Winnipeg Jets
    '30': 'Central Division',       // Minnesota Wild
    '31': 'Central Division',
    '32': 'Central Division',
    '54': 'Central Division',
    '68': 'Central Division',
    '129764': 'Central Division',

    // Pacific (8)
    '19': 'Pacific Division',       // Calgary Flames
    '20': 'Pacific Division',       // Edmonton Oilers
    '22': 'Pacific Division',       // Vancouver Canucks
    '23': 'Pacific Division',       // San Jose Sharks
    '24': 'Pacific Division',       // Los Angeles Kings
    '26': 'Pacific Division',       // Anaheim Ducks
    '52': 'Pacific Division',       // Seattle Kraken
    '53': 'Pacific Division',       // Vegas Golden Knights
  },
};

const FALLBACK_DIVISIONS: Record<string, Record<string, string>> = {
  nfl: {
    BUF: 'AFC East', MIA: 'AFC East', NE: 'AFC East', NYJ: 'AFC East', NY: 'AFC East',
    BAL: 'AFC North', CIN: 'AFC North', CLE: 'AFC North', PIT: 'AFC North',
    HOU: 'AFC South', IND: 'AFC South', JAX: 'AFC South', JAC: 'AFC South', TEN: 'AFC South',
    DEN: 'AFC West', KC: 'AFC West', LV: 'AFC West', LVR: 'AFC West', LAC: 'AFC West',
    DAL: 'NFC East', NYG: 'NFC East', PHI: 'NFC East', WAS: 'NFC East', WSH: 'NFC East',
    CHI: 'NFC North', DET: 'NFC North', GB: 'NFC North', MIN: 'NFC North',
    ATL: 'NFC South', CAR: 'NFC South', NO: 'NFC South', TB: 'NFC South',
    ARI: 'NFC West', LAR: 'NFC West', LA: 'NFC West', SF: 'NFC West', SEA: 'NFC West',
  },
  nba: {
    BOS: 'Atlantic Division', BKN: 'Atlantic Division', NYK: 'Atlantic Division', NY: 'Atlantic Division', PHI: 'Atlantic Division', TOR: 'Atlantic Division',
    CHI: 'Central Division', CLE: 'Central Division', DET: 'Central Division', IND: 'Central Division', MIL: 'Central Division',
    ATL: 'Southeast Division', CHA: 'Southeast Division', MIA: 'Southeast Division', ORL: 'Southeast Division', WAS: 'Southeast Division', WSH: 'Southeast Division',
    DEN: 'Northwest Division', MIN: 'Northwest Division', OKC: 'Northwest Division', POR: 'Northwest Division', UTA: 'Northwest Division', UT: 'Northwest Division',
    GSW: 'Pacific Division', GS: 'Pacific Division', LAC: 'Pacific Division', LAL: 'Pacific Division', PHX: 'Pacific Division', PHO: 'Pacific Division', SAC: 'Pacific Division',
    DAL: 'Southwest Division', HOU: 'Southwest Division', MEM: 'Southwest Division', NOP: 'Southwest Division', NO: 'Southwest Division', SAS: 'Southwest Division', SA: 'Southwest Division',
  },
  mlb: {
    BAL: 'AL East', BOS: 'AL East', NYY: 'AL East', NY: 'AL East', TB: 'AL East', TOR: 'AL East',
    CWS: 'AL Central', CHW: 'AL Central', SOX: 'AL Central', CLE: 'AL Central', DET: 'AL Central', KC: 'AL Central', MIN: 'AL Central',
    HOU: 'AL West', LAA: 'AL West', ANG: 'AL West', OAK: 'AL West', ATH: 'AL West', SEA: 'AL West', TEX: 'AL West',
    ATL: 'NL East', MIA: 'NL East', NYM: 'NL East', PHI: 'NL East', WAS: 'NL East', WSH: 'NL East',
    CHC: 'NL Central', CIN: 'NL Central', MIL: 'NL Central', PIT: 'NL Central', STL: 'NL Central',
    ARI: 'NL West', COL: 'NL West', LAD: 'NL West', SD: 'NL West', SF: 'NL West',
  },
  nhl: {
    BOS: 'Atlantic Division', BUF: 'Atlantic Division', DET: 'Atlantic Division', FLA: 'Atlantic Division', MTL: 'Atlantic Division', OTT: 'Atlantic Division', TB: 'Atlantic Division', TOR: 'Atlantic Division',
    CAR: 'Metropolitan Division', CBJ: 'Metropolitan Division', NJD: 'Metropolitan Division', NYI: 'Metropolitan Division', NYR: 'Metropolitan Division', PHI: 'Metropolitan Division', PIT: 'Metropolitan Division', WSH: 'Metropolitan Division', WAS: 'Metropolitan Division',
    ARI: 'Central Division', CHI: 'Central Division', COL: 'Central Division', DAL: 'Central Division', MIN: 'Central Division', NSH: 'Central Division', STL: 'Central Division', WPG: 'Central Division', UTA: 'Central Division', UTAH: 'Central Division', UT: 'Central Division', MAM: 'Central Division', UM: 'Central Division',
    ANA: 'Pacific Division', CGY: 'Pacific Division', EDM: 'Pacific Division', LAK: 'Pacific Division', LA: 'Pacific Division', SJS: 'Pacific Division', SEA: 'Pacific Division', VAN: 'Pacific Division', VGK: 'Pacific Division',
  },
};

const getSportDisplayName = (sport: string) => {
  return SPORT_DISPLAY_NAMES[sport] || (sport.charAt(0).toUpperCase() + sport.slice(1));
};

const getSportGradient = (sport: string) => {
  return SPORT_GRADIENTS[sport] || 'linear-gradient(135deg, #818cf8 0%, #3730a3 100%)';
};

export function groupTeamsByDivision(teams: SportsTeam[], leagueId?: string): Map<string, SportsTeam[]> {
  const groups = new Map<string, SportsTeam[]>();
  const lid = (leagueId || '').toLowerCase();

  const normalizeDivName = (name: string): string => {
    let cleaned = name.trim();
    if (!cleaned || cleaned.toLowerCase() === 'all teams') return 'All Teams';
    if (/^(Pacific|Atlantic|Central|Southeast|Southwest|Northwest|Metropolitan)$/i.test(cleaned)) {
      cleaned = `${cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase()} Division`;
    }
    return cleaned;
  };

  for (const team of teams) {
    let divName = 'All Teams';
    const teamAny = team as any;
    const teamId = String(team.id || '');
    const abbrev = (teamAny.abbreviation || team.shortName || '').toUpperCase();
    const fullName = `${teamAny.location || ''} ${team.name || ''} ${team.shortName || ''}`.toLowerCase();

    // 1. Immutable Team Name / Phrase Match (100% deterministic)
    if (lid === 'nhl') {
      if (fullName.includes('bruins')) divName = 'Atlantic Division';
      else if (fullName.includes('sabres')) divName = 'Atlantic Division';
      else if (fullName.includes('red wings')) divName = 'Atlantic Division';
      else if (fullName.includes('panthers')) divName = 'Atlantic Division';
      else if (fullName.includes('canadiens')) divName = 'Atlantic Division';
      else if (fullName.includes('senators')) divName = 'Atlantic Division';
      else if (fullName.includes('lightning')) divName = 'Atlantic Division';
      else if (fullName.includes('maple leafs') || fullName.includes('leafs')) divName = 'Atlantic Division';

      else if (fullName.includes('hurricanes')) divName = 'Metropolitan Division';
      else if (fullName.includes('blue jackets')) divName = 'Metropolitan Division';
      else if (fullName.includes('devils')) divName = 'Metropolitan Division';
      else if (fullName.includes('islanders')) divName = 'Metropolitan Division';
      else if (fullName.includes('rangers')) divName = 'Metropolitan Division';
      else if (fullName.includes('flyers')) divName = 'Metropolitan Division';
      else if (fullName.includes('penguins')) divName = 'Metropolitan Division';
      else if (fullName.includes('capitals')) divName = 'Metropolitan Division';

      else if (fullName.includes('blackhawks')) divName = 'Central Division';
      else if (fullName.includes('avalanche')) divName = 'Central Division';
      else if (fullName.includes('stars')) divName = 'Central Division';
      else if (fullName.includes('wild')) divName = 'Central Division';
      else if (fullName.includes('predators')) divName = 'Central Division';
      else if (fullName.includes('blues')) divName = 'Central Division';
      else if (fullName.includes('utah') || fullName.includes('mammoth')) divName = 'Central Division';
      else if (fullName.includes('jets')) divName = 'Central Division';

      else if (fullName.includes('ducks')) divName = 'Pacific Division';
      else if (fullName.includes('flames')) divName = 'Pacific Division';
      else if (fullName.includes('oilers')) divName = 'Pacific Division';
      else if (fullName.includes('kings')) divName = 'Pacific Division';
      else if (fullName.includes('sharks')) divName = 'Pacific Division';
      else if (fullName.includes('kraken')) divName = 'Pacific Division';
      else if (fullName.includes('canucks')) divName = 'Pacific Division';
      else if (fullName.includes('golden knights') || fullName.includes('knights')) divName = 'Pacific Division';
    } else if (lid === 'mlb') {
      if (fullName.includes('orioles')) divName = 'AL East';
      else if (fullName.includes('red sox')) divName = 'AL East';
      else if (fullName.includes('yankees')) divName = 'AL East';
      else if (fullName.includes('rays')) divName = 'AL East';
      else if (fullName.includes('blue jays')) divName = 'AL East';

      else if (fullName.includes('white sox')) divName = 'AL Central';
      else if (fullName.includes('guardians')) divName = 'AL Central';
      else if (fullName.includes('tigers')) divName = 'AL Central';
      else if (fullName.includes('royals')) divName = 'AL Central';
      else if (fullName.includes('twins')) divName = 'AL Central';

      else if (fullName.includes('astros')) divName = 'AL West';
      else if (fullName.includes('angels')) divName = 'AL West';
      else if (fullName.includes('athletics') || fullName.includes("a's")) divName = 'AL West';
      else if (fullName.includes('mariners')) divName = 'AL West';
      else if (fullName.includes('rangers')) divName = 'AL West';

      else if (fullName.includes('braves')) divName = 'NL East';
      else if (fullName.includes('marlins')) divName = 'NL East';
      else if (fullName.includes('mets')) divName = 'NL East';
      else if (fullName.includes('phillies')) divName = 'NL East';
      else if (fullName.includes('nationals')) divName = 'NL East';

      else if (fullName.includes('cubs')) divName = 'NL Central';
      else if (fullName.includes('reds')) divName = 'NL Central';
      else if (fullName.includes('brewers')) divName = 'NL Central';
      else if (fullName.includes('pirates')) divName = 'NL Central';
      else if (fullName.includes('cardinals')) divName = 'NL Central';

      else if (fullName.includes('diamondbacks') || fullName.includes('d-backs')) divName = 'NL West';
      else if (fullName.includes('rockies')) divName = 'NL West';
      else if (fullName.includes('dodgers')) divName = 'NL West';
      else if (fullName.includes('padres')) divName = 'NL West';
      else if (fullName.includes('giants')) divName = 'NL West';
    } else if (lid === 'nba') {
      if (fullName.includes('hawks') || fullName.includes('hornets') || fullName.includes('heat') || fullName.includes('magic') || fullName.includes('wizards')) divName = 'Southeast Division';
      else if (fullName.includes('celtics') || ((fullName.includes('brooklyn') || /\bnets\b/i.test(fullName)) && !fullName.includes('hornets')) || fullName.includes('knicks') || fullName.includes('76ers') || fullName.includes('raptors')) divName = 'Atlantic Division';
      else if (fullName.includes('bulls') || fullName.includes('cavaliers') || fullName.includes('pistons') || fullName.includes('pacers') || fullName.includes('bucks')) divName = 'Central Division';
      else if (fullName.includes('nuggets') || fullName.includes('timberwolves') || fullName.includes('thunder') || fullName.includes('trail blazers') || fullName.includes('blazers') || fullName.includes('jazz')) divName = 'Northwest Division';
      else if (fullName.includes('warriors') || fullName.includes('clippers') || fullName.includes('lakers') || fullName.includes('suns') || fullName.includes('kings')) divName = 'Pacific Division';
      else if (fullName.includes('mavericks') || fullName.includes('rockets') || fullName.includes('grizzlies') || fullName.includes('pelicans') || fullName.includes('spurs')) divName = 'Southwest Division';
    } else if (lid === 'nfl') {
      if (fullName.includes('bills') || fullName.includes('dolphins') || fullName.includes('patriots') || fullName.includes('jets')) divName = 'AFC East';
      else if (fullName.includes('ravens') || fullName.includes('bengals') || fullName.includes('browns') || fullName.includes('steelers')) divName = 'AFC North';
      else if (fullName.includes('texans') || fullName.includes('colts') || fullName.includes('jaguars') || fullName.includes('titans')) divName = 'AFC South';
      else if (fullName.includes('broncos') || fullName.includes('chiefs') || fullName.includes('raiders') || fullName.includes('chargers')) divName = 'AFC West';
      else if (fullName.includes('cowboys') || fullName.includes('giants') || fullName.includes('eagles') || fullName.includes('commanders')) divName = 'NFC East';
      else if (fullName.includes('bears') || fullName.includes('lions') || fullName.includes('packers') || fullName.includes('vikings')) divName = 'NFC North';
      else if (fullName.includes('falcons') || fullName.includes('panthers') || fullName.includes('saints') || fullName.includes('buccaneers') || fullName.includes('bucs')) divName = 'NFC South';
      else if (fullName.includes('cardinals') || fullName.includes('rams') || fullName.includes('49ers') || fullName.includes('seahawks')) divName = 'NFC West';
    }

    // 2. Abbreviation lookup
    if (divName === 'All Teams' && lid && FALLBACK_DIVISIONS[lid]) {
      if (abbrev && FALLBACK_DIVISIONS[lid][abbrev]) {
        divName = FALLBACK_DIVISIONS[lid][abbrev];
      }
    }

    // 3. Direct Team ID lookup by League
    if (divName === 'All Teams' && lid && LEAGUE_TEAM_ID_DIVISIONS[lid] && LEAGUE_TEAM_ID_DIVISIONS[lid][teamId]) {
      divName = LEAGUE_TEAM_ID_DIVISIONS[lid][teamId];
    }
    
    // 4. Standing summary match fallback
    if (divName === 'All Teams' && teamAny.standingSummary) {
      const match = teamAny.standingSummary.match(/in\s+([A-Za-z0-9\s]+)$/i);
      if (match && match[1]) {
        divName = normalizeDivName(match[1]);
      }
    }

    divName = normalizeDivName(divName);

    if (!groups.has(divName)) {
      groups.set(divName, []);
    }
    groups.get(divName)!.push(team);
  }

  // Preferred division sorting order
  const preferredOrder = [
    'Atlantic Division', 'Central Division', 'Southeast Division',
    'Northwest Division', 'Pacific Division', 'Southwest Division',
    'AFC East', 'AFC North', 'AFC South', 'AFC West',
    'NFC East', 'NFC North', 'NFC South', 'NFC West',
    'AL East', 'AL Central', 'AL West',
    'NL East', 'NL Central', 'NL West',
    'Metropolitan Division'
  ];

  const sortedGroups = new Map<string, SportsTeam[]>();
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'All Teams') return 1;
    if (b === 'All Teams') return -1;
    const idxA = preferredOrder.indexOf(a);
    const idxB = preferredOrder.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const k of sortedKeys) {
    sortedGroups.set(k, groups.get(k)!);
  }

  return sortedGroups;
}

interface DateRailProps {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  onOpenCalendar: () => void;
}

function HorizontalDateRail({ selectedDate, onSelectDate, onOpenCalendar }: DateRailProps) {
  const { t } = useTranslation('sports');
  const [baseDate, setBaseDate] = useState<Date>(() => new Date(selectedDate));

  const isSameDay = (d1: Date, d2: Date) => {
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  };

  useEffect(() => {
    const minVisible = new Date(baseDate);
    minVisible.setDate(minVisible.getDate() - 3);
    const maxVisible = new Date(baseDate);
    maxVisible.setDate(maxVisible.getDate() + 3);

    const selTime = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime();
    const minTime = new Date(minVisible.getFullYear(), minVisible.getMonth(), minVisible.getDate()).getTime();
    const maxTime = new Date(maxVisible.getFullYear(), maxVisible.getMonth(), maxVisible.getDate()).getTime();

    if (selTime < minTime || selTime > maxTime) {
      setBaseDate(new Date(selectedDate));
    }
  }, [selectedDate, baseDate]);

  const handlePrevWeek = () => {
    const prev = new Date(baseDate);
    prev.setDate(prev.getDate() - 7);
    setBaseDate(prev);
    onSelectDate(prev);
  };

  const handleNextWeek = () => {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + 7);
    setBaseDate(next);
    onSelectDate(next);
  };

  const handleJumpToday = () => {
    const today = new Date();
    setBaseDate(today);
    onSelectDate(today);
  };

  const days: Date[] = [];
  for (let i = -3; i <= 3; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  const isTodayActive = isSameDay(selectedDate, new Date());

  const formattedTitle = formatDate(selectedDate, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="horizontal-date-rail-container">
      <div className="horizontal-date-rail">
        <button
          className="date-rail-nav-btn"
          onClick={handlePrevWeek}
          title={t('previousWeek')}
        >
          ‹
        </button>

        <div className="date-rail-pills">
          {days.map((day) => {
            const active = isSameDay(day, selectedDate);
            const dayName = formatDate(day, { weekday: 'short' });
            const dayNum = day.getDate();

            return (
              <button
                key={day.toISOString()}
                className={`date-rail-pill${active ? ' active' : ''}`}
                onClick={() => onSelectDate(day)}
              >
                <span className="date-rail-day-name">{dayName}</span>
                <span className="date-rail-day-num">{dayNum}</span>
              </button>
            );
          })}
        </div>

        <button
          className="date-rail-nav-btn"
          onClick={handleNextWeek}
          title={t('nextWeek')}
        >
          ›
        </button>

        <button
          className="date-rail-calendar-btn"
          onClick={onOpenCalendar}
          title={t('pickCustomDate')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>{t('pickDate')}</span>
        </button>

        {!isTodayActive && (
          <button className="date-rail-today-btn" onClick={handleJumpToday}>
            {t('today')}
          </button>
        )}
      </div>

      <div
        className="date-rail-title-container"
        onClick={onOpenCalendar}
        title={t('clickCustomDate')}
      >
        <span className="date-rail-title">{formattedTitle}</span>
        <svg className="date-rail-title-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </div>
    </div>
  );
}

interface LeagueGameCardProps {
  event: SportsEvent;
  isIndividualSport: boolean;
  onChannelClick?: (channelName: string) => void;
  onClick?: () => void;
}

function LeagueGameCard({ event, isIndividualSport, onChannelClick, onClick }: LeagueGameCardProps) {
  const { t } = useTranslation('sports');
  const epgClockFormat = useEpgClockFormat();
  const isLive = event.status === 'live';
  const isFinished = event.status === 'finished';

  const networkName = event.channels && event.channels.length > 0 ? event.channels[0].name : null;

  if (isIndividualSport) {
    return (
      <div className="league-game-card individual" onClick={onClick}>
        <div className="game-card-main">
          <div className="game-card-individual-info">
            <span className="game-card-event-title">{event.title}</span>
            {event.venue && <span className="game-card-venue">{event.venue}</span>}
          </div>
        </div>

        <div className="game-card-right">
          <div className="game-card-time">
            {formatTime(event.startTime, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })}
          </div>
          {networkName && <span className="game-card-network-badge-btn">{networkName}</span>}
        </div>
      </div>
    );
  }

  const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
  const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);

  const awayAbbrev = (event.awayTeam as any).abbreviation || event.awayTeam.name.slice(0, 3).toUpperCase();
  const homeAbbrev = (event.homeTeam as any).abbreviation || event.homeTeam.name.slice(0, 3).toUpperCase();
  const awayRecord = (event as any).awayRecord || '0-0';
  const homeRecord = (event as any).homeRecord || '0-0';

  return (
    <div className={`league-game-card${isLive ? ' live' : ''}`} onClick={onClick}>
      <div className="game-card-teams-area">
        {/* Away Team */}
        <div className={`game-card-team away${isFinished && awayWinning ? ' winner' : ''}`}>
          {event.awayTeam.logo ? (
            <img src={event.awayTeam.logo} alt="" className="game-card-logo" />
          ) : (
            <div className="game-card-logo-placeholder">{awayAbbrev.slice(0, 3).toUpperCase()}</div>
          )}
          <div className="game-card-team-info">
            <span className="game-card-team-name">{awayAbbrev}</span>
            <span className="game-card-team-record">{awayRecord}</span>
          </div>
          <span className="game-card-score">{event.awayScore ?? 0}</span>
        </div>

        {/* Versus / Divider */}
        <div className="game-card-divider">
          {isLive ? (
            <span className="game-card-live-pill">
              <span className="live-dot" />
              {event.period || event.timeElapsed || t('statusLive')}
            </span>
          ) : (
            <span className="game-card-vs">{t('vs')}</span>
          )}
        </div>

        {/* Home Team */}
        <div className={`game-card-team home${isFinished && homeWinning ? ' winner' : ''}`}>
          <span className="game-card-score">{event.homeScore ?? 0}</span>
          <div className="game-card-team-info">
            <span className="game-card-team-name">{homeAbbrev}</span>
            <span className="game-card-team-record">{homeRecord}</span>
          </div>
          {event.homeTeam.logo ? (
            <img src={event.homeTeam.logo} alt="" className="game-card-logo" />
          ) : (
            <div className="game-card-logo-placeholder">{homeAbbrev.slice(0, 3).toUpperCase()}</div>
          )}
        </div>
      </div>

      {/* Right Side: Start Time & Network Badge */}
      <div className="game-card-right">
        <span className="game-card-time">
          {formatEventTime(event.startTime, epgClockFormat !== '24h')}
        </span>
        {networkName ? (
          <button
            className="game-card-network-badge-btn"
            onClick={(e) => {
              e.stopPropagation();
              onChannelClick?.(networkName);
            }}
            title={t('searchChannelsForNetwork', { network: networkName })}
          >
            {networkName}
          </button>
        ) : (
          <span className="game-card-network-placeholder">{t('tbd')}</span>
        )}
      </div>
    </div>
  );
}

function SportIcon({ sport, size = 20 }: { sport: string; size?: number }) {
  const idPrefix = useMemo(() => `sport-${sport}-${Math.random().toString(36).substr(2, 4)}`, [sport]);

  switch (sport.toLowerCase()) {
    case 'football':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <linearGradient id={`${idPrefix}-leather`} x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#78350f" />
            </linearGradient>
          </defs>
          <path
            d="M5.5 26.5C5.5 26.5 4 18 11.5 10.5C19 3 27.5 4.5 27.5 4.5C27.5 4.5 29 13 21.5 20.5C14 28 5.5 26.5 5.5 26.5Z"
            fill={`url(#${idPrefix}-leather)`}
            stroke="#fbbf24"
            strokeWidth="1.5"
          />
          <path d="M7 25L25 7" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12.5 15.5L16.5 19.5M14.5 13.5L18.5 17.5M16.5 11.5L20.5 15.5" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M8 20C9.5 22.5 13 24 16 23.5" stroke="rgba(255,255,255,0.7)" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M12 8.5C14.5 9 16 12.5 15.5 15" stroke="rgba(255,255,255,0.7)" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'basketball':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <radialGradient id={`${idPrefix}-ball`} cx="35%" cy="35%" r="65%">
              <stop offset="0%" stopColor="#fb923c" />
              <stop offset="60%" stopColor="#ea580c" />
              <stop offset="100%" stopColor="#9a3412" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="13" fill={`url(#${idPrefix}-ball)`} stroke="#c2410c" strokeWidth="1" />
          <path d="M3 16H29" stroke="#1c1917" strokeWidth="1.8" />
          <path d="M16 3V29" stroke="#1c1917" strokeWidth="1.8" />
          <path d="M6.5 7.5C11.5 12.5 11.5 19.5 6.5 24.5" stroke="#1c1917" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M25.5 7.5C20.5 12.5 20.5 19.5 25.5 24.5" stroke="#1c1917" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'baseball':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <radialGradient id={`${idPrefix}-base`} cx="35%" cy="35%" r="65%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="70%" stopColor="#e2e8f0" />
              <stop offset="100%" stopColor="#cbd5e1" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="13" fill={`url(#${idPrefix}-base)`} stroke="#94a3b8" strokeWidth="1" />
          <path d="M8 5.5C12 9.5 12 22.5 8 26.5" stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2 2" />
          <path d="M24 5.5C20 9.5 20 22.5 24 26.5" stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2 2" />
        </svg>
      );
    case 'hockey':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <path d="M25 4L9 22.5L5 21" stroke="#f1f5f9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 4L23 22.5L27 21" stroke="#f1f5f9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <ellipse cx="16" cy="24" rx="7" ry="3.5" fill="#0f172a" stroke="#38bdf8" strokeWidth="1.5" />
          <ellipse cx="16" cy="22.5" rx="7" ry="3" fill="#334155" />
        </svg>
      );
    case 'soccer':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <radialGradient id={`${idPrefix}-soccer-bg`} cx="35%" cy="35%" r="65%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="80%" stopColor="#e2e8f0" />
              <stop offset="100%" stopColor="#94a3b8" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="13" fill={`url(#${idPrefix}-soccer-bg)`} stroke="#475569" strokeWidth="1" />
          <polygon points="16,10 20.5,13.5 19,18.5 13,18.5 11.5,13.5" fill="#1e293b" />
          <line x1="16" y1="10" x2="16" y2="3" stroke="#1e293b" strokeWidth="1.5" />
          <line x1="20.5" y1="13.5" x2="28.5" y2="11" stroke="#1e293b" strokeWidth="1.5" />
          <line x1="19" y1="18.5" x2="24.5" y2="26" stroke="#1e293b" strokeWidth="1.5" />
          <line x1="13" y1="18.5" x2="7.5" y2="26" stroke="#1e293b" strokeWidth="1.5" />
          <line x1="11.5" y1="13.5" x2="3.5" y2="11" stroke="#1e293b" strokeWidth="1.5" />
        </svg>
      );
    case 'mma':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <linearGradient id={`${idPrefix}-mma-gold`} x1="0" y1="0" x2="32" y2="32">
              <stop offset="0%" stopColor="#fbbf24" />
              <stop offset="50%" stopColor="#d97706" />
              <stop offset="100%" stopColor="#78350f" />
            </linearGradient>
          </defs>
          <polygon points="11,3 21,3 28,10 28,22 21,29 11,29 4,22 4,10" fill="none" stroke={`url(#${idPrefix}-mma-gold)`} strokeWidth="2.5" />
          <circle cx="16" cy="16" r="6" fill="rgba(239, 68, 68, 0.2)" stroke="#ef4444" strokeWidth="1.5" />
          <path d="M13 16L15 18L19 14" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'golf':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <path d="M23 4L11 24" stroke="#10b981" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M7 4V13L14 8.5L7 4Z" fill="#34d399" stroke="#10b981" strokeWidth="1.2" />
          <circle cx="21" cy="25" r="2.5" fill="#ffffff" stroke="#94a3b8" strokeWidth="1" />
          <ellipse cx="19" cy="27" rx="7" ry="2" fill="rgba(16, 185, 129, 0.2)" />
        </svg>
      );
    case 'tennis':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <radialGradient id={`${idPrefix}-tennis-ball`} cx="35%" cy="35%" r="65%">
              <stop offset="0%" stopColor="#bef264" />
              <stop offset="100%" stopColor="#65a30d" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="12" fill={`url(#${idPrefix}-tennis-ball)`} stroke="#4d7c0f" strokeWidth="1" />
          <path d="M7 8C12 11 12 21 7 24" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M25 8C20 11 20 21 25 24" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'racing':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <path d="M6 29V3" stroke="#e2e8f0" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M6 5C10 3 13 7 17 5C21 3 24 5 27 5V16C24 16 21 14 17 16C13 18 10 14 6 16Z" fill="#1e293b" stroke="#64748b" strokeWidth="1.2" />
          <rect x="6" y="5" width="5.25" height="5.5" fill="#ffffff" />
          <rect x="16.5" y="5" width="5.25" height="5.5" fill="#ffffff" />
          <rect x="11.25" y="10.5" width="5.25" height="5.5" fill="#ffffff" />
          <rect x="21.75" y="10.5" width="5.25" height="5.5" fill="#ffffff" />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="4" y="6" width="24" height="20" rx="4" fill="rgba(129, 140, 248, 0.2)" stroke="#818cf8" strokeWidth="1.8" />
          <circle cx="16" cy="16" r="5" fill="#818cf8" />
        </svg>
      );
  }
}

function TeamLogo({ logo, name, abbreviation, primaryColor, size = 36, className = "sports-team-card-logo" }: {
  logo?: string;
  name: string;
  abbreviation?: string;
  primaryColor?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt={name}
        className={className}
        style={{ width: size, height: size, objectFit: 'contain' }}
        onError={() => setFailed(true)}
      />
    );
  }

  const initials = (abbreviation || name.slice(0, 3)).toUpperCase();
  const bg = primaryColor ? (primaryColor.startsWith('#') ? primaryColor : `#${primaryColor}`) : '#6366f1';

  return (
    <div
      className="sports-team-card-logo-placeholder"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: size * 0.35, flexShrink: 0 }}
    >
      {initials}
    </div>
  );
}

function LeagueIcon({ leagueId, sport, size = 48, logo }: { leagueId: string; sport: string; size?: number; logo?: string }) {
  const idPrefix = useMemo(() => `league-${leagueId}-${Math.random().toString(36).substr(2, 4)}`, [leagueId]);
  const [logoFailed, setLogoFailed] = useState(false);

  // Prefer the official ESPN league logo when available, sitting standalone with normalized size
  if (logo && !logoFailed) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          display: 'block',
          filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45))',
        }}
        onError={() => setLogoFailed(true)}
      />
    );
  }

  switch (leagueId.toLowerCase()) {
    case 'nfl':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <linearGradient id={`${idPrefix}-nfl-shield`} x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#013369" />
              <stop offset="100%" stopColor="#001838" />
            </linearGradient>
          </defs>
          <path d="M16 2L4 6V16C4 23 9.5 28.5 16 30C22.5 28.5 28 23 28 16V6L16 2Z" fill={`url(#${idPrefix}-nfl-shield)`} stroke="#d50a0a" strokeWidth="1.8" />
          <path d="M16 4.5L6 7.8V15.5C6 21.5 10.5 26.2 16 27.8C21.5 26.2 26 21.5 26 15.5V7.8L16 4.5Z" fill="none" stroke="#ffffff" strokeWidth="1" strokeOpacity="0.4" />
          <path d="M11 11C11 11 13.5 8 18 9.5C22.5 11 23 15 23 15C23 15 20.5 18 16 16.5C11.5 15 11 11 11 11Z" fill="#d97706" stroke="#ffffff" strokeWidth="1" />
          <line x1="13.5" y1="13" x2="19" y2="11.5" stroke="#ffffff" strokeWidth="1" />
          <circle cx="10" cy="8" r="0.8" fill="#ffffff" />
          <circle cx="22" cy="8" r="0.8" fill="#ffffff" />
          <circle cx="16" cy="6" r="0.8" fill="#ffffff" />
          <text x="16" y="24" fill="#ffffff" fontSize="6.5" fontWeight="900" textAnchor="middle" letterSpacing="0.5">NFL</text>
        </svg>
      );
    case 'ncaaf':
    case 'college-football':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <defs>
            <linearGradient id={`${idPrefix}-ncaa`} x1="0" y1="0" x2="32" y2="32">
              <stop offset="0%" stopColor="#1e3a8a" />
              <stop offset="100%" stopColor="#0f172a" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="13" fill={`url(#${idPrefix}-ncaa)`} stroke="#3b82f6" strokeWidth="1.8" />
          <polygon points="16,5 19,11 26,11 20.5,15.5 22.5,22 16,18 9.5,22 11.5,15.5 6,11 13,11" fill="none" stroke="#60a5fa" strokeWidth="1" opacity="0.4" />
          <text x="16" y="18.5" fill="#ffffff" fontSize="6.5" fontWeight="900" textAnchor="middle" letterSpacing="0.2">NCAA</text>
        </svg>
      );
    case 'nba':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="5" y="3" width="22" height="26" rx="4" fill="#17408b" stroke="#c9082a" strokeWidth="1.8" />
          <path d="M16 3H23C25.2 3 27 4.8 27 7V25C27 27.2 25.2 29 23 29H16V3Z" fill="#c9082a" />
          <path d="M14 8C14.5 8 15 9.5 15 11C15 12.5 13 13.5 13 15C13 16.5 15.5 17.5 15.5 20C15.5 22.5 13.5 25 12 26" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="18" cy="10" r="2" fill="#ffffff" />
        </svg>
      );
    case 'wnba':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="5" y="3" width="22" height="26" rx="4" fill="#ff6b00" stroke="#ffffff" strokeWidth="1.5" />
          <path d="M13 8C13.5 8 14.5 10 14.5 12C14.5 14 12 15 12 17C12 19 14.5 20.5 14.5 23C14.5 25 12.5 26 11 27" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
          <circle cx="17.5" cy="11" r="2" fill="#ffffff" />
        </svg>
      );
    case 'mlb':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="3" y="6" width="26" height="20" rx="4" fill="#002d62" stroke="#ffffff" strokeWidth="1.2" />
          <path d="M16 6H25C27.2 6 29 7.8 29 10V22C29 24.2 27.2 26 25 26H16V6Z" fill="#d50032" />
          <circle cx="10.5" cy="16" r="2" fill="#ffffff" />
          <path d="M13 22L17.5 13.5L22 22" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'nhl':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <path d="M16 3L5 7V17C5 23.5 10.2 28.5 16 30C21.8 28.5 27 23.5 27 17V7L16 3Z" fill="#000000" stroke="#c0c0c0" strokeWidth="2" />
          <path d="M8 9.5L24 23.5" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
          <text x="16" y="19" fill="#ffffff" fontSize="7" fontWeight="900" textAnchor="middle" letterSpacing="0.5" transform="rotate(-15 16 19)">NHL</text>
        </svg>
      );
    case 'ufc':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="3" y="8" width="26" height="16" rx="3" fill="#d20a0a" stroke="#ffffff" strokeWidth="1.2" />
          <text x="16" y="20" fill="#ffffff" fontSize="10" fontWeight="900" textAnchor="middle" letterSpacing="1">UFC</text>
        </svg>
      );
    case 'pga':
    case 'lpga':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="13" fill="#0c2340" stroke="#c59b27" strokeWidth="1.8" />
          <path d="M16 6V24M16 6L22 10.5L16 15" stroke="#c59b27" strokeWidth="1.8" fill="#c59b27" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="23" cy="23" r="1.8" fill="#ffffff" />
        </svg>
      );
    case 'f1':
    case 'nascar':
    case 'indycar':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="3" y="7" width="26" height="18" rx="3" fill="#e10600" stroke="#ffffff" strokeWidth="1.2" />
          <path d="M8 20L15 12H24" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="18" y1="16" x2="24" y2="16" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return <SportIcon sport={sport} size={size} />;
  }
}

export function LeaguesTab({ onSearchChannels, onPlayChannel }: LeaguesTabProps) {
  const { t } = useTranslation('sports');
  const [leagues, setLeagues] = useState<SportsLeague[]>([]);
  const [selectedLeague, setSelectedLeague] = useState<SportsLeague | null>(null);
  const [leagueEvents, setLeagueEvents] = useState<SportsEvent[]>([]);
  const [leagueLogos, setLeagueLogos] = useState<Record<string, string>>({});
  const [leagueTeams, setLeagueTeams] = useState<SportsTeam[]>([]);
  const [leagueStandings, setLeagueStandings] = useState<StandingTeam[]>([]);
  const [leagueStandingsGroups, setLeagueStandingsGroups] = useState<StandingGroup[]>([]);
  const [golfRankings, setGolfRankings] = useState<GolfRanking[]>([]);
  const [tennisRankings, setTennisRankings] = useState<TennisRanking[]>([]);
  const [racingStandings, setRacingStandings] = useState<RacingStanding[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState<LeagueView>('teams');
  const [selectedTeam, setSelectedTeam] = useState<SportsTeam | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const [activeSport, setActiveSport] = useState<string>('');
  const [selectedScheduleDate, setSelectedScheduleDate] = useState<Date | null>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState<boolean>(false);
  const [teamSearchQuery, setTeamSearchQuery] = useState<string>('');
  const [standingsMode, setStandingsMode] = useState<'division' | 'conference'>('division');
  const [teamsLayout, setTeamsLayout] = useState<'columns' | 'grid' | 'stacked'>('columns');

  const favorites = useSportsFavoritesStore((s) => s.favorites);
  const addFavorite = useSportsFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useSportsFavoritesStore((s) => s.removeFavorite);

  const isUFC = selectedLeague?.id === 'ufc';
  const isGolf = selectedLeague?.id === 'pga' || selectedLeague?.id === 'lpga';
  const isTennis = selectedLeague?.id === 'atp' || selectedLeague?.id === 'wta';
  const isRacing = selectedLeague?.id === 'f1' || selectedLeague?.id === 'nascar' || selectedLeague?.id === 'indycar';
  const isIndividualSport = selectedLeague ? INDIVIDUAL_SPORTS.includes(selectedLeague.id) : false;

  const { enabledLeagues, loaded, loadSettings } = useSportsSettingsStore();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  useEffect(() => {
    const allLeagues = getAvailableLeagues();
    if (loaded) {
      setLeagues(allLeagues.filter(l => enabledLeagues.includes(l.id)));
    } else {
      setLeagues(allLeagues);
    }
  }, [loaded, enabledLeagues]);

  // Fetch official league logos from ESPN once the (enabled) league list is known.
  // Gated on `loaded` so we only fetch for the final filtered list, and keyed on
  // the joined ids to avoid refetching/flashing when the same set re-renders.
  const logosFetchedFor = useRef('');
  useEffect(() => {
    if (!loaded || leagues.length === 0) return;
    const ids = leagues.map(l => l.id).join(',');
    if (logosFetchedFor.current === ids) return;
    logosFetchedFor.current = ids;
    let cancelled = false;
    getLeagueLogos(leagues.map(l => l.id)).then((logos) => {
      if (!cancelled) setLeagueLogos(logos);
    });
    return () => {
      cancelled = true;
    };
  }, [leagues, loaded]);

  useEffect(() => {
    if (leagues.length > 0 && (!activeSport || !leagues.some(l => l.sport === activeSport))) {
      setActiveSport(leagues[0].sport || 'football');
    }
  }, [leagues, activeSport]);

  useEffect(() => {
    if (selectedLeague) {
      setLoading(true);
      setSelectedScheduleDate(null);
      setTeamSearchQuery('');
      setLeagueEvents([]);
      setLeagueTeams([]);
      setLeagueStandings([]);
      setLeagueStandingsGroups([]);
      setGolfRankings([]);
      setTennisRankings([]);
      setRacingStandings([]);

      // For individual sports, default to schedule (events)
      setActiveView(isIndividualSport ? 'schedule' : 'teams');
      
      if (isIndividualSport) {
        // Load events for individual sports
        getLeagueEvents(selectedLeague.id)
          .then(setLeagueEvents)
          .finally(() => setLoading(false));
      } else {
        getLeagueTeams(selectedLeague.id)
          .then(setLeagueTeams)
          .finally(() => setLoading(false));
      }
    }
  }, [selectedLeague?.id, isIndividualSport]);

  const activeScheduleDate = useMemo(() => {
    return selectedScheduleDate || new Date();
  }, [selectedScheduleDate]);

  const displayedScheduleEvents = useMemo(() => {
    if (isIndividualSport) {
      return leagueEvents;
    }
    return leagueEvents
      .filter((event) => {
        const eventDate = event.startTime instanceof Date ? event.startTime : new Date(event.startTime);
        return (
          eventDate.getFullYear() === activeScheduleDate.getFullYear() &&
          eventDate.getMonth() === activeScheduleDate.getMonth() &&
          eventDate.getDate() === activeScheduleDate.getDate()
        );
      })
      .sort((a, b) => {
        const timeA = a.startTime instanceof Date ? a.startTime.getTime() : new Date(a.startTime).getTime();
        const timeB = b.startTime instanceof Date ? b.startTime.getTime() : new Date(b.startTime).getTime();
        return timeA - timeB;
      });
  }, [leagueEvents, activeScheduleDate, isIndividualSport]);

  const handleDateChange = useCallback((date: Date | null) => {
    if (!selectedLeague) return;
    setSelectedScheduleDate(date);
    setLoading(true);

    getLeagueEvents(selectedLeague.id, date || undefined)
      .then(setLeagueEvents)
      .finally(() => setLoading(false));
  }, [selectedLeague]);

  const handleViewChange = useCallback((view: LeagueView) => {
    if (!selectedLeague) return;
    setActiveView(view);

    if (view === 'schedule' && leagueEvents.length === 0) {
      setLoading(true);
      getLeagueEvents(selectedLeague.id, selectedScheduleDate || undefined)
        .then(setLeagueEvents)
        .finally(() => setLoading(false));
    } else if (view === 'standings') {
      if (isGolf && golfRankings.length === 0) {
        setLoading(true);
        getGolfRankings(selectedLeague.id as any)
          .then(setGolfRankings)
          .finally(() => setLoading(false));
      } else if (isTennis && tennisRankings.length === 0) {
        setLoading(true);
        getTennisRankings(selectedLeague.id as any)
          .then(setTennisRankings)
          .finally(() => setLoading(false));
      } else if (isRacing && racingStandings.length === 0) {
        setLoading(true);
        getRacingStandings(selectedLeague.id as any)
          .then(setRacingStandings)
          .finally(() => setLoading(false));
      } else if (!isIndividualSport && leagueStandings.length === 0 && leagueStandingsGroups.length === 0) {
        setLoading(true);
        getLeagueStandingsGrouped(selectedLeague.id)
          .then((groups) => {
            setLeagueStandingsGroups(groups);
            setLeagueStandings(groups.flatMap(g => g.teams));
          })
          .finally(() => setLoading(false));
      }
    }
  }, [selectedLeague, leagueEvents.length, leagueStandings.length, leagueStandingsGroups.length, golfRankings.length, tennisRankings.length, racingStandings.length, isGolf, isTennis, isRacing, isIndividualSport, selectedScheduleDate]);

  const filteredTeams = useMemo(() => {
    if (!teamSearchQuery.trim()) return leagueTeams;
    const q = teamSearchQuery.toLowerCase();
    return leagueTeams.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.shortName?.toLowerCase().includes(q) ||
        (t as any).abbreviation?.toLowerCase().includes(q) ||
        (t as any).location?.toLowerCase().includes(q)
    );
  }, [leagueTeams, teamSearchQuery]);

  const teamGroups = useMemo(() => {
    return groupTeamsByDivision(filteredTeams, selectedLeague?.id);
  }, [filteredTeams, selectedLeague]);

  const displayStandingsGroups = useMemo(() => {
    if (leagueStandingsGroups.length === 0) return [];
    if (standingsMode === 'division' && selectedLeague) {
      return getLeagueStandingsByDivision(selectedLeague.id, leagueStandingsGroups);
    }
    return leagueStandingsGroups;
  }, [leagueStandingsGroups, standingsMode, selectedLeague]);

  const leaguesBySport = useMemo(() => {
    const grouped = leagues.reduce((acc, league) => {
      const sport = league.sport || 'Other';
      if (!acc[sport]) acc[sport] = [];
      acc[sport].push(league);
      return acc;
    }, {} as Record<string, SportsLeague[]>);

    const sportOrder = ['football', 'basketball', 'baseball', 'hockey', 'soccer'];
    const sortedSports = Object.keys(grouped).sort((a, b) => {
      const aIdx = sportOrder.indexOf(a);
      const bIdx = sportOrder.indexOf(b);
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });

    return { grouped, sortedSports };
  }, [leagues]);

  const handleChannelClick = (channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
    }
  };

  if (selectedTeam) {
    return (
      <TeamDetail
        team={selectedTeam}
        onClose={() => setSelectedTeam(null)}
        onRootClick={() => {
          setSelectedTeam(null);
          setSelectedLeague(null);
        }}
        onChannelClick={handleChannelClick}
        onPlayChannel={onPlayChannel}
        fromTab="Leagues"
      />
    );
  }

  if (selectedEvent) {
    return (
      <GameDetail
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        onChannelClick={handleChannelClick}
        onPlayChannel={onPlayChannel}
      />
    );
  }

  return (
    <div className="sports-tab-content">
      {!selectedLeague ? (
        <div className="sports-leagues-hero-picker">
          {/* Top Horizontal Sport Rail */}
          <div className="sports-leagues-top-rail">
            {leaguesBySport.sortedSports.map((sport) => {
              const count = leaguesBySport.grouped[sport]?.length || 0;
              const isActive = activeSport === sport;
              return (
                <button
                  key={sport}
                  className={`sports-sport-rail-btn${isActive ? ' active' : ''}`}
                  onClick={() => setActiveSport(sport)}
                >
                  <div
                    className="sports-sport-rail-icon"
                    style={{ background: getSportGradient(sport) }}
                  >
                    <SportIcon sport={sport} size={18} />
                  </div>
                  <span>{getSportDisplayName(sport)}</span>
                  <span className="sports-sport-rail-badge">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Hero Sport Banner */}
          <div
            className="sports-hero-banner"
            style={{
              background: `linear-gradient(135deg, rgba(15, 23, 42, 0.75) 0%, rgba(10, 15, 30, 0.95) 100%), ${getSportGradient(activeSport)}`,
              backgroundBlendMode: 'overlay',
            }}
          >
            <div className="sports-hero-banner-content">
              <div
                className="sports-hero-icon-wrapper"
                style={{
                  background: getSportGradient(activeSport),
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 0 40px rgba(59, 130, 246, 0.25)',
                }}
              >
                <SportIcon sport={activeSport} size={42} />
              </div>
              <div className="sports-hero-text">
                <h2 className="sports-hero-title">{getSportDisplayName(activeSport)}</h2>
                <p className="sports-hero-subtitle">
                  Explore full schedules, live match updates, division standings, and team rosters
                </p>
              </div>
            </div>
            <div className="sports-hero-badge">
              {(leaguesBySport.grouped[activeSport] || []).length}{' '}
              {(leaguesBySport.grouped[activeSport] || []).length === 1 ? t('league') : t('leagues')}
            </div>
          </div>

          {/* Wide Hero League Cards Grid */}
          <div className="sports-leagues-grid-hero">
            {(leaguesBySport.grouped[activeSport] || []).map((league) => (
              <button
                key={league.id}
                className="sports-league-card-hero"
                onClick={() => setSelectedLeague(league)}
              >
                <div className="sports-league-card-hero-left">
                  <div className="sports-league-card-icon-badge">
                    <LeagueIcon leagueId={league.id} sport={league.sport} size={48} logo={leagueLogos[league.id]} />
                  </div>
                  <div className="sports-league-card-hero-info">
                    <span className="sports-league-card-hero-name">{league.name}</span>
                    <span className="sports-league-card-hero-country">
                      {league.country || getSportDisplayName(league.sport)}
                    </span>
                  </div>
                </div>

                <div className="sports-league-card-hero-btn">
                  <span>{t('explore')}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="sports-league-detail-view">
          <div className="sports-league-header">
            <button
              className="sports-back-link"
              onClick={() => {
                setSelectedLeague(null);
                setLeagueEvents([]);
                setLeagueTeams([]);
                setLeagueStandings([]);
                setLeagueStandingsGroups([]);
                setGolfRankings([]);
                setTennisRankings([]);
                setRacingStandings([]);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              Back to All Leagues
            </button>

            <div className="sports-league-info">
              <div className="sports-leagues-content-icon">
                <LeagueIcon leagueId={selectedLeague.id} sport={selectedLeague.sport} size={56} logo={leagueLogos[selectedLeague.id]} />
              </div>
              <div>
                <h2 className="sports-league-detail-name">{selectedLeague.name}</h2>
                <span className="sports-league-detail-country">
                  {selectedLeague.country || getSportDisplayName(selectedLeague.sport)}
                </span>
              </div>
            </div>

            <div className="sports-league-nav" style={{ marginTop: 20 }}>
              {!isIndividualSport && (
                <button
                  className={`sports-league-nav-btn ${activeView === 'teams' ? 'active' : ''}`}
                  onClick={() => handleViewChange('teams')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  Teams
                </button>
              )}
              <button
                className={`sports-league-nav-btn ${activeView === 'schedule' ? 'active' : ''}`}
                onClick={() => handleViewChange('schedule')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                {isIndividualSport ? t('schedule') : t('games')}
              </button>
              {!isUFC && (
                <button
                  className={`sports-league-nav-btn ${activeView === 'standings' ? 'active' : ''}`}
                  onClick={() => handleViewChange('standings')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  {isIndividualSport ? t('rankings') : t('standings')}
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="sports-loading">
              <div className="sports-spinner" />
              <span>{t('loading')}</span>
            </div>
          ) : (
            <>
              {activeView === 'teams' && (
                <section className="sports-section">
                  <div className="league-teams-top-bar">
                    <div className="league-teams-search-box">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        type="text"
                        className="league-teams-search-input"
                        placeholder={t('searchTeamsPlaceholder')}
                        value={teamSearchQuery}
                        onChange={(e) => setTeamSearchQuery(e.target.value)}
                      />
                      {teamSearchQuery && (
                        <button className="league-teams-search-clear" onClick={() => setTeamSearchQuery('')}>
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="league-teams-layout-toggles">
                      <button 
                        className={`league-teams-layout-btn${teamsLayout === 'stacked' ? ' active' : ''}`}
                        onClick={() => setTeamsLayout('stacked')}
                        title={t('stackedList')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="3" y1="6" x2="21" y2="6" />
                          <line x1="3" y1="12" x2="21" y2="12" />
                          <line x1="3" y1="18" x2="21" y2="18" />
                        </svg>
                        {t('list')}
                      </button>
                      <button 
                        className={`league-teams-layout-btn${teamsLayout === 'columns' ? ' active' : ''}`}
                        onClick={() => setTeamsLayout('columns')}
                        title={t('columnsBoard')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="3" width="5" height="18" rx="1" />
                          <rect x="11" y="3" width="5" height="18" rx="1" />
                          <rect x="19" y="3" width="5" height="18" rx="1" />
                        </svg>
                        {t('columns')}
                      </button>
                      <button 
                        className={`league-teams-layout-btn${teamsLayout === 'grid' ? ' active' : ''}`}
                        onClick={() => setTeamsLayout('grid')}
                        title={t('cardsGrid')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="3" width="7" height="7" rx="1" />
                          <rect x="14" y="3" width="7" height="7" rx="1" />
                          <rect x="3" y="14" width="7" height="7" rx="1" />
                          <rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                        Grid
                      </button>
                    </div>

                    <span className="league-teams-count-badge">
                      {filteredTeams.length} {filteredTeams.length === 1 ? 'team' : 'teams'}
                    </span>
                  </div>

                  {/* Mode 1: Stacked Vertical List (Default) */}
                  {teamsLayout === 'stacked' && (
                    <div className="league-divisions-stacked-container">
                      {Array.from(teamGroups.entries()).map(([divName, divTeams]) => (
                        <div key={divName} className="league-division-group">
                          <h4 className="league-division-title">{divName}</h4>
                          <div className="sports-teams-stacked-list">
                            {divTeams.map((team) => {
                              const teamAny = team as any;
                              const isFav = favorites.some((f) => matchesFavorite(f, team.id, selectedLeague.id));
                              const primaryColor = teamAny.color ? `#${teamAny.color.replace('#', '')}` : '#6366f1';

                              return (
                                <div
                                  key={team.id}
                                  className={`sports-team-row-stacked${isFav ? ' favorite' : ''}`}
                                  style={{ borderLeftColor: primaryColor }}
                                  onClick={() => setSelectedTeam(team)}
                                >
                                  <div className="team-row-stacked-left">
                                    <TeamLogo
                                      logo={team.logo}
                                      name={team.name}
                                      abbreviation={teamAny.abbreviation}
                                      primaryColor={primaryColor}
                                      size={32}
                                    />
                                    <div className="sports-team-row-info">
                                      <span className="sports-team-row-name">{team.name}</span>
                                      {teamAny.location && <span className="sports-team-row-location">{teamAny.location}</span>}
                                    </div>
                                  </div>

                                  <div className="team-row-stacked-right">
                                    {teamAny.standingSummary && (
                                      <span className="sports-team-row-summary">{teamAny.standingSummary}</span>
                                    )}
                                    <button
                                      className={`sports-team-card-star${isFav ? ' active' : ''}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (isFav) {
                                          removeFavorite(team.id, selectedLeague.id);
                                        } else {
                                          addFavorite({
                                            id: team.id,
                                            name: team.name,
                                            shortName: team.shortName,
                                            location: teamAny.location,
                                            abbreviation: teamAny.abbreviation,
                                            color: teamAny.color,
                                            alternateColor: teamAny.alternateColor,
                                            logo: team.logo,
                                            leagueId: selectedLeague.id,
                                          } as any);
                                        }
                                      }}
                                      title={isFav ? t('removeFromFavoriteTeams') : t('addToFavoriteTeams')}
                                    >
                                      ★
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Mode 2: Division Columns Board */}
                  {teamsLayout === 'columns' && (
                    <div className="league-divisions-board">
                      {Array.from(teamGroups.entries()).map(([divName, divTeams]) => (
                        <div key={divName} className="league-division-column-panel">
                          <div className="league-division-column-header">
                            <h4>{divName}</h4>
                            <span className="league-division-team-count">{divTeams.length}</span>
                          </div>
                          <div className="league-division-column-teams">
                            {divTeams.map((team, idx) => {
                              const teamAny = team as any;
                              const isFav = favorites.some((f) => matchesFavorite(f, team.id, selectedLeague.id));
                              const primaryColor = teamAny.color ? `#${teamAny.color.replace('#', '')}` : '#6366f1';

                              return (
                                <div
                                  key={team.id}
                                  className={`sports-team-column-card${isFav ? ' favorite' : ''}`}
                                  style={{ borderLeftColor: primaryColor }}
                                  onClick={() => setSelectedTeam(team)}
                                >
                                  <span className="team-column-rank">{idx + 1}</span>
                                  <TeamLogo
                                    logo={team.logo}
                                    name={team.name}
                                    abbreviation={teamAny.abbreviation}
                                    primaryColor={primaryColor}
                                    size={32}
                                  />
                                  <div className="sports-team-card-info">
                                    <span className="sports-team-card-name">{team.name}</span>
                                    {team.shortName && <span className="sports-team-card-sub">{team.shortName}</span>}
                                  </div>
                                  <button
                                    className={`sports-team-card-star${isFav ? ' active' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isFav) {
                                        removeFavorite(team.id, selectedLeague.id);
                                      } else {
                                        addFavorite({
                                          id: team.id,
                                          name: team.name,
                                          shortName: team.shortName,
                                          location: teamAny.location,
                                          abbreviation: teamAny.abbreviation,
                                          color: teamAny.color,
                                          alternateColor: teamAny.alternateColor,
                                          logo: team.logo,
                                          leagueId: selectedLeague.id,
                                        } as any);
                                      }
                                    }}
                                    title={isFav ? t('removeFromFavoriteTeams') : t('addToFavoriteTeams')}
                                  >
                                    ★
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Mode 3: Cards Grid */}
                  {teamsLayout === 'grid' && (
                    <div className="league-divisions-grid-container">
                      {Array.from(teamGroups.entries()).map(([divName, divTeams]) => (
                        <div key={divName} className="league-division-group">
                          <h4 className="league-division-title">{divName}</h4>
                          <div className="sports-teams-grid-v2">
                            {divTeams.map((team) => {
                              const teamAny = team as any;
                              const isFav = favorites.some((f) => matchesFavorite(f, team.id, selectedLeague.id));
                              const primaryColor = teamAny.color ? `#${teamAny.color.replace('#', '')}` : '#6366f1';

                              return (
                                <div
                                  key={team.id}
                                  className={`sports-team-card-v2${isFav ? ' favorite' : ''}`}
                                  style={{ borderLeftColor: primaryColor }}
                                  onClick={() => setSelectedTeam(team)}
                                >
                                  <div className="team-card-v2-main">
                                    <TeamLogo
                                      logo={team.logo}
                                      name={team.name}
                                      abbreviation={teamAny.abbreviation}
                                      primaryColor={primaryColor}
                                      size={36}
                                    />
                                    <div className="sports-team-card-info">
                                      <span className="sports-team-card-name">{team.name}</span>
                                      {teamAny.standingSummary ? (
                                        <span className="sports-team-card-sub">{teamAny.standingSummary}</span>
                                      ) : team.shortName ? (
                                        <span className="sports-team-card-sub">{team.shortName}</span>
                                      ) : null}
                                    </div>
                                  </div>

                                  <button
                                    className={`sports-team-card-star${isFav ? ' active' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isFav) {
                                        removeFavorite(team.id, selectedLeague.id);
                                      } else {
                                        addFavorite({
                                          id: team.id,
                                          name: team.name,
                                          shortName: team.shortName,
                                          location: teamAny.location,
                                          abbreviation: teamAny.abbreviation,
                                          color: teamAny.color,
                                          alternateColor: teamAny.alternateColor,
                                          logo: team.logo,
                                          leagueId: selectedLeague.id,
                                        } as any);
                                      }
                                    }}
                                    title={isFav ? t('removeFromFavoriteTeams') : t('addToFavoriteTeams')}
                                  >
                                    ★
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {activeView === 'schedule' && (
                <section className="sports-section">
                  <HorizontalDateRail
                    selectedDate={activeScheduleDate}
                    onSelectDate={(d) => handleDateChange(d)}
                    onOpenCalendar={() => setIsCalendarOpen(true)}
                  />

                  <SportsCalendarModal
                    isOpen={isCalendarOpen}
                    selectedDate={activeScheduleDate}
                    leagueName={selectedLeague?.name}
                    onSelectDate={(d) => handleDateChange(d)}
                    onClose={() => setIsCalendarOpen(false)}
                  />

                  {displayedScheduleEvents.length > 0 ? (
                    <div className="league-game-cards-list">
                      {displayedScheduleEvents.slice(0, 50).map((event) => (
                        <LeagueGameCard
                          key={event.id}
                          event={event}
                          isIndividualSport={isIndividualSport}
                          onChannelClick={handleChannelClick}
                          onClick={() => setSelectedEvent(event)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="sports-empty">
                      <p>{t('noGamesScheduled')}</p>
                    </div>
                  )}
                </section>
              )}

              {activeView === 'standings' && !isIndividualSport && (
                <section className="sports-section">
                  <div className="sports-standings-top-bar">
                    <h3 className="sports-section-title" style={{ margin: 0 }}>{t('standings')}</h3>
                    {leagueStandingsGroups.length > 0 && (
                      <div className="sports-standings-toggle-group">
                        <button
                          className={`sports-standings-toggle-btn${standingsMode === 'division' ? ' active' : ''}`}
                          onClick={() => setStandingsMode('division')}
                        >
                          {t('byDivision')}
                        </button>
                        <button
                          className={`sports-standings-toggle-btn${standingsMode === 'conference' ? ' active' : ''}`}
                          onClick={() => setStandingsMode('conference')}
                        >
                          {t('byConference')}
                        </button>
                      </div>
                    )}
                  </div>
                  {(() => {
                    const activeGroups = displayStandingsGroups.length > 0 ? displayStandingsGroups : [];
                    const isPreseason = activeGroups.every((g) => g.teams.every((t) => t.wins === 0 && t.losses === 0)) ||
                      (leagueStandings.length > 0 && leagueStandings.every((t) => t.wins === 0 && t.losses === 0));

                    return (
                      <>
                        {isPreseason && (
                          <div className="standings-preseason-banner">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="12" y1="16" x2="12" y2="12" />
                              <circle cx="12" cy="8" r="0.5" fill="currentColor" />
                            </svg>
                            <span>{t('preseasonStandingsHint')}</span>
                          </div>
                        )}

                        {activeGroups.length > 0 ? (
                          <div className="sports-standings-groups">
                            {activeGroups.map((group) => (
                              <div key={group.name} className="sports-standings-group">
                                <h4 className="sports-standings-conference">{group.name}</h4>
                                <div className="sports-standings-table">
                                  <div className="sports-standings-header">
                                    <span>#</span>
                                    <span>{t('team')}</span>
                                    <span>{t('wins')}</span>
                                    <span>{t('losses')}</span>
                                    <span>{t('pct')}</span>
                                  </div>
                                  {group.teams.map((team, idx) => (
                                    <div key={team.id} className={`sports-standings-row${idx === 0 || team.rank === 1 ? ' leader-row' : ''}`}>
                                      <span>{team.rank}</span>
                                      <button
                                        className="sports-standings-team"
                                        onClick={() => setSelectedTeam({ id: team.id, name: team.name, shortName: team.shortName, logo: team.logo, leagueId: selectedLeague.id })}
                                      >
                                        {team.logo && (
                                          <img src={team.logo} alt="" className="sports-standings-logo" />
                                        )}
                                        {team.name}
                                      </button>
                                      <span>{team.wins}</span>
                                      <span>{team.losses}</span>
                                      <span>{team.winPercent}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : leagueStandings.length > 0 ? (
                          <div className="sports-standings-table">
                            <div className="sports-standings-header">
                              <span>#</span>
                              <span>{t('team')}</span>
                              <span>{t('wins')}</span>
                              <span>{t('losses')}</span>
                              <span>{t('pct')}</span>
                            </div>
                            {leagueStandings.map((team, idx) => (
                              <div key={team.id} className={`sports-standings-row${idx === 0 ? ' leader-row' : ''}`}>
                                <span>{idx + 1}</span>
                                <button
                                  className="sports-standings-team"
                                  onClick={() => setSelectedTeam({ id: team.id, name: team.name, shortName: team.shortName, logo: team.logo, leagueId: selectedLeague.id })}
                                >
                                  {team.logo && (
                                    <img src={team.logo} alt="" className="sports-standings-logo" />
                                  )}
                                  {team.name}
                                </button>
                                <span>{team.wins}</span>
                                <span>{team.losses}</span>
                                <span>{team.winPercent}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="sports-empty">
                            <p>{t('standingsNotAvailable')}</p>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default LeaguesTab;
