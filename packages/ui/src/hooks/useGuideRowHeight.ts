import { useCallback, useMemo, useRef, useState } from 'react';
import type { VirtualListItemMeasurement } from '../components/common/VirtualList';
import { resolveGuideRowHeight, type GuideRowHeightFlags } from '../utils/guideRowHeight';

/**
 * Row height for a virtualized channel-strip list (`ChannelPanel`).
 *
 * Pass the returned `onVirtualItemsChange` to the list's `VirtualList` and the
 * returned height as its `estimateItemHeight`.
 *
 * Why measure instead of just reading the token: the token only covers the
 * variants the design knows about (source line / bitrate badge). A row is
 * `max(token, content)`, and the content can outgrow the token - a logo box
 * bigger than ~44px, a taller name/badge stack - so the only height guaranteed
 * to be right is one the browser actually laid out. Rows in a strip list are
 * uniform for a given variant, so the median of the mounted rows describes the
 * whole list, and the virtualizer re-measures on resize (settings toggles,
 * logo size, design/theme switch), which feeds the new value back here.
 *
 * The token estimate still matters: it is what the very first render and any
 * not-yet-measured list uses, and until now that value was a hardcoded 52 -
 * 13px short of a Modern V2 row and 43px short of one with the source line and
 * the bitrate badge.
 */
export function useGuideRowHeight(flags: GuideRowHeightFlags): {
  rowHeight: number;
  onVirtualItemsChange: (items: VirtualListItemMeasurement[]) => void;
} {
  const playlistName = Boolean(flags.playlistName);
  const bitrateBadge = Boolean(flags.bitrateBadge);

  // Re-read the tokens only when the row variant changes (a theme or design
  // switch is picked up by the measurement instead).
  const tokenHeight = useMemo(
    () => resolveGuideRowHeight({ playlistName, bitrateBadge }),
    [playlistName, bitrateBadge]
  );

  const [measured, setMeasured] = useState<number | null>(null);
  const measuredRef = useRef<number | null>(null);

  const onVirtualItemsChange = useCallback((items: VirtualListItemMeasurement[]) => {
    const sizes: number[] = [];
    for (const item of items) {
      if (Number.isFinite(item.size) && item.size > 0) sizes.push(item.size);
    }
    if (sizes.length === 0) return; // hidden/zero-sized - keep the last real value
    sizes.sort((a, b) => a - b);
    const next = Math.round(sizes[Math.floor(sizes.length / 2)]);
    if (next === measuredRef.current) return; // avoids a render per virtualizer tick
    measuredRef.current = next;
    setMeasured(next);
  }, []);

  return { rowHeight: measured ?? tokenHeight, onVirtualItemsChange };
}
