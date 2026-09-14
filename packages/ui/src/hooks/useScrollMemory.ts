/**
 * Remembers and restores a virtualized gallery's scroll offset, per list.
 *
 * Two things make this different from saving in an effect cleanup:
 *
 *  - The offset is recorded on every scroll event (a Map write, so it needs no
 *    throttling) instead of at unmount, so no teardown path can lose it.
 *  - A scroll event only cancels a pending restore when it deviates from an
 *    offset this hook actually applied. Previously any stray event arriving
 *    before the restore had applied anything cancelled it, which is how
 *    re-entering a list could leave it stuck at the top.
 *
 * Consumer contract: give it a stable `listKey` per list, flip `ready` once the
 * list has content, and wire `onScroll` into the scroll container.
 */
import { useCallback, useEffect, useRef, type RefObject, type UIEvent } from 'react';
import {
  isUserScrollDuringRestore,
  recallScrollPosition,
  rememberScrollPosition,
  readScrollPosition,
  restoreScrollPosition,
} from './scrollRestore';

/**
 * How long to wait for a list's scroll container to mount. Generous on purpose:
 * a list whose lazy-load overlay is still up has items but no container, and
 * giving up early there would leave it restored to the top.
 */
const CONTAINER_WAIT_FRAMES = 600;

export interface UseScrollMemoryOptions {
  /** Stable identity of the list, e.g. `vod:movies:cat:63`. */
  listKey: string;
  scrollRef: RefObject<HTMLElement | null>;
  /** True once the list has rendered content to scroll to. */
  ready: boolean;
  /** Called when entering a list that has no remembered position (reset to top). */
  onNoSavedPosition?: () => void;
}

export interface ScrollMemoryHandle {
  /** Wire into the scroll container's onScroll. */
  onScroll: (event: UIEvent<HTMLElement>) => void;
}

export function useScrollMemory({
  listKey,
  scrollRef,
  ready,
  onNoSavedPosition,
}: UseScrollMemoryOptions): ScrollMemoryHandle {
  const pendingKeyRef = useRef<string | null>(listKey);
  // Set while a programmatic restore is applying scrollTop, so onScroll can
  // tell it apart from a real user scroll.
  const restoreTargetRef = useRef<number | null>(null);

  // Latest-ref: consumers pass this callback inline, and the restore effect
  // must not re-run just because its identity changed.
  const onNoSavedPositionRef = useRef(onNoSavedPosition);
  useEffect(() => {
    onNoSavedPositionRef.current = onNoSavedPosition;
  }, [onNoSavedPosition]);

  // Entering a list arms its restore; leaving discards any in-flight target.
  useEffect(() => {
    pendingKeyRef.current = listKey;
    restoreTargetRef.current = null;
  }, [listKey]);

  useEffect(() => {
    if (!ready) return;
    if (pendingKeyRef.current !== listKey) return;

    const saved = recallScrollPosition(listKey);
    let cancelRestore: (() => void) | null = null;
    let raf = 0;
    let waitedFrames = 0;
    let cancelled = false;

    const start = () => {
      if (cancelled) return;
      const el = scrollRef.current;
      if (!el) {
        // The list has items but its scroll container isn't on screen yet (a
        // loading/empty branch is still rendered). Wait for it to mount rather
        // than giving up and leaving the list at the top.
        if (waitedFrames < CONTAINER_WAIT_FRAMES) {
          waitedFrames += 1;
          raf = requestAnimationFrame(start);
        } else {
          // Give up on this entry so the list doesn't stay "mid-restore"
          // forever (which would stop it recording the user's position).
          pendingKeyRef.current = null;
        }
        return;
      }

      if (!saved || saved.top <= 0) {
        // Nothing remembered for this list (or the user left it at the very
        // top): start at the top rather than inheriting the previous list's
        // offset.
        pendingKeyRef.current = null;
        onNoSavedPositionRef.current?.();
        return;
      }

      cancelRestore = restoreScrollPosition({
        el,
        saved,
        isPending: () => pendingKeyRef.current === listKey,
        onSettled: () => {
          pendingKeyRef.current = null;
        },
        targetRef: restoreTargetRef,
      });
    };

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cancelRestore?.();
    };
  }, [listKey, ready, scrollRef]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const el = event.currentTarget;
      const target = restoreTargetRef.current;

      if (isUserScrollDuringRestore(target, el.scrollTop)) {
        pendingKeyRef.current = null;
      }

      // Mid-restore, the container can be holding a leftover offset from the
      // previous list, a clamped one, or one of our own applies — none of which
      // is a position worth remembering, and recording the first two would
      // overwrite the real one. A genuine user scroll has already cleared the
      // pending flag above, so their position still gets recorded.
      if (pendingKeyRef.current === listKey) return;

      rememberScrollPosition(listKey, readScrollPosition(el));
    },
    [listKey]
  );

  return { onScroll };
}
