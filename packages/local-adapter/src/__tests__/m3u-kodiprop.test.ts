import { describe, expect, it } from 'vitest';
import { parseM3U } from '../m3u-parser';

describe('M3U KODIPROP parsing', () => {
  it('associates and preserves properties until the item URL', () => {
    const result = parseM3U(`#EXTM3U
#EXTINF:-1 tvg-id="dash",DASH
#KODIPROP:inputstream.adaptive.manifest_type=MPD
#KODIPROP:inputstream.adaptive.license_type=ClearKey
#KODIPROP:inputstream.adaptive.license_key=00112233445566778899AABBCCDDEEFF:FFEEDDCCBBAA99887766554433221100
#KODIPROP:future.property=kept
https://example.test/manifest
#EXTINF:-1,Plain
https://example.test/plain.ts`, 'source');

    expect(result.channels[0].kodi_props).toEqual({
      'inputstream.adaptive.manifest_type': 'MPD',
      'inputstream.adaptive.license_type': 'ClearKey',
      'inputstream.adaptive.license_key': '00112233445566778899AABBCCDDEEFF:FFEEDDCCBBAA99887766554433221100',
      'future.property': 'kept',
    });
    expect(result.channels[1].kodi_props).toBeUndefined();
  });
});
