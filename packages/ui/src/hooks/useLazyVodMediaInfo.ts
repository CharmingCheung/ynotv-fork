/**
 * useLazyVodMediaInfo.ts
 *
 * Hook for lazy-loading VOD media file details (resolution, video codec, audio channels/codec,
 * bitrate, container format, file size) when opening the movie detail view.
 */

import { useState, useEffect, useRef } from 'react';
import type { StoredMovie } from '../db';
import { XtreamClient } from '@ynotv/local-adapter';
import { resolveSourceUserAgent } from '../db/sync';
import {
  type VodMediaInfo,
  extractProviderFileSize,
  parseStreamMetadata,
  probeFileSize,
} from '../services/vod-media-info';

// In-memory cache across component mounts to keep reopening instantaneous
const mediaInfoCache = new Map<string, VodMediaInfo>();
// Movies the provider genuinely has no metadata for. Without this, every reopen
// re-fetches get_vod_info and re-probes the stream URL for nothing.
const mediaInfoMisses = new Set<string>();

interface MediaInfoState {
  /** The stream this payload belongs to, so another movie's info is never shown. */
  id: string | null;
  info: VodMediaInfo | null;
  loading: boolean;
}

export function useLazyVodMediaInfo(movie: StoredMovie | null | undefined): {
  mediaInfo: VodMediaInfo | null;
  loading: boolean;
} {
  const streamId = movie?.stream_id ?? null;
  const [state, setState] = useState<MediaInfoState>(() => ({
    id: streamId,
    info: streamId ? mediaInfoCache.get(streamId) ?? null : null,
    loading: streamId ? !mediaInfoCache.has(streamId) && !mediaInfoMisses.has(streamId) : false,
  }));

  const inFlightRef = useRef<string | null>(null);

  useEffect(() => {
    if (!movie || !movie.stream_id) {
      setState({ id: null, info: null, loading: false });
      return;
    }

    const currentId = movie.stream_id;

    // Check the in-memory caches first
    const cached = mediaInfoCache.get(currentId);
    if (cached) {
      setState({ id: currentId, info: cached, loading: false });
      return;
    }

    if (mediaInfoMisses.has(currentId)) {
      setState({ id: currentId, info: null, loading: false });
      return;
    }

    if (inFlightRef.current === currentId) {
      return;
    }

    let cancelled = false;
    inFlightRef.current = currentId;
    // Drop the previous movie's payload here rather than after the request
    // settles: that is what stops stale pills rendering against a newly opened
    // movie when the same detail view instance is reused.
    setState({ id: currentId, info: null, loading: true });

    const loadDetails = async () => {
      // Tracked separately from the payload so an offline/provider failure is
      // never mistaken for "this movie has no metadata".
      let hadError = false;

      try {
        let providerInfo: any = null;
        let containerExt: string | null = movie.container_extension || null;

        // 1. Fetch Xtream get_vod_info if source credentials are available
        if (window.storage && movie.source_id) {
          try {
            const sourcesResult = await window.storage.getSources();
            const rawSource = sourcesResult.data?.find(
              (s: any) => String(s.id) === String(movie.source_id)
            );

            if (rawSource && rawSource.type === 'xtream' && rawSource.username && rawSource.password) {
              const source = await resolveSourceUserAgent(rawSource);
              if (source && source.username && source.password) {
                const client = new XtreamClient(
                  {
                    baseUrl: source.url,
                    username: source.username,
                    password: source.password,
                    userAgent: source.user_agent,
                  },
                  source.id
                );

                const fullData = await client.getVodFullInfo(movie.stream_id);
                if (fullData) {
                  providerInfo = fullData.info;
                  if (fullData.movie_data?.container_extension) {
                    containerExt = fullData.movie_data.container_extension;
                  }
                }
              }
            }
          } catch (e) {
            hadError = true;
            console.warn('[useLazyVodMediaInfo] Provider get_vod_info failed:', e);
          }
        }

        if (cancelled) return;

        // 2. File size: only probe the stream URL when the provider didn't
        //    already report a size — every probe is an extra request to the
        //    provider's stream endpoint, which some of them rate-limit.
        let fileSizeBytes: number | null = extractProviderFileSize(providerInfo);
        if (!fileSizeBytes && movie.direct_url) {
          try {
            fileSizeBytes = await probeFileSize(movie.source_id, movie.direct_url);
          } catch (e) {
            hadError = true;
            console.warn('[useLazyVodMediaInfo] File size probe failed:', e);
          }
        }

        if (cancelled) return;

        // 3. Parse stream metadata into normalized VodMediaInfo
        const parsed = parseStreamMetadata(
          providerInfo,
          containerExt,
          fileSizeBytes,
          movie.direct_url,
          movie.title || movie.name
        );

        // Cache result if any meaningful info was obtained
        const hasDetails = Boolean(
          parsed.qualityLabel ||
          parsed.videoCodec ||
          parsed.audioCodec ||
          parsed.audioChannels ||
          parsed.fileSize ||
          parsed.container
        );

        if (hasDetails) {
          mediaInfoCache.set(currentId, parsed);
          setState({ id: currentId, info: parsed, loading: false });
        } else {
          // Only remember "nothing here" when the lookup actually completed, so
          // a transient failure doesn't hide the info for the whole session.
          if (!hadError) {
            mediaInfoMisses.add(currentId);
          }
          setState({ id: currentId, info: null, loading: false });
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[useLazyVodMediaInfo] Failed to load media info:', err);
          setState({ id: currentId, info: null, loading: false });
        }
      } finally {
        if (!cancelled) {
          inFlightRef.current = null;
        }
      }
    };

    loadDetails();

    return () => {
      cancelled = true;
      if (inFlightRef.current === currentId) {
        inFlightRef.current = null;
      }
    };
  }, [movie?.stream_id, movie?.source_id, movie?.direct_url, movie?.container_extension]);

  // Read through the cache first so reopening a movie is instant, then fall back
  // to loaded state — but only when it belongs to the movie we were asked for.
  const cachedInfo = streamId ? mediaInfoCache.get(streamId) : undefined;
  const isKnownMiss = streamId ? mediaInfoMisses.has(streamId) : false;
  const mediaInfo = cachedInfo ?? (state.id === streamId ? state.info : null);
  const loading = state.id === streamId ? state.loading : Boolean(streamId) && !isKnownMiss;

  return { mediaInfo, loading };
}
