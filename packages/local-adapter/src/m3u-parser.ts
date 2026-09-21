/**
 * M3U Playlist Parser
 *
 * Parses M3U/M3U8 playlists with EXTINF metadata.
 * M3U playlist parser for IPTV channel lists.
 *
 * M3U Format:
 * #EXTM3U url-tvg="http://epg.url/xmltv.xml"
 * #EXTINF:-1 tvg-id="channel1" tvg-name="Channel One" tvg-logo="http://logo.png" group-title="News",Channel One
 * http://stream.url/live/123.ts
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Channel, Category } from '@ynotv/core';

const XTREAM_STREAM_ID_RE = /\/live\/[^/]+\/[^/]+\/(\d+)(?:\.(?:ts|m3u8|m3u))?/i;
export const M3U_HTTP_HEADERS_PROPERTY = 'ynotv.http_headers';

type HttpHeaders = Record<string, string>;

function decodeHeaderComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'));
  } catch {
    return value;
  }
}

function setHttpHeader(headers: HttpHeaders, rawName: string, rawValue: string, decode = true): void {
  const name = rawName.trim().replace(/^!+/, '');
  if (!name || /[\r\n:]/.test(name)) return;
  const value = (decode ? decodeHeaderComponent(rawValue.trim()) : rawValue.trim());
  if (!value || /[\r\n]/.test(value)) return;
  const existing = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  const canonical = ({
    'user-agent': 'User-Agent', referer: 'Referer', referrer: 'Referer',
    origin: 'Origin', cookie: 'Cookie', authorization: 'Authorization',
  } as Record<string, string>)[name.toLowerCase()] || name;
  headers[canonical] = value;
}

function mergeHeaderString(headers: HttpHeaders, value: string): void {
  for (const part of value.replace(/\|/g, '&').split('&')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    setHttpHeader(headers, part.substring(0, separator), part.substring(separator + 1));
  }
}

function mergeJsonHeaders(headers: HttpHeaders, value: string): void {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [name, headerValue] of Object.entries(parsed)) {
      if (typeof headerValue === 'string') setHttpHeader(headers, name, headerValue, false);
    }
  } catch { /* Ignore malformed optional metadata. */ }
}

function mergeKodiHeaders(headers: HttpHeaders, key: string, value: string): void {
  if (/inputstream\.adaptive\.(?:common|manifest|stream)_headers$/i.test(key)) {
    mergeHeaderString(headers, value);
    return;
  }
  if (/inputstream\.adaptive\.(?:license_key|drm_legacy)$/i.test(key)) {
    const pipe = value.indexOf('|');
    if (pipe >= 0) mergeHeaderString(headers, value.substring(pipe + 1));
    return;
  }
  if (/inputstream\.adaptive\.drm$/i.test(key)) {
    try {
      const drm = JSON.parse(value);
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
          if (childKey.toLowerCase() === 'req_headers' && typeof child === 'string') mergeHeaderString(headers, child);
          else visit(child);
        }
      };
      visit(drm);
    } catch { /* Keep the original KODIPROP even when its JSON is invalid. */ }
  }
}

function splitUrlHeaders(line: string): { url: string; headers: HttpHeaders } {
  const separator = line.indexOf('|');
  if (separator < 0) return { url: line, headers: {} };
  const headers: HttpHeaders = {};
  mergeHeaderString(headers, line.substring(separator + 1));
  return { url: line.substring(0, separator).trim(), headers };
}

/**
 * Generate a stable hash from a string (DJB2 algorithm)
 * Returns a short alphanumeric hash for use in IDs
 */
function stableHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
  }
  // Convert to base36 (alphanumeric) and take first 8 chars
  return Math.abs(hash).toString(36).substring(0, 8);
}

/**
 * Extract Xtream stream_id from a channel URL.
 * Xtream URLs follow the pattern: /live/{username}/{password}/{stream_id}.ts
 */
export function extractXtreamStreamId(url: string): string | null {
  const match = XTREAM_STREAM_ID_RE.exec(url);
  return match ? match[1] : null;
}

/**
 * Generate a stable stream_id for a channel
 * Uses tvg-id if available, otherwise falls back to URL hash
 * This ensures favorites, custom groups, and EPG remain matched after re-sync
 */
function generateStableStreamId(
  sourceId: string,
  tvgId: string,
  url: string,
  seenIds: Set<string>
): string {
  // Sanitize tvg-id for use in ID (remove special chars)
  const sanitizedTvgId = tvgId ? tvgId.replace(/[^a-zA-Z0-9._-]/g, '_') : '';

  // Try using tvg-id first
  if (sanitizedTvgId) {
    const baseId = `${sourceId}_${sanitizedTvgId}`;

    // If this tvg-id hasn't been seen yet, use it directly
    if (!seenIds.has(baseId)) {
      seenIds.add(baseId);
      return baseId;
    }

    // Tvg-id collision - add URL hash suffix to make it unique but stable
    // This handles cases like multiple ESPN backup channels with same tvg-id
    const urlHash = stableHash(url);
    const uniqueId = `${baseId}_${urlHash}`;
    if (!seenIds.has(uniqueId)) {
      seenIds.add(uniqueId);
      return uniqueId;
    }

    // If both tvg-id and URL are duplicated, keep incrementing until unique.
    let counter = 1;
    let finalId = `${uniqueId}_${counter}`;
    while (seenIds.has(finalId)) {
      counter++;
      finalId = `${uniqueId}_${counter}`;
    }
    seenIds.add(finalId);
    return finalId;
  }

  // No tvg-id - use URL hash for stable ID
  const urlHash = stableHash(url);
  const fallbackId = `${sourceId}_url_${urlHash}`;

  // Handle rare case of URL hash collision
  if (!seenIds.has(fallbackId)) {
    seenIds.add(fallbackId);
    return fallbackId;
  }

  // Extremely rare: hash collision - add counter
  let counter = 1;
  let finalId = `${fallbackId}_${counter}`;
  while (seenIds.has(finalId)) {
    counter++;
    finalId = `${fallbackId}_${counter}`;
  }
  seenIds.add(finalId);
  return finalId;
}



export interface M3UParseResult {
  channels: Channel[];
  categories: Category[];
  epgUrl: string | null;
}

interface ExtInfMetadata {
  duration: number;
  tvgId: string;
  tvgName: string;
  tvgLogo: string;
  tvgChno: number | null;  // Channel number for ordering
  groupTitle: string;
  displayName: string;
  tvArchive: boolean;
  catchupType?: string;
  catchupDays?: number;
  catchupSource?: string;
  httpHeaders: HttpHeaders;
}

interface HeaderCatchupDefaults {
  catchupType?: string;
  catchupDays?: number;
  catchupSource?: string;
  tvArchive: boolean;
}

/**
 * Extract attribute value supporting double quotes, single quotes, and unquoted values
 */
function extractAttribute(text: string, keys: string[]): string {
  for (const key of keys) {
    // 1. Double quoted: key="value"
    const doubleMatch = text.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i'));
    if (doubleMatch && doubleMatch[1] !== undefined) return doubleMatch[1].trim();

    // 2. Single quoted: key='value'
    const singleMatch = text.match(new RegExp(`${key}\\s*=\\s*'([^']*)'`, 'i'));
    if (singleMatch && singleMatch[1] !== undefined) return singleMatch[1].trim();

    // 3. Unquoted: key=value (terminated by space, comma, or end of string)
    const unquotedMatch = text.match(new RegExp(`${key}\\s*=\\s*([^\\s,"]+)`, 'i'));
    if (unquotedMatch && unquotedMatch[1] !== undefined) return unquotedMatch[1].trim();
  }
  return '';
}

/**
 * Extract playlist-wide default catchup settings from #EXTM3U header line
 */
function extractHeaderCatchup(line: string): HeaderCatchupDefaults {
  const defaults: HeaderCatchupDefaults = {
    tvArchive: false,
  };

  const catchupType = extractAttribute(line, ['catchup', 'catchup-type', 'catchup-mode']);
  if (catchupType) {
    defaults.tvArchive = true;
    defaults.catchupType = catchupType;
  }

  const catchupDaysStr = extractAttribute(line, ['catchup-days', 'catchup-days-max', 'catchup-range']);
  if (catchupDaysStr) {
    const days = parseInt(catchupDaysStr, 10);
    if (!isNaN(days) && days > 0) {
      defaults.tvArchive = true;
      defaults.catchupDays = days;
    }
  }

  const catchupSource = extractAttribute(line, ['catchup-source', 'catchup-url']);
  if (catchupSource) {
    defaults.tvArchive = true;
    defaults.catchupSource = catchupSource;
  }

  const timeshiftStr = extractAttribute(line, ['timeshift', 'tvg-shift']);
  if (timeshiftStr && !defaults.tvArchive) {
    const shift = parseInt(timeshiftStr, 10);
    if (!isNaN(shift) && shift > 0) {
      defaults.tvArchive = true;
      defaults.catchupType = 'shift';
    }
  }

  return defaults;
}

/**
 * Parse an M3U playlist content
 */
export function parseM3U(content: string, sourceId: string): M3UParseResult {
  const lines = content.split('\n').map(line => line.trim());
  const channels: Channel[] = [];
  const categoriesMap = new Map<string, Category>();

  let epgUrl: string | null = null;
  let headerCatchup: HeaderCatchupDefaults = { tvArchive: false };
  let currentMetadata: ExtInfMetadata | null = null;
  let currentKodiProps: Record<string, string> = {};
  let channelCounter = 0;

  // Track seen stream_ids to handle duplicates (e.g., multiple channels with same tvg-id)
  const seenStreamIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines
    if (!line) continue;

    // Parse header for EPG URL and global catchup defaults
    if (line.startsWith('#EXTM3U')) {
      epgUrl = extractEpgUrl(line);
      headerCatchup = extractHeaderCatchup(line);
      continue;
    }

    // Parse EXTINF line
    if (line.startsWith('#EXTINF:')) {
      currentMetadata = parseExtInf(line, headerCatchup);
      currentKodiProps = {};
      continue;
    }

    // KODIPROP directives belong to the current EXTINF item up to its URL.
    // Preserve unknown keys so future inputstream properties survive import.
    if (currentMetadata && line.toUpperCase().startsWith('#KODIPROP:')) {
      const property = line.substring('#KODIPROP:'.length);
      const separator = property.indexOf('=');
      if (separator > 0) {
        const key = property.substring(0, separator).trim().toLowerCase();
        const value = property.substring(separator + 1).trim();
        if (key) {
          currentKodiProps[key] = value;
          mergeKodiHeaders(currentMetadata.httpHeaders, key, value);
        }
      }
      continue;
    }

    if (currentMetadata && line.toUpperCase().startsWith('#EXTVLCOPT:')) {
      const option = line.substring('#EXTVLCOPT:'.length);
      const separator = option.indexOf('=');
      if (separator > 0) {
        const key = option.substring(0, separator).trim().toLowerCase();
        const value = option.substring(separator + 1).trim();
        const headerName = ({
          'http-user-agent': 'User-Agent',
          'http-referrer': 'Referer',
          'http-referer': 'Referer',
          'http-origin': 'Origin',
        } as Record<string, string>)[key];
        if (headerName) setHttpHeader(currentMetadata.httpHeaders, headerName, value, false);
      }
      continue;
    }

    if (currentMetadata && line.toUpperCase().startsWith('#EXTHTTP:')) {
      mergeJsonHeaders(currentMetadata.httpHeaders, line.substring('#EXTHTTP:'.length).trim());
      continue;
    }

    // Skip other comments/directives
    if (line.startsWith('#')) {
      continue;
    }

    // This should be a URL - create channel if we have metadata
    if (currentMetadata && (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('rtmp://'))) {
      const parsedUrl = splitUrlHeaders(line);
      for (const [name, value] of Object.entries(parsedUrl.headers)) {
        setHttpHeader(currentMetadata.httpHeaders, name, value, false);
      }
      if (Object.keys(currentMetadata.httpHeaders).length > 0) {
        currentKodiProps[M3U_HTTP_HEADERS_PROPERTY] = JSON.stringify(currentMetadata.httpHeaders);
      }
      channelCounter++;

      // Generate stable stream_id that persists across re-syncs
      const streamId = generateStableStreamId(
        sourceId,
        currentMetadata.tvgId,
        parsedUrl.url,
        seenStreamIds
      );

      // DEBUG: Log first few channels to verify stable ID generation
      if (channels.length < 5) {
        console.log(`[M3U DEBUG] Channel ${channels.length}: tvgId="${currentMetadata.tvgId}" -> stream_id="${streamId}"`);
      }

      // Create category if needed — use "Uncategorized" when group-title is missing
      const categoryName = currentMetadata.groupTitle || 'Uncategorized';
      const categoryId = createCategoryId(sourceId, categoryName);
      if (!categoriesMap.has(categoryId)) {
        categoriesMap.set(categoryId, {
          category_id: categoryId,
          category_name: categoryName,
          source_id: sourceId,
          display_order: categoriesMap.size,
        });
      }

      // Create channel with stable stream_id
      const channel: Channel = {
        stream_id: streamId,
        name: currentMetadata.displayName || currentMetadata.tvgName || `Channel ${channelCounter}`,
        stream_icon: currentMetadata.tvgLogo || '',
        epg_channel_id: currentMetadata.tvgId || '',
        category_ids: [categoryId],
        direct_url: parsedUrl.url,
        source_id: sourceId,
        tv_archive: currentMetadata.tvArchive ? 1 : 0,
        provider_order: channelCounter - 1, // 0-based position in M3U file
        ...(currentMetadata.tvgChno !== null && { channel_num: currentMetadata.tvgChno }),
        xtream_stream_id: extractXtreamStreamId(parsedUrl.url) || undefined,
        catchup_type: currentMetadata.catchupType,
        catchup_source: currentMetadata.catchupSource,
        catchup_days: currentMetadata.catchupDays,
        ...(Object.keys(currentKodiProps).length > 0 && { kodi_props: { ...currentKodiProps } }),
      };

      channels.push(channel);
      currentMetadata = null;
      currentKodiProps = {};
    }
  }

  return {
    channels,
    categories: Array.from(categoriesMap.values()),
    epgUrl,
  };
}

/**
 * Extract EPG URL from #EXTM3U header
 */
function extractEpgUrl(line: string): string | null {
  // Try url-tvg="..." or single quote / unquoted
  const urlTvg = extractAttribute(line, ['url-tvg', 'x-tvg-url']);
  if (urlTvg) {
    return urlTvg;
  }

  return null;
}

/**
 * Parse #EXTINF line metadata
 *
 * Format: #EXTINF:duration key="value" key="value"...,Display Name
 * Example: #EXTINF:-1 tvg-id="cnn" tvg-logo="http://..." group-title="News",CNN HD
 */
function parseExtInf(line: string, headerDefaults?: HeaderCatchupDefaults): ExtInfMetadata {
  const metadata: ExtInfMetadata = {
    duration: -1,
    tvgId: '',
    tvgName: '',
    tvgLogo: '',
    tvgChno: null,
    groupTitle: '',
    displayName: '',
    tvArchive: headerDefaults?.tvArchive || false,
    catchupType: headerDefaults?.catchupType,
    catchupDays: headerDefaults?.catchupDays,
    catchupSource: headerDefaults?.catchupSource,
    httpHeaders: {},
  };

  // Remove #EXTINF: prefix
  const content = line.substring(8);

  // Split by comma to get display name (everything after last comma)
  const commaIndex = content.lastIndexOf(',');
  if (commaIndex !== -1) {
    metadata.displayName = content.substring(commaIndex + 1).trim();
  }

  // Parse the part before the comma for attributes
  const attrPart = commaIndex !== -1 ? content.substring(0, commaIndex) : content;

  // Extract duration (first number)
  const durationMatch = attrPart.match(/^(-?\d+)/);
  if (durationMatch) {
    metadata.duration = parseInt(durationMatch[1], 10);
  }

  // Extract tvg-id
  const tvgId = extractAttribute(attrPart, ['tvg-id']);
  if (tvgId) {
    metadata.tvgId = tvgId;
  }

  // Extract tvg-name
  const tvgName = extractAttribute(attrPart, ['tvg-name']);
  if (tvgName) {
    metadata.tvgName = tvgName;
  }

  // Extract tvg-logo
  const tvgLogo = extractAttribute(attrPart, ['tvg-logo', 'tvg-icon', 'logo']);
  if (tvgLogo) {
    metadata.tvgLogo = tvgLogo;
  }

  // Extract group-title
  const groupTitle = extractAttribute(attrPart, ['group-title', 'group']);
  if (groupTitle) {
    metadata.groupTitle = groupTitle;
  }

  const userAgent = extractAttribute(attrPart, ['http-user-agent', 'user-agent']);
  if (userAgent) setHttpHeader(metadata.httpHeaders, 'User-Agent', userAgent, false);
  const referrer = extractAttribute(attrPart, ['http-referrer', 'http-referer', 'referrer', 'referer']);
  if (referrer) setHttpHeader(metadata.httpHeaders, 'Referer', referrer, false);

  // Extract catchup tags (override header defaults if present)
  const catchupType = extractAttribute(attrPart, ['catchup', 'catchup-type', 'catchup-mode']);
  if (catchupType) {
    metadata.tvArchive = true;
    metadata.catchupType = catchupType;
  }

  const catchupDaysStr = extractAttribute(attrPart, ['catchup-days', 'catchup-days-max', 'catchup-range']);
  if (catchupDaysStr) {
    const days = parseInt(catchupDaysStr, 10);
    if (!isNaN(days) && days > 0) {
      metadata.tvArchive = true;
      metadata.catchupDays = days;
    }
  }

  const catchupSource = extractAttribute(attrPart, ['catchup-source', 'catchup-url']);
  if (catchupSource) {
    metadata.tvArchive = true;
    metadata.catchupSource = catchupSource;
  }

  const timeshiftStr = extractAttribute(attrPart, ['timeshift', 'tvg-shift']);
  if (timeshiftStr && !metadata.tvArchive) {
    const shift = parseInt(timeshiftStr, 10);
    if (!isNaN(shift) && shift > 0) {
      metadata.tvArchive = true;
      if (!metadata.catchupType) metadata.catchupType = 'shift';
    }
  }

  // Extract tvg-chno (channel number for ordering)
  const tvgChnoStr = extractAttribute(attrPart, ['tvg-chno', 'tvg-ch', 'channel-id']);
  if (tvgChnoStr) {
    const num = parseInt(tvgChnoStr, 10);
    if (!isNaN(num)) {
      metadata.tvgChno = num;
    }
  }

  return metadata;
}

/**
 * Create a category ID from source and group name
 */
function createCategoryId(sourceId: string, groupTitle: string): string {
  if (!groupTitle) return '';

  // Slugify the group title
  const slug = groupTitle
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');

  return `${sourceId}_${slug || `category-${stableHash(groupTitle)}`}`;
}

/**
 * Fetch and parse an M3U playlist from URL
 */
export async function fetchAndParseM3U(url: string, sourceId: string, userAgent?: string): Promise<M3UParseResult> {
  const headers: Record<string, string> = {};
  headers['User-Agent'] = userAgent || 'VLC/3.0.18 LibVLC/3.0.18';

  // Tauri Environment
  if ((window as any).__TAURI__) {
    const response = await tauriFetch(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    return parseM3U(content, sourceId);
  }

  // Use Electron's fetch proxy if available (bypasses CORS + SSRF protection)
  if (typeof window !== 'undefined' && window.fetchProxy) {
    const result = await window.fetchProxy.fetch(url, { headers });
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to fetch M3U');
    }
    if (!result.data.ok) {
      throw new Error(`Failed to fetch M3U: ${result.data.status} ${result.data.statusText}`);
    }
    return parseM3U(result.data.text, sourceId);
  }

  // Fallback to regular fetch (Node.js or when CORS is not an issue)
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to fetch M3U: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();
  return parseM3U(content, sourceId);
}
