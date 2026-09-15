/**
 * Streaming EPG Parser Service
 *
 * Provides high-performance EPG parsing with real-time progress updates.
 * Replaces the old synchronous EPG parsing that blocked the UI.
 *
 * Features:
 * - Streaming download and parse
 * - Real-time progress callbacks
 * - Batch database insertion
 * - Memory efficient (no loading entire XML into RAM)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { bulkOps } from './bulk-ops';
import i18n from '../i18n';
import { activeLocale } from '../utils/dateTime';

// Re-export types from Rust
export interface ChannelMapping {
  epg_channel_id: string;
  stream_id: string;
  channel_name: string;  // Fallback for fuzzy matching
}

export interface EpgParseProgress {
  source_id: string;
  phase: 'downloading' | 'parsing' | 'inserting' | 'complete';
  bytes_downloaded: number;
  total_bytes: number | null;
  programs_parsed: number;
  programs_matched: number;
  programs_inserted: number;
  estimated_remaining_seconds: number | null;
}

export interface EpgParseResult {
  source_id: string;
  total_programs: number;
  matched_programs: number;
  inserted_programs: number;
  unmatched_channels: number;
  matched_channels: number;
  duration_ms: number;
  bytes_processed: number;
  working_url?: string;
  /** Wall time spent downloading the EPG file (or reading it, for local files). */
  download_ms: number;
  /** Wall time spent decompressing (0 when the payload wasn't gzipped). */
  decompress_ms: number;
  /** Wall time spent parsing the XML (XMLTV -> matched programs). */
  parse_ms: number;
  /** Wall time spent inserting the parsed batches into the database (includes waiting for the SQLite write lock). */
  insert_ms: number;
  /** Wall time of insert_ms spent waiting for the SQLite write lock (contention), not writing rows. */
  lock_wait_ms: number;
}

/**
 * Lightweight per-source reference for multi-source/cache parses. The
 * needing-EPG channel mappings are computed in Rust from the main database
 * (channels minus already-filled stream ids, overrides applied), so the
 * renderer no longer builds or ships ~20k-row mapping payloads across IPC.
 */
export interface EpgSourceRef {
  sourceId: string;
  sourceName: string;
  advancedEpgMatching?: boolean;
  timeshiftHours?: number;
  clearExisting?: boolean;
}

// Progress callback type
export type EpgProgressCallback = (progress: EpgParseProgress) => void;

/**
 * Stream parse EPG from URL with progress updates
 *
 * @param sourceId - Source identifier
 * @param epgUrl - URL to the EPG XML file
 * @param channelMappings - Map of EPG channel IDs to stream_ids
 * @param onProgress - Optional callback for progress updates
 * @returns Parse result with statistics
 *
 * @example
 * ```typescript
 * const result = await streamParseEpg(
 *   'source123',
 *   'http://example.com/epg.xml',
 *   [{ epg_channel_id: 'bbc1', stream_id: 'source123_1' }],
 *   (progress) => console.log(`${progress.programs_parsed} programs parsed`)
 * );
 * ```
 */
/**
 * Generates an ordered list of candidate URLs for EPG fetching,
 * handling scheme downgrades (https -> http fallback), upgrades (http -> https),
 * port mismatches (https on :80, http on :443), custom port removal (e.g., :8089/:8443 behind CDNs),
 * and fallback to base source URL.
 */
export function getEpgUrlCandidates(
  primaryUrl: string,
  fallbackBaseUrl?: string,
  username?: string,
  password?: string
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  function addCandidate(rawUrl: string | undefined | null) {
    if (!rawUrl) return;
    let urlStr = rawUrl.trim();
    if (!urlStr) return;

    // Detect duplicated URL if any (e.g. "http://...http://...")
    if (urlStr.length >= 2) {
      const half = urlStr.length / 2;
      if (urlStr.substring(0, half) === urlStr.substring(half)) {
        urlStr = urlStr.substring(0, half);
      }
    }

    if (!seen.has(urlStr)) {
      seen.add(urlStr);
      candidates.push(urlStr);
    }
  }

  const cleanPrimary = (primaryUrl || '').trim();
  if (cleanPrimary) {
    // If port 80 is specified with HTTPS (e.g. https://domain:80/...), port 80 is HTTP
    if (cleanPrimary.startsWith('https://') && /:80(?:\/|$)/.test(cleanPrimary)) {
      addCandidate(cleanPrimary.replace(/^https:\/\//, 'http://'));
    }
    // If port 443 is specified with HTTP (e.g. http://domain:443/...), port 443 is HTTPS
    if (cleanPrimary.startsWith('http://') && /:443(?:\/|$)/.test(cleanPrimary)) {
      addCandidate(cleanPrimary.replace(/^http:\/\//, 'https://'));
    }

    // Add primary URL
    addCandidate(cleanPrimary);

    try {
      const parsed = new URL(cleanPrimary);
      if (parsed.protocol === 'https:') {
        // Fallback 1: Downgrade https -> http (preserving or fixing port)
        const httpUrl = new URL(cleanPrimary);
        httpUrl.protocol = 'http:';
        if (httpUrl.port === '443') httpUrl.port = '';
        addCandidate(httpUrl.toString());

        // Fallback 2: If URL has a custom non-standard port (like 8089 or 8443), try standard ports
        if (parsed.port && parsed.port !== '443' && parsed.port !== '80') {
          const noPortHttps = new URL(cleanPrimary);
          noPortHttps.port = '';
          addCandidate(noPortHttps.toString());

          const noPortHttp = new URL(cleanPrimary);
          noPortHttp.protocol = 'http:';
          noPortHttp.port = '';
          addCandidate(noPortHttp.toString());
        }
      } else if (parsed.protocol === 'http:') {
        // Fallback 1: Upgrade http -> https
        const httpsUrl = new URL(cleanPrimary);
        httpsUrl.protocol = 'https:';
        if (httpsUrl.port === '80') httpsUrl.port = '';
        addCandidate(httpsUrl.toString());

        // Fallback 2: If URL has a custom port, try without custom port
        if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
          const noPortHttp = new URL(cleanPrimary);
          noPortHttp.port = '';
          addCandidate(noPortHttp.toString());

          const noPortHttps = new URL(cleanPrimary);
          noPortHttps.protocol = 'https:';
          noPortHttps.port = '';
          addCandidate(noPortHttps.toString());
        }
      }
    } catch {
      // Fallback if URL parser fails
      if (cleanPrimary.startsWith('https://')) {
        addCandidate(cleanPrimary.replace(/^https:\/\//, 'http://'));
      } else if (cleanPrimary.startsWith('http://')) {
        addCandidate(cleanPrimary.replace(/^http:\/\//, 'https://'));
      }
    }
  }

  // Fallback 3: If fallbackBaseUrl (e.g. source.url) with credentials is provided
  if (fallbackBaseUrl && username && password) {
    const base = fallbackBaseUrl.trim().replace(/\/+$/, '');
    const defaultXmltv = `${base}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    addCandidate(defaultXmltv);

    if (defaultXmltv.startsWith('https://')) {
      addCandidate(defaultXmltv.replace(/^https:\/\//, 'http://'));
    } else if (defaultXmltv.startsWith('http://')) {
      addCandidate(defaultXmltv.replace(/^http:\/\//, 'https://'));
    }
  }

  return candidates;
}

/**
 * Stream parse EPG from URL with progress updates
 *
 * @param sourceId - Source identifier
 * @param epgUrl - URL to the EPG XML file
 * @param channelMappings - Map of EPG channel IDs to stream_ids
 * @param onProgress - Optional callback for progress updates
 * @returns Parse result with statistics
 */
export async function streamParseEpg(
  sourceId: string,
  sourceName: string,
  epgUrl: string,
  channelMappings: ChannelMapping[],
  onProgress?: EpgProgressCallback,
  advancedEpgMatching?: boolean,
  timeshiftHours?: number,
  clearExisting: boolean = true,
  userAgent?: string,
  candidateUrls?: string[]
): Promise<EpgParseResult> {
  const urlsToTry = candidateUrls && candidateUrls.length > 0
    ? candidateUrls
    : getEpgUrlCandidates(epgUrl);

  let lastError: any = null;

  for (let i = 0; i < urlsToTry.length; i++) {
    const currentUrl = urlsToTry[i];
    console.log(`[Streaming EPG] (${i + 1}/${urlsToTry.length}) Streaming from: ${currentUrl}`);

    // Set up progress listener
    let unsubscribe: (() => void) | null = null;

    if (onProgress) {
      const listener = await listen<EpgParseProgress>('epg:parse_progress', (event) => {
        if (event.payload.source_id === sourceId) {
          onProgress(event.payload);
        }
      });
      unsubscribe = listener;
    }

    try {
      const timerKey = `stream-parse-epg-${sourceId}-${i}`;
      console.time(timerKey);

      const result = await invoke<EpgParseResult>('stream_parse_epg', {
        sourceId,
        sourceName,
        epgUrl: currentUrl,
        channelMappings,
        advancedEpgMatching: advancedEpgMatching ?? false,
        timeshiftHours: timeshiftHours ?? 0,
        clearExisting,
        userAgent: userAgent || null,
      });

      result.working_url = currentUrl;

      console.timeEnd(timerKey);
      console.log(
        `[Streaming EPG] Complete on attempt ${i + 1}: ${result.matched_programs}/${result.total_programs} programs ` +
        `matched and ${result.inserted_programs} inserted in ${result.duration_ms}ms (working URL: ${currentUrl})`
      );

      return result;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Streaming EPG] Attempt ${i + 1} (${currentUrl}) failed: ${errMsg}`);
      if (i < urlsToTry.length - 1) {
        console.log(`[Streaming EPG] Retrying with fallback candidate: ${urlsToTry[i + 1]}`);
      }
    } finally {
      if (unsubscribe) {
        unsubscribe();
      }
    }
  }

  throw lastError || new Error('All EPG URL candidates failed to download');
}

/**
 * Parse EPG from local file with progress updates
 *
 * @param sourceId - Source identifier
 * @param filePath - Path to the local EPG XML file
 * @param channelMappings - Map of EPG channel IDs to stream_ids
 * @param onProgress - Optional callback for progress updates
 * @returns Parse result with statistics
 */
export async function parseEpgFile(
  sourceId: string,
  filePath: string,
  channelMappings: ChannelMapping[],
  onProgress?: EpgProgressCallback,
  advancedEpgMatching?: boolean,
  timeshiftHours?: number,
  clearExisting: boolean = true
): Promise<EpgParseResult> {
  // Set up progress listener
  let unsubscribe: (() => void) | null = null;

  if (onProgress) {
    const listener = await listen<EpgParseProgress>('epg:parse_progress', (event) => {
      if (event.payload.source_id === sourceId) {
        onProgress(event.payload);
      }
    });
    unsubscribe = listener;
  }

  try {
    console.time(`parse-epg-file-${sourceId}`);

    const result = await invoke<EpgParseResult>('parse_epg_file', {
      sourceId,
      filePath,
      channelMappings,
      advancedEpgMatching: advancedEpgMatching ?? false,
      timeshiftHours: timeshiftHours ?? 0,
      clearExisting,
    });

    console.timeEnd(`parse-epg-file-${sourceId}`);
    console.log(
      `[Local EPG] Complete: ${result.matched_programs}/${result.total_programs} programs ` +
      `matched and ${result.inserted_programs} inserted in ${result.duration_ms}ms`
    );

    return result;
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
  }
}

/**
 * Stream parse EPG for multiple sources with a single download.
 * Rust downloads the EPG once, parses it, and inserts programmes for all sources.
 * Each source only gets programmes for its own channels (waterfall/gap-fill).
 */
export async function streamParseEpgMulti(
  epgUrl: string,
  sourceRefs: EpgSourceRef[],
  userAgent?: string,
  /**
   * Identity of the feed being parsed, for channel feed pins: a global EPG link
   * passes `global_epg_<linkId>`, a source's own feed/extra URL passes the
   * source id. Channels pinned to a different feed are left out of the mappings.
   */
  feedRef?: string,
  /**
   * Feed refs a pin may name that no longer exist. The Rust pass reads the pins
   * out of the DB itself, so it can't tell a live feed from a deleted one —
   * handed this list it treats those pins as absent instead of honouring a lock
   * nothing can satisfy (see `dropUnservableFeedPins`).
   */
  unservableFeeds?: string[],
  candidateUrls?: string[]
): Promise<EpgParseResult[]> {
  const urlsToTry = candidateUrls && candidateUrls.length > 0
    ? candidateUrls
    : getEpgUrlCandidates(epgUrl);

  let lastError: any = null;

  for (let i = 0; i < urlsToTry.length; i++) {
    const currentUrl = urlsToTry[i];
    console.log(`[Streaming EPG Multi] (${i + 1}/${urlsToTry.length}) Streaming from: ${currentUrl}`);

    try {
      console.time(`stream-parse-epg-multi-${i}`);

      const results = await invoke<EpgParseResult[]>('stream_parse_epg_multi', {
        epgUrl: currentUrl,
        sources: sourceRefs.map((c) => ({
          sourceId: c.sourceId,
          sourceName: c.sourceName,
          advancedEpgMatching: c.advancedEpgMatching ?? false,
          timeshiftHours: c.timeshiftHours ?? 0,
          clearExisting: c.clearExisting ?? false,
        })),
        userAgent: userAgent || null,
        feedRef: feedRef || null,
        unservableFeeds: unservableFeeds ?? [],
      });

      for (const r of results) {
        r.working_url = currentUrl;
      }

      console.timeEnd(`stream-parse-epg-multi-${i}`);

      const totalInserted = results.reduce((sum, r) => sum + r.inserted_programs, 0);
      console.log(
        `[Streaming EPG Multi] Complete on attempt ${i + 1}: ${totalInserted} total programs inserted across ${results.length} source(s) (working URL: ${currentUrl})`
      );

      return results;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Streaming EPG Multi] Attempt ${i + 1} (${currentUrl}) failed: ${errMsg}`);
      if (i < urlsToTry.length - 1) {
        console.log(`[Streaming EPG Multi] Retrying with fallback candidate: ${urlsToTry[i + 1]}`);
      }
    }
  }

  throw lastError || new Error('All EPG URL candidates failed for multi-source EPG parse');
}

/**
 * Create channel mappings from channels array
 * Extracts epg_channel_id from channels and maps to stream_id
 * Includes channel_name as fallback for fuzzy matching
 */
export function createChannelMappings(
  channels: Array<{ stream_id: string; epg_channel_id?: string; name?: string }>
): ChannelMapping[] {
  return channels
    .filter((ch) => ch.epg_channel_id || ch.name)
    .map((ch) => ({
      epg_channel_id: ch.epg_channel_id || ch.name || '',
      stream_id: ch.stream_id,
      channel_name: ch.name || '',
    }));
}

/**
 * Format progress for display
 * Creates a human-readable progress message
 */
export function formatProgress(progress: EpgParseProgress): string {
  const phaseLabels: Record<string, string> = {
    downloading: i18n.t('common:phaseDownloading'),
    parsing: i18n.t('common:phaseParsingXml'),
    inserting: i18n.t('common:phaseInsertingDb'),
    complete: i18n.t('common:phaseComplete'),
  };

  const phase = phaseLabels[progress.phase] || progress.phase;
  const percent = progress.total_bytes
    ? Math.round((progress.bytes_downloaded / progress.total_bytes) * 100)
    : null;

  let message = `[${phase}]`;

  if (percent !== null) {
    message += ` ${percent}%`;
  }

  message += ` ${i18n.t('common:programsParsed', { count: progress.programs_parsed.toLocaleString(activeLocale()) })}`;

  if (progress.programs_matched > 0) {
    message += `, ${i18n.t('common:programsMatched', { count: progress.programs_matched.toLocaleString(activeLocale()) })}`;
  }

  if (progress.programs_inserted > 0) {
    message += `, ${i18n.t('common:programsInserted', { count: progress.programs_inserted.toLocaleString(activeLocale()) })}`;
  }

  if (
    progress.estimated_remaining_seconds !== null &&
    progress.estimated_remaining_seconds > 0
  ) {
    const mins = Math.ceil(progress.estimated_remaining_seconds / 60);
    message += ` ${i18n.t('common:minutesRemaining', { mins })}`;
  }

  return message;
}

/**
 * Drop the `programs` secondary indexes before a bulk EPG load (sync-all).
 * Call bulkLoadFinish() when the load is done (use a finally block).
 */
export async function bulkLoadStart(): Promise<void> {
  await invoke<void>('epg_bulk_load_start');
}

/**
 * Recreate the `programs` secondary indexes after a bulk EPG load.
 *
 * Runs on a background Rust thread and resolves immediately; the indexes are
 * rebuilt within seconds. If the process exits first, the schema init on next
 * app start recreates them (CREATE INDEX IF NOT EXISTS).
 */
export async function bulkLoadFinish(): Promise<void> {
  await invoke<void>('epg_bulk_load_finish');
}

/**
 * Write one per-run summary row into epg_timings.jsonl (kind: "run") and
 * reset the Rust-side accumulator. Called by the sync orchestration's finally
 * block so even failed runs get a row.
 */
export async function timingRunEnd(opts: {
  alignmentMaxMs?: number;
  sourcesOk?: number;
  sourcesFailed?: number;
}): Promise<void> {
  await invoke<void>('epg_timing_run_end', {
    alignmentMaxMs: opts.alignmentMaxMs ?? null,
    sourcesOk: opts.sourcesOk ?? null,
    sourcesFailed: opts.sourcesFailed ?? null,
  });
}

// Export all functions as a namespace
export const epgStreaming = {
  streamParseEpg,
  streamParseEpgMulti,
  parseEpgFile,
  createChannelMappings,
  formatProgress,
  bulkLoadStart,
  bulkLoadFinish,
  timingRunEnd,
};

export default epgStreaming;
