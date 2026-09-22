import { Bridge } from './tauri-bridge';
import { db, ChannelMetadata } from '../db';
import { dbEvents } from '../db/sqlite-adapter';
import type { DashTrackCatalog, DashVideoRepresentation } from './native-dash';

/**
 * Video metadata capture service
 * Captures resolution, fps, and audio information from MPV player
 */

// In-memory cache to prevent reloading when components remount (e.g., scrolling)
const metadataCache = new Map<string, ChannelMetadata>();

// Per-source bulk metadata cache (stream_id -> metadata) used by the EPG
// resolution filter so filtering a whole category is a single indexed query.
const metadataBySourceCache = new Map<string, Map<string, ChannelMetadata>>();

// Automatically clear the in-memory cache when channelMetadata table updates (e.g. from probe scans or sync)
dbEvents.subscribe('channelMetadata', () => {
    metadataCache.clear();
    metadataBySourceCache.clear();
});

export function clearMetadataCache(streamId?: string) {
    if (streamId) {
        metadataCache.delete(streamId);
    } else {
        metadataCache.clear();
    }
}

export interface VideoMetadata {
    width: number;
    height: number;
    fps: number;
    audioChannels: number;
}

function parseDashFrameRate(value?: string): number | null {
    if (!value) return null;
    const [numeratorText, denominatorText] = value.split('/');
    const numerator = Number(numeratorText);
    const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
    const fps = numerator / denominator;
    return fps > 0 && fps <= 240 ? fps : null;
}

/** Highest advertised video size in the active native DASH manifest. */
export function getHighestDashRepresentation(
    catalog: DashTrackCatalog | null | undefined
): DashVideoRepresentation | null {
    if (!catalog?.active) return null;
    return catalog.videoRepresentations.reduce<DashVideoRepresentation | null>((best, candidate) => {
        if (!candidate.width || !candidate.height) return best;
        if (!best?.width || !best.height) return candidate;
        return candidate.width * candidate.height > best.width * best.height ? candidate : best;
    }, null);
}

/**
 * Capture current video metadata from MPV
 */
export async function captureVideoMetadata(): Promise<VideoMetadata | null> {
    try {
        // Native DASH starts conservatively and often renders an SD
        // Representation before ABR moves up. Channel badges describe the
        // stream's available quality, so use the highest manifest
        // Representation instead of persisting that transient startup size.
        const [width, height, fps, audioParams, dashCatalog] = await Promise.all([
            Bridge.getProperty('width'),
            Bridge.getProperty('height'),
            Bridge.getProperty('estimated-vf-fps'),
            Bridge.getProperty('audio-params'),
            Bridge.getNativeDashTrackCatalog().catch(() => null),
        ]);
        const highestDashRepresentation = getHighestDashRepresentation(dashCatalog);
        const dashFps = parseDashFrameRate(highestDashRepresentation?.frameRate);

        // audio-params might be null if audio isn't loaded yet
        const audioChannels = audioParams?.channels || 2;

        return {
            width: highestDashRepresentation?.width || width || 0,
            height: highestDashRepresentation?.height || height || 0,
            fps: dashFps || fps || 0,
            audioChannels
        };
    } catch (error) {
        console.error('[VideoMetadata] Failed to capture:', error);
        return null;
    }
}

/**
 * Convert resolution to quality label
 */
export function getQualityLabel(width: number, height: number): string {
    if (width >= 3840 || height >= 2160) return '4K';
    if (width >= 1920 || height >= 1080) return '1080p';
    if (width >= 1280 || height >= 720) return '720p';
    return 'SD';
}

/**
 * Normalize stored quality labels to a consistent short form, handling legacy
 * values (e.g. "FHD", "1080P", "UHD") alongside current ones.
 */
export function normalizeQualityLabel(label: string): string {
    const value = (label || '').trim();
    const upper = value.toUpperCase();
    if (upper === '4K' || upper === 'UHD') return '4K';
    if (upper === 'FHD' || upper === '1080P' || upper === '1080' || upper === '1920X1080') return '1080p';
    if (upper === 'HD' || upper === '720P' || upper === '720' || upper === '1280X720') return '720p';
    if (upper === 'SD') return 'SD';
    return value;
}

/** Resolution filter buckets shown in the EPG toolbar. */
export type QualityFilter = 'all' | '4k' | 'fhd' | 'hd' | 'sd';

/** True when a stored quality label belongs to the given filter bucket. */
export function qualityLabelMatchesFilter(label: string, filter: Exclude<QualityFilter, 'all'>): boolean {
    const normalized = normalizeQualityLabel(label);
    switch (filter) {
        case '4k': return normalized === '4K';
        case 'fhd': return normalized === '1080p';
        case 'hd': return normalized === '720p';
        case 'sd': return normalized === 'SD';
    }
}

/**
 * Fetch channel metadata for a set of sources in one indexed query per source
 * (idx_metadata_source), merged into a stream_id -> metadata map. Results are
 * cached per source and invalidated on channelMetadata table updates.
 */
export async function getChannelMetadataBySource(sourceIds: string[]): Promise<Map<string, ChannelMetadata>> {
    const result = new Map<string, ChannelMetadata>();
    const missing: string[] = [];
    for (const sid of sourceIds) {
        const cached = metadataBySourceCache.get(sid);
        if (cached) {
            for (const [streamId, meta] of cached) result.set(streamId, meta);
        } else {
            missing.push(sid);
        }
    }
    if (missing.length > 0) {
        const fresh = await Promise.all(missing.map(async (sid) => {
            const rows = await db.channelMetadata.where('source_id').equals(sid).toArray();
            const map = new Map<string, ChannelMetadata>();
            for (const row of rows) map.set(row.stream_id, row);
            return [sid, map] as const;
        }));
        for (const [sid, map] of fresh) {
            metadataBySourceCache.set(sid, map);
            for (const [streamId, meta] of map) result.set(streamId, meta);
        }
    }
    return result;
}

/**
 * Format audio channels to human-readable string
 */
export function formatAudioChannels(channels: number): string {
    if (channels >= 6) return '5.1';
    if (channels === 2) return 'Stereo';
    if (channels === 1) return 'Mono';
    return `${channels}CH`;
}

/**
 * Save channel metadata to database and cache
 */
export async function saveChannelMetadata(
    streamId: string,
    sourceId: string,
    metadata: VideoMetadata
): Promise<void> {
    const existing = await db.channelMetadata.get(streamId);
    const channelMetadata: ChannelMetadata = {
        stream_id: streamId,
        source_id: sourceId,
        resolution_width: metadata.width,
        resolution_height: metadata.height,
        fps: metadata.fps,
        audio_channels: formatAudioChannels(metadata.audioChannels),
        quality_label: getQualityLabel(metadata.width, metadata.height),
        video_bitrate_kbps: existing?.video_bitrate_kbps ?? null,
        audio_bitrate_kbps: existing?.audio_bitrate_kbps ?? null,
        bitrate_kbps: existing?.bitrate_kbps ?? null,
        last_updated: new Date().toISOString()
    };

    await db.channelMetadata.put(channelMetadata);
    // Update cache so badges show immediately
    metadataCache.set(streamId, channelMetadata);
    console.log(`[VideoMetadata]  Saved for ${streamId}:`, channelMetadata);
}

/**
 * Get channel metadata from cache or database
 * Uses in-memory cache for instant retrieval on remount
 */
export async function getChannelMetadata(streamId: string, forceRefresh = false): Promise<ChannelMetadata | null> {
    try {
        // Check memory cache first unless forceRefresh is true
        if (!forceRefresh) {
            const cached = metadataCache.get(streamId);
            if (cached) return cached;
        }

        // Fall back to SQLite DB
        const metadata = await db.channelMetadata.get(streamId);
        if (metadata) {
            metadataCache.set(streamId, metadata);
        }
        return metadata || null;
    } catch (error) {
        console.error('[VideoMetadata] Failed to get metadata:', error);
        return null;
    }
}

/**
 * Capture and save metadata for currently playing channel
 * Should be called after video starts playing successfully.
 * Retries with exponential backoff if stream hasn't loaded yet.
 */
export async function captureAndSaveMetadata(streamId: string, sourceId: string): Promise<void> {
    const maxRetries = 10;
    const baseDelay = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 1500 : baseDelay * Math.pow(1.5, attempt)));

        const metadata = await captureVideoMetadata();
        if (metadata && metadata.width > 0) {
            await saveChannelMetadata(streamId, sourceId, metadata);
            return;
        }

        console.log(`[VideoMetadata] Retry ${attempt + 1}/${maxRetries} for`, streamId);
    }

    console.warn('[VideoMetadata] No valid metadata captured for', streamId, 'after', maxRetries, 'attempts');
}
