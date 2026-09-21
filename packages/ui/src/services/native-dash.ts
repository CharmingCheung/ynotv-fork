import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface NativeDashPlaybackConfig {
  manifestUrl: string;
  requestHeaders?: Record<string, string>;
  drm: { type: 'clearkey'; kid: string; key: string };
}

export interface DashVideoRepresentation {
  representationId: string;
  width?: number;
  height?: number;
  bandwidth: number;
  codec: string;
  frameRate?: string;
  label: string;
  compatible: boolean;
}

export interface DashAudioTrack {
  adaptationSetId: string;
  mpvTrackId: number;
  language: string;
  label: string;
  role: string[];
  codec: string;
  channels?: string;
  sampleRate?: number;
  representationId: string;
}

export interface DashTrackCatalog {
  active: boolean;
  videoAdaptationSetId: string;
  selectedVideoRepresentationId: string;
  videoQualityMode: { type: 'auto' } | { type: 'manual'; representationId: string };
  pendingVideoRepresentationId?: string;
  abrStatistics: {
    throughputSampleCount: number;
    currentEstimate?: number;
    currentSafeBandwidth?: number;
    currentRepresentation: string;
    abrSwitchCount: number;
    downSwitchCount: number;
    upSwitchCount: number;
    lastSwitchReason?: string;
    bufferedSeconds?: number;
    minimumObservedBufferedSeconds?: number;
    maximumObservedBufferedSeconds?: number;
  };
  selectedAudioAdaptationSetId: string;
  videoRepresentations: DashVideoRepresentation[];
  audioTracks: DashAudioTrack[];
}

export type NativeDashRoute =
  | { kind: 'normal' }
  | { kind: 'native'; config: NativeDashPlaybackConfig }
  | { kind: 'error'; error: string };

const CLEARKEY_RE = /^([0-9a-fA-F]{32}):([0-9a-fA-F]{32})$/;

export type ManifestFormat = 'mpd' | 'hls' | 'unknown';
type ManifestProbe = (url: string, headers?: Record<string, string>) => Promise<ManifestFormat>;

export function classifyManifest(content: string, contentType = ''): ManifestFormat {
  const normalized = content.trimStart().replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<(?:[\w.-]+:)?MPD(?:\s|>)/i.test(normalized)) return 'mpd';
  if (normalized.startsWith('#EXTM3U') && /#EXT-X-/i.test(normalized)) return 'hls';

  const mime = contentType.toLowerCase();
  if (mime.includes('dash+xml')) return 'mpd';
  if (mime.includes('mpegurl')) return 'hls';
  return 'unknown';
}

export function getManifestProbeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const hasOrigin = Object.keys(headers).some(name => name.toLowerCase() === 'origin');
  // With the Tauri HTTP plugin's `unsafe-headers` feature, an explicit empty
  // Origin removes the webview's automatic `Origin: tauri://localhost`. Some
  // IPTV CDNs reject that synthetic origin even when the required UA is valid.
  return hasOrigin ? headers : { ...headers, Origin: '' };
}

async function probeManifest(url: string, headers?: Record<string, string>): Promise<ManifestFormat> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await tauriFetch(url, {
      method: 'GET', headers: getManifestProbeHeaders(headers), signal: controller.signal, connectTimeout: 10_000,
    });
    if (!response.ok) throw new Error(`Manifest probe failed: HTTP ${response.status}`);
    return classifyManifest(await response.text(), response.headers.get('content-type') || '');
  } finally {
    clearTimeout(timeout);
  }
}

export async function routeNativeDash(
  manifestUrl: string,
  properties?: Record<string, string> | string,
  requestHeaders?: Record<string, string>,
  inspectManifest: ManifestProbe = probeManifest,
): Promise<NativeDashRoute> {
  if (!properties) return { kind: 'normal' };
  let props: Record<string, string>;
  try {
    props = typeof properties === 'string' ? JSON.parse(properties) : properties;
  } catch {
    return { kind: 'normal' };
  }
  const manifestType = props['inputstream.adaptive.manifest_type']?.trim().toLowerCase();
  const licenseType = props['inputstream.adaptive.license_type']?.trim().toLowerCase();
  const licenseKey = props['inputstream.adaptive.license_key']?.trim();
  if (manifestType && manifestType !== 'mpd') return { kind: 'normal' };
  if (!manifestType) {
    // DRM metadata alone cannot distinguish DASH from HLS. Only pay the probe
    // cost when DRM metadata makes native routing relevant, then trust the
    // actual manifest body rather than its URL extension.
    if (!licenseType && !licenseKey) return { kind: 'normal' };
    let detected: ManifestFormat;
    try {
      detected = await inspectManifest(manifestUrl, requestHeaders);
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : 'Manifest probe failed' };
    }
    if (detected === 'hls') return { kind: 'normal' };
    if (detected !== 'mpd') return { kind: 'error', error: 'Unable to identify manifest format' };
  }
  if (licenseType !== 'clearkey') {
    return { kind: 'error', error: `Unsupported DASH DRM type: ${licenseType || '(missing)'}` };
  }
  const match = licenseKey?.match(CLEARKEY_RE);
  if (!match) return { kind: 'error', error: 'Invalid ClearKey property' };
  return { kind: 'native', config: {
    manifestUrl,
    ...(requestHeaders && Object.keys(requestHeaders).length > 0 && { requestHeaders }),
    drm: { type: 'clearkey', kid: match[1].toLowerCase(), key: match[2].toLowerCase() },
  } };
}
