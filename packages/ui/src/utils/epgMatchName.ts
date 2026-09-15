/**
 * Which name EPG matching uses for a channel.
 *
 * A provider's channel names ("|DE| ZDF HD", "ARD-ALPHA HD") routinely fail to
 * match a feed's clean display names, and there is no way to fix that on an
 * Xtream or Stalker source — the names come from the portal. Renaming the
 * channel in the app fixes it *only if* matching is told to use that name.
 *
 * `match_by_alias` (per channel, off by default) does exactly that: the user's
 * rename replaces the provider name as the matching key. Replacement, not a
 * fallback — the provider name is then not registered at all, so a feed channel
 * that happens to match the raw name can no longer fill the channel either. That
 * is what makes it able to correct a *wrong* match, not just fill an empty one.
 *
 * A channel with the flag set but no alias keeps using the provider name: it is
 * never a match on the empty string.
 */

export interface MatchNameChannel {
  name?: string | null;
  alias?: string | null;
}

/**
 * The name to match on. `flagged` comes from the channel's
 * `epg_channel_overrides.match_by_alias`.
 */
export function effectiveMatchName(
  channel: MatchNameChannel,
  flagged: boolean
): string {
  const providerName = (channel.name ?? '').trim();
  if (!flagged) return providerName;
  const alias = (channel.alias ?? '').trim();
  return alias || providerName;
}

/**
 * Reduce `epg_channel_overrides.match_by_alias ⋈ channels.alias` rows to the
 * stream_id → name map the sync uses.
 *
 * A row with no usable alias is dropped rather than mapped to an empty string:
 * a flagged channel with no rename must keep its provider name, and an empty
 * key would make it match nothing (or, worse, match everything unnamed).
 */
export function buildAliasMatchNames(
  rows: Array<{ stream_id: string; alias?: string | null }>
): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows || []) {
    const alias = (row?.alias ?? '').trim();
    if (!row?.stream_id || !alias) continue;
    names.set(row.stream_id, alias);
  }
  return names;
}

/**
 * Whether an alias exists that matching is *not* using — i.e. the channel has
 * been renamed but the rename has no effect on EPG matching yet. Used to offer
 * the one-click "use this name for EPG matching" in the editor.
 */
export function aliasUnusedForMatching(
  channel: MatchNameChannel,
  flagged: boolean
): boolean {
  const alias = (channel.alias ?? '').trim();
  return Boolean(alias) && !flagged && alias !== (channel.name ?? '').trim();
}
