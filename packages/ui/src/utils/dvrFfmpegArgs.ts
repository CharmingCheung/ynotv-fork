/**
 * Validation for the user-supplied FFmpeg arguments in DVR settings.
 *
 * Mirrors the rules in packages/app/src-tauri/src/dvr/ffmpeg_args.rs so the
 * settings UI can reject a value before it is saved. The recorder validates
 * again and ignores anything invalid, so both lists must stay in step.
 */

/** Options the recorder sets itself; a user value must not override them. */
export const RESERVED_FFMPEG_OPTIONS = [
  '-stats',
  '-progress',
  '-i',
  '-y',
  '-n',
  '-t',
  '-to',
];

export const MAX_EXTRA_ARGS_LEN = 500;
export const MAX_EXTRA_ARGS_TOKENS = 64;

export type ReconnectStrategy = 'auto' | 'aggressive' | 'off';

/** Unrecognised stored values fall back to the safe default. */
export function normalizeReconnectStrategy(value: unknown): ReconnectStrategy {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'aggressive' || normalized === 'always' || normalized === 'on') {
    return 'aggressive';
  }
  if (normalized === 'off' || normalized === 'disabled' || normalized === 'none') {
    return 'off';
  }
  return 'auto';
}

export type ExtraArgsError =
  | { code: 'rejected'; option: string }
  | { code: 'pathOrUrl'; option: string }
  | { code: 'malformed' };

export type ExtraArgsValidation =
  | { ok: true; args: string[] }
  | { ok: false; error: ExtraArgsError };

const RESERVED = new Set(RESERVED_FFMPEG_OPTIONS);

/**
 * A bare path or URL would be read by FFmpeg as an extra input file rather than
 * as the value of a flag. Only the start of the token is inspected, so a quoted
 * header value such as `Referer: http://example.com` is left alone.
 */
function looksLikePathOrUrl(token: string): boolean {
  if (
    token.startsWith('http://') ||
    token.startsWith('https://') ||
    token.startsWith('/') ||
    token.startsWith('\\') ||
    token.startsWith('//') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('.\\')
  ) {
    return true;
  }
  // Windows drive root, e.g. C:\recordings\x.ts
  return /^[A-Za-z]:[\\/]/.test(token);
}

/**
 * Split and check the extra FFmpeg arguments.
 *
 * Arguments reach FFmpeg as separate argv entries (never through a shell), so
 * quoting is only needed to keep a value containing spaces in one piece:
 * `-headers "Referer: http://example.com"`.
 */
export function validateExtraFfmpegArgs(raw: string): ExtraArgsValidation {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: true, args: [] };
  if (trimmed.length > MAX_EXTRA_ARGS_LEN) {
    return { ok: false, error: { code: 'malformed' } };
  }

  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const ch of trimmed) {
    if (ch === '\n' || ch === '\r') return { ok: false, error: { code: 'malformed' } };
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) return { ok: false, error: { code: 'malformed' } };
  if (current) tokens.push(current);
  if (tokens.length > MAX_EXTRA_ARGS_TOKENS) {
    return { ok: false, error: { code: 'malformed' } };
  }

  for (const token of tokens) {
    // Compare the bare flag so `-t=60` is caught as well as `-t 60`, while a
    // value keeps its `key=value` shape (`-metadata comment=-i` is not `-i`).
    const bare = token.toLowerCase().split('=')[0];
    if (RESERVED.has(bare)) {
      return { ok: false, error: { code: 'rejected', option: bare } };
    }
    if (looksLikePathOrUrl(token)) {
      return { ok: false, error: { code: 'pathOrUrl', option: token } };
    }
  }

  return { ok: true, args: tokens };
}
