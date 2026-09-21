import { describe, expect, it } from 'vitest';
import { classifyManifest, getManifestProbeHeaders, routeNativeDash } from '../native-dash';

describe('native DASH routing', () => {
  const base = {
    'inputstream.adaptive.manifest_type': 'MPD',
    'inputstream.adaptive.license_type': 'ClearKey',
  };
  it('normalizes a strict KID:key pair', async () => {
    const requestHeaders = { Referer: 'https://example.test/' };
    const route = await routeNativeDash('https://example.test/a.mpd', { ...base,
      'inputstream.adaptive.license_key': '00112233445566778899AABBCCDDEEFF:FFEEDDCCBBAA99887766554433221100' }, requestHeaders);
    expect(route.kind).toBe('native');
    if (route.kind === 'native') {
      expect(route.config.drm.kid).toBe('00112233445566778899aabbccddeeff');
      expect(route.config.drm.key).toBe('ffeeddccbbaa99887766554433221100');
      expect(route.config.requestHeaders).toEqual(requestHeaders);
    }
  });
  it.each(['short:00', 'g'.repeat(32) + ':' + '0'.repeat(32), '0'.repeat(64)])('rejects malformed key material', async value => {
    expect(await routeNativeDash('https://example.test/a.mpd', { ...base,
      'inputstream.adaptive.license_key': value })).toEqual({ kind: 'error', error: 'Invalid ClearKey property' });
  });
  it('rejects unsupported DRM explicitly', async () => {
    expect(await routeNativeDash('https://example.test/a.mpd', { ...base,
      'inputstream.adaptive.license_type': 'widevine' })).toEqual({ kind: 'error', error: 'Unsupported DASH DRM type: widevine' });
  });
  it('leaves unrelated streams alone', async () => {
    expect(await routeNativeDash('https://example.test/live.m3u8')).toEqual({ kind: 'normal' });
  });

  it('detects an actual MPD when manifest_type is omitted', async () => {
    const route = await routeNativeDash('https://example.test/extensionless', {
      'inputstream.adaptive.license_type': 'clearkey',
      'inputstream.adaptive.license_key': '0'.repeat(32) + ':' + '1'.repeat(32),
    }, { 'User-Agent': 'Channel/1.0' }, async (_url, headers) => {
      expect(headers).toEqual({ 'User-Agent': 'Channel/1.0' });
      return 'mpd';
    });
    expect(route.kind).toBe('native');
  });

  it('keeps ClearKey HLS on the normal playback path', async () => {
    expect(await routeNativeDash('https://example.test/extensionless', {
      'inputstream.adaptive.license_type': 'clearkey',
      'inputstream.adaptive.license_key': '0'.repeat(32) + ':' + '1'.repeat(32),
    }, undefined, async () => 'hls')).toEqual({ kind: 'normal' });
  });

  it('classifies manifests by body before content type', () => {
    expect(classifyManifest('<?xml version="1.0"?><MPD type="dynamic"></MPD>')).toBe('mpd');
    expect(classifyManifest('#EXTM3U\n#EXT-X-VERSION:3', 'application/dash+xml')).toBe('hls');
    expect(classifyManifest('', 'application/dash+xml')).toBe('mpd');
  });

  it('suppresses the synthetic Tauri Origin unless the channel configured one', () => {
    expect(getManifestProbeHeaders({ 'User-Agent': 'Channel/1.0' })).toEqual({
      'User-Agent': 'Channel/1.0', Origin: '',
    });
    const configured = { Origin: 'https://provider.example', Referer: 'https://provider.example/' };
    expect(getManifestProbeHeaders(configured)).toBe(configured);
  });
});
