import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../toastStore';

describe('toastStore error stacking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('appends a new error to an existing error toast instead of creating another', () => {
    const { addToast } = useToastStore.getState();
    addToast('first error', 'error');
    addToast('second error', 'error');

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('first error\nsecond error');
    expect(toasts[0].count).toBe(2);
  });

  it('labels a single error with count 1 and stacks increment it', () => {
    const { addToast } = useToastStore.getState();
    addToast('only error', 'error');
    expect(useToastStore.getState().toasts[0].count).toBe(1);

    addToast('another error', 'error');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].count).toBe(2);
  });

  it('keeps a stacked error toast visible 6s after the last appended error', () => {
    const { addToast } = useToastStore.getState();
    addToast('first error', 'error');
    vi.advanceTimersByTime(4000); // almost expired
    addToast('second error', 'error'); // timer should reset

    vi.advanceTimersByTime(5500);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(600);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('starts a fresh toast once the previous error toast has been dismissed', () => {
    const { addToast } = useToastStore.getState();
    addToast('first error', 'error');
    vi.advanceTimersByTime(6100); // auto-dismissed
    addToast('later error', 'error');

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('later error');
  });

  it('keeps success toasts separate while errors stack among themselves', () => {
    const { addToast } = useToastStore.getState();
    addToast('first error', 'error');
    addToast('all good', 'success');
    addToast('second error', 'error');

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    const errors = toasts.filter((t) => t.type === 'error');
    const successes = toasts.filter((t) => t.type === 'success');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('first error\nsecond error');
    expect(errors[0].count).toBe(2);
    expect(successes).toHaveLength(1);
    expect(successes[0].message).toBe('all good');
    expect(successes[0].count).toBeUndefined();
  });

  it('manual removal cancels the pending auto-dismiss timer', () => {
    const { addToast, removeToast } = useToastStore.getState();
    addToast('first error', 'error');
    const id = useToastStore.getState().toasts[0].id;
    removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);

    vi.advanceTimersByTime(10000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('correctly resolves plural error counts across languages', async () => {
    const { default: i18n } = await import('../../i18n');
    for (const [lang, expected2] of [
      ['en', '2 errors'],
      ['ru', '2 ошибки'],
      ['pl', '2 błędy'],
      ['ar', '2 أخطاء'],
    ] as const) {
      await i18n.changeLanguage(lang);
      expect(i18n.t('common:errorCount', { count: 2 })).toBe(expected2);
    }
    await i18n.changeLanguage('en');
  });
});
