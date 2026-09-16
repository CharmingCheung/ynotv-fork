/**
 * Height of one channel-strip row (`ChannelRow`) in CSS pixels.
 *
 * The channel strip's virtualizer has to know how tall a row is *before* the
 * row exists: `scrollToIndex` (used when returning to Live TV, and to follow
 * the playing channel) places a channel that has never been on screen from the
 * estimate alone. When the estimate is too small, the jump lands short by
 * (real - estimate) x rows and only settles once the mounted rows have been
 * measured - the strip visibly re-settles instead of arriving.
 *
 * Rows are not a fixed 52px. Every variant is laid out from a min-height token
 * declared by the active design (`ChannelPanel.css` for the Classic design,
 * `ModernV2.css` for Modern V2/V3):
 *
 *                        base  bitrate  source line  both
 *   Classic / Light       56     70         76        88
 *   Modern V2 / V3        64     76         84        94
 *
 * A row also carries a 1px bottom border and nothing in the app resets
 * `box-sizing`, so the laid-out height is that token plus the border. A row's
 * *content* can exceed the token too (a logo box taller than ~44px, a taller
 * name/badge stack), which is why the strip measures a real row and only uses
 * this resolver until it has one - see `useGuideRowHeight`.
 */

export interface GuideRowHeightFlags {
  /** Row renders the source/playlist line (Show Source in Live TV). */
  playlistName?: boolean;
  /** Row renders the bitrate or audio-bitrate metadata badge. */
  bitrateBadge?: boolean;
}

export type GuideRowVariant = 'base' | 'bitrate' | 'playlist' | 'playlistBitrate';

export function guideRowVariant({
  playlistName,
  bitrateBadge,
}: GuideRowHeightFlags): GuideRowVariant {
  if (playlistName && bitrateBadge) return 'playlistBitrate';
  if (playlistName) return 'playlist';
  if (bitrateBadge) return 'bitrate';
  return 'base';
}

/** Token each variant's min-height is read from. */
const TOKEN_BY_VARIANT: Record<GuideRowVariant, string> = {
  base: '--guide-row-min-height',
  bitrate: '--guide-row-bitrate-min-height',
  playlist: '--guide-row-playlist-min-height',
  playlistBitrate: '--guide-row-playlist-bitrate-min-height',
};

/** Values `ChannelPanel.css` declares when the design sets no token (Classic). */
export const GUIDE_ROW_HEIGHT_FALLBACKS: Record<GuideRowVariant, number> = {
  base: 56,
  bitrate: 70,
  playlist: 76,
  playlistBitrate: 88,
};

/** `.guide-channel-row` border-bottom width - 1px in every design and theme. */
export const GUIDE_ROW_BORDER_PX = 1;

/**
 * Parse a CSS length ("64px", "4rem", " 64px ") into pixels. Returns null for
 * anything else (an empty token, `auto`, a `calc()` we can't evaluate), so the
 * caller can fall back instead of estimating with NaN.
 */
export function parseCssPx(raw: string | null | undefined, remPx = 16): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^\s*(-?\d*\.?\d+)\s*(px|rem)?\s*$/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return match[2] === 'rem' ? value * remPx : value;
}

export type ReadCssVar = (name: string) => string;

/** Reader over the document's resolved custom properties (design tokens). */
export function readDocumentCssVar(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

/**
 * Estimated height of a strip row for the given variant, read from the live
 * tokens. The tokens live on `html` (`modern-ui` / `modern-ui-v3` classes), so
 * a design switch is reflected without a reload.
 */
export function resolveGuideRowHeight(
  flags: GuideRowHeightFlags,
  read: ReadCssVar = readDocumentCssVar
): number {
  const variant = guideRowVariant(flags);
  const token = parseCssPx(read(TOKEN_BY_VARIANT[variant]));
  return (token ?? GUIDE_ROW_HEIGHT_FALLBACKS[variant]) + GUIDE_ROW_BORDER_PX;
}
