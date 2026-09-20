import { describe, expect, it } from 'vitest';
import { shouldRecheckCachedBox } from '../logoContentBox';

/**
 * The bug these cover: a content box is cached by URL and outlives the bytes it
 * was measured from — a CDN can serve different art at the same URL, and a box
 * can be recorded from a partially-painted copy of the image.
 *
 * Smart Trim zooms the logo to whatever the box claims is content *and* offsets
 * it by where the box says that content begins, so a box that covers only part
 * of the artwork draws the logo oversized, cropped and off-centre — the round
 * "abc" logo whose art touches all four canvas edges, stored as a box covering
 * ~59% of the height, drew ~1.7x the tile width and clipped it, while turning
 * Smart Trim off made it render correctly.
 *
 * Re-measuring only boxes that crop a lot was the earlier attempt at this and it
 * is not enough: the direction that hurts (a box smaller than the art) is only
 * detectable by measuring, and a box that crops 5% still shifts the logo. So
 * every cached box is verified once per session against the loaded image, which
 * costs one small canvas scan per logo actually rendered.
 */
describe('shouldRecheckCachedBox', () => {
  it('asks for a re-measure the first time a logo is seen in a session', () => {
    expect(shouldRecheckCachedBox(false)).toBe(true);
  });

  it('trusts the re-measured box for the rest of the session', () => {
    expect(shouldRecheckCachedBox(true)).toBe(false);
  });
});
