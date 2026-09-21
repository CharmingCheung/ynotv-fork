import { describe, expect, it } from 'vitest';
import { M3U_HTTP_HEADERS_PROPERTY, parseM3U } from '../m3u-parser';

function headersFor(body: string): Record<string, string> {
  const channel = parseM3U(`#EXTM3U\n${body}`, 'headers').channels[0];
  const encoded = channel.kodi_props?.[M3U_HTTP_HEADERS_PROPERTY];
  return encoded ? JSON.parse(encoded) : {};
}

describe('M3U per-channel HTTP headers', () => {
  it.each([
    ['pipe header', 'https://example.com/live.m3u8|User-Agent=Mozilla/5.0', { 'User-Agent': 'Mozilla/5.0' }],
    ['pipe multi header', 'https://example.com/live.m3u8|User-Agent=Mozilla/5.0&Referer=https://example.com/&Origin=https://example.com', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/', Origin: 'https://example.com' }],
    ['pipe cookie', 'https://example.com/live.m3u8|Cookie=session%3Dabc%3B%20token%3D123', { Cookie: 'session=abc; token=123' }],
    ['pipe authorization', 'https://example.com/live.m3u8|Authorization=Bearer%20abcdef', { Authorization: 'Bearer abcdef' }],
    ['pipe custom', 'https://example.com/live.m3u8|X-Token=abc&X-Device-ID=123', { 'X-Token': 'abc', 'X-Device-ID': '123' }],
    ['Kodi bang prefix', 'https://example.com/live.m3u8|!X-Token=abc&!X-Device-ID=123', { 'X-Token': 'abc', 'X-Device-ID': '123' }],
    ['multiple pipes', 'https://example.com/live.m3u8|User-Agent=Mozilla/5.0|Referer=https://example.com/|Origin=https://example.com', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/', Origin: 'https://example.com' }],
    ['encoded pipe', 'https://example.com/live.m3u8|User-Agent=Mozilla%2F5.0%20Chrome&Referer=https%3A%2F%2Fexample.com%2F', { 'User-Agent': 'Mozilla/5.0 Chrome', Referer: 'https://example.com/' }],
    ['lowercase names', 'https://example.com/live.m3u8|user-agent=Mozilla/5.0&referer=https://example.com/', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/' }],
    ['mixed-case names', 'https://example.com/live.m3u8|User-agent=Mozilla/5.0&REFErer=https://example.com/', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/' }],
  ])('parses %s', (_name, url, expected) => {
    const body = `#EXTINF:-1,Channel\n${url}`;
    expect(headersFor(body)).toEqual(expected);
    expect(parseM3U(`#EXTM3U\n${body}`, 'headers').channels[0].direct_url).toBe('https://example.com/live.m3u8');
  });

  it('parses VLC, EXTHTTP, and EXTINF header forms', () => {
    expect(headersFor(`#EXTINF:-1,Channel
#EXTVLCOPT:http-user-agent=Mozilla/5.0
#EXTVLCOPT:http-referrer=https://example.com/
#EXTVLCOPT:http-origin=https://example.com
https://example.com/live.m3u8`)).toEqual({
      'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/', Origin: 'https://example.com',
    });

    expect(headersFor(`#EXTINF:-1,Channel
#EXTHTTP:{"Authorization":"Bearer abc","Cookie":"session=123","X-Token":"xyz"}
https://example.com/live.m3u8`)).toEqual({
      Authorization: 'Bearer abc', Cookie: 'session=123', 'X-Token': 'xyz',
    });

    expect(headersFor(`#EXTINF:-1 http-user-agent="Mozilla/5.0" http-referrer="https://example.com/",Channel
https://example.com/live.m3u8`)).toEqual({ 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/' });
    expect(headersFor(`#EXTINF:-1 user-agent="Alternate/1.0",Channel
https://example.com/live.m3u8`)).toEqual({ 'User-Agent': 'Alternate/1.0' });
  });

  it('parses Kodi adaptive header and DRM variants', () => {
    expect(headersFor(`#EXTINF:-1,Channel
#KODIPROP:inputstream.adaptive.common_headers=User-Agent=Mozilla%2F5.0&Referer=https%3A%2F%2Fexample.com
#KODIPROP:inputstream.adaptive.manifest_headers=Authorization=Bearer%20abc
#KODIPROP:inputstream.adaptive.stream_headers=Origin=https://example.com
https://example.com/manifest.mpd`)).toEqual({
      'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com', Authorization: 'Bearer abc', Origin: 'https://example.com',
    });

    expect(headersFor(`#EXTINF:-1,Channel
#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Mozilla/5.0
#KODIPROP:inputstream.adaptive.stream_headers=Referer=https://example.com/
#KODIPROP:inputstream.adaptive.stream_headers=Origin=https://example.com
https://example.com/manifest.mpd`)).toEqual({
      'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/', Origin: 'https://example.com',
    });

    expect(headersFor(`#EXTINF:-1,Channel
#KODIPROP:inputstream.adaptive.license_key=https://license.example.com|Authorization=Bearer%20abc&User-Agent=Mozilla%2F5.0
#KODIPROP:inputstream.adaptive.drm_legacy=com.widevine.alpha|https://license.example.com|X-Token=legacy
#KODIPROP:inputstream.adaptive.drm={"com.widevine.alpha":{"license":{"server_url":"https://license.example.com","req_headers":"Cookie=session%3D123"}}}
https://example.com/manifest.mpd`)).toEqual({
      Authorization: 'Bearer abc', 'User-Agent': 'Mozilla/5.0', 'X-Token': 'legacy', Cookie: 'session=123',
    });
  });

  it('does not leak headers into the next channel', () => {
    const channels = parseM3U(`#EXTM3U
#EXTINF:-1,One
#EXTHTTP:{"Authorization":"Bearer abc"}
https://example.com/one.m3u8
#EXTINF:-1,Two
https://example.com/two.m3u8`, 'headers').channels;
    expect(channels[0].kodi_props?.[M3U_HTTP_HEADERS_PROPERTY]).toBeTruthy();
    expect(channels[1].kodi_props).toBeUndefined();
  });
});
