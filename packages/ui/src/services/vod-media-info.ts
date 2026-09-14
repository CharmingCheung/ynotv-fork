/**
 * vod-media-info.ts
 *
 * Services for parsing VOD stream metadata (codecs, resolution, audio channels, bitrate)
 * and probing file sizes via HTTP HEAD/Range requests.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { resolvePlayUrl } from './stream-resolver';

/** Hard ceiling for each probe request; the card must never hang on one. */
export const PROBE_TIMEOUT_MS = 6000;

type FetchLike = (url: string, init?: any) => Promise<any>;

export interface VodMediaInfo {
  width?: number;
  height?: number;
  qualityLabel?: string; // e.g. "4K", "1080p", "720p", "SD"
  resolution?: string;   // e.g. "1920×1080"
  videoCodec?: string;   // e.g. "HEVC", "H.264"
  videoBitrate?: string; // e.g. "8.5 Mbps"
  audioCodec?: string;   // e.g. "E-AC-3", "AAC", "DTS"
  audioChannels?: string;// e.g. "5.1", "Stereo"
  container?: string;    // e.g. "MKV", "MP4"
  fileSize?: string;     // e.g. "4.82 GB", "950 MB"
  fileSizeBytes?: number;
}

/** Normalize video codec strings to clean display badges */
export function normalizeVideoCodec(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean === 'hevc' || clean === 'h265' || clean === 'x265') return 'HEVC';
  if (clean === 'h264' || clean === 'avc' || clean === 'x264' || clean === 'avc1') return 'H.264';
  if (clean === 'av1' || clean === 'av01') return 'AV1';
  if (clean === 'mpeg4' || clean === 'mp4v' || clean === 'xvid' || clean === 'divx') return 'MPEG-4';
  if (clean === 'vp9') return 'VP9';
  if (clean === 'vp8') return 'VP8';
  if (clean === 'vc1') return 'VC-1';
  if (clean === 'mpeg2video' || clean === 'mpeg2') return 'MPEG-2';
  return raw.trim().toUpperCase();
}

/** Normalize audio codec strings to clean display badges */
export function normalizeAudioCodec(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean === 'eac3' || clean === 'ec3') return 'E-AC-3';
  if (clean === 'ac3') return 'AC-3';
  if (clean === 'dts') return 'DTS';
  if (clean === 'dtshd' || clean === 'dtshdma') return 'DTS-HD';
  if (clean === 'truehd') return 'TrueHD';
  if (clean === 'aac' || clean === 'mp4a') return 'AAC';
  if (clean === 'mp3') return 'MP3';
  if (clean === 'flac') return 'FLAC';
  if (clean === 'opus') return 'Opus';
  if (clean === 'vorbis') return 'Vorbis';
  return raw.trim().toUpperCase();
}

/** Normalize audio channels to clean display format (e.g. 5.1, Stereo, 7.1) */
export function normalizeAudioChannels(channels?: number | string | null, layout?: string | null): string | undefined {
  if (channels !== undefined && channels !== null) {
    const num = typeof channels === 'number' ? channels : parseInt(String(channels).trim(), 10);
    if (num === 6) return '5.1';
    if (num === 8) return '7.1';
    if (num === 2) return 'Stereo';
    if (num === 1) return 'Mono';
  }

  if (layout && typeof layout === 'string') {
    const clean = layout.trim().toLowerCase();
    if (clean.includes('5.1') || clean.includes('6ch')) return '5.1';
    if (clean.includes('7.1') || clean.includes('8ch')) return '7.1';
    if (clean.includes('stereo') || clean.includes('2ch')) return 'Stereo';
    if (clean.includes('mono') || clean.includes('1ch')) return 'Mono';
  }

  return undefined;
}

/** Format resolution into quality label (4K, 1080p, 720p, SD) */
export function getQualityLabel(width: number, height: number): string {
  if (width >= 3840 || height >= 2160) return '4K';
  if (width >= 1920 || height >= 1080) return '1080p';
  if (width >= 1280 || height >= 720) return '720p';
  return 'SD';
}

/** Format bitrate in bps or kbps into human readable string */
export function formatBitrate(raw?: number | string | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const num = typeof raw === 'number' ? raw : parseFloat(String(raw).trim());
  if (isNaN(num) || num <= 0) return undefined;

  // If > 100,000, value is in bps; if <= 100,000, value is in kbps
  const kbps = num > 100000 ? num / 1000 : num;
  if (kbps >= 1000) {
    const mbps = (kbps / 1000).toFixed(1).replace(/\.0$/, '');
    return `${mbps} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

/** Format bytes into human readable file size */
export function formatBytes(bytes?: number | null): string | undefined {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes <= 0) return undefined;
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/** Format container extension */
export function formatContainer(ext?: string | null): string | undefined {
  if (!ext || typeof ext !== 'string') return undefined;
  const clean = ext.trim().replace(/^\./, '').toUpperCase();
  return clean || undefined;
}

/** Extract quality label from release title as fallback */
export function extractQualityFromTitle(title?: string | null): string | undefined {
  if (!title) return undefined;
  if (/\b(4k|uhd|2160p)\b/i.test(title)) return '4K';
  if (/\b(1080p|fhd|1920x1080)\b/i.test(title)) return '1080p';
  if (/\b(720p|hd|1280x720)\b/i.test(title)) return '720p';
  if (/\b(sd|480p|576p)\b/i.test(title)) return 'SD';
  return undefined;
}

/** Extract video codec from release title as fallback */
export function extractCodecFromTitle(title?: string | null): string | undefined {
  if (!title) return undefined;
  if (/\b(hevc|h[\.\s]?265|x265)\b/i.test(title)) return 'HEVC';
  if (/\b(h[\.\s]?264|x264|avc)\b/i.test(title)) return 'H.264';
  if (/\bav1\b/i.test(title)) return 'AV1';
  if (/\b(mpeg[\s-]?4|xvid|divx)\b/i.test(title)) return 'MPEG-4';
  return undefined;
}

/** Extract container extension from URL if not explicitly provided */
export function extractContainerFromUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const match = cleanUrl.match(/\.([a-zA-Z0-9]{2,4})$/);
    if (match) {
      return formatContainer(match[1]);
    }
  } catch {
    // Ignore URL parse error
  }
  return undefined;
}

/**
 * Unwrap an info payload that may be an object, a JSON string, or the legacy
 * "[object Object]" corruption. Returns null when there is nothing to read.
 */
function parseInfoObject(infoRaw: any): any {
  if (typeof infoRaw !== 'string') return infoRaw;
  const trimmed = infoRaw.trim();
  if (!trimmed || trimmed.startsWith('[object')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Read a file size the provider already reported, so an HTTP probe can be skipped.
 * Returns null when no usable size is present.
 */
export function extractProviderFileSize(infoRaw: any): number | null {
  const info = parseInfoObject(infoRaw);
  if (!info || typeof info !== 'object') return null;

  for (const candidate of [info.size, info.filesize, info.file_size]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const parsed = parseInt(String(candidate).trim(), 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}

/**
 * Safely parse stream metadata from Xtream info payload and/or episode info object
 */
export function parseStreamMetadata(
  infoRaw: any,
  containerExt?: string | null,
  fileSizeBytes?: number | null,
  directUrl?: string | null,
  fallbackTitle?: string | null
): VodMediaInfo {
  const info = parseInfoObject(infoRaw);

  const result: VodMediaInfo = {};

  if (info && typeof info === 'object') {
    // 1. Video information
    let video = info.video;
    if (typeof video === 'string') {
      try { video = JSON.parse(video); } catch { video = null; }
    } else if (Array.isArray(video) && video.length > 0) {
      video = video[0];
    }

    if (video && typeof video === 'object') {
      const width = Number(video.width);
      const height = Number(video.height);
      if (!isNaN(width) && width > 0 && !isNaN(height) && height > 0) {
        result.width = width;
        result.height = height;
        result.resolution = `${width}×${height}`;
        result.qualityLabel = getQualityLabel(width, height);
      }

      result.videoCodec = normalizeVideoCodec(video.codec_name);
      if (video.bit_rate) {
        result.videoBitrate = formatBitrate(video.bit_rate);
      }
    }

    // 2. Audio information
    let audio = info.audio;
    if (typeof audio === 'string') {
      try { audio = JSON.parse(audio); } catch { audio = null; }
    } else if (Array.isArray(audio) && audio.length > 0) {
      audio = audio[0];
    }

    if (audio && typeof audio === 'object') {
      result.audioCodec = normalizeAudioCodec(audio.codec_name);
      result.audioChannels = normalizeAudioChannels(audio.channels, audio.channel_layout);
    }

    // 3. Fallback overall bitrate
    if (!result.videoBitrate && info.bitrate) {
      result.videoBitrate = formatBitrate(info.bitrate);
    }

    // 4. Fallback file size if provider supplied it in info
    if (!fileSizeBytes) {
      fileSizeBytes = extractProviderFileSize(info);
    }
  }

  // Container extension: prefer containerExt, fallback to directUrl
  if (containerExt) {
    result.container = formatContainer(containerExt);
  } else if (directUrl) {
    result.container = extractContainerFromUrl(directUrl);
  }

  // Fallback quality and codec from title if provider omitted server-side ffprobe data
  if (!result.qualityLabel && fallbackTitle) {
    result.qualityLabel = extractQualityFromTitle(fallbackTitle);
  }
  if (!result.videoCodec && fallbackTitle) {
    result.videoCodec = extractCodecFromTitle(fallbackTitle);
  }

  // File size
  if (fileSizeBytes) {
    result.fileSizeBytes = fileSizeBytes;
    result.fileSize = formatBytes(fileSizeBytes);
  }

  return result;
}

/** Read a positive Content-Length header, ignoring anything unusable. */
function parseContentLength(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const size = parseInt(raw, 10);
  return !isNaN(size) && size > 0 ? size : null;
}

/** Raised when our own timeout fired, so a timeout can't be confused with a refusal. */
class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Probe request timed out after ${timeoutMs}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

function isProbeTimeout(err: unknown): boolean {
  return err instanceof ProbeTimeoutError || (err as any)?.name === 'ProbeTimeoutError';
}

/**
 * Fetch with a hard timeout. `abortAfterHeaders` drops the response body as soon
 * as the headers (which carry the size we want) have arrived, so a ranged probe
 * never transfers video data.
 *
 * The timeout is tracked with our own flag rather than by inspecting the thrown
 * error, because the Tauri plugin reports a cancelled request as
 * "Request cancelled" while the browser reports a DOMException named AbortError.
 */
async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: any,
  timeoutMs: number,
  abortAfterHeaders = false
): Promise<any> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (abortAfterHeaders) controller.abort();
    return res;
  } catch (err) {
    if (timedOut) throw new ProbeTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Perform a lightweight HTTP HEAD / Range check to probe file size without
 * downloading video. Bounded by `timeoutMs` per request so a provider that
 * accepts the connection and then stalls cannot leave the caller hanging.
 */
export async function probeFileSize(
  sourceId: string,
  directUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<number | null> {
  if (!sourceId || !directUrl) return null;

  try {
    const resolved = await resolvePlayUrl(sourceId, directUrl);
    if (!resolved?.url) return null;

    const headers: Record<string, string> = {};
    if (resolved.userAgent) {
      headers['User-Agent'] = resolved.userAgent;
    }

    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
    const fetchImpl: FetchLike = isTauri ? (tauriFetch as unknown as FetchLike) : (globalThis.fetch as FetchLike);

    // 1. HEAD first — cheapest way to learn the size.
    try {
      const headRes = await fetchWithTimeout(fetchImpl, resolved.url, { method: 'HEAD', headers }, timeoutMs);
      if (headRes?.ok) {
        const size = parseContentLength(headRes.headers?.get('content-length'));
        if (size) return size;
      }
    } catch (headErr) {
      if (isProbeTimeout(headErr)) {
        // The endpoint accepted the connection but never answered. A second
        // request against the same stream would only stall this too, so give up
        // rather than making the caller wait through two full timeouts.
        console.warn(`[VodMediaInfo] ${(headErr as Error).message}`);
        return null;
      }
      console.warn('[VodMediaInfo] HEAD request failed, falling back to Range:', headErr);
    }

    // 2. Fall back to a one-byte ranged GET, which CDNs answer even when HEAD is rejected.
    try {
      const getRes = await fetchWithTimeout(
        fetchImpl,
        resolved.url,
        { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } },
        timeoutMs,
        true
      );

      const contentRange: string | null = getRes?.headers?.get('content-range') ?? null; // e.g. "bytes 0-0/4837281920"
      const ranged = contentRange ? contentRange.match(/\/(\d+)$/) : null;
      if (ranged) {
        const size = parseInt(ranged[1], 10);
        if (!isNaN(size) && size > 0) return size;
      }

      if (getRes?.status === 200) {
        const size = parseContentLength(getRes.headers?.get('content-length'));
        if (size) return size;
      }
    } catch (rangeErr) {
      console.warn('[VodMediaInfo] Range request failed:', rangeErr);
    }

    return null;
  } catch (err) {
    console.warn('[VodMediaInfo] Failed to probe file size:', err);
    return null;
  }
}
