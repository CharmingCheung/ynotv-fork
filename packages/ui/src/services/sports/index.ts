/**
 * Sports API Service
 *
 * Modular sports data fetching from ESPN's public API
 * 
 * @example
 * ```typescript
 * import { getLiveScores, getLeagueNews, getGameSummary } from './services/sports';
 * 
 * const scores = await getLiveScores();
 * const news = await getLeagueNews('nfl', 10);
 * const game = await getGameSummary('event-id', 'nfl');
 * ```
 */

// Types
export type {
  // Base types
  SportsEvent,
  SportsTeam,
  SportsLeague,
  SportsBroadcastChannel,
  
  // ESPN API types
  ESPNEvent,
  ESPTeam,
  ESPNLeague,
  SportConfig,
  
  // Team types
  TeamRecord,
  TeamAthlete,
  TeamDetails,
  
  // Standings types
  StandingTeam,
  StandingGroup,
  
  // UFC types
  UFCWeightClassRanking,
  
  // Game types
  TeamStatistics,
  PlayerStat,
  PlayerStatCategory,
  GameSummaryTeam,
  ScoringPlay,
  MatchEvent,
  GameSummary,
  PlayByPlay,
  PlayPeriod,
  Play,
  
  // News types
  NewsArticle,
  
  // Rankings types
  Ranking,
  RankingsList,
  
  // Leaders types
  LeagueLeader,
  LeadersCategory,
  
  // Individual sports rankings
  GolfRanking,
  TennisRanking,
  RacingStanding,

  // Depth Chart types
  DepthChartGroup,
  DepthChartPosition,
  DepthChartAthlete,

  // Injury types
  TeamInjury,

  // Team Leader types
  TeamLeaderCategory,
  TeamLeader,

  // Team News types
  TeamNewsArticle,

  // Athlete types
  AthleteBio,
  AthleteStatSplit,
  AthleteGameLogRow,
  AthleteGameLogData,
} from './types';

// Configuration
export {
  ESPN_API_BASE,
  SPORT_CONFIG,
  DEFAULT_LIVE_LEAGUES,
  DEFAULT_UPCOMING_LEAGUES,
  CATEGORY_NAMES,
  LEADERS_LEAGUES,
} from './config';

// API Client
export {
  fetchJson,
  buildScoreboardUrl,
  buildDateRangeUrl,
  buildTeamsUrl,
  buildTeamUrl,
  buildTeamScheduleUrl,
  buildStandingsUrl,
  buildNewsUrl,
  buildRankingsUrl,
  buildLeadersUrl,
  buildGameSummaryUrl,
  buildPlayByPlayUrl,
  buildUFCRankingsUrl,
  buildCoreLeagueUrl,
} from './client';

// Mappers
export {
  mapESPNEvent,
  mapESPNTeam,
  getSportConfig,
  getCategoryDisplayName,
} from './mappers';

// Scores API
export {
  getScoreboard,
  getLiveScores,
  getLiveScoresForLeagues,
  getUpcomingEvents,
  getLeagueEvents,
  getEventsForDate,
  type ScoreboardFilters,
} from './scores';

// Teams API
export {
  searchTeams,
  getTeamById,
  getTeamNextEvents,
  getTeamPastEvents,
  getTeamSchedule,
  getTeamDetails,
  getLeagueTeams,
  getLeagueStandings,
  getLeagueStandingsGrouped,
  getLeagueStandingsByDivision,
  getTeamDepthChart,
  getTeamInjuries,
  getTeamLeaders,
  getTeamNews,
} from './teams';

// Athletes API
export {
  getAthleteDetails,
  getAthleteGameLog,
  type AthleteProfileResponse,
} from './athletes';

// Games API
export {
  getGameSummary,
  getPlayByPlay,
} from './games';

// News API
export {
  getLeagueNews,
} from './news';

// Rankings API
export {
  getLeagueRankings,
  getUFCRankings,
  getGolfRankings,
  getTennisRankings,
  getRacingStandings,
} from './rankings';

// Leaders API
export {
  getLeagueLeaders,
} from './leaders';

// Utils
export {
  formatEventTime,
  formatEventDate,
  formatEventDateTime,
  formatLastUpdated,
  formatRelativeDate,
  isEventLive,
  isEventLiveOrPastStart,
  isEventUpcoming,
  isEventFinished,
  getAvailableSports,
  getAvailableLeagues,
  getAvailableCategories,
  getLeaguesByCategory,
  getLeaguesBySport,
  getLeagueLogos,
} from './utils';

// League Inference
export {
  inferTeamLeague,
  inferTeamLeagueResult,
  inferLeagueFromLogoUrl,
  inferLeagueFromTeamName,
} from './leagueInference';
