/**
 * Logo tile padding resolution.
 * ----------------------------
 * Three levels decide whether a channel logo tile is inset or full-bleed:
 *
 *  1. the per-channel override (`epg_channel_overrides.logo_padding`),
 *  2. the global Tile Layout setting (`channelLogoPadding`),
 *  3. the base tile (no padding).
 *
 * The override has three meaningful values, and the distinction matters:
 *
 *  - `'default'` — the user picked "Normal" in the EPG editor: an explicit
 *    request for standard tile padding, so it wins over a Full-Bleed setting.
 *  - `'none'`    — the user picked "No Pad": an explicit request for a
 *    full-bleed tile, so it wins over a Padded setting.
 *  - `undefined`/"absent" — no choice was ever made for this channel, so the
 *    global Tile Layout setting decides. This is the case the Settings toggle
 *    exists for, and the one that regressed when the component's `padding`
 *    prop defaulted to `'default'`: an absent value was indistinguishable from
 *    an explicit "Normal", which silently made the toggle a no-op.
 *
 * `'padded'` is accepted as an explicit alias of `'default'` so callers can
 * state the intent without borrowing the "unset" spelling.
 */
export type LogoPadding = 'default' | 'padded' | 'none' | undefined;
export type GlobalLogoPadding = 'none' | 'padded' | undefined;
/**
 * What a single channel's row can say: an explicit Normal/No Pad, or no choice at
 * all. Editors load and store this shape (`'padded'` never survives a round trip —
 * see `storedLogoPaddingOverride`), while the renderer accepts the wider
 * `LogoPadding` so a caller can state "Normal" without borrowing the "unset"
 * spelling.
 */
export type LogoPaddingOverride = 'default' | 'none' | undefined;

/**
 * The override a stored `logo_padding` value represents, or `undefined` when the
 * row carries no choice at all.
 *
 * The two spellings of an explicit "Normal" both load as `'default'`, and anything
 * else — a blank, a value an older build wrote, a column that was never set — means
 * the channel has no padding of its own, so its tile follows the global Tile Layout
 * setting. Editors use this rather than a bare cast: a cast would let `'padded'`
 * through as a third, unrecognised state and leave *both* of their buttons
 * inactive, reading as a choice the user cannot see or clear.
 */
export function storedLogoPaddingOverride(value: unknown): LogoPaddingOverride {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') return 'none';
  if (normalized === 'default' || normalized === 'padded') return 'default';
  return undefined;
}

/** Whether the tile should render inset (`logo-padded`) rather than full-bleed. */
export function resolveLogoPadded(
  override: LogoPadding,
  globalSetting: GlobalLogoPadding
): boolean {
  if (override === 'default' || override === 'padded') return true;
  if (override === 'none') return false;
  return (globalSetting ?? 'none') === 'padded';
}
