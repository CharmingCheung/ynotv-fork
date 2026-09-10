import { useState, useEffect, useRef, useCallback } from 'react';
import type { VodPlayInfo } from '../types/media';
import { fetchIntroSegments } from '../services/introdb';
import { db } from '../db';
import { Bridge } from '../services/tauri-bridge';
import { readLocalLibrary, extractEpisodeNumber } from '../services/local-library/local-library';
import { getTvShowDetails } from '../services/tmdb';
import { useSettingsStore } from '../stores/settingsStore';

interface UseSkipIntroOptions {
  vodInfo: VodPlayInfo | null;
  playing: boolean;
  position: number;
  duration: number;
  stremioEpisodeRef?: React.MutableRefObject<{
    metaId: string;
    name: string;
    poster?: string;
    videoId: string;
    season: number;
    episode: number;
    nextVideoId?: string;
    nextSeason?: number;
    nextEpisode?: number;
  } | null>;
}

interface SkipIntroSettings {
  skipIntroTimerSeconds: number;
  skipIntroAutoSkip: boolean;
}

const DEFAULT_SETTINGS: SkipIntroSettings = {
  skipIntroTimerSeconds: 10,
  skipIntroAutoSkip: false,
};

/**
 * Resolves IMDb ID, season number, and episode number from various sources:
 * - Direct VodPlayInfo fields
 * - Stremio / Nuvio episode metadata
 * - Media ID / Series ID regex patterns (e.g. local_tt39837101_ep_...)
 * - Local Library store lookup
 * - Local SQLite vodSeries DB lookup
 * - TMDb external IDs resolution (if TMDb ID is known)
 * - TVMaze fallback lookup
 * - Filename episode regex parsing (e.g. S01E01)
 */
export async function resolveIntroDbParams(
  vodInfo: VodPlayInfo,
  stremioEpisodeRef?: React.MutableRefObject<{
    metaId: string;
    season: number;
    episode: number;
    [key: string]: any;
  } | null>
): Promise<{ imdbId?: string; season?: number; episode?: number }> {
  let imdbId: string | undefined;
  let season: number | undefined;
  let episode: number | undefined;
  let tmdbId: number | string | undefined = vodInfo.tmdbId;

  // 1. Stremio / Nuvio episode info
  if ((vodInfo.source_id === 'stremio' || vodInfo.source_id === 'nuvio') && stremioEpisodeRef?.current) {
    imdbId = stremioEpisodeRef.current.metaId;
    season = stremioEpisodeRef.current.season;
    episode = stremioEpisodeRef.current.episode;
  } else {
    season = vodInfo.seasonNum;
    episode = vodInfo.episodeNum;

    // 2. Direct imdbId on vodInfo
    if (vodInfo.imdbId && /tt\d{7,8}/i.test(vodInfo.imdbId)) {
      imdbId = vodInfo.imdbId;
    }

    // 3. Extract tt... pattern from mediaId or seriesId (e.g. local_tt39837101_ep_... or local_tt39837101)
    if (!imdbId) {
      const match =
        vodInfo.mediaId?.match(/(tt\d{7,8})/i) ||
        vodInfo.seriesId?.match(/(tt\d{7,8})/i) ||
        vodInfo.url?.match(/(tt\d{7,8})/i);
      if (match?.[1]) {
        imdbId = match[1];
      }
    }

    // 4. Local Library lookup
    if (
      vodInfo.source_id === 'local' ||
      vodInfo.mediaId?.startsWith('local_') ||
      vodInfo.url?.includes('/') ||
      vodInfo.url?.includes('\\')
    ) {
      try {
        const localEntries = readLocalLibrary();
        const entry = localEntries.find(
          (e) =>
            e.id === vodInfo.episodeId ||
            (vodInfo.mediaId && vodInfo.mediaId.includes(e.id)) ||
            (vodInfo.url && e.path && e.path.toLowerCase() === vodInfo.url.toLowerCase())
        );

        if (entry) {
          if (!imdbId && entry.imdbId && /tt\d{7,8}/i.test(entry.imdbId)) {
            imdbId = entry.imdbId;
          }
          if (!tmdbId && entry.tmdbId) {
            tmdbId = entry.tmdbId;
          }
          if (season == null && entry.season != null) {
            season = entry.season;
          }
          if (episode == null && entry.episode != null) {
            episode = entry.episode;
          }
        }
      } catch (e) {
        console.warn('[SkipIntro] Local library lookup error:', e);
      }
    }

    // 5. Local DB lookup for standard VOD series
    if (!imdbId && vodInfo.seriesId) {
      try {
        const series = await db.vodSeries.get(vodInfo.seriesId);
        if (series?.imdb_id && /tt\d{7,8}/i.test(series.imdb_id)) {
          imdbId = series.imdb_id;
        }
        if (!tmdbId && series?.tmdb_id) {
          tmdbId = series.tmdb_id;
        }
      } catch (e) {
        // DB lookup error ignored
      }
    }

    // 6. TMDb ID -> IMDb ID resolution
    if (!imdbId && tmdbId) {
      const numericTmdbId =
        typeof tmdbId === 'number' ? tmdbId : parseInt(String(tmdbId).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(numericTmdbId) && numericTmdbId > 0) {
        const apiKey = useSettingsStore.getState().tmdbApiKey;
        if (apiKey) {
          try {
            const showDetails = await getTvShowDetails(apiKey, numericTmdbId);
            const foundImdb = showDetails.external_ids?.imdb_id;
            if (foundImdb && /tt\d{7,8}/i.test(foundImdb)) {
              imdbId = foundImdb;
            }
          } catch (e) {
            console.warn('[SkipIntro] TMDb external_ids lookup failed:', e);
          }
        }
      }
    }

    // 7. TVMaze fallback by title
    if (!imdbId && vodInfo.title) {
      try {
        const searchUrl = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(vodInfo.title)}`;
        const res = await fetch(searchUrl);
        if (res.ok) {
          const data = await res.json();
          const tvmazeImdb = data?.externals?.imdb;
          if (tvmazeImdb && /tt\d{7,8}/i.test(tvmazeImdb)) {
            imdbId = tvmazeImdb;
          }
        }
      } catch (e) {
        // TVMaze lookup failed
      }
    }

    // 8. Season/Episode extraction from filename / URL / title if missing or 0
    if (!season || !episode || season <= 0 || episode <= 0) {
      const extracted =
        extractEpisodeNumber(vodInfo.url || '') ||
        extractEpisodeNumber(vodInfo.episodeInfo || '') ||
        extractEpisodeNumber(vodInfo.title || '');
      if (extracted) {
        if (!season || season <= 0) season = extracted.season;
        if (!episode || episode <= 0) episode = extracted.episode;
      }
    }
  }

  return { imdbId, season, episode };
}

export function useSkipIntro(options: UseSkipIntroOptions) {
  const { vodInfo, playing, position, duration, stremioEpisodeRef } = options;
  const [showButton, setShowButton] = useState(false);
  const [countdown, setCountdown] = useState(DEFAULT_SETTINGS.skipIntroTimerSeconds);

  const introRef = useRef<{ start: number; end: number } | null>(null);
  const dismissedRef = useRef(false);
  const fetchingRef = useRef(false);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const episodeKeyRef = useRef<string | null>(null);
  const settingsRef = useRef<SkipIntroSettings>({ ...DEFAULT_SETTINGS });
  const autoSkipTriggeredRef = useRef(false);

  const currentEpisodeKey = vodInfo?.mediaId || vodInfo?.url || null;

  // Hydrate settings on mount
  useEffect(() => {
    window.storage?.getSettings().then((res: any) => {
      if (res?.data) {
        if (typeof res.data.skipIntroTimerSeconds === 'number' && res.data.skipIntroTimerSeconds >= 3) {
          settingsRef.current.skipIntroTimerSeconds = res.data.skipIntroTimerSeconds;
          setCountdown(res.data.skipIntroTimerSeconds);
        }
        if (typeof res.data.skipIntroAutoSkip === 'boolean') {
          settingsRef.current.skipIntroAutoSkip = res.data.skipIntroAutoSkip;
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Partial<SkipIntroSettings>>).detail;
      if (typeof detail.skipIntroTimerSeconds === 'number' && detail.skipIntroTimerSeconds >= 3) {
        settingsRef.current.skipIntroTimerSeconds = detail.skipIntroTimerSeconds;
      }
      if (typeof detail.skipIntroAutoSkip === 'boolean') {
        settingsRef.current.skipIntroAutoSkip = detail.skipIntroAutoSkip;
      }
    };
    window.addEventListener('ynotv:skip-intro-settings-changed', handler);
    return () => window.removeEventListener('ynotv:skip-intro-settings-changed', handler);
  }, []);

  useEffect(() => {
    if (currentEpisodeKey === episodeKeyRef.current) return;
    episodeKeyRef.current = currentEpisodeKey;
    introRef.current = null;
    dismissedRef.current = false;
    fetchingRef.current = false;
    autoSkipTriggeredRef.current = false;
    setShowButton(false);
    setCountdown(settingsRef.current.skipIntroTimerSeconds);
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, [currentEpisodeKey]);

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!vodInfo || !playing || fetchingRef.current) return;
    if (vodInfo.type !== 'series') {
      return;
    }
    if (introRef.current) {
      return;
    }

    const fetchIntro = async () => {
      fetchingRef.current = true;
      try {
        const { imdbId, season, episode } = await resolveIntroDbParams(vodInfo, stremioEpisodeRef);
        console.log('[SkipIntro] Checking intro segments:', {
          title: vodInfo.title,
          imdbId,
          season,
          episode,
          url: vodInfo.url,
        });

        if (!imdbId || !season || !episode) {
          console.log('[SkipIntro] Insufficient metadata to query IntroDB:', { imdbId, season, episode });
          return;
        }

        const segment = await fetchIntroSegments(imdbId, season, episode);
        if (segment) {
          console.log(
            `[SkipIntro] Intro segment ready: ${segment.start_sec}s - ${segment.end_sec}s (autoSkip=${settingsRef.current.skipIntroAutoSkip})`
          );
          introRef.current = { start: segment.start_sec, end: segment.end_sec };
        } else {
          console.log('[SkipIntro] No intro segment found in IntroDB for', imdbId, `S${season}E${episode}`);
        }
      } catch (err) {
        console.error('[SkipIntro] Error resolving/fetching intro:', err);
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchIntro();
  }, [vodInfo, playing, stremioEpisodeRef]);

  useEffect(() => {
    if (!introRef.current) {
      return;
    }

    const { start, end } = introRef.current;

    if (!playing) {
      return;
    }

    if (position >= end) {
      if (showButton) {
        setShowButton(false);
        if (countdownTimerRef.current) {
          clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
      }
      return;
    }

    if (position >= start && settingsRef.current.skipIntroAutoSkip && !autoSkipTriggeredRef.current) {
      autoSkipTriggeredRef.current = true;
      dismissedRef.current = true;
      Bridge.seek(end).catch(() => {});
      return;
    }

    if (position >= start && !dismissedRef.current && !showButton && !settingsRef.current.skipIntroAutoSkip) {
      const timer = settingsRef.current.skipIntroTimerSeconds;
      setShowButton(true);
      setCountdown(timer);

      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
      }

      countdownTimerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownTimerRef.current) {
              clearInterval(countdownTimerRef.current);
              countdownTimerRef.current = null;
            }
            dismissedRef.current = true;
            setShowButton(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
  }, [position, playing, showButton]);

  const handleSkip = useCallback(() => {
    if (!introRef.current) return;
    dismissedRef.current = true;
    setShowButton(false);
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    Bridge.seek(introRef.current.end).catch(() => {});
  }, []);

  return { showButton, countdown, handleSkip };
}