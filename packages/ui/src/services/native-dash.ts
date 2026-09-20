export interface NativeDashPlaybackConfig {
  manifestUrl: string;
  drm: { type: 'clearkey'; kid: string; key: string };
}

export type NativeDashRoute =
  | { kind: 'normal' }
  | { kind: 'native'; config: NativeDashPlaybackConfig }
  | { kind: 'error'; error: string };

const CLEARKEY_RE = /^([0-9a-fA-F]{32}):([0-9a-fA-F]{32})$/;

export function routeNativeDash(manifestUrl: string, properties?: Record<string, string> | string): NativeDashRoute {
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
  if (manifestType !== 'mpd') return { kind: 'normal' };
  if (licenseType !== 'clearkey') {
    return { kind: 'error', error: `Unsupported DASH DRM type: ${licenseType || '(missing)'}` };
  }
  const match = licenseKey?.match(CLEARKEY_RE);
  if (!match) return { kind: 'error', error: 'Invalid ClearKey property' };
  return { kind: 'native', config: {
    manifestUrl,
    drm: { type: 'clearkey', kid: match[1].toLowerCase(), key: match[2].toLowerCase() },
  } };
}
