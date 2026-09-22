import { describe, expect, it } from 'vitest';
import { getHighestDashRepresentation, getQualityLabel } from '../video-metadata';
import type { DashTrackCatalog } from '../native-dash';

function catalog(videoRepresentations: DashTrackCatalog['videoRepresentations']): DashTrackCatalog {
  return {
    active: true,
    videoAdaptationSetId: 'video',
    selectedVideoRepresentationId: 'sd',
    videoQualityMode: { type: 'auto' },
    abrStatistics: {
      throughputSampleCount: 0,
      currentRepresentation: 'sd',
      abrSwitchCount: 0,
      downSwitchCount: 0,
      upSwitchCount: 0,
    },
    selectedAudioAdaptationSetId: 'audio',
    videoRepresentations,
    audioTracks: [],
  };
}

describe('getHighestDashRepresentation', () => {
  it('uses the highest advertised quality while DASH is currently on SD', () => {
    const result = getHighestDashRepresentation(catalog([
      { representationId: 'sd', width: 640, height: 360, bandwidth: 500_000, codec: 'avc1', label: '640×360', compatible: true },
      { representationId: 'fhd', width: 1920, height: 1080, bandwidth: 5_000_000, codec: 'avc1', label: '1920×1080', compatible: true },
      { representationId: 'hd', width: 1280, height: 720, bandwidth: 2_000_000, codec: 'avc1', label: '1280×720', compatible: true },
    ]));

    expect(result?.representationId).toBe('fhd');
    expect(result?.height).toBe(1080);
  });

  it('ignores representations without dimensions', () => {
    const result = getHighestDashRepresentation(catalog([
      { representationId: 'unknown', bandwidth: 8_000_000, codec: 'avc1', label: 'unknown', compatible: true },
      { representationId: 'hd', width: 1280, height: 720, bandwidth: 2_000_000, codec: 'avc1', label: '1280×720', compatible: true },
    ]));

    expect(result?.representationId).toBe('hd');
  });

  it('selects UHD and classifies it as 4K', () => {
    const result = getHighestDashRepresentation(catalog([
      { representationId: 'fhd', width: 1920, height: 1080, bandwidth: 5_000_000, codec: 'avc1', label: '1920×1080', compatible: true },
      { representationId: 'uhd', width: 3840, height: 2160, bandwidth: 15_000_000, codec: 'hvc1', label: '3840×2160', compatible: true },
    ]));

    expect(result?.representationId).toBe('uhd');
    expect(getQualityLabel(result?.width || 0, result?.height || 0)).toBe('4K');
  });

  it('returns null when native DASH is inactive', () => {
    expect(getHighestDashRepresentation({ ...catalog([]), active: false })).toBeNull();
  });
});
