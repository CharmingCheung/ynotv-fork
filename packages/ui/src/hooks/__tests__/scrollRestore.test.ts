import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  clearScrollMemory,
  forgetScrollPosition,
  isUserScrollDuringRestore,
  readScrollPosition,
  recallScrollPosition,
  rememberScrollPosition,
  restoreScrollPosition,
  shouldPersistScroll,
  type SavedScrollPosition,
} from '../scrollRestore';

// The restore loop is rAF-driven; stub it so frames can be run synchronously.
let rafCallbacks: Array<() => void> = [];
let rafId = 0;

function makeEl(initialContentHeight = 1000, initialTop = 0) {
  let scrollTop = initialTop;
  let contentHeight = initialContentHeight;
  const clientHeight = 500;
  return {
    get scrollHeight() {
      return contentHeight;
    },
    get clientHeight() {
      return clientHeight;
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(v: number) {
      scrollTop = v;
    },
    // Simulate async content (pages/rows) growing the scrollable area.
    growTo(h: number) {
      contentHeight = h;
    },
  };
}

function runFrames(n: number): number {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    const cb = rafCallbacks.shift();
    if (!cb) break;
    ran += 1;
    cb();
  }
  return ran;
}

beforeEach(() => {
  rafCallbacks = [];
  rafId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafCallbacks.push(cb);
    return ++rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function start(opts: {
  el: ReturnType<typeof makeEl>;
  saved: SavedScrollPosition;
  pending?: () => boolean;
  onSettled?: () => void;
  targetRef?: { current: number | null };
}) {
  const settled = opts.onSettled ?? vi.fn();
  const pending = opts.pending ?? (() => true);
  const targetRef = opts.targetRef ?? { current: null };
  const stop = restoreScrollPosition({
    el: opts.el as unknown as HTMLElement,
    saved: opts.saved,
    isPending: pending,
    onSettled: settled,
    targetRef,
  });
  return { settled, pending, targetRef, stop };
}

describe('shouldPersistScroll', () => {
  it('does not persist when the list never scrolled (StrictMode synthetic cleanup)', () => {
    expect(shouldPersistScroll(0, 0)).toBe(false);
  });

  it('persists a normal scroll offset', () => {
    expect(shouldPersistScroll(300, 1200)).toBe(true);
  });

  it('persists a deliberate scroll back to the top so it replaces a stale offset', () => {
    // lastTop is 0 but the list did scroll (lastMax is known), so leaving at the
    // top must overwrite any previously saved deeper position.
    expect(shouldPersistScroll(0, 1200)).toBe(true);
  });
});

describe('restoreScrollPosition', () => {
  it('applies an exact offset once the list can reach it and settles', () => {
    const el = makeEl(1000); // max = 1000 - 500 = 500
    const { settled, targetRef } = start({ el, saved: { top: 400, max: 500 } });

    runFrames(1);
    expect(el.scrollTop).toBe(400);
    expect(targetRef.current).toBe(400); // onScroll can tell it apart from a user scroll

    runFrames(1);
    expect(el.scrollTop).toBe(400);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(targetRef.current).toBeNull();
  });

  it('keeps re-applying while the list is still too short, then lands at the saved offset', () => {
    const el = makeEl(600); // max = 100 — saved offset unreachable at first
    const { settled } = start({ el, saved: { top: 400, max: 500 } });

    runFrames(1);
    expect(el.scrollTop).toBe(0); // still short — keep watching

    el.growTo(1200); // max = 700 — now reachable
    runFrames(1);
    expect(el.scrollTop).toBe(400);
    expect(settled).not.toHaveBeenCalled();

    runFrames(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('follows the live bottom when the user was at the very bottom', () => {
    // User left the list at the bottom: content 1000px (max 500), scrolled to 498.
    const el = makeEl(1000, 498);
    const { settled } = start({ el, saved: { top: 498, max: 500 } });

    // Height not stable yet — no snap.
    runFrames(1);
    expect(el.scrollTop).toBe(498);

    // Async rows load and expand the list; the restore must follow the NEW bottom.
    el.growTo(1600); // max = 1100
    runFrames(1);
    expect(el.scrollTop).toBe(498); // still stabilizing
    runFrames(1);
    // Two stable frames — snap to the live bottom.
    runFrames(1);
    expect(el.scrollTop).toBe(1100);
    runFrames(1);
    runFrames(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the user scrolls (isPending turns false)', () => {
    const el = makeEl(600); // too short initially
    let pending = true;
    const { targetRef } = start({ el, saved: { top: 400, max: 500 }, pending: () => pending });

    runFrames(1);
    expect(el.scrollTop).toBe(0);

    // User takes over mid-restore — the loop must stop fighting them.
    pending = false;
    el.growTo(1200);
    runFrames(5);
    expect(el.scrollTop).toBe(0);
    expect(targetRef.current).toBeNull();
  });

  it('cleanup cancels the pending frame and clears the target ref', () => {
    const el = makeEl(600);
    const { targetRef, stop } = start({ el, saved: { top: 400, max: 500 } });

    runFrames(1);
    expect(rafCallbacks.length).toBe(1); // a frame is still scheduled
    stop();
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(targetRef.current).toBeNull();
    expect(rafCallbacks.length).toBe(1); // frame cancelled, not run
  });
});

describe('scroll memory', () => {
  beforeEach(() => {
    clearScrollMemory();
  });

  function makeMemEl(opts: {
    top?: number;
    contentHeight?: number;
    clientHeight?: number;
    connected?: boolean;
  } = {}) {
    return {
      isConnected: opts.connected ?? true,
      clientHeight: opts.clientHeight ?? 500,
      scrollHeight: opts.contentHeight ?? 1500,
      scrollTop: opts.top ?? 0,
    } as unknown as HTMLElement;
  }

  describe('readScrollPosition', () => {
    it('reads the offset and the scrollable excess', () => {
      expect(readScrollPosition(makeMemEl({ top: 420, contentHeight: 1500, clientHeight: 500 })))
        .toEqual({ top: 420, max: 1000 });
    });

    it('returns null for a detached container (a torn-down list)', () => {
      expect(readScrollPosition(makeMemEl({ top: 0, connected: false }))).toBeNull();
    });

    it('returns null for a collapsed container (hidden list)', () => {
      // A list that is hidden or torn down reports clientHeight 0; recording
      // that would look like the user scrolling back to the top.
      expect(readScrollPosition(makeMemEl({ top: 0, clientHeight: 0 }))).toBeNull();
    });

    it('never reports a negative max', () => {
      expect(readScrollPosition(makeMemEl({ top: 0, contentHeight: 300, clientHeight: 500 })))
        .toEqual({ top: 0, max: 0 });
    });

    it('tolerates a missing element', () => {
      expect(readScrollPosition(null)).toBeNull();
      expect(readScrollPosition(undefined)).toBeNull();
    });
  });

  describe('rememberScrollPosition / recallScrollPosition', () => {
    it('remembers an offset per list key', () => {
      rememberScrollPosition('vod:movies:cat:63', { top: 900, max: 4000 });
      expect(recallScrollPosition('vod:movies:cat:63')).toEqual({ top: 900, max: 4000 });
      expect(recallScrollPosition('vod:movies:cat:12')).toBeUndefined();
    });

    it('keeps each list independent, so switching lists and returning restores the right one', () => {
      rememberScrollPosition('vod:movies:all:q:', { top: 300, max: 2000 });
      rememberScrollPosition('vod:movies:list:favorites', { top: 1500, max: 1800 });
      rememberScrollPosition('local:movies:::name:asc', { top: 42, max: 900 });

      expect(recallScrollPosition('vod:movies:all:q:')).toEqual({ top: 300, max: 2000 });
      expect(recallScrollPosition('vod:movies:list:favorites')).toEqual({ top: 1500, max: 1800 });
      expect(recallScrollPosition('local:movies:::name:asc')).toEqual({ top: 42, max: 900 });
    });

    it('refuses a never-scrolled offset so a teardown cannot clobber a saved position', () => {
      rememberScrollPosition('vod:movies:all:q:', { top: 700, max: 2000 });
      rememberScrollPosition('vod:movies:all:q:', { top: 0, max: 0 });
      expect(recallScrollPosition('vod:movies:all:q:')).toEqual({ top: 700, max: 2000 });
    });

    it('ignores an unmeasurable read instead of treating it as scroll-to-top', () => {
      rememberScrollPosition('vod:series:cat:9', { top: 1200, max: 3000 });
      rememberScrollPosition('vod:series:cat:9', readScrollPosition(makeMemEl({ connected: false })));
      expect(recallScrollPosition('vod:series:cat:9')).toEqual({ top: 1200, max: 3000 });
    });

    it('records a deliberate scroll back to the top, which consumers read as "no position"', () => {
      rememberScrollPosition('vod:movies:cat:63', { top: 0, max: 2500 });
      const saved = recallScrollPosition('vod:movies:cat:63');
      expect(saved).toEqual({ top: 0, max: 2500 });
      // Every restore consumer bails on top <= 0, so the stale deeper offset
      // cannot come back.
      expect(saved!.top <= 0).toBe(true);
    });

    it('updates a list when the user scrolls again', () => {
      rememberScrollPosition('vod:movies:list:recent', { top: 100, max: 500 });
      rememberScrollPosition('vod:movies:list:recent', { top: 480, max: 500 });
      expect(recallScrollPosition('vod:movies:list:recent')).toEqual({ top: 480, max: 500 });
    });
  });

  describe('isUserScrollDuringRestore', () => {
    it('does not treat a scroll event as a takeover before the restore has applied anything', () => {
      // This is the regression: a stray event while the offset was still
      // pending used to cancel the restore, leaving the list at the top.
      expect(isUserScrollDuringRestore(null, 0)).toBe(false);
      expect(isUserScrollDuringRestore(null, 1200)).toBe(false);
    });

    it('treats our own programmatic apply as still restoring', () => {
      expect(isUserScrollDuringRestore(3000, 3000)).toBe(false);
      // Sub-pixel rounding from the browser is not a user scroll either.
      expect(isUserScrollDuringRestore(3000, 3001)).toBe(false);
    });

    it('treats a real deviation as the user taking over', () => {
      expect(isUserScrollDuringRestore(3000, 0)).toBe(true);
      expect(isUserScrollDuringRestore(3000, 500)).toBe(true);
    });
  });

  it('forgetScrollPosition drops one list and clearScrollMemory drops all', () => {
    rememberScrollPosition('a', { top: 10, max: 100 });
    rememberScrollPosition('b', { top: 20, max: 100 });

    forgetScrollPosition('a');
    expect(recallScrollPosition('a')).toBeUndefined();
    expect(recallScrollPosition('b')).toEqual({ top: 20, max: 100 });

    clearScrollMemory();
    expect(recallScrollPosition('b')).toBeUndefined();
  });
});