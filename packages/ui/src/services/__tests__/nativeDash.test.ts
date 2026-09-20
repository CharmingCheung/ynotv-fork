import { describe, expect, it } from 'vitest';
import { routeNativeDash } from '../native-dash';

describe('native DASH routing', () => {
  const base = {
    'inputstream.adaptive.manifest_type': 'MPD',
    'inputstream.adaptive.license_type': 'ClearKey',
  };
  it('normalizes a strict KID:key pair', () => {
    const route = routeNativeDash('https://example.test/a.mpd', { ...base,
      'inputstream.adaptive.license_key': '00112233445566778899AABBCCDDEEFF:FFEEDDCCBBAA99887766554433221100' });
    expect(route.kind).toBe('native');
    if (route.kind === 'native') {
      expect(route.config.drm.kid).toBe('00112233445566778899aabbccddeeff');
      expect(route.config.drm.key).toBe('ffeeddccbbaa99887766554433221100');
    }
  });
  it.each(['short:00', 'g'.repeat(32) + ':' + '0'.repeat(32), '0'.repeat(64)])('rejects malformed key material', value => {
    expect(routeNativeDash('https://example.test/a.mpd', { ...base,
      'inputstream.adaptive.license_key': value })).toEqual({ kind: 'error', error: 'Invalid ClearKey property' });
  });
  it('rejects unsupported DRM explicitly', () => {
    expect(routeNativeDash('https://example.test/a.mpd', { ...base,
      'inputstream.adaptive.license_type': 'widevine' })).toEqual({ kind: 'error', error: 'Unsupported DASH DRM type: widevine' });
  });
  it('leaves unrelated streams alone', () => {
    expect(routeNativeDash('https://example.test/live.m3u8')).toEqual({ kind: 'normal' });
  });
});
