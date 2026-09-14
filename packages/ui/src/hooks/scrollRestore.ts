/**
 * Shared scroll-restore logic for the virtualized VOD and Local galleries.
 *
 * Virtualized grids don't have their final height when they first mount: pages
 * load asynchronously and @tanstack/react-virtual re-measures rendered rows, so
 * a single `scrollTop` assignment can be clamped to a still-growing max — the
 * restore lands short, or while the list is still very short, at the top. This
 * re-applies the saved offset every frame until the content has settled at (or
 * beyond) it.
 *
 * Two position kinds are handled:
 *  - Exact offset: re-applied until the container can actually reach it.
 *  - Bottom ("user was at the very bottom"): the list's bottom moves as rows
 *    are measured and pages load, so the restore follows the LIVE bottom
 *    instead of a stale pixel value.
 *
 * The loop stops when the offset is applied and the layout settled, when the
 * user manually scrolls (`isPending()` turns false), or after `maxFrames` —
 * it is a best-effort restore, never a fight with the user. Wire `targetRef`
 * into the container's onScroll so the consumer can tell programmatic applies
 * apart from real user scrolls (and only cancel the restore on the latter).
 */
export interface SavedScrollPosition {
  /** Pixel offset the user left the list at. */
  top: number;
  /** `scrollHeight - clientHeight` at save time — used to detect a bottom scroll. */
  max: number;
}

/**
 * Whether an offset is worth remembering.
 *
 * `{ top: 0, max: 0 }` means this list was never scrolled — nothing to
 * remember, and also what a teardown can look like — so it is dropped instead
 * of stored. A deliberate scroll back to the very top is `{ top: 0, max }`,
 * which IS worth storing because it has to replace a stale deeper offset; every
 * restore consumer then reads `top <= 0` as "no position" and starts at the top.
 */
export function shouldPersistScroll(top: number, max: number): boolean {
  return top > 0 || max > 0;
}

// ============================================================================
// Shared scroll memory
// ============================================================================

/**
 * Scroll offset per list, shared by every virtualized gallery.
 *
 * Offsets are recorded as the user scrolls rather than on unmount. Playback and
 * section switches tear a grid down in ways whose cleanup ordering is hard to
 * depend on — and a teardown can reset a scroller's offset to 0 before the
 * cleanup gets to read it, which looks exactly like the user deliberately
 * scrolling back to the top. Recording while the list is live makes re-entry
 * independent of all of that.
 *
 * Keyed per list (view + category/filter + search) so every list remembers its
 * own spot instead of sharing one offset.
 */
const scrollMemory = new Map<string, SavedScrollPosition>();

/**
 * Reads a container's current offset, or null when it isn't measurable.
 *
 * A detached or collapsed container reports `clientHeight === 0`, which is what
 * a teardown looks like — recording that as `{ top: 0 }` would wipe the real
 * position, so callers must treat null as "no measurement".
 */
export function readScrollPosition(el: HTMLElement | null | undefined): SavedScrollPosition | null {
  if (!el || !el.isConnected || el.clientHeight <= 0) return null;
  return {
    top: el.scrollTop,
    max: Math.max(0, el.scrollHeight - el.clientHeight),
  };
}

/** Records a list's offset. `null` (unmeasurable) and `{ top: 0, max: 0 }` are ignored. */
export function rememberScrollPosition(key: string, pos: SavedScrollPosition | null): void {
  if (!pos) return;
  if (!shouldPersistScroll(pos.top, pos.max)) return;
  scrollMemory.set(key, pos);
}

/** The remembered offset for a list, if it has one. */
export function recallScrollPosition(key: string): SavedScrollPosition | undefined {
  return scrollMemory.get(key);
}

/** Drops a list's remembered offset (used by tests). */
export function forgetScrollPosition(key: string): void {
  scrollMemory.delete(key);
}

/** Drops every remembered offset (used by tests). */
export function clearScrollMemory(): void {
  scrollMemory.clear();
}

/**
 * Whether a scroll event means the user took over from an in-flight restore.
 *
 * Only a deviation from an offset we actually applied counts. `target === null`
 * means the restore hasn't applied anything yet — the list may still be too
 * short for the saved offset — and treating that as a user scroll is how a
 * re-entered list used to end up stuck at the top.
 */
export function isUserScrollDuringRestore(
  target: number | null,
  currentTop: number
): boolean {
  return target !== null && Math.abs(currentTop - target) > 1;
}

export function restoreScrollPosition(opts: {
  el: HTMLElement;
  saved: SavedScrollPosition;
  /** False once the user scrolls or the view key changes — stop retrying. */
  isPending: () => boolean;
  /**
   * Called once the restore is finished — either the offset was applied and the
   * layout settled, or the retry budget ran out. Consumers use it to stop
   * treating the list as mid-restore.
   */
  onSettled: () => void;
  /** Ref the consumer's onScroll checks to tell programmatic applies apart from user scrolls. */
  targetRef: { current: number | null };
  maxFrames?: number;
}): () => void {
  const { el, saved, isPending, onSettled, targetRef, maxFrames = 300 } = opts;
  const snapToBottom = saved.max > 0 && saved.top >= saved.max - 4;
  let frames = 0;
  let lastMax = -1;
  let stableFrames = 0;
  let raf = 0;

  const tick = () => {
    if (!isPending()) {
      targetRef.current = null;
      return;
    }
    const max = el.scrollHeight - el.clientHeight;

    if (snapToBottom) {
      // Follow the live bottom: wait until the height stops changing, then
      // snap once to the final bottom.
      if (max !== lastMax) {
        lastMax = max;
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }
      if (stableFrames >= 2) {
        if (Math.abs(el.scrollTop - max) > 1) {
          targetRef.current = max;
          el.scrollTop = max;
          stableFrames = 0;
        } else {
          targetRef.current = null;
          onSettled();
          return;
        }
      }
    } else if (saved.top <= max) {
      // Reachable now — apply once (or confirm it's already there).
      if (Math.abs(el.scrollTop - saved.top) > 1) {
        targetRef.current = saved.top;
        el.scrollTop = saved.top;
      } else {
        targetRef.current = null;
        onSettled();
        return;
      }
    }
    // else: content still too short to reach the saved offset — keep watching
    // for the list to grow (pagination / async page loads).

    frames += 1;
    if (frames < maxFrames) {
      raf = requestAnimationFrame(tick);
    } else {
      // Out of retries (the list never grew enough) — stop waiting on us.
      targetRef.current = null;
      onSettled();
    }
  };

  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    targetRef.current = null;
  };
}
