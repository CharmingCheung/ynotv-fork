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
 * Whether leaving a grid view should persist its scroll position.
 *
 * Both refs stay 0 until the list has actually scrolled, so this also guards
 * against React StrictMode's synthetic mount cleanup (which runs before any
 * scroll) clobbering a previously saved position with `{ top: 0 }`. A
 * deliberate scroll back to the very top sets `lastMax` but leaves `lastTop`
 * at 0, so it is persisted as `{ top: 0 }` — treated by every restore consumer
 * as "no saved position" rather than restoring a stale deeper offset.
 */
export function shouldPersistScroll(lastTop: number, lastMax: number): boolean {
  return lastTop > 0 || lastMax > 0;
}

export function restoreScrollPosition(opts: {
  el: HTMLElement;
  saved: SavedScrollPosition;
  /** False once the user scrolls or the view key changes — stop retrying. */
  isPending: () => boolean;
  /** Called once the offset is applied and the layout has settled. */
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
      targetRef.current = null;
    }
  };

  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    targetRef.current = null;
  };
}