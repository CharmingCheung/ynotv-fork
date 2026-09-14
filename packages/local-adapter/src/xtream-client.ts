/**
 * Xtream Codes API Client
 *
 * Implements the Xtream Codes player_api.php interface.
 * Client for Xtream Codes API.
 *
 * API Reference:
 * - Base: http://server/player_api.php?username=X&password=Y
 * - Actions: get_live_categories, get_live_streams, get_vod_categories, etc.
 * - Stream URLs: http://server/live/username/password/stream_id.ts
 */

import type { Channel, Category, Movie, Series, Season } from '@ynotv/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { parseXmltv, type XmltvProgram } from './xmltv-parser';

export interface XtreamConfig {
  baseUrl: string;
  username: string;
  password: string;
  userAgent?: string;
}

export interface XtreamServerInfo {
  url: string;
  port: string;
  server_protocol: string;
  rtmp_port: string;
  timezone: string;
  timestamp_now: number;
  time_now: string;
}

export interface XtreamUserInfo {
  username: string;
  password: string;
  message: string;
  auth: number;
  status: string;
  exp_date: string;
  is_trial: string;
  active_cons: string;
  created_at: string;
  max_connections: string;
  allowed_output_formats: string[];
}

export interface XtreamAuthResponse {
  user_info: XtreamUserInfo;
  server_info: XtreamServerInfo;
}

export class XtreamClient {
  private config: XtreamConfig;
  private sourceId: string;

  constructor(config: XtreamConfig, sourceId: string) {
    // Normalize base URL (remove trailing slash)
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      userAgent: config.userAgent || 'VLC/3.0.18 LibVLC/3.0.18',
    };
    this.sourceId = sourceId;
  }

  /**
   * Helper to build a timeshift URL for playing catchup content
   */
  static buildTimeshiftUrl(
    streamId: string | number,
    baseUrl: string,
    username: string,
    password: string,
    durationMinutes: number,
    startTime: Date,
    extension: string = 'ts'
  ): string {
    const formattedBase = baseUrl.replace(/\/+$/, '');

    // Format start time exactly as "YYYY-MM-DD:HH-MM"
    const year = startTime.getUTCFullYear();
    const month = String(startTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(startTime.getUTCDate()).padStart(2, '0');
    const hour = String(startTime.getUTCHours()).padStart(2, '0');
    const minute = String(startTime.getUTCMinutes()).padStart(2, '0');
    const formattedStartTime = `${year}-${month}-${day}:${hour}-${minute}`;

    // http://<server>/timeshift/<username>/<password>/<duration>/<YYYY-MM-DD:HH-MM>/<stream_id>.<extension>
    return `${formattedBase}/timeshift/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${durationMinutes}/${formattedStartTime}/${streamId}.${extension}`;
  }

  // ===========================================================================
  // API Helpers
  // ===========================================================================

  private buildApiUrl(action?: string): string {
    const { baseUrl, username, password } = this.config;
    let url = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    if (action) {
      url += `&action=${action}`;
    }
    return url;
  }

  // In-flight request deduplication across all XtreamClient instances
  private static inFlightRequests = new Map<string, Promise<any>>();
  // Response cache (TTL: 60s) for metadata calls like get_vod_info and get_series_info
  private static responseCache = new Map<string, { data: any; expiresAt: number }>();
  private static readonly RESPONSE_CACHE_TTL_MS = 60000;
  // Hard cap so a heavy browsing session can't retain every payload it saw
  private static readonly RESPONSE_CACHE_MAX_ENTRIES = 200;

  private static cacheResponse(url: string, data: any): void {
    const cache = XtreamClient.responseCache;
    const now = Date.now();

    // Drop expired entries. Nothing else ever removes them, and series payloads
    // are large enough that keeping them for the whole session adds up.
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }

    cache.set(url, { data, expiresAt: now + XtreamClient.RESPONSE_CACHE_TTL_MS });

    // Map preserves insertion order, so the first key is the oldest entry.
    while (cache.size > XtreamClient.RESPONSE_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const now = Date.now();
    const cached = XtreamClient.responseCache.get(url);
    if (cached && cached.expiresAt > now) {
      return cached.data as T;
    }

    const inFlight = XtreamClient.inFlightRequests.get(url);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const promise = (async () => {
      try {
        const data = await this.doFetchJson<T>(url);
        // Cache metadata requests so concurrent or subsequent hooks share the data
        if (url.includes('action=get_vod_info') || url.includes('action=get_series_info')) {
          XtreamClient.cacheResponse(url, data);
        }
        return data;
      } finally {
        XtreamClient.inFlightRequests.delete(url);
      }
    })();

    XtreamClient.inFlightRequests.set(url, promise);
    return promise;
  }

  private async doFetchJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent;
    }

    // Tauri Environment
    if ((window as any).__TAURI__) {
      try {
        console.log('[Xtream] Fetching (Tauri):', url);
        const response = await tauriFetch(url, {
          method: 'GET',
          headers
        });
        console.log('[Xtream] Response status:', response.status);
        if (!response.ok) {
          const text = await response.text();
          console.error('[Xtream] Error response body:', text);
          throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
        }
        const json = await response.json();
        console.log('[Xtream] Success, data length:', JSON.stringify(json).length);
        return json;
      } catch (e: any) {
        console.error('[Xtream] Tauri fetch failed:', e);
        throw new Error(`Tauri fetch failed: ${e.message || e}`);
      }
    }

    // Use Electron's fetch proxy if available (bypasses CORS)
    if (typeof window !== 'undefined' && window.fetchProxy) {
      const result = await window.fetchProxy.fetch(url, { headers });
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Fetch failed');
      }
      if (!result.data.ok) {
        throw new Error(`Xtream API error: ${result.data.status} ${result.data.statusText}`);
      }
      return JSON.parse(result.data.text);
    }

    // Fallback to regular fetch (works in Node.js or when CORS is not an issue)
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent;
    }

    // Use Electron's fetch proxy if available (bypasses CORS)
    if (typeof window !== 'undefined' && window.fetchProxy) {
      const result = await window.fetchProxy.fetch(url, { headers });
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Fetch failed');
      }
      if (!result.data.ok) {
        throw new Error(`Xtream API error: ${result.data.status} ${result.data.statusText}`);
      }
      return result.data.text;
    }

    // Fallback to regular fetch (works in Node.js or when CORS is not an issue)
    // Tauri Environment
    if ((window as any).__TAURI__) {
      try {
        const response = await tauriFetch(url, { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (e) {
        console.error('[Xtream] EPG Tauri fetch failed:', e);
        throw e;
      }
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  // ===========================================================================
  // Authentication
  // ===========================================================================

  async authenticate(): Promise<XtreamAuthResponse> {
    const url = this.buildApiUrl();
    return this.fetchJson<XtreamAuthResponse>(url);
  }

  async testConnection(): Promise<{ success: boolean; error?: string; info?: XtreamAuthResponse }> {
    try {
      const info = await this.authenticate();
      if (info.user_info.auth !== 1) {
        return { success: false, error: 'Authentication failed' };
      }
      return { success: true, info };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getUserInfo(): Promise<{ expiry_date?: string; active_cons?: string; max_connections?: string }> {
    try {
      const authResponse = await this.authenticate();

      // Format expiry date from Unix timestamp to readable format
      let formattedExpiry: string | undefined;
      if (authResponse.user_info.exp_date) {
        const timestamp = parseInt(authResponse.user_info.exp_date, 10);
        if (!isNaN(timestamp)) {
          const date = new Date(timestamp * 1000); // Convert seconds to milliseconds

          // Format to match Stalker style: "August 18, 2026, 12:00 am"
          const options: Intl.DateTimeFormatOptions = {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          };
          formattedExpiry = date.toLocaleString('en-US', options);
        }
      }

      return {
        expiry_date: formattedExpiry,
        active_cons: authResponse.user_info.active_cons !== undefined && authResponse.user_info.active_cons !== null ? String(authResponse.user_info.active_cons) : undefined,
        max_connections: authResponse.user_info.max_connections !== undefined && authResponse.user_info.max_connections !== null ? String(authResponse.user_info.max_connections) : undefined,
      };
    } catch (error) {
      console.error('[Xtream] Failed to fetch user info:', error);
      return {};
    }
  }

  private ensureArray<T>(data: any): T[] {
    if (!data) return [];
    if (Array.isArray(data)) return data as T[];

    if (typeof data === 'object') {
      if (data.user_info && data.user_info.auth === 0) {
        throw new Error('Xtream Codes authentication failed');
      }
      if (data.error) {
        throw new Error(data.error);
      }
      if (data.message) {
        throw new Error(data.message);
      }
      if (Object.keys(data).length === 0) {
        return [];
      }
    }

    return [data] as T[];
  }

  // ===========================================================================
  // Live TV
  // ===========================================================================

  async getLiveCategories(): Promise<Category[]> {
    const url = this.buildApiUrl('get_live_categories');
    const rawData = await this.fetchJson<any>(url);
    const data = this.ensureArray<XtreamCategory>(rawData);

    return data.map((cat, index) => ({
      category_id: `${this.sourceId}_${cat.category_id}`,
      category_name: cat.category_name,
      source_id: this.sourceId,
      display_order: index,
    }));
  }

  async getLiveStreams(categoryId?: string): Promise<Channel[]> {
    let url = this.buildApiUrl('get_live_streams');
    if (categoryId) {
      // Strip source prefix if present
      const rawCatId = categoryId.replace(`${this.sourceId}_`, '');
      url += `&category_id=${rawCatId}`;
    }

    const rawData = await this.fetchJson<any>(url);
    const data = this.ensureArray<XtreamStream>(rawData);

    return data.map((stream, index) => ({
      stream_id: `${this.sourceId}_${stream.stream_id}`,
      name: stream.name,
      stream_icon: stream.stream_icon || '',
      epg_channel_id: stream.epg_channel_id || '',
      category_ids: stream.category_id ? [`${this.sourceId}_${stream.category_id}`] : [],
      direct_url: this.buildStreamUrl('live', stream.stream_id),
      source_id: this.sourceId,
      tv_archive: stream.tv_archive === 1,
      channel_num: stream.num,
      provider_order: index,
    }));
  }

  // ===========================================================================
  // VOD (Movies)
  // ===========================================================================

  async getVodCategories(): Promise<Category[]> {
    const url = this.buildApiUrl('get_vod_categories');
    const rawData = await this.fetchJson<any>(url);
    const data = this.ensureArray<XtreamCategory>(rawData);

    return data.map((cat, index) => ({
      category_id: `${this.sourceId}_vod_${cat.category_id}`,
      category_name: cat.category_name,
      source_id: this.sourceId,
      display_order: index,
    }));
  }

  async getVodStreams(categoryId?: string): Promise<Movie[]> {
    let url = this.buildApiUrl('get_vod_streams');
    if (categoryId) {
      const rawCatId = categoryId.replace(`${this.sourceId}_vod_`, '');
      url += `&category_id=${rawCatId}`;
    }

    const rawData = await this.fetchJson<any>(url);
    const data = this.ensureArray<XtreamVodStream>(rawData);

    return data.map(vod => ({
      stream_id: `${this.sourceId}_${vod.stream_id}`,
      name: vod.name,
      title: vod.title,
      year: vod.year,
      stream_icon: vod.stream_icon || '',
      category_ids: vod.category_id ? [`${this.sourceId}_vod_${vod.category_id}`] : [],
      direct_url: this.buildStreamUrl('movie', vod.stream_id, vod.container_extension),
      source_id: this.sourceId,
      plot: vod.plot,
      cast: vod.cast,
      director: vod.director,
      genre: vod.genre,
      release_date: vod.releasedate,
      rating: vod.rating,
      added: vod.added ? String(vod.added) : undefined,
    }));
  }

  // ===========================================================================
  // Series
  // ===========================================================================

  async getVodInfo(vodId: string): Promise<any> {
    const rawVodId = vodId.replace(`${this.sourceId}_vod_`, '').replace(`${this.sourceId}_`, '');
    const url = this.buildApiUrl('get_vod_info') + `&vod_id=${rawVodId}`;
    const data = await this.fetchJson<any>(url);

    if (!data || typeof data !== 'object') return null;
    const rawData = data as any;
    if (rawData.user_info && rawData.user_info.auth === 0) {
      throw new Error('Xtream Codes authentication failed');
    }
    if ((data as any).error) {
      throw new Error((data as any).error);
    }
    // info holds the provider metadata (including tmdb_id) for the movie
    return rawData.info || null;
  }

  async getVodFullInfo(vodId: string): Promise<{ info: any; movie_data: any } | null> {
    const rawVodId = vodId.replace(`${this.sourceId}_vod_`, '').replace(`${this.sourceId}_`, '');
    const url = this.buildApiUrl('get_vod_info') + `&vod_id=${rawVodId}`;
    const data = await this.fetchJson<any>(url);

    if (!data || typeof data !== 'object') return null;
    const rawData = data as any;
    if (rawData.user_info && rawData.user_info.auth === 0) {
      throw new Error('Xtream Codes authentication failed');
    }
    if ((data as any).error) {
      throw new Error((data as any).error);
    }
    return {
      info: rawData.info || null,
      movie_data: rawData.movie_data || null,
    };
  }

  async getSeriesCategories(): Promise<Category[]> {
    const url = this.buildApiUrl('get_series_categories');
    const rawData = await this.fetchJson<any>(url);
    const data = this.ensureArray<XtreamCategory>(rawData);

    return data.map((cat, index) => ({
      category_id: `${this.sourceId}_series_${cat.category_id}`,
      category_name: cat.category_name,
      source_id: this.sourceId,
      display_order: index,
    }));
  }

  async getSeries(categoryId?: string): Promise<Series[]> {
    let url = this.buildApiUrl('get_series');
    if (categoryId) {
      const rawCatId = categoryId.replace(`${this.sourceId}_series_`, '');
      url += `&category_id=${rawCatId}`;
    }

    const rawData = await this.fetchJson<any>(url);
    const data = this.ensureArray<XtreamSeries>(rawData);

    return data.map(series => ({
      series_id: `${this.sourceId}_${series.series_id}`,
      name: series.name,
      title: series.title,
      year: series.year,
      cover: series.cover || '',
      category_ids: series.category_id ? [`${this.sourceId}_series_${series.category_id}`] : [],
      source_id: this.sourceId,
      plot: series.plot,
      cast: series.cast,
      genre: series.genre,
      release_date: series.releaseDate,
      rating: series.rating,
      added: series.added ? String(series.added) : undefined,
      last_modified: series.last_modified ? String(series.last_modified) : undefined,
    }));
  }

  async getSeriesInfo(seriesId: string): Promise<Season[]> {
    const rawData = await this.fetchSeriesInfoRaw(seriesId);
    if (!rawData) return [];
    return this.mapSeriesSeasons(rawData)
  }

  /**
   * Fetch series info metadata (info.tmdb, info.youtube_trailer, etc.)
   * from the provider's get_series_info response. The series-level info
   * object is discarded by getSeriesInfo(), which only maps episodes.
   */
  async getSeriesInfoMeta(seriesId: string): Promise<any> {
    const rawData = await this.fetchSeriesInfoRaw(seriesId);
    if (!rawData) return null;
    // info holds the provider metadata (including tmdb / youtube_trailer) for the series
    const rawInfo = rawData.info;
    if (!rawInfo) return null;
    // Normalize the series TMDB ID so callers can always rely on `tmdb_id`.
    // Providers often leave `tmdb_id` as an empty string `''` and instead ship
    // the real ID in `info.tmdb`; use `||` (not `??`) so `''` falls through.
    const rawTmdb = rawInfo.tmdb_id || rawInfo.tmdb;
    const seriesTmdb = rawTmdb != null && !Number.isNaN(Number(rawTmdb)) ? Number(rawTmdb) : null;
    if (seriesTmdb) rawInfo.tmdb_id = seriesTmdb;
    return rawInfo;
  }

  /**
   * Fetch series episodes AND normalized series metadata in a single
   * get_series_info request. Avoids the double round-trip that calling
   * getSeriesInfo() + getSeriesInfoMeta() separately would incur.
   */
  async getSeriesInfoWithMeta(seriesId: string): Promise<{ seasons: Season[]; info: any } | null> {
    const rawData = await this.fetchSeriesInfoRaw(seriesId);
    if (!rawData) return null;
    const seasons = this.mapSeriesSeasons(rawData);
    const rawInfo = rawData.info;
    if (!rawInfo) return { seasons, info: null };
    const rawTmdb = rawInfo.tmdb_id || rawInfo.tmdb;
    const seriesTmdb = rawTmdb != null && !Number.isNaN(Number(rawTmdb)) ? Number(rawTmdb) : null;
    if (seriesTmdb) rawInfo.tmdb_id = seriesTmdb;
    return { seasons, info: rawInfo };
  }

  private async fetchSeriesInfoRaw(seriesId: string): Promise<XtreamSeriesInfo | null> {
    const rawSeriesId = seriesId.replace(`${this.sourceId}_`, '');
    const url = this.buildApiUrl('get_series_info') + `&series_id=${rawSeriesId}`;
    const data = await this.fetchJson<XtreamSeriesInfo>(url);

    if (!data || typeof data !== 'object') return null;
    const rawData = data as any;
    if (rawData.user_info && rawData.user_info.auth === 0) {
      throw new Error('Xtream Codes authentication failed');
    }
    if ((data as any).error) {
      throw new Error((data as any).error);
    }
    return rawData;
  }

  private mapSeriesSeasons(rawData: any): Season[] {
    if (!rawData.episodes || typeof rawData.episodes !== 'object') return [];
    // Episodes are grouped by season number
    const seasons: Season[] = [];
    for (const [seasonNum, episodes] of Object.entries(rawData.episodes)) {
      const seasonEpisodes = this.ensureArray<XtreamEpisode>(episodes).map(ep => ({
        id: `${this.sourceId}_${ep.id}`,
        title: ep.title,
        episode_num: ep.episode_num,
        season_num: parseInt(seasonNum, 10),
        direct_url: this.buildStreamUrl('series', ep.id, ep.container_extension),
        plot: ep.info?.plot,
        duration: ep.info?.duration ? parseInt(ep.info.duration, 10) : undefined,
        info: ep.info,
        container_extension: ep.container_extension || (ep.info?.container_extension as string | undefined),
      }));

      seasons.push({
        season_number: parseInt(seasonNum, 10),
        episodes: seasonEpisodes,
      });
    }
    return seasons.sort((a, b) => a.season_number - b.season_number);
  }

  // ===========================================================================
  // EPG
  // ===========================================================================

  getEpgUrl(): string {
    const { baseUrl, username, password } = this.config;
    return `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  }

  async getShortEpg(streamId: string, limit = 4): Promise<XtreamEpgEntry[]> {
    const rawStreamId = streamId.replace(`${this.sourceId}_`, '');
    const url = this.buildApiUrl('get_short_epg') + `&stream_id=${rawStreamId}&limit=${limit}`;
    const data = await this.fetchJson<{ epg_listings: XtreamEpgEntry[] }>(url);
    return (data && data.epg_listings) ? this.ensureArray<XtreamEpgEntry>(data.epg_listings) : [];
  }

  // Fetch full XMLTV EPG data
  async getXmltvEpg(): Promise<XmltvProgram[]> {
    const url = this.getEpgUrl();
    const xmlText = await this.fetchText(url);
    return parseXmltv(xmlText);
  }

  // ===========================================================================
  // URL Building
  // ===========================================================================

  buildStreamUrl(type: 'live' | 'movie' | 'series', streamId: string | number, extension?: string | null): string {
    const { baseUrl, username, password } = this.config;
    // Default extension: 'mp4' for VOD content, 'ts' for live
    const ext = extension || (type === 'live' ? 'ts' : 'mp4');
    return `${baseUrl}/${type}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;
  }

  buildTimeshiftUrl(streamId: string | number, duration: number, startTime: string, extension = 'ts'): string {
    const { baseUrl, username, password } = this.config;
    return `${baseUrl}/timeshift/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${duration}/${startTime}/${streamId}.${extension}`;
  }
}

// ===========================================================================
// Xtream API Response Types
// ===========================================================================

interface XtreamCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

interface XtreamStream {
  num: number;            // Channel order from provider
  stream_id: number;
  name: string;
  stream_icon: string;
  epg_channel_id: string;
  category_id: string;
  tv_archive: number;
  direct_source: string;
}

interface XtreamVodStream {
  stream_id: number;
  name: string;
  title?: string;       // Clean title without year (e.g., "40 Pounds of Trouble")
  year?: string;        // Release year (e.g., "1962")
  stream_icon: string;
  category_id: string;
  container_extension: string | null;  // null is valid per Xtream Codes spec
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  releasedate?: string;
  rating?: string;
  added?: string | number;
}

interface XtreamSeries {
  series_id: number;
  name: string;
  title?: string;       // Clean title without year
  year?: string;        // First air year
  cover: string;
  category_id: string;
  plot?: string;
  cast?: string;
  genre?: string;
  releaseDate?: string;
  rating?: string;
  added?: string | number;
  last_modified?: string | number;
}

interface XtreamSeriesInfo {
  seasons: unknown[];
  episodes: Record<string, XtreamEpisode[]>;
  info?: any;
}

interface XtreamEpisode {
  id: string;
  title: string;
  episode_num: number;
  container_extension: string | null;  // null is valid per Xtream Codes spec
  info?: {
    plot?: string;
    duration?: string;
    [key: string]: unknown;
  };
}

interface XtreamEpgEntry {
  id: string;
  epg_id: string;
  title: string;
  lang: string;
  start: string;
  end: string;
  description: string;
  channel_id: string;
}

// XmltvProgram is now exported from xmltv-parser.ts
