import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the (also hoisted) vi.mock factory below can reach them.
const mocks = vi.hoisted(() => ({
  groupCount: vi.fn(),
  clearGroups: vi.fn(),
  clearMembers: vi.fn(),
  transactionScopeCount: vi.fn(),
}));

vi.mock('../../db', () => {
  const db = {
    failoverGroups: {
      count: () => mocks.groupCount(),
      clear: () => mocks.clearGroups(),
    },
    failoverGroupMembers: {
      clear: () => mocks.clearMembers(),
    },
    // Run the transaction scope straight away; we only care that both tables
    // are cleared inside it, not that Dexie is real.
    transaction: async (_mode: string, _tables: unknown, scope: () => Promise<void>) => {
      mocks.transactionScopeCount();
      return scope();
    },
  };
  return { db, updateFailoverMembersBatch: vi.fn() };
});

vi.mock('../../stores/sportsSettingsStore', () => ({
  useSportsSettingsStore: { getState: () => ({ autoSwapDeadStreams: false }) },
}));

vi.mock('../../stores/teamChannelLinksStore', () => ({
  useTeamChannelLinksStore: { getState: () => ({ ensureLoaded: async () => {}, links: [] }) },
  getTeamLinks: () => [],
}));

import { deleteAllFailoverGroups } from '../failover-groups';

describe('deleteAllFailoverGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.groupCount.mockResolvedValue(4);
  });

  it('clears the groups and their members, and returns the number of groups removed', async () => {
    const removed = await deleteAllFailoverGroups();

    expect(removed).toBe(4);
    // Both tables must be cleared in one transaction, or deleting the groups
    // would leave orphaned member rows behind.
    expect(mocks.transactionScopeCount).toHaveBeenCalledTimes(1);
    expect(mocks.clearMembers).toHaveBeenCalledTimes(1);
    expect(mocks.clearGroups).toHaveBeenCalledTimes(1);
  });

  it('reports zero when there was nothing to delete', async () => {
    mocks.groupCount.mockResolvedValue(0);

    expect(await deleteAllFailoverGroups()).toBe(0);
  });
});
