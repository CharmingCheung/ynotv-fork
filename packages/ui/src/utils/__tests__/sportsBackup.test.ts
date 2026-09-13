import { describe, expect, it } from 'vitest';
import {
  SPORTS_FAVORITES_STORE_VERSION,
  deserializeTeamChannelLinks,
  parseSportsFavorites,
  serializeSportsFavorites,
  serializeTeamChannelLinks,
  teamChannelLinkId,
} from '../sportsBackup';

describe('team channel links backup', () => {
  it('round-trips rows through camelCase serialization', () => {
    const rows = [
      {
        id: 'nfl:12:stream-a',
        league_id: 'nfl',
        team_id: '12',
        stream_id: 'stream-a',
        channel_name: 'NFL RedZone',
        source_id: 'src-1',
        priority: 0,
        auto: 0,
        confidence: 1,
        updated_at: 1700000000000,
      },
      {
        id: 'nfl:12:stream-b',
        league_id: 'nfl',
        team_id: '12',
        stream_id: 'stream-b',
        channel_name: 'Backup',
        priority: 1,
        auto: 1,
        confidence: 0.72,
        updated_at: 1700000000001,
      },
    ];

    const backup = serializeTeamChannelLinks(rows);
    expect(backup[0]).toMatchObject({
      id: 'nfl:12:stream-a',
      leagueId: 'nfl',
      teamId: '12',
      streamId: 'stream-a',
      channelName: 'NFL RedZone',
      sourceId: 'src-1',
      priority: 0,
      auto: 0,
      confidence: 1,
      updatedAt: 1700000000000,
    });

    expect(deserializeTeamChannelLinks(backup)).toEqual(rows);
  });

  it('preserves primary/backup ordering via priority', () => {
    const restored = deserializeTeamChannelLinks([
      { id: 'nba:1:b', leagueId: 'nba', teamId: '1', streamId: 'b', channelName: 'B', priority: 1, auto: 0, confidence: 1, updatedAt: 1 },
      { id: 'nba:1:a', leagueId: 'nba', teamId: '1', streamId: 'a', channelName: 'A', priority: 0, auto: 0, confidence: 1, updatedAt: 1 },
    ]);

    const sorted = [...restored].sort((x, y) => (x.priority ?? 0) - (y.priority ?? 0));
    expect(sorted.map((l) => l.stream_id)).toEqual(['a', 'b']);
  });

  it('drops rows that cannot resolve to a channel', () => {
    const restored = deserializeTeamChannelLinks([
      { id: 'ok', leagueId: 'nfl', teamId: '1', streamId: 's1', channelName: 'Ok', auto: 0, confidence: 1, updatedAt: 1 },
      { leagueId: 'nfl', teamId: '2', streamId: '', channelName: 'No stream' } as never,
      { leagueId: '', teamId: '3', streamId: 's3', channelName: 'No league' } as never,
      null as never,
    ]);

    expect(restored).toHaveLength(1);
    expect(restored[0].stream_id).toBe('s1');
  });

  it('derives the composite id when a backup omits it (legacy shape)', () => {
    const restored = deserializeTeamChannelLinks([
      { leagueId: 'nhl', teamId: '7', streamId: 's9', channelName: 'Hockey', auto: 1, confidence: 0.9, updatedAt: 5 } as never,
    ]);

    expect(restored[0].id).toBe(teamChannelLinkId('nhl', '7', 's9'));
  });

  it('tolerates missing/undefined lists and applies safe defaults', () => {
    expect(deserializeTeamChannelLinks(undefined)).toEqual([]);
    expect(deserializeTeamChannelLinks(null)).toEqual([]);

    const restored = deserializeTeamChannelLinks([
      { leagueId: 'nfl', teamId: '1', streamId: 's1' } as never,
    ]);
    expect(restored[0]).toMatchObject({ priority: 0, auto: 0, confidence: 1, channel_name: '' });
  });
});

describe('sports favorites backup', () => {
  const favorites = [
    { id: '12', name: 'Packers', leagueId: 'nfl', addedAt: 1, isPinned: true },
    { id: '9', name: 'Chiefs', leagueId: 'nfl', addedAt: 2, needsLeagueResolution: true },
  ];

  it('round-trips the persisted zustand envelope', () => {
    const raw = serializeSportsFavorites({ favorites, repairPromptDismissed: true });
    const parsed = parseSportsFavorites(raw);

    expect(parsed).toEqual({ favorites, repairPromptDismissed: true });
    expect(JSON.parse(raw).version).toBe(SPORTS_FAVORITES_STORE_VERSION);
  });

  it('preserves pinning and the repair flag', () => {
    const parsed = parseSportsFavorites(serializeSportsFavorites({ favorites, repairPromptDismissed: false }));
    expect(parsed?.favorites[0].isPinned).toBe(true);
    expect(parsed?.favorites[1].needsLeagueResolution).toBe(true);
    expect(parsed?.repairPromptDismissed).toBe(false);
  });

  it('returns undefined for a missing blob so old backups never wipe favorites', () => {
    expect(parseSportsFavorites(null)).toBeUndefined();
    expect(parseSportsFavorites(undefined)).toBeUndefined();
    expect(parseSportsFavorites('')).toBeUndefined();
  });

  it('returns undefined for corrupt or unexpected shapes', () => {
    expect(parseSportsFavorites('not json')).toBeUndefined();
    expect(parseSportsFavorites('{"state":{}}')).toBeUndefined();
    expect(parseSportsFavorites('{"state":{"favorites":"nope"}}')).toBeUndefined();
    expect(parseSportsFavorites('{"other":1}')).toBeUndefined();
  });
});
