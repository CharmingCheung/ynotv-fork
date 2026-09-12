import { describe, it, expect } from 'vitest';
import {
  computeTotalSeconds,
  describePadding,
  START_PRESETS,
  END_PRESETS,
} from '../DvrScheduleOptionsModal';

describe('DvrScheduleOptionsModal padding calculations', () => {
  describe('computeTotalSeconds', () => {
    it('calculates total seconds from minutes and seconds correctly', () => {
      expect(computeTotalSeconds(1, 30)).toBe(90);
      expect(computeTotalSeconds(0, 45)).toBe(45);
      expect(computeTotalSeconds(2, 0)).toBe(120);
      expect(computeTotalSeconds(40, 0)).toBe(2400);
    });

    it('handles string input values from input fields gracefully', () => {
      expect(computeTotalSeconds('2', '15')).toBe(135);
      expect(computeTotalSeconds('0', '60')).toBe(60);
      expect(computeTotalSeconds('', '')).toBe(0);
      expect(computeTotalSeconds('', '30')).toBe(30);
      expect(computeTotalSeconds('5', '')).toBe(300);
    });

    it('allows entering any number of seconds without restriction', () => {
      // User requested allowing any # of minutes + seconds
      expect(computeTotalSeconds(0, 90)).toBe(90);
      expect(computeTotalSeconds(1, 120)).toBe(180);
    });

    it('clamps negative values to 0', () => {
      expect(computeTotalSeconds(-5, -10)).toBe(0);
    });
  });

  describe('describePadding', () => {
    it('reports on-time when both fields are zero or blank', () => {
      expect(describePadding(0, 0, true)).toEqual({ kind: 'on-time', totalSec: 0 });
      expect(describePadding(0, 0, false)).toEqual({ kind: 'on-time', totalSec: 0 });
      expect(describePadding('', '', true)).toEqual({ kind: 'on-time', totalSec: 0 });
    });

    it('flags start padding as starting early', () => {
      expect(describePadding(1, 0, true)).toEqual({
        kind: 'starts-early',
        totalSec: 60,
        minutes: 1,
        seconds: 0,
      });
      expect(describePadding(0, 30, true)).toEqual({
        kind: 'starts-early',
        totalSec: 30,
        minutes: 0,
        seconds: 30,
      });
      expect(describePadding(2, 15, true)).toEqual({
        kind: 'starts-early',
        totalSec: 135,
        minutes: 2,
        seconds: 15,
      });
    });

    it('flags end padding as ending late', () => {
      expect(describePadding(2, 0, false)).toEqual({
        kind: 'ends-late',
        totalSec: 120,
        minutes: 2,
        seconds: 0,
      });
      expect(describePadding(5, 0, false)).toEqual({
        kind: 'ends-late',
        totalSec: 300,
        minutes: 5,
        seconds: 0,
      });
      expect(describePadding(40, 0, false)).toEqual({
        kind: 'ends-late',
        totalSec: 2400,
        minutes: 40,
        seconds: 0,
      });
      expect(describePadding(15, 30, false)).toEqual({
        kind: 'ends-late',
        totalSec: 930,
        minutes: 15,
        seconds: 30,
      });
    });

    it('normalises seconds beyond 59 into the minute part', () => {
      // Seconds are intentionally unrestricted, so the badge must still read
      // sensibly (e.g. "0 min : 90 sec" -> "-1m 30s early").
      expect(describePadding(0, 90, true)).toEqual({
        kind: 'starts-early',
        totalSec: 90,
        minutes: 1,
        seconds: 30,
      });
      expect(describePadding(1, 120, false)).toEqual({
        kind: 'ends-late',
        totalSec: 180,
        minutes: 3,
        seconds: 0,
      });
    });

    it('never reports both duration parts as zero for non-zero padding', () => {
      for (const total of [1, 59, 60, 61, 3599, 3661]) {
        const parts = describePadding(Math.floor(total / 60), total % 60, true);
        if (parts.kind === 'on-time') throw new Error(`expected non-zero result for ${total}s`);
        expect(parts.minutes + parts.seconds).toBeGreaterThan(0);
      }
    });

    it('clamps negative input to on-time', () => {
      expect(describePadding(-5, -10, true)).toEqual({ kind: 'on-time', totalSec: 0 });
    });

    it('accepts string values straight from the inputs', () => {
      expect(describePadding('2', '15', true)).toEqual({
        kind: 'starts-early',
        totalSec: 135,
        minutes: 2,
        seconds: 15,
      });
      expect(describePadding('', '30', false)).toEqual({
        kind: 'ends-late',
        totalSec: 30,
        minutes: 0,
        seconds: 30,
      });
    });
  });

  describe('presets', () => {
    it('provides start padding presets with expected intervals', () => {
      expect(START_PRESETS.map((p) => p.label)).toEqual(['0s', '30s', '1m', '2m', '5m']);
      expect(START_PRESETS.find((p) => p.label === '30s')).toEqual({ label: '30s', min: 0, sec: 30 });
      expect(START_PRESETS.find((p) => p.label === '1m')).toEqual({ label: '1m', min: 1, sec: 0 });
    });

    it('provides end padding presets with expected intervals including 40m', () => {
      expect(END_PRESETS.map((p) => p.label)).toEqual(['0s', '2m', '5m', '15m', '30m', '40m']);
      expect(END_PRESETS.find((p) => p.label === '40m')).toEqual({ label: '40m', min: 40, sec: 0 });
    });

    it('uses second values consistent with the preset labels', () => {
      for (const p of [...START_PRESETS, ...END_PRESETS]) {
        expect(computeTotalSeconds(p.min, p.sec)).toBe(p.min * 60 + p.sec);
      }
    });
  });
});
