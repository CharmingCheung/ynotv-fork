import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportVodSyncFailures,
  vodSyncFailureLine,
  vodSyncFailureLines,
  type VodSyncOutcome,
} from '../vodSyncFailures';
import { useToastStore } from '../../stores/toastStore';
import i18n from '../../i18n';

const ok = (name: string): VodSyncOutcome => ({ name, result: { success: true } });
const failed = (name: string, error?: string): VodSyncOutcome => ({
  name,
  result: { success: false, error },
});

describe('vodSyncFailures', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('produces no line for a source that synced', () => {
    expect(vodSyncFailureLine(ok('XP'))).toBeNull();
    expect(vodSyncFailureLines([ok('XP'), ok('OMNI')])).toEqual([]);
  });

  it('names the source and the error, like channel auto-sync does', () => {
    expect(vodSyncFailureLine(failed('XP', 'HTTP Error 403'))).toBe(
      'Auto-sync failed: XP - HTTP Error 403'
    );
  });

  it('translates a native/provider message before showing it', () => {
    expect(
      vodSyncFailureLine(failed('XP', 'Download interrupted: connection reset by peer'))
    ).toBe('Auto-sync failed: XP - Download interrupted');
  });

  it('falls back to a generic reason when the error string is empty', () => {
    expect(vodSyncFailureLine(failed('XP'))).toBe('Auto-sync failed: XP - Unknown error occurred');
    expect(vodSyncFailureLine(failed('XP', ''))).toBe(
      'Auto-sync failed: XP - Unknown error occurred'
    );
  });

  it('keeps one line per failed source, in order', () => {
    expect(
      vodSyncFailureLines([failed('XP', 'HTTP Error 403'), ok('OMNI'), failed('PRIME', 'Timeout')])
    ).toEqual(['Auto-sync failed: XP - HTTP Error 403', 'Auto-sync failed: PRIME - Timeout']);
  });

  it('reports a whole batch as a single toast, not one toast per source', () => {
    const reported = reportVodSyncFailures([
      failed('XP', 'HTTP Error 403'),
      failed('OMNI', 'Timeout'),
      ok('PRIME'),
    ]);

    expect(reported).toBe(2);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    // One message, one line per source — the store renders the '\n' as a break.
    expect(toasts[0].message).toBe(
      'Auto-sync failed: XP - HTTP Error 403\nAuto-sync failed: OMNI - Timeout'
    );
    expect(toasts[0].count).toBe(1);
  });

  it('adds nothing when the batch all succeeded', () => {
    expect(reportVodSyncFailures([ok('XP'), ok('OMNI')])).toBe(0);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('appends a later batch to the same toast instead of spawning another', () => {
    reportVodSyncFailures([failed('XP', 'HTTP Error 403')]);
    reportVodSyncFailures([failed('OMNI', 'Timeout')]);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(
      'Auto-sync failed: XP - HTTP Error 403\nAuto-sync failed: OMNI - Timeout'
    );
    expect(toasts[0].count).toBe(2);
  });
});
