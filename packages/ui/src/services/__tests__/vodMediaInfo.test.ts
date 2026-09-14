import { describe, it, expect } from 'vitest';
import {
  normalizeVideoCodec,
  normalizeAudioCodec,
  normalizeAudioChannels,
  getQualityLabel,
  formatBitrate,
  formatBytes,
  formatContainer,
  extractProviderFileSize,
  parseStreamMetadata,
} from '../vod-media-info';

describe('vod-media-info parser', () => {
  describe('normalizeVideoCodec', () => {
    it('normalizes HEVC / H.265 aliases', () => {
      expect(normalizeVideoCodec('hevc')).toBe('HEVC');
      expect(normalizeVideoCodec('h265')).toBe('HEVC');
      expect(normalizeVideoCodec('x265')).toBe('HEVC');
    });

    it('normalizes H.264 / AVC aliases', () => {
      expect(normalizeVideoCodec('h264')).toBe('H.264');
      expect(normalizeVideoCodec('avc')).toBe('H.264');
      expect(normalizeVideoCodec('x264')).toBe('H.264');
      expect(normalizeVideoCodec('avc1')).toBe('H.264');
    });

    it('normalizes other modern codecs', () => {
      expect(normalizeVideoCodec('av1')).toBe('AV1');
      expect(normalizeVideoCodec('vp9')).toBe('VP9');
      expect(normalizeVideoCodec('mpeg4')).toBe('MPEG-4');
      expect(normalizeVideoCodec('mpeg2video')).toBe('MPEG-2');
    });

    it('handles undefined, null, or empty string gracefully', () => {
      expect(normalizeVideoCodec(undefined)).toBeUndefined();
      expect(normalizeVideoCodec(null)).toBeUndefined();
      expect(normalizeVideoCodec('')).toBeUndefined();
    });
  });

  describe('normalizeAudioCodec', () => {
    it('normalizes Dolby and DTS codecs', () => {
      expect(normalizeAudioCodec('eac3')).toBe('E-AC-3');
      expect(normalizeAudioCodec('ac3')).toBe('AC-3');
      expect(normalizeAudioCodec('dts')).toBe('DTS');
      expect(normalizeAudioCodec('dtshd')).toBe('DTS-HD');
      expect(normalizeAudioCodec('truehd')).toBe('TrueHD');
    });

    it('normalizes standard audio codecs', () => {
      expect(normalizeAudioCodec('aac')).toBe('AAC');
      expect(normalizeAudioCodec('mp3')).toBe('MP3');
      expect(normalizeAudioCodec('flac')).toBe('FLAC');
      expect(normalizeAudioCodec('opus')).toBe('Opus');
    });
  });

  describe('normalizeAudioChannels', () => {
    it('maps channel counts to standard audio channel labels', () => {
      expect(normalizeAudioChannels(6)).toBe('5.1');
      expect(normalizeAudioChannels(8)).toBe('7.1');
      expect(normalizeAudioChannels(2)).toBe('Stereo');
      expect(normalizeAudioChannels(1)).toBe('Mono');
    });

    it('maps channel layout strings to standard labels', () => {
      expect(normalizeAudioChannels(undefined, '5.1(side)')).toBe('5.1');
      expect(normalizeAudioChannels(undefined, 'stereo')).toBe('Stereo');
      expect(normalizeAudioChannels(undefined, '7.1')).toBe('7.1');
    });
  });

  describe('getQualityLabel', () => {
    it('identifies 4K, 1080p, 720p, and SD', () => {
      expect(getQualityLabel(3840, 2160)).toBe('4K');
      expect(getQualityLabel(4096, 2160)).toBe('4K');
      expect(getQualityLabel(1920, 1080)).toBe('1080p');
      expect(getQualityLabel(1920, 800)).toBe('1080p');
      expect(getQualityLabel(1280, 720)).toBe('720p');
      expect(getQualityLabel(720, 480)).toBe('SD');
    });
  });

  describe('formatBitrate', () => {
    it('formats bps values above 100,000 into Mbps', () => {
      expect(formatBitrate(8500000)).toBe('8.5 Mbps');
      expect(formatBitrate('12000000')).toBe('12 Mbps');
    });

    it('formats kbps values into Mbps or kbps', () => {
      expect(formatBitrate(4500)).toBe('4.5 Mbps');
      expect(formatBitrate(384)).toBe('384 kbps');
    });

    it('handles invalid or zero bitrate gracefully', () => {
      expect(formatBitrate(0)).toBeUndefined();
      expect(formatBitrate(null)).toBeUndefined();
      expect(formatBitrate('invalid')).toBeUndefined();
    });
  });

  describe('formatBytes', () => {
    it('formats bytes into GB, MB, or KB', () => {
      expect(formatBytes(4.82 * 1024 * 1024 * 1024)).toBe('4.82 GB');
      expect(formatBytes(850 * 1024 * 1024)).toBe('850 MB');
      expect(formatBytes(500 * 1024)).toBe('500 KB');
    });

    it('handles undefined and invalid values', () => {
      expect(formatBytes(undefined)).toBeUndefined();
      expect(formatBytes(0)).toBeUndefined();
    });
  });

  describe('formatContainer', () => {
    it('cleans container extension', () => {
      expect(formatContainer('.mkv')).toBe('MKV');
      expect(formatContainer('mp4')).toBe('MP4');
      expect(formatContainer('avi')).toBe('AVI');
    });
  });

  describe('parseStreamMetadata', () => {
    it('parses typical Xtream info payload with video, audio, and container', () => {
      const info = {
        video: {
          codec_name: 'hevc',
          width: 3840,
          height: 2160,
          bit_rate: 15400000,
        },
        audio: {
          codec_name: 'eac3',
          channels: 6,
          channel_layout: '5.1',
        },
      };

      const result = parseStreamMetadata(info, 'mkv', 5.2 * 1024 * 1024 * 1024);
      expect(result.qualityLabel).toBe('4K');
      expect(result.resolution).toBe('3840×2160');
      expect(result.videoCodec).toBe('HEVC');
      expect(result.videoBitrate).toBe('15.4 Mbps');
      expect(result.audioCodec).toBe('E-AC-3');
      expect(result.audioChannels).toBe('5.1');
      expect(result.container).toBe('MKV');
      expect(result.fileSize).toBe('5.20 GB');
    });

    it('handles JSON stringified info and video/audio fields', () => {
      const info = JSON.stringify({
        video: JSON.stringify({
          codec_name: 'h264',
          width: 1920,
          height: 1080,
        }),
        audio: JSON.stringify({
          codec_name: 'aac',
          channels: 2,
        }),
        bitrate: 4500,
      });

      const result = parseStreamMetadata(info, '.mp4');
      expect(result.qualityLabel).toBe('1080p');
      expect(result.videoCodec).toBe('H.264');
      expect(result.audioCodec).toBe('AAC');
      expect(result.audioChannels).toBe('Stereo');
      expect(result.videoBitrate).toBe('4.5 Mbps');
      expect(result.container).toBe('MP4');
    });

    it('handles empty or missing info gracefully', () => {
      const result = parseStreamMetadata(null, 'mp4', 1.2 * 1024 * 1024 * 1024);
      expect(result.qualityLabel).toBeUndefined();
      expect(result.videoCodec).toBeUndefined();
      expect(result.container).toBe('MP4');
      expect(result.fileSize).toBe('1.20 GB');
    });

    it('safely handles corrupted "[object Object]" string without throwing', () => {
      const result = parseStreamMetadata('[object Object]', null, null, 'http://server.com/episodes/1234.mp4', 'American Dad! [1080p] [HEVC]');
      expect(result.qualityLabel).toBe('1080p');
      expect(result.videoCodec).toBe('HEVC');
      expect(result.container).toBe('MP4');
    });

    it('falls back to directUrl for container when container extension is null', () => {
      const result = parseStreamMetadata(null, null, null, 'http://server.com/movie/user/pass/123.mkv');
      expect(result.container).toBe('MKV');
    });

    it('falls back to title for quality and codec when provider has no video info', () => {
      const result = parseStreamMetadata({}, null, null, null, 'Avatar 2022 (4K HDR) HEVC');
      expect(result.qualityLabel).toBe('4K');
      expect(result.videoCodec).toBe('HEVC');
    });

    it('uses the size the provider reported when no probe was performed', () => {
      const result = parseStreamMetadata({ size: '5368709120' }, null, null, null, null);
      expect(result.fileSize).toBe('5.00 GB');
      expect(result.fileSizeBytes).toBe(5368709120);
    });
  });

  describe('extractProviderFileSize', () => {
    it('reads every size field a provider may use', () => {
      expect(extractProviderFileSize({ size: '4837281920' })).toBe(4837281920);
      expect(extractProviderFileSize({ filesize: 123456 })).toBe(123456);
      expect(extractProviderFileSize({ file_size: ' 900 ' })).toBe(900);
    });

    it('accepts a JSON-stringified info payload', () => {
      expect(extractProviderFileSize(JSON.stringify({ size: 2048 }))).toBe(2048);
    });

    it('returns null when there is no usable size', () => {
      expect(extractProviderFileSize(null)).toBeNull();
      expect(extractProviderFileSize(undefined)).toBeNull();
      expect(extractProviderFileSize({})).toBeNull();
      expect(extractProviderFileSize({ size: '0' })).toBeNull();
      expect(extractProviderFileSize({ size: '' })).toBeNull();
      expect(extractProviderFileSize('[object Object]')).toBeNull();
      expect(extractProviderFileSize('not json')).toBeNull();
    });

    it('falls through to a later field when an earlier one is unusable', () => {
      expect(extractProviderFileSize({ size: '', filesize: '4096' })).toBe(4096);
    });
  });
});
