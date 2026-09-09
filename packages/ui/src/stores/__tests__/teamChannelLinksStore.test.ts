import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store transitively imports the Tauri DB layer, which doesn't load in the
// node test environment — stub it out with an in-memory table.
const toArrayMock = vi.fn();
const bulkPutMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    teamChannelLinks: {
      toArray: () => toArrayMock(),
      bulkPut: (...args: unknown[]) => bulkPutMock(...args),
      put: (...args: unknown[]) => putMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
  },
}));

// getLeagueTeams / matchTeamsToChannels are only used by autoLinkLeague, which
// these tests don't exercise — stub them out so the module graph loads.
vi.mock('../../services/sports', () => ({ getLeagueTeams: vi.fn() }));
vi.mock('../../services/sports/teamChannelMatcher', () => ({ matchTeamsToChannels: vi.fn() }));

import { useTeamChannelLinksStore } from '../teamChannelLinksStore';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const resetStore = () => {
  useTeamChannelLinksStore.setState({
    links: [],
    teamIndex: new Map(),
    loaded: false,
    loading: false,
  });
};

beforeEach(() => {
  // mockReset (not clearAllMocks) also drops queued implementations, so a
  // mockRejectedValueOnce from a previous test can't leak into this one.
  vi.clearAllMocks();
  vi.resetAllMocks();
  resetStore();
});

describe('ensureLoaded', () => {
  it('waits for an in-flight load instead of resolving immediately while loading', async () => {
    const gate = deferred<unknown[]>();
    toArrayMock.mockReturnValueOnce(gate.promise);

    const first = useTeamChannelLinksStore.getState().ensureLoaded();
    const second = useTeamChannelLinksStore.getState().ensureLoaded();

    // Neither should resolve until the underlying read completes.
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => (firstSettled = true));
    void second.then(() => (secondSettled = true));

    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    gate.resolve([]);
    await Promise.all([first, second]);

    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    // The in-flight load was awaited, so a caller racing the initial load
    // sees the loaded links (not an empty set).
    expect(useTeamChannelLinksStore.getState().loaded).toBe(true);
    // Only one read issued for both callers.
    expect(toArrayMock).toHaveBeenCalledTimes(1);
  });

  it('does not mark a failed load as loaded, so the next call retries', async () => {
    toArrayMock.mockRejectedValueOnce(new Error('db unavailable'));
    await useTeamChannelLinksStore.getState().ensureLoaded();

    expect(useTeamChannelLinksStore.getState().loaded).toBe(false);
    expect(useTeamChannelLinksStore.getState().loading).toBe(false);

    // A later call retries and succeeds instead of being stuck on empty state.
    toArrayMock.mockResolvedValueOnce([
      { id: 'nfl:team1:ch1', league_id: 'nfl', team_id: 'team1', stream_id: 'ch1', channel_name: 'Chan 1', priority: 0 },
    ]);
    await useTeamChannelLinksStore.getState().ensureLoaded();

    expect(useTeamChannelLinksStore.getState().loaded).toBe(true);
    expect(useTeamChannelLinksStore.getState().links).toHaveLength(1);
    expect(toArrayMock).toHaveBeenCalledTimes(2);
  });
});

describe('mutations after a failed load', () => {
  it('does not write when links failed to load', async () => {
    // Persistent rejection: linkTeamAtSlot calls ensureLoaded() again under
    // the hood, which must also fail rather than fall through to a write.
    toArrayMock.mockRejectedValue(new Error('db unavailable'));
    await useTeamChannelLinksStore.getState().ensureLoaded();

    await useTeamChannelLinksStore.getState().linkTeamAtSlot(
      {
        league_id: 'nfl',
        team_id: 'team1',
        stream_id: 'ch1',
        channel_name: 'Chan 1',
      },
      0
    );

    expect(bulkPutMock).not.toHaveBeenCalled();
    expect(useTeamChannelLinksStore.getState().links).toEqual([]);
  });
});