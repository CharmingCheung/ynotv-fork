/**
 * vodSyncFailures.ts
 *
 * Reporting for automatic VOD refreshes.
 *
 * `syncVodForSource` resolves with `{ success: false, error }` instead of
 * throwing, so an auto-sync pass that discards the resolved value drops the
 * provider's HTTP error silently — the status line just disappears and the
 * library keeps whatever it had. These helpers surface it the way channel
 * auto-sync does (`common:autoSyncFailed`), but collapse a whole batch into a
 * single toast with one line per failed source rather than one toast each.
 */
import i18n, { translateNativeError } from '../i18n';
import { useToastStore } from '../stores/toastStore';

export interface VodSyncOutcome {
  /** Source name as shown in Settings → Sources. */
  name: string;
  /** The resolved result of `syncVodForSource` for that source. */
  result: { success: boolean; error?: string };
}

/**
 * The toast line for one VOD sync outcome, or null when it succeeded.
 *
 * The error is run through `translateNativeError` first (same as the per-source
 * VOD sync toast in Settings → Sources), so a raw adapter/Rust message is shown
 * in the user's language when we have a translation for it.
 */
export function vodSyncFailureLine(outcome: VodSyncOutcome): string | null {
  if (outcome.result.success) return null;
  const raw = outcome.result.error;
  const detail = translateNativeError(raw) || raw || i18n.t('common:unknownErrorOccurred');
  return i18n.t('common:autoSyncFailed', { name: outcome.name, error: detail });
}

/** Failure lines for a batch, in the order the sources were handed to us. */
export function vodSyncFailureLines(outcomes: VodSyncOutcome[]): string[] {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const line = vodSyncFailureLine(outcome);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Toast a batch's failed VOD syncs as ONE stacked message (each failure on its
 * own line). Call once per batch, after its `Promise.all` settles; a batch where
 * everything succeeded adds nothing.
 *
 * Returns the number of failures reported, for callers that want to log it.
 */
export function reportVodSyncFailures(outcomes: VodSyncOutcome[]): number {
  const lines = vodSyncFailureLines(outcomes);
  if (lines.length === 0) return 0;
  useToastStore.getState().addToast(lines.join('\n'), 'error');
  return lines.length;
}
