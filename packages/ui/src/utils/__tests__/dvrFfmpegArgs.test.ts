import { describe, expect, it } from 'vitest';
import {
  normalizeReconnectStrategy,
  validateExtraFfmpegArgs,
} from '../dvrFfmpegArgs';

describe('normalizeReconnectStrategy', () => {
  it('keeps the three known strategies', () => {
    expect(normalizeReconnectStrategy('auto')).toBe('auto');
    expect(normalizeReconnectStrategy('aggressive')).toBe('aggressive');
    expect(normalizeReconnectStrategy('off')).toBe('off');
  });

  it('is case and whitespace insensitive', () => {
    expect(normalizeReconnectStrategy('  AUTO ')).toBe('auto');
    expect(normalizeReconnectStrategy('Off')).toBe('off');
  });

  it('falls back to auto for anything unrecognised', () => {
    expect(normalizeReconnectStrategy(undefined)).toBe('auto');
    expect(normalizeReconnectStrategy(null)).toBe('auto');
    expect(normalizeReconnectStrategy('')).toBe('auto');
    expect(normalizeReconnectStrategy('garbage')).toBe('auto');
    expect(normalizeReconnectStrategy(42)).toBe('auto');
  });
});

describe('validateExtraFfmpegArgs', () => {
  it('treats empty and whitespace input as no arguments', () => {
    expect(validateExtraFfmpegArgs('')).toEqual({ ok: true, args: [] });
    expect(validateExtraFfmpegArgs('   \t ')).toEqual({ ok: true, args: [] });
  });

  it('splits arguments and keeps quoted values in one piece', () => {
    expect(validateExtraFfmpegArgs('-probesize 10M -analyzeduration 5M')).toEqual({
      ok: true,
      args: ['-probesize', '10M', '-analyzeduration', '5M'],
    });
    expect(
      validateExtraFfmpegArgs('-headers "Referer: http://example.com" -probesize 10M'),
    ).toEqual({
      ok: true,
      args: ['-headers', 'Referer: http://example.com', '-probesize', '10M'],
    });
  });

  it('allows the common output bitstream filter', () => {
    expect(validateExtraFfmpegArgs('-bsf:a aac_adtstoasc')).toEqual({
      ok: true,
      args: ['-bsf:a', 'aac_adtstoasc'],
    });
  });

  it('rejects options the recorder owns', () => {
    for (const raw of ['-i http://host/x.ts', '-y', '-n', '-stats', '-t 60', '-to 60']) {
      const result = validateExtraFfmpegArgs(raw);
      expect(result.ok, `${raw} should be rejected`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('rejected');
    }
    expect(validateExtraFfmpegArgs('-t=60').ok).toBe(false);
    expect(validateExtraFfmpegArgs('-STATS').ok).toBe(false);
  });

  it('keeps values that merely look like reserved options', () => {
    expect(validateExtraFfmpegArgs('-metadata comment=-i')).toEqual({
      ok: true,
      args: ['-metadata', 'comment=-i'],
    });
  });

  it('rejects bare paths and URLs', () => {
    for (const raw of [
      'http://host/other.ts',
      'https://host/other.ts',
      'C:\\recordings\\other.ts',
      '/tmp/other.ts',
      './other.ts',
    ]) {
      const result = validateExtraFfmpegArgs(raw);
      expect(result.ok, `${raw} should be rejected`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('pathOrUrl');
    }
  });

  it('rejects broken quoting and oversized input', () => {
    expect(validateExtraFfmpegArgs('-headers "unterminated')).toEqual({
      ok: false,
      error: { code: 'malformed' },
    });
    expect(validateExtraFfmpegArgs(`-probesize ${'9'.repeat(500)}`).ok).toBe(false);
    const many = Array.from({ length: 40 }, () => '-x 1').join(' ');
    expect(validateExtraFfmpegArgs(many).ok).toBe(false);
  });
});
