import { describe, it, expect } from 'vitest';
import {
  effectiveMatchName,
  aliasUnusedForMatching,
  buildAliasMatchNames,
} from '../epgMatchName';

describe('effective EPG match name', () => {
  it('uses the provider name when the channel has not opted in', () => {
    const channel = { name: '|DE| ZDF HD', alias: 'ZDF' };
    expect(effectiveMatchName(channel, false)).toBe('|DE| ZDF HD');
  });

  it('replaces the provider name with the alias when opted in', () => {
    const channel = { name: '|DE| ZDF HD', alias: 'ZDF' };
    expect(effectiveMatchName(channel, true)).toBe('ZDF');
  });

  it('falls back to the provider name when the alias is missing or blank', () => {
    expect(effectiveMatchName({ name: 'ARD-ALPHA HD', alias: null }, true)).toBe('ARD-ALPHA HD');
    expect(effectiveMatchName({ name: 'ARD-ALPHA HD', alias: '   ' }, true)).toBe('ARD-ALPHA HD');
    expect(effectiveMatchName({ name: 'ARD-ALPHA HD' }, true)).toBe('ARD-ALPHA HD');
  });

  it('never returns a padded name', () => {
    expect(effectiveMatchName({ name: '  ZDF  ', alias: '  ZDF HD  ' }, true)).toBe('ZDF HD');
    expect(effectiveMatchName({ name: null, alias: null }, true)).toBe('');
  });

  it('maps only flagged channels that have a usable alias', () => {
    const names = buildAliasMatchNames([
      { stream_id: 's1', alias: 'ZDF' },
      // Blank / missing alias: the provider name must stay in play, so no entry.
      { stream_id: 's2', alias: '   ' },
      { stream_id: 's3', alias: null },
      { stream_id: 's4' },
      // A row with no stream id can't be keyed.
      { stream_id: '', alias: 'Ghost' },
    ]);
    expect([...names.entries()]).toEqual([['s1', 'ZDF']]);
  });

  it('trims aliases and keeps the last value per stream', () => {
    const names = buildAliasMatchNames([
      { stream_id: 's1', alias: '  ZDF HD  ' },
      { stream_id: 's1', alias: 'ZDF' },
    ]);
    expect(names.get('s1')).toBe('ZDF');
  });

  it('tolerates a missing rows array (old database)', () => {
    expect(buildAliasMatchNames(undefined as any).size).toBe(0);
  });

  it('reports an unused rename only when it would actually change matching', () => {
    // Renamed, opted out -> the rename is not used yet.
    expect(aliasUnusedForMatching({ name: '|DE| ZDF HD', alias: 'ZDF' }, false)).toBe(true);
    // Opted in -> it is used.
    expect(aliasUnusedForMatching({ name: '|DE| ZDF HD', alias: 'ZDF' }, true)).toBe(false);
    // No rename, or a rename identical to the provider name -> nothing to offer.
    expect(aliasUnusedForMatching({ name: 'ZDF', alias: null }, false)).toBe(false);
    expect(aliasUnusedForMatching({ name: 'ZDF', alias: 'ZDF' }, false)).toBe(false);
    expect(aliasUnusedForMatching({ name: 'ZDF', alias: '  ' }, false)).toBe(false);
  });
});
