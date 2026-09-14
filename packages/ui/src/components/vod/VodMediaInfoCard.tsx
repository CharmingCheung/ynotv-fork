import React from 'react';
import type { VodMediaInfo } from '../../services/vod-media-info';
import './VodMediaInfoCard.css';

interface VodMediaInfoCardProps {
  mediaInfo: VodMediaInfo | null;
  loading?: boolean;
  className?: string;
  compact?: boolean;
}

export const VodMediaInfoCard: React.FC<VodMediaInfoCardProps> = ({
  mediaInfo,
  loading = false,
  className = '',
  compact = false,
}) => {
  if (loading) {
    return (
      <div className={`vod-media-info-card vod-media-info-card--loading ${compact ? 'vod-media-info-card--compact' : ''} ${className}`}>
        <span className="vod-media-info-pill vod-media-info-pill--skeleton" />
        <span className="vod-media-info-pill vod-media-info-pill--skeleton" />
        <span className="vod-media-info-pill vod-media-info-pill--skeleton" />
      </div>
    );
  }

  if (!mediaInfo) return null;

  const {
    qualityLabel,
    resolution,
    videoCodec,
    videoBitrate,
    audioCodec,
    audioChannels,
    container,
    fileSize,
  } = mediaInfo;

  // If no fields are present, don't render an empty box
  const hasAnyData = Boolean(
    qualityLabel ||
    videoCodec ||
    videoBitrate ||
    audioCodec ||
    audioChannels ||
    container ||
    fileSize
  );

  if (!hasAnyData) return null;

  return (
    <div className={`vod-media-info-card ${compact ? 'vod-media-info-card--compact' : ''} ${className}`}>
      {/* Resolution / Quality */}
      {qualityLabel && (
        <span
          className={`vod-media-info-pill vod-media-info-pill--quality ${qualityLabel === '4K' ? 'vod-media-info-pill--4k' : ''}`}
          title={resolution ? `Resolution: ${resolution}` : undefined}
        >
          {qualityLabel}
        </span>
      )}

      {/* Video Codec */}
      {videoCodec && (
        <span className="vod-media-info-pill vod-media-info-pill--codec" title="Video Codec">
          {videoCodec}
        </span>
      )}

      {/* Video Bitrate */}
      {videoBitrate && (
        <span className="vod-media-info-pill vod-media-info-pill--bitrate" title="Bitrate">
          {videoBitrate}
        </span>
      )}

      {/* Audio Codec & Channels */}
      {(audioChannels || audioCodec) && (
        <span
          className="vod-media-info-pill vod-media-info-pill--audio"
          title={`Audio: ${[audioChannels, audioCodec].filter(Boolean).join(' ')}`}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="vod-media-info-pill-icon">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
          {[audioChannels, audioCodec].filter(Boolean).join(' ')}
        </span>
      )}

      {/* Container / File Format */}
      {container && (
        <span className="vod-media-info-pill vod-media-info-pill--container" title="Container Format">
          {container}
        </span>
      )}

      {/* File Size */}
      {fileSize && (
        <span className="vod-media-info-pill vod-media-info-pill--size" title="Estimated File Size">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="vod-media-info-pill-icon">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {fileSize}
        </span>
      )}
    </div>
  );
};
