import { describe, expect, it } from 'vitest';
import { dvrProgressPercent } from '../useTimeshift';

describe('DASH DVR progress mapping', () => {
  it('maps a non-zero absolute presentation window', () => {
    expect(dvrProgressPercent({ cacheStart: 3600, cacheEnd: 46800, timePos: 25200 })).toBe(50);
  });

  it('does not move the presentation position when the window slides', () => {
    const before = dvrProgressPercent({ cacheStart: 3600, cacheEnd: 46800, timePos: 36000 });
    const after = dvrProgressPercent({ cacheStart: 3660, cacheEnd: 46860, timePos: 36000 });
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo((32340 / 43200) * 100);
  });

  it('clamps positions outside the current window', () => {
    expect(dvrProgressPercent({ cacheStart: 100, cacheEnd: 200, timePos: 50 })).toBe(0);
    expect(dvrProgressPercent({ cacheStart: 100, cacheEnd: 200, timePos: 250 })).toBe(100);
  });
});
