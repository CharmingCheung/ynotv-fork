import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bridge } from '../services/tauri-bridge';
import './PlaybackStatsModal.css';

interface PlaybackStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaTitle?: string | null;
  standalone?: boolean;
}

type StatsValues = Record<string, unknown>;

interface HistoryPoint {
  bitrate: number;
  buffer: number;
}

const STATS_PROPERTIES = [
  'media-title', 'time-pos', 'duration', 'pause', 'paused-for-cache', 'speed', 'avsync',
  'width', 'height', 'estimated-vf-fps', 'container-fps', 'display-fps',
  'video-codec', 'video-codec-name', 'video-format', 'video-params/pixelformat',
  'video-params/primaries', 'video-params/gamma', 'video-params/colorlevels',
  'hwdec-current', 'current-vo', 'video-bitrate', 'packet-video-bitrate',
  'audio-codec', 'audio-codec-name', 'audio-params/samplerate',
  'audio-params/channel-count', 'audio-params/channels', 'current-ao',
  'audio-bitrate', 'packet-audio-bitrate', 'demuxer-cache-duration',
  'cache-speed', 'cache-buffering-state', 'demuxer-via-network', 'file-format',
  'frame-drop-count', 'decoder-frame-drop-count', 'mistimed-frame-count',
  'vo-delayed-frame-count',
];

const numberValue = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const textValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
};

const boolValue = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'yes' || value === 'true';

const firstNumber = (values: StatsValues, ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = numberValue(values[key]);
    if (value !== null && value >= 0) return value;
  }
  return null;
};

const formatBitrate = (value: number | null): string => {
  if (value === null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)} Mbps`;
  return `${Math.round(value / 1_000)} kbps`;
};

const formatBytesPerSecond = (value: number | null): string => {
  if (value === null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB/s`;
  return `${Math.round(value)} B/s`;
};

const formatSeconds = (value: number | null, digits = 1): string =>
  value === null ? '—' : `${value.toFixed(digits)} s`;

const formatClock = (value: number | null): string => {
  if (value === null) return '—';
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const points = useMemo(() => {
    if (values.length < 2) return '';
    const max = Math.max(...values, 1);
    return values.map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 31 - (value / max) * 27;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }, [values]);

  return (
    <svg className="playback-stats-sparkline" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="32" x2="100" y2="32" className="playback-stats-sparkline-base" />
      {points && <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function StatRow({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`playback-stats-row${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

export function PlaybackStatsModal({ isOpen, onClose, mediaTitle, standalone = false }: PlaybackStatsModalProps) {
  const { t } = useTranslation('player');
  const [values, setValues] = useState<StatsValues>({});
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);

  const poll = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const next = await Bridge.getProperties(STATS_PROPERTIES);
      setValues(next);
      setError(null);
      const videoBitrate = firstNumber(next, 'video-bitrate', 'packet-video-bitrate') ?? 0;
      const audioBitrate = firstNumber(next, 'audio-bitrate', 'packet-audio-bitrate') ?? 0;
      const buffer = firstNumber(next, 'demuxer-cache-duration') ?? 0;
      setHistory((current) => [...current, { bitrate: videoBitrate + audioBitrate, buffer }].slice(-45));
    } catch (value) {
      setError(String(value));
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setHistory([]);
      return;
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, poll]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const width = firstNumber(values, 'width');
  const height = firstNumber(values, 'height');
  const fps = firstNumber(values, 'estimated-vf-fps', 'container-fps');
  const displayFps = firstNumber(values, 'display-fps');
  const videoBitrate = firstNumber(values, 'video-bitrate', 'packet-video-bitrate');
  const audioBitrate = firstNumber(values, 'audio-bitrate', 'packet-audio-bitrate');
  const totalBitrate = videoBitrate === null && audioBitrate === null
    ? null
    : (videoBitrate ?? 0) + (audioBitrate ?? 0);
  const buffer = firstNumber(values, 'demuxer-cache-duration');
  const cachePercent = firstNumber(values, 'cache-buffering-state');
  const paused = boolValue(values.pause);
  const buffering = boolValue(values['paused-for-cache']);
  const dropped = (firstNumber(values, 'frame-drop-count') ?? 0)
    + (firstNumber(values, 'decoder-frame-drop-count') ?? 0);
  const videoCodec = textValue(values['video-codec-name'] ?? values['video-codec']);
  const audioCodec = textValue(values['audio-codec-name'] ?? values['audio-codec']);
  const position = firstNumber(values, 'time-pos');
  const duration = firstNumber(values, 'duration');

  const labels = {
    title: t('playbackStats.title'),
    live: t('playbackStats.liveUpdate'),
    unavailable: t('playbackStats.waitingForData'),
    bitrate: t('playbackStats.totalBitrate'),
    buffer: t('playbackStats.bufferDuration'),
    resolution: t('playbackStats.videoSize'),
    fps: t('playbackStats.frameRate'),
    video: t('playbackStats.video'),
    audio: t('playbackStats.audio'),
    network: t('playbackStats.networkBuffer'),
    playback: t('playbackStats.playback'),
    codec: t('playbackStats.codec'),
    pixel: t('playbackStats.pixelFormat'),
    color: t('playbackStats.color'),
    hwdec: t('playbackStats.hardwareDecode'),
    output: t('playbackStats.outputDriver'),
    sampleRate: t('playbackStats.sampleRate'),
    channels: t('playbackStats.channels'),
    videoRate: t('playbackStats.videoBitrate'),
    audioRate: t('playbackStats.audioBitrate'),
    cacheSpeed: t('playbackStats.cacheSpeed'),
    cacheFill: t('playbackStats.cacheFill'),
    transport: t('playbackStats.inputType'),
    format: t('playbackStats.containerFormat'),
    state: t('playbackStats.state'),
    position: t('playbackStats.position'),
    sync: t('playbackStats.avSync'),
    dropped: t('playbackStats.droppedFrames'),
    delayed: t('playbackStats.delayedFrames'),
    speed: t('playbackStats.speed'),
    playing: t('playbackStats.playing'),
    paused: t('playbackStats.paused'),
    buffering: t('playbackStats.buffering'),
    networkInput: t('playbackStats.networkStream'),
    localInput: t('playbackStats.localMedia'),
    close: t('playbackStats.close'),
  };
  const networkInput = values['demuxer-via-network'] === null || values['demuxer-via-network'] === undefined
    ? '—'
    : boolValue(values['demuxer-via-network']) ? labels.networkInput : labels.localInput;

  const hasData = Object.values(values).some((value) => value !== null && value !== undefined);
  const playbackState = buffering ? labels.buffering : paused ? labels.paused : labels.playing;

  return (
    <div className={`playback-stats-overlay${standalone ? ' standalone' : ''}`} onMouseDown={standalone ? undefined : onClose} role="presentation">
      <section className="playback-stats-modal" role="dialog" aria-modal="true" aria-label={labels.title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="playback-stats-header">
          <div>
            <div className="playback-stats-title-line"><span className="playback-stats-live-dot" /><h2>{labels.title}</h2></div>
            <p>{mediaTitle || textValue(values['media-title']) || labels.unavailable}</p>
          </div>
          <div className="playback-stats-header-actions"><span>{labels.live}</span><button onClick={onClose} aria-label={labels.close}>×</button></div>
        </header>

        {error ? <div className="playback-stats-message error">{error}</div> : !hasData ? <div className="playback-stats-message">{labels.unavailable}</div> : <>
          <div className="playback-stats-summary">
            <div className="playback-stats-metric"><span>{labels.bitrate}</span><strong>{formatBitrate(totalBitrate)}</strong><Sparkline values={history.map((point) => point.bitrate)} color="#44d7ff" /></div>
            <div className="playback-stats-metric"><span>{labels.buffer}</span><strong>{formatSeconds(buffer)}</strong><Sparkline values={history.map((point) => point.buffer)} color="#8b7cff" /></div>
            <div className="playback-stats-metric compact"><span>{labels.resolution}</span><strong>{width && height ? `${width} × ${height}` : '—'}</strong><small>{textValue(values['video-params/pixelformat'])}</small></div>
            <div className="playback-stats-metric compact"><span>{labels.fps}</span><strong>{fps === null ? '—' : `${fps.toFixed(2)} fps`}</strong><small>{displayFps === null ? '—' : t('playbackStats.displayRefresh', { rate: displayFps.toFixed(2) })}</small></div>
          </div>

          <div className="playback-stats-sections">
            <div className="playback-stats-section"><h3><span className="video" />{labels.video}</h3><div className="playback-stats-grid">
              <StatRow label={labels.codec} value={videoCodec} />
              <StatRow label={labels.videoRate} value={formatBitrate(videoBitrate)} />
              <StatRow label={labels.hwdec} value={textValue(values['hwdec-current'])} />
              <StatRow label={labels.output} value={textValue(values['current-vo'])} />
              <StatRow label={labels.pixel} value={textValue(values['video-params/pixelformat'])} />
              <StatRow label={labels.color} value={[values['video-params/primaries'], values['video-params/gamma'], values['video-params/colorlevels']].filter(Boolean).join(' · ') || '—'} wide />
            </div></div>

            <div className="playback-stats-section"><h3><span className="audio" />{labels.audio}</h3><div className="playback-stats-grid">
              <StatRow label={labels.codec} value={audioCodec} />
              <StatRow label={labels.audioRate} value={formatBitrate(audioBitrate)} />
              <StatRow label={labels.sampleRate} value={firstNumber(values, 'audio-params/samplerate') === null ? '—' : `${Math.round((firstNumber(values, 'audio-params/samplerate') ?? 0) / 1000)} kHz`} />
              <StatRow label={labels.channels} value={textValue(values['audio-params/channels'] ?? values['audio-params/channel-count'])} />
              <StatRow label={labels.output} value={textValue(values['current-ao'])} wide />
            </div></div>

            <div className="playback-stats-section"><h3><span className="network" />{labels.network}</h3><div className="playback-stats-grid">
              <StatRow label={labels.buffer} value={formatSeconds(buffer)} />
              <StatRow label={labels.cacheSpeed} value={formatBytesPerSecond(firstNumber(values, 'cache-speed'))} />
              <StatRow label={labels.cacheFill} value={cachePercent === null ? '—' : `${cachePercent.toFixed(0)}%`} />
              <StatRow label={labels.transport} value={networkInput} />
              <StatRow label={labels.format} value={textValue(values['file-format'])} wide />
            </div></div>

            <div className="playback-stats-section"><h3><span className="playback" />{labels.playback}</h3><div className="playback-stats-grid">
              <StatRow label={labels.state} value={playbackState} />
              <StatRow label={labels.position} value={`${formatClock(position)} / ${formatClock(duration)}`} />
              <StatRow label={labels.sync} value={formatSeconds(firstNumber(values, 'avsync'), 3)} />
              <StatRow label={labels.dropped} value={String(dropped)} />
              <StatRow label={labels.delayed} value={textValue(values['vo-delayed-frame-count'] ?? values['mistimed-frame-count'])} />
              <StatRow label={labels.speed} value={`${(firstNumber(values, 'speed') ?? 1).toFixed(2)}×`} />
            </div></div>
          </div>
        </>}
      </section>
    </div>
  );
}
