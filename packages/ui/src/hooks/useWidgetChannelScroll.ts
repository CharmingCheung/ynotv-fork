import { useEffect, useRef, type RefObject } from 'react';

/**
 * Pure scroll-position decision for the overlay channel widgets. Extracted so
 * the branch logic is unit-testable; `useWidgetChannelScroll` feeds it DOM
 * measurements.
 *
 * Returns the scrollTop to apply, or `null` when the list should stay put.
 */
export function computeWidgetScrollTop(input: {
  /** The playing channel changed (or this is the list's first appearance). */
  channelChanged: boolean;
  /** Last user scroll position of the list (0 = scrolled all the way up). */
  savedScrollTop: number;
  /** True once the user has actually scrolled the list — a deliberate scroll
   *  to the very top is a user action, not "never scrolled". */
  hasUserScrolled: boolean;
  /** `scrollHeight - clientHeight` of the list (0 when nothing scrolls). */
  maxScroll: number;
  /** Row's offsetTop within the list. */
  rowTop: number;
  /** Row height. */
  rowHeight: number;
  /** Current scrollTop of the list. */
  viewTop: number;
  /** clientHeight of the list. */
  viewHeight: number;
  /** Channel is within the last 3 items of the list. */
  isNearBottom?: boolean;
}): number | null {
  const { channelChanged, savedScrollTop, hasUserScrolled, maxScroll, rowTop, rowHeight, viewTop, viewHeight, isNearBottom } = input;
  const clamp = (v: number) => Math.min(Math.max(v, 0), Math.max(maxScroll, 0));
  // Center the current channel vertically, like the EPG centers the now-playing
  // row (falls back to the top when the row is taller than the list viewport).
  const centerOffset = Math.max(Math.floor((viewHeight - rowHeight) / 2), 0);

  if (channelChanged) {
    if (isNearBottom) {
      return maxScroll;
    }
    // Switched channels (or first appearance) — center the playing channel.
    return clamp(rowTop - centerOffset);
  }
  if (isNearBottom) {
    // The playing channel sits in the last few rows, so the only scroll
    // position that shows it fully is the bottom. Pin there even when the
    // user had scrolled elsewhere (or EPG rows expanded after their scroll), so
    // the channel is never left cut off at the bottom edge.
    return maxScroll;
  }
  if (hasUserScrolled) {
    // Plain re-appearance — restore exactly where the user left off (including
    // an intentional scroll all the way back to the top).
    return clamp(savedScrollTop);
  }
  // Never scrolled — only move if the current channel is off-screen.
  const rowBottom = rowTop + rowHeight;
  const viewBottom = viewTop + viewHeight;
  if (rowTop < viewTop || rowBottom > viewBottom) {
    return clamp(rowTop - centerOffset);
  }
  return null;
}

/**
 * Shared scroll behavior for the overlay channel widgets (Favorites, Recent,
 * Custom Groups).
 *
 * The widget lists remount at scrollTop 0 whenever the overlay controls hide
 * (the widget renders `null` and its DOM is destroyed, though the component
 * instance — and therefore our refs — survive). This hook restores what the
 * user actually left behind:
 *
 *  - When the playing channel changed since the list was last visible, center
 *    the current channel in the list (like the EPG centers the now-playing row).
 *    If the channel is in the bottom 3 items, scroll all the way down.
 *  - When the widget simply re-appeared (same channel) and the user had
 *    scrolled the list, restore their exact scroll position.
 *  - When it re-appeared, the user never scrolled, and the current channel is
 *    off-screen, bring the channel into view so it never has to be hunted for.
 *  - When the playing channel isn't in this list at all (e.g. watching a live
 *    channel while browsing Favorites), restore the user's scroll position
 *    instead of leaving the remounted list at the top.
 *  - When program titles load asynchronously and expand row heights, re-adjust
 *    the scroll position if the user hasn't manually scrolled.
 *
 * Scroll math uses `scrollTop` + `offsetTop` on the list container directly
 * instead of `scrollIntoView`: it cannot scroll ancestor containers (the page
 * or the widget bar) and is unaffected by the widget bar's `transform: scale()`
 * (offsetTop is layout-space, matching scrollTop's coordinate system), which
 * can make `scrollIntoView` land visibly off at non-100% widget scales.
 *
 * Requires the list container to be `position: relative` so rows' `offsetTop`
 * is relative to the list itself.
 */
export function useWidgetChannelScroll(params: {
  isVisible: boolean;
  currentChannelId?: string;
  listRef: RefObject<HTMLDivElement | null>;
  /** Row count — re-runs the scroll logic when the list's data finishes loading. */
  itemCount: number;
}) {
  const { isVisible, currentChannelId, listRef, itemCount } = params;
  const savedScrollTopRef = useRef(0);
  // Distinguishes "user deliberately scrolled to the top" (savedScrollTop 0)
  // from "never scrolled", so an intentional scroll to 0 is preserved instead
  // of being treated as a fresh list that should re-center the channel.
  const hasUserScrolledRef = useRef(false);
  const prevChannelRef = useRef<string | undefined>(undefined);
  const programmaticTargetRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isVisible || !listRef.current || !currentChannelId) return;
    const list = listRef.current;
    const channelChanged = currentChannelId !== prevChannelRef.current;
    prevChannelRef.current = currentChannelId;

    const applyScroll = (target: number) => {
      if (Math.abs(list.scrollTop - target) > 1) {
        programmaticTargetRef.current = target;
        list.scrollTop = target;
      }
    };

    const adjustScroll = (isChannelChange = false) => {
      const match = findRow(list, currentChannelId);
      if (!match) {
        // The playing channel isn't in this widget's list (e.g. watching a live
        // channel while browsing Favorites, or a channel not in this custom
        // group). There is nothing to center, but if the user had scrolled the
        // list, restore their position instead of leaving the remounted list at
        // the top. Preserves user scroll position across live channel switches.
        if (itemCount > 0 && hasUserScrolledRef.current) {
          const maxScroll = Math.max(list.scrollHeight - list.clientHeight, 0);
          applyScroll(Math.min(Math.max(savedScrollTopRef.current, 0), maxScroll));
        }
        return;
      }

      // Channel IS in this list. If the channel changed, reset user scroll state
      // so the widget re-orients to the newly selected channel.
      if (isChannelChange) {
        hasUserScrolledRef.current = false;
        savedScrollTopRef.current = 0;
      }

      const { row, index } = match;
      const totalItems = itemCount > 0 ? itemCount : list.children.length;
      const isNearBottom = totalItems > 3 && index >= totalItems - 3;

      const next = computeWidgetScrollTop({
        channelChanged: isChannelChange,
        savedScrollTop: savedScrollTopRef.current,
        hasUserScrolled: hasUserScrolledRef.current,
        maxScroll: Math.max(list.scrollHeight - list.clientHeight, 0),
        rowTop: row.offsetTop,
        rowHeight: row.offsetHeight,
        viewTop: list.scrollTop,
        viewHeight: list.clientHeight,
        isNearBottom,
      });

      if (next !== null) {
        applyScroll(next);
      }
    };

    // Initial positioning
    adjustScroll(channelChanged);

    // Re-adjust scroll when program subtitles load asynchronously and expand row heights,
    // coalesced via requestAnimationFrame to prevent reflow thrashing on burst loads.
    // While the user is actively browsing the list we leave them alone — except
    // when the playing channel is in the last few rows, where any row expansion
    // can clip it and the only fully-visible position is the bottom (re-pin so
    // it never ends up cut off at the edge).
    let rafId: number | null = null;
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (hasUserScrolledRef.current && !channelIsNearBottom(list, currentChannelId, itemCount)) return;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (hasUserScrolledRef.current && !channelIsNearBottom(list, currentChannelId, itemCount)) return;
          adjustScroll(false);
        });
      });
      observer.observe(list, { childList: true, subtree: true });
    }

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (observer) {
        observer.disconnect();
      }
    };
  }, [isVisible, currentChannelId, itemCount, listRef]);

  /** Track the user's scroll position so it can be restored after hide/show. */
  const onListScroll = () => {
    if (listRef.current) {
      if (programmaticTargetRef.current !== null) {
        if (Math.abs(listRef.current.scrollTop - programmaticTargetRef.current) <= 1) {
          programmaticTargetRef.current = null;
          return;
        }
        programmaticTargetRef.current = null;
      }
      savedScrollTopRef.current = listRef.current.scrollTop;
      hasUserScrolledRef.current = true;
    }
  };

  return { onListScroll };
}

export function findRow(
  list: { children: HTMLCollection | HTMLElement[] | ArrayLike<Element> },
  streamId: string
): { row: HTMLElement; index: number } | null {
  for (let i = 0; i < list.children.length; i++) {
    const child = list.children[i];
    const isElement = typeof HTMLElement !== 'undefined' ? child instanceof HTMLElement : Boolean(child && (child as any).dataset);
    if (isElement && (child as any).dataset?.streamId === streamId) {
      return { row: child as HTMLElement, index: i };
    }
  }
  return null;
}

/** True when the channel's row sits within the last 3 rows of the list. */
function channelIsNearBottom(
  list: { children: HTMLCollection | HTMLElement[] | ArrayLike<Element> },
  streamId: string,
  itemCount: number
): boolean {
  const match = findRow(list, streamId);
  if (!match) return false;
  const totalItems = itemCount > 0 ? itemCount : list.children.length;
  return totalItems > 3 && match.index >= totalItems - 3;
}