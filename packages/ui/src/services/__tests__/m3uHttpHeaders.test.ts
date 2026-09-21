import { describe, expect, it } from 'vitest';
import { getM3uHttpHeaders, splitM3uUserAgent } from '../m3u-http-headers';

describe('M3U playback HTTP headers', () => {
  it('reads serialized channel headers and promotes User-Agent', () => {
    const headers = getM3uHttpHeaders({
      'ynotv.http_headers': JSON.stringify({
        'User-Agent': 'Channel/1.0', Referer: 'https://example.com/', Authorization: 'Bearer abc',
      }),
    });
    expect(splitM3uUserAgent(headers, 'Source/1.0')).toEqual({
      userAgent: 'Channel/1.0',
      headerFields: 'Referer: https://example.com/,Authorization: Bearer abc',
    });
  });

  it('ignores malformed metadata', () => {
    expect(getM3uHttpHeaders({ 'ynotv.http_headers': '{bad' })).toEqual({});
  });
});
