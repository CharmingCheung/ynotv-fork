import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatProbeResultSummary, quickProbeChannel, activeQuickProbes, type ProbeChannelResult } from '../stream-probe';
import type { StoredChannel } from '../../db';
import { useSettingsStore } from '../../stores/settingsStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe('formatProbeResultSummary', () => {
  it('formats full alive probe result with quality, fps, audio, and bitrates', () => {
    const result: ProbeChannelResult = {
      stream_id: 'test_1',
      source_id: 'src_1',
      name: 'Channel 1',
      url: 'http://test.stream/live.ts',
      status: 'alive',
      quality_label: '1080p',
      fps: 59.94,
      audio_channels: '5.1',
      video_bitrate_kbps: 4620,
      audio_bitrate_kbps: 128,
    };

    expect(formatProbeResultSummary(result)).toBe('1080p · 60fps · 5.1 · V: 4.6M · A: 128K');
  });

  it('omits Stereo audio channel but includes other channels', () => {
    const result: ProbeChannelResult = {
      stream_id: 'test_2',
      source_id: 'src_1',
      name: 'Channel 2',
      url: 'http://test.stream/live.ts',
      status: 'alive',
      quality_label: '720p',
      fps: 30,
      audio_channels: 'Stereo',
      video_bitrate_kbps: 2100,
      audio_bitrate_kbps: 96,
    };

    expect(formatProbeResultSummary(result)).toBe('720p · 30fps · V: 2.1M · A: 96K');
  });

  it('formats bitrates below 1000 kbps as K', () => {
    const result: ProbeChannelResult = {
      stream_id: 'test_3',
      source_id: 'src_1',
      name: 'Channel 3',
      url: 'http://test.stream/live.ts',
      status: 'alive',
      quality_label: 'SD',
      video_bitrate_kbps: 850,
      audio_bitrate_kbps: 64,
    };

    expect(formatProbeResultSummary(result)).toBe('SD · V: 850K · A: 64K');
  });

  it('falls back to status when no quality or bitrate info exists', () => {
    const result: ProbeChannelResult = {
      stream_id: 'test_4',
      source_id: 'src_1',
      name: 'Channel 4',
      url: 'http://test.stream/live.ts',
      status: 'dead',
    };

    expect(formatProbeResultSummary(result)).toBe('dead');
  });
});

describe('quickProbeChannel', () => {
  const channel: StoredChannel = {
    stream_id: 'ch_1',
    source_id: 'src_1',
    name: 'ESPN HD',
    direct_url: 'http://example.com/live/ch1.m3u8',
    category_ids: ['cat_1'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      epgMetadataBadgeBitrate: false,
      epgMetadataBadgeAudioBitrate: false,
    });
  });

  it('probes channel, saves metadata, and enables bitrate badges when channel is alive', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockProbeResult = {
      stream_id: '',
      source_id: '',
      name: '',
      url: channel.direct_url,
      status: 'alive',
      resolution: '1080p',
      width: 1920,
      height: 1080,
      fps: 60,
      quality_label: '1080p',
      video_bitrate_kbps: 4500,
      audio_bitrate_kbps: 128,
    };

    (invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'probe_single_stream') {
        return Promise.resolve(mockProbeResult);
      }
      if (cmd === 'bulk_upsert_channel_metadata') {
        return Promise.resolve(1);
      }
      return Promise.resolve();
    });

    const result = await quickProbeChannel(channel);

    expect(result.status).toBe('alive');
    expect(result.quality_label).toBe('1080p');
    expect(result.video_bitrate_kbps).toBe(4500);
    expect(result.audio_bitrate_kbps).toBe(128);

    // Verify invoke was called with measureBitrate: true
    expect(invoke).toHaveBeenCalledWith('probe_single_stream', {
      url: channel.direct_url,
      userAgent: expect.any(String),
      timeoutSecs: 12,
      measureBitrate: true,
    });

    // Verify settings for bitrate badges were enabled
    expect(useSettingsStore.getState().epgMetadataBadgeBitrate).toBe(true);
    expect(useSettingsStore.getState().epgMetadataBadgeAudioBitrate).toBe(true);
  });

  it('tracks active probe in activeQuickProbes set', () => {
    expect(activeQuickProbes.has('some_stream')).toBe(false);
    activeQuickProbes.add('some_stream');
    expect(activeQuickProbes.has('some_stream')).toBe(true);
    activeQuickProbes.delete('some_stream');
    expect(activeQuickProbes.has('some_stream')).toBe(false);
  });

  it('passes M3U channel headers to the probe command', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    (invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'probe_single_stream') return Promise.resolve({ status: 'dead', url: channel.direct_url });
      return Promise.resolve();
    });

    await quickProbeChannel({
      ...channel,
      kodi_props: {
        'ynotv.http_headers': JSON.stringify({ Referer: 'https://example.com/', Origin: 'https://example.com' }),
      },
    });

    expect(invoke).toHaveBeenCalledWith('probe_single_stream', expect.objectContaining({
      headers: { Referer: 'https://example.com/', Origin: 'https://example.com' },
    }));
  });
});
