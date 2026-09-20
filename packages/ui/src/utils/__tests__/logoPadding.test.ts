import { describe, expect, it } from 'vitest';
import { resolveLogoPadded, storedLogoPaddingOverride } from '../logoPadding';

/**
 * The regression these cover: the tile-padding prop used to default to
 * `'default'`, so a channel with no stored override was indistinguishable from
 * one where the user explicitly picked "Normal" — and the global Tile Layout
 * setting (Settings → Logos) was never consulted, making its Full-Bleed option
 * a no-op for every channel in the app.
 */
describe('resolveLogoPadded', () => {
  it('treats an absent override as "follow the global Tile Layout setting"', () => {
    expect(resolveLogoPadded(undefined, 'padded')).toBe(true);
    expect(resolveLogoPadded(undefined, 'none')).toBe(false);
  });

  it('falls back to the base (unpadded) tile when there is no global setting', () => {
    expect(resolveLogoPadded(undefined, undefined)).toBe(false);
  });

  it('lets an explicit "Normal" beat a Full-Bleed global setting', () => {
    expect(resolveLogoPadded('default', 'none')).toBe(true);
    expect(resolveLogoPadded('padded', 'none')).toBe(true);
  });

  it('lets an explicit "No Pad" beat a Padded global setting', () => {
    expect(resolveLogoPadded('none', 'padded')).toBe(false);
  });

  it('agrees with the global setting when the override matches it', () => {
    expect(resolveLogoPadded('default', 'padded')).toBe(true);
    expect(resolveLogoPadded('none', 'none')).toBe(false);
  });
});

/**
 * Reading a stored override back is what tells an editor whether the user has
 * chosen anything for the channel. Getting it wrong is not cosmetic: an editor that
 * reads *no choice* as an explicit "Normal" writes that padding on every save (and
 * so overrides the global Full-Bleed setting for the channel), and one that fails to
 * recognise a stored choice leaves the control with nothing selected.
 */
describe('storedLogoPaddingOverride', () => {
  it('reads both spellings of an explicit Normal as Normal', () => {
    expect(storedLogoPaddingOverride('default')).toBe('default');
    expect(storedLogoPaddingOverride('padded')).toBe('default');
    expect(storedLogoPaddingOverride('PADDED')).toBe('default');
    expect(storedLogoPaddingOverride('  Default  ')).toBe('default');
  });

  it('reads an explicit No Pad as No Pad', () => {
    expect(storedLogoPaddingOverride('none')).toBe('none');
    expect(storedLogoPaddingOverride('None')).toBe('none');
  });

  it('treats an empty or missing value as no choice, so the global setting applies', () => {
    expect(storedLogoPaddingOverride(null)).toBeUndefined();
    expect(storedLogoPaddingOverride(undefined)).toBeUndefined();
    expect(storedLogoPaddingOverride('')).toBeUndefined();
    expect(storedLogoPaddingOverride('   ')).toBeUndefined();
  });

  it('treats an unrecognised value as no choice rather than a third state', () => {
    expect(storedLogoPaddingOverride('inset')).toBeUndefined();
    expect(storedLogoPaddingOverride(2)).toBeUndefined();
  });
});
