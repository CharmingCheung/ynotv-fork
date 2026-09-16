import { describe, it, expect } from 'vitest';
import {
  GUIDE_ROW_BORDER_PX,
  GUIDE_ROW_HEIGHT_FALLBACKS,
  guideRowVariant,
  parseCssPx,
  resolveGuideRowHeight,
  type ReadCssVar,
} from '../guideRowHeight';

/** Reader that answers from a token table, like getComputedStyle on `html`. */
const readerFrom = (tokens: Record<string, string>): ReadCssVar => (name) => tokens[name] ?? '';

describe('guideRowVariant', () => {
  it('maps the strip row variants', () => {
    expect(guideRowVariant({})).toBe('base');
    expect(guideRowVariant({ playlistName: true })).toBe('playlist');
    expect(guideRowVariant({ bitrateBadge: true })).toBe('bitrate');
    expect(guideRowVariant({ playlistName: true, bitrateBadge: true })).toBe('playlistBitrate');
  });
});

describe('parseCssPx', () => {
  it('parses px and rem lengths', () => {
    expect(parseCssPx('64px')).toBe(64);
    expect(parseCssPx(' 64px ')).toBe(64);
    expect(parseCssPx('4rem')).toBe(64);
    expect(parseCssPx('3.5rem')).toBe(56);
  });

  it('returns null instead of NaN for anything it cannot evaluate', () => {
    expect(parseCssPx('')).toBeNull();
    expect(parseCssPx('   ')).toBeNull();
    expect(parseCssPx('auto')).toBeNull();
    expect(parseCssPx('calc(64px + 1px)')).toBeNull();
    expect(parseCssPx(undefined)).toBeNull();
  });
});

describe('resolveGuideRowHeight', () => {
  const modernV2 = readerFrom({
    '--guide-row-min-height': '64px',
    '--guide-row-bitrate-min-height': '76px',
    '--guide-row-playlist-min-height': '84px',
    '--guide-row-playlist-bitrate-min-height': '94px',
  });

  it('matches the Modern V2/V3 tokens plus the row border', () => {
    expect(resolveGuideRowHeight({}, modernV2)).toBe(65);
    expect(resolveGuideRowHeight({ bitrateBadge: true }, modernV2)).toBe(77);
    expect(resolveGuideRowHeight({ playlistName: true }, modernV2)).toBe(85);
    expect(resolveGuideRowHeight({ playlistName: true, bitrateBadge: true }, modernV2)).toBe(95);
  });

  it('falls back to the Classic design values when a design sets no tokens', () => {
    const classic = readerFrom({});
    expect(resolveGuideRowHeight({}, classic)).toBe(
      GUIDE_ROW_HEIGHT_FALLBACKS.base + GUIDE_ROW_BORDER_PX
    );
    expect(resolveGuideRowHeight({ bitrateBadge: true }, classic)).toBe(71);
    expect(resolveGuideRowHeight({ playlistName: true }, classic)).toBe(77);
    expect(resolveGuideRowHeight({ playlistName: true, bitrateBadge: true }, classic)).toBe(89);
  });

  it('uses the fallback for a token it cannot parse, never NaN', () => {
    const broken = readerFrom({ '--guide-row-min-height': 'auto' });
    expect(resolveGuideRowHeight({}, broken)).toBe(
      GUIDE_ROW_HEIGHT_FALLBACKS.base + GUIDE_ROW_BORDER_PX
    );
  });

  it('tracks a theme that uses its own row height', () => {
    const tall = readerFrom({ '--guide-row-min-height': '90px' });
    expect(resolveGuideRowHeight({}, tall)).toBe(91);
  });
});
