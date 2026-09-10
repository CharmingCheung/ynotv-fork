import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { restoreScrollPosition, shouldPersistScroll, type SavedScrollPosition } from '../scrollRestore';

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