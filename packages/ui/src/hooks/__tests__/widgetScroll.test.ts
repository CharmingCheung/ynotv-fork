import { describe, expect, it } from 'vitest';
import { computeWidgetScrollTop, findRow } from '../useWidgetChannelScroll';

// List is 190px tall, rows ~32px; the current channel is centered vertically,
// so the centering offset is (190 - 32) / 2 = 79px.
const BASE = {
  savedScrollTop: 0,
  hasUserScrolled: false,
  maxScroll: 400,
  rowTop: 0,
  rowHeight: 32,
  viewTop: 0,
  viewHeight: 190,
};

describe('computeWidgetScrollTop', () => {
  it('centers the current channel when the channel changed', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: true, rowTop: 256 });
    // 256 - 79 centering offset = 177
    expect(result).toBe(177);
  });

  it('clamps to the top when the channel is near the start', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: true, rowTop: 40 });
    expect(result).toBe(0);
  });

  it('clamps to the bottom when the list cannot scroll that far', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: true, rowTop: 500, maxScroll: 300 });
    expect(result).toBe(300);
  });

  it('centers when the row is taller than the viewport (offset floors at 0)', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: true, rowTop: 500, rowHeight: 240, viewHeight: 190 });
    expect(result).toBe(400);
  });

  it('restores the user scroll position on plain re-appearance', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: false, hasUserScrolled: true, savedScrollTop: 220, rowTop: 256 });
    expect(result).toBe(220);
  });

  it('clamps the restored position to the new max scroll', () => {
    const result = computeWidgetScrollTop({
      ...BASE,
      channelChanged: false,
      hasUserScrolled: true,
      savedScrollTop: 900,
      maxScroll: 300,
      rowTop: 256,
    });
    expect(result).toBe(300);
  });

  it('keeps the top when the user deliberately scrolled back to the top', () => {
    // Scrolling all the way up is a deliberate action — do not re-center an
    // off-screen channel just because savedScrollTop is 0.
    const result = computeWidgetScrollTop({
      ...BASE,
      channelChanged: false,
      hasUserScrolled: true,
      savedScrollTop: 0,
      rowTop: 256,
      viewTop: 0,
    });
    expect(result).toBe(0);
  });

  it('leaves the list untouched when the current channel is fully visible and no scroll happened', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: false, rowTop: 48, viewTop: 0 });
    expect(result).toBeNull();
  });

  it('centers an off-screen channel when the user never scrolled', () => {
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: false, rowTop: 256, viewTop: 0 });
    expect(result).toBe(177);
  });

  it('centers a partially clipped channel', () => {
    // Channel straddles the bottom edge (rowTop 170 + 32 = 202 > 190)
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: false, rowTop: 170, viewTop: 0 });
    expect(result).toBe(91);
  });

  it('does not move when the current channel is fully visible after a restore', () => {
    // Saved position already shows the channel; nothing should change.
    const result = computeWidgetScrollTop({ ...BASE, channelChanged: false, hasUserScrolled: true, savedScrollTop: 192, rowTop: 256, viewTop: 192 });
    expect(result).toBe(192);
  });

  it('scrolls all the way down to maxScroll when channel is within the last 3 items on channel change', () => {
    const result = computeWidgetScrollTop({
      ...BASE,
      channelChanged: true,
      rowTop: 350,
      maxScroll: 250,
      isNearBottom: true,
    });
    expect(result).toBe(250);
  });

  it('scrolls all the way down to maxScroll when channel is within the last 3 items and user never scrolled', () => {
    const result = computeWidgetScrollTop({
      ...BASE,
      channelChanged: false,
      hasUserScrolled: false,
      rowTop: 350,
      maxScroll: 250,
      isNearBottom: true,
    });
    expect(result).toBe(250);
  });

  it('pins a near-bottom channel to the bottom even if the user had scrolled elsewhere', () => {
    // A stale/earlier user scroll must not leave the playing channel cut off
    // at the bottom edge — the only fully-visible position is maxScroll.
    const result = computeWidgetScrollTop({
      ...BASE,
      channelChanged: false,
      hasUserScrolled: true,
      savedScrollTop: 100,
      rowTop: 350,
      maxScroll: 250,
      isNearBottom: true,
    });
    expect(result).toBe(250);
  });

  it('pins a near-bottom channel to the bottom on re-appearance after a previous scroll', () => {
    const result = computeWidgetScrollTop({
      ...BASE,
      channelChanged: false,
      hasUserScrolled: true,
      savedScrollTop: 0,
      rowTop: 350,
      maxScroll: 250,
      isNearBottom: true,
    });
    expect(result).toBe(250);
  });
});

describe('findRow', () => {
  it('returns matching element and its index when found', () => {
    const el1 = { dataset: { streamId: 'stream-1' } } as unknown as HTMLElement;
    const el2 = { dataset: { streamId: 'stream-2' } } as unknown as HTMLElement;
    const el3 = { dataset: { streamId: 'stream-3' } } as unknown as HTMLElement;

    const list = { children: [el1, el2, el3] };
    const match = findRow(list as any, 'stream-2');
    expect(match).not.toBeNull();
    expect(match?.index).toBe(1);
    expect(match?.row).toBe(el2);
  });

  it('returns null when streamId is not in the list', () => {
    const el1 = { dataset: { streamId: 'stream-1' } } as unknown as HTMLElement;
    const list = { children: [el1] };
    const match = findRow(list as any, 'stream-999');
    expect(match).toBeNull();
  });
});