/**
 * HlsMultiviewCell — Secondary slot cell for HLS engine mode.
 *
 * Instead of positioning a native MPV window behind an overlay div, this
 * component renders a real <video> element driven by hls.js. Because the
 * video is part of the React DOM, any overlays (badges, controls, widgets)
 * can freely sit on top of it using normal z-index stacking.
 *
 * The component:
 *  - Self-manages hls.js lifecycle (create/destroy on URL change or unmount).
 *  - Falls back to native <video src> for browsers with built-in HLS (Safari).
 *  - Shows an error badge if hls.js cannot load the stream.
 *  - Exposes the same visual API as MultiviewCell (badge, controls bar, swap-on-click).
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Hls from 'hls.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { PlayIcon, PauseIcon, ReloadIcon, StopIcon, VolumeIcon, AspectRatioIcon } from './MultiviewIcons';
import { type AspectRatioMode, getAspectRatioLabel } from '../../services/tauri-bridge';
import './multiviewCellShared.css';
import './HlsMultiviewCell.css';

interface HlsMultiviewCellProps {
    slotId: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
    onSwapWithMain: () => void;
    onStop: () => void;
    onReload: () => void;
    hidden?: boolean;
}

export function HlsMultiviewCell({
    slotId,
    channelName,
    channelUrl,
    sourceName,
    active,
    onSwapWithMain,
    onStop,
    onReload,
    hidden,
}: HlsMultiviewCellProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const fatalRetryCountRef = useRef(0);
    const fatalRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Timestamp of the last fatal error, so the retry budget counts *consecutive*
    // failures within a window instead of a lifetime total. A stream that hiccups
    // once every few minutes must keep playing; only a stream that keeps failing
    // back-to-back should burn the budget and surface the error badge.
    const lastFatalAtRef = useRef(0);
    const FATAL_RETRY_WINDOW_MS = 30_000;
    const { t } = useTranslation('player');

    const [volume, setVolume] = useState(100);
    const [muted, setMuted] = useState(true);
    const [hlsError, setHlsError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    // includeSourceInSearch is a settings-store field — subscribe instead of
    // paying an IPC getSettings round-trip on mount (mirrors MultiviewCell).
    const showSourceName = useSettingsStore((s) => s.includeSourceInSearch);

    // Destroy hls instance helper
    const destroyHls = useCallback(() => {
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }
        if (videoRef.current) {
            const video = videoRef.current;
            video.pause();
            video.src = '';
            try {
                video.load();
            } catch (e) {
                // Ignore load errors on unmounted video
            }
        }
    }, []);

    // Load / reload whenever channelUrl or hidden status changes
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        destroyHls();
        if (fatalRetryTimerRef.current) {
            clearTimeout(fatalRetryTimerRef.current);
            fatalRetryTimerRef.current = null;
        }
        fatalRetryCountRef.current = 0;
        lastFatalAtRef.current = 0;
        setHlsError(null);

        if (!channelUrl || !active || hidden) {
            video.pause();
            video.src = '';
            try {
                video.load();
            } catch (e) {
                // Ignore load errors
            }
            return;
        }

        // hls.js CANNOT play raw MPEG-TS (.ts) streams. It needs an HLS manifest (.m3u8).
        // Many IPTV providers (like Xtream Codes) use .ts by default but support .m3u8 
        // on the exact same path just by changing the extension.
        let streamUrl = channelUrl;
        try {
            const parsed = new URL(streamUrl);
            if (parsed.pathname.endsWith('.ts')) {
                parsed.pathname = parsed.pathname.replace(/\.ts$/, '.m3u8');
                streamUrl = parsed.toString();
            }
        } catch (e) {
            if (streamUrl.endsWith('.ts')) {
                streamUrl = streamUrl.replace(/\.ts$/, '.m3u8');
            }
        }

        let watchdog: ReturnType<typeof setInterval> | null = null;
        const markProgress = () => { lastProgressAt = Date.now(); };
        let lastProgressAt = Date.now();

        if (Hls.isSupported()) {
            // IPTV live streams are plain (non low-latency) HLS. lowLatencyMode +
            // backBufferLength flushing is a known source of repeated black-frame /
            // rebuffer loops on such streams, so keep the normal buffer path and
            // give it generous headroom for multiview cells.
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 90,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                maxBufferSize: 60 * 1000 * 1000,
                liveSyncDurationCount: 3,
            });
            hlsRef.current = hls;
            video.addEventListener('timeupdate', markProgress);
            video.addEventListener('progress', markProgress);
            video.addEventListener('playing', markProgress);
            watchdog = setInterval(() => {
                if (video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
                if (Date.now() - lastProgressAt < 8_000) return;
                lastProgressAt = Date.now();
                try {
                    hls.startLoad();
                    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
                        hls.recoverMediaError();
                    }
                    video.play().catch(() => { });
                } catch { /* instance may be tearing down */ }
            }, 5_000);

            // Fatal-error recovery with a bounded, backed-off retry budget. The
            // previous code called startLoad()/recoverMediaError() unconditionally
            // on every fatal error, so a stream that kept failing (e.g. a .ts URL
            // rewritten to .m3u8 that the provider doesn't actually serve) looped
            // forever: video went black, retry, black, retry... with no backoff and
            // no user-visible signal. Now we pace retries and surface an error
            // badge once the budget is exhausted. The budget only counts
            // consecutive failures inside FATAL_RETRY_WINDOW_MS, so a glitchy
            // stream that occasionally drops is retried indefinitely while a
            // truly dead stream still gives up fast.
            const MAX_FATAL_RETRIES = 3;
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                console.warn('[HLS Error]', data.type, data.details);

                if (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    // Start a fresh streak if the previous fatal was long ago.
                    const now = Date.now();
                    if (now - lastFatalAtRef.current > FATAL_RETRY_WINDOW_MS) {
                        fatalRetryCountRef.current = 0;
                    }
                    lastFatalAtRef.current = now;
                    fatalRetryCountRef.current += 1;
                    if (fatalRetryCountRef.current > MAX_FATAL_RETRIES) {
                        // Give up: clear any pending retry first so it can't fire
                        // startLoad() on the instance we're about to destroy.
                        if (fatalRetryTimerRef.current) {
                            clearTimeout(fatalRetryTimerRef.current);
                            fatalRetryTimerRef.current = null;
                        }
                        setHlsError(`Fatal stream error: ${data.details}`);
                        destroyHls();
                        return;
                    }
                    console.warn(
                        `[HLS Error] fatal ${data.type} (attempt ${fatalRetryCountRef.current}/${MAX_FATAL_RETRIES}), retrying with backoff`
                    );
                    if (fatalRetryTimerRef.current) clearTimeout(fatalRetryTimerRef.current);
                    // hls.js does not add backoff to manual fatal recovery; pace it
                    // ourselves so a dead stream doesn't flash black at full speed.
                    fatalRetryTimerRef.current = setTimeout(() => {
                        fatalRetryTimerRef.current = null;
                        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                            hls.startLoad();
                        } else {
                            hls.recoverMediaError();
                        }
                    }, 1000 * fatalRetryCountRef.current);
                } else {
                    // Cannot recover (manifest/parser etc.)
                    setHlsError(`Fatal stream error: ${data.details}`);
                    destroyHls();
                }
            });

            hls.loadSource(streamUrl);
            hls.attachMedia(video);
            
            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                video.muted = true;
                video.play().catch(() => { /* autoplay blocked */ });
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native HLS support
            video.src = streamUrl;
            video.muted = true;
            video.play().catch(() => { });
            video.addEventListener('timeupdate', markProgress);
            video.addEventListener('progress', markProgress);
            video.addEventListener('playing', markProgress);
            watchdog = setInterval(() => {
                if (video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
                if (Date.now() - lastProgressAt < 8_000) return;
                lastProgressAt = Date.now();
                const resumeAt = video.currentTime;
                video.load();
                video.currentTime = resumeAt;
                video.play().catch(() => { });
            }, 5_000);
        } else {
            setHlsError('HLS is not supported in this environment.');
        }

        return () => {
            if (watchdog) clearInterval(watchdog);
            video.removeEventListener('timeupdate', markProgress);
            video.removeEventListener('progress', markProgress);
            video.removeEventListener('playing', markProgress);
            destroyHls();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelUrl, active, hidden]);

    // Reset volume & mute when new channel is loaded
    useEffect(() => {
        if (channelUrl && active) {
            setVolume(100);
            setMuted(true);
            setHlsError(null);
            if (videoRef.current) {
                videoRef.current.muted = true;
                videoRef.current.volume = 1;
            }
        }
    }, [channelUrl, active]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (fatalRetryTimerRef.current) clearTimeout(fatalRetryTimerRef.current);
            destroyHls();
        };
    }, [destroyHls]);

    const handleMuteToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        const newMuted = !muted;
        setMuted(newMuted);
        if (videoRef.current) {
            videoRef.current.muted = newMuted;
            if (!newMuted && volume === 0) {
                setVolume(100);
                videoRef.current.volume = 1;
            }
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVol = parseInt(e.target.value, 10);
        setVolume(newVol);
        if (videoRef.current) {
            videoRef.current.volume = newVol / 100;
        }
        if (newVol > 0 && muted) {
            setMuted(false);
            if (videoRef.current) videoRef.current.muted = false;
        }
    };

    const [playing, setPlaying] = useState(true);
    const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>('fill');
    const [showAspectMenu, setShowAspectMenu] = useState(false);

    const handlePlay = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        videoRef.current?.play().catch(() => { });
    };

    const handlePause = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        videoRef.current?.pause();
    };

    const handleTogglePlayPause = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (playing) handlePause();
        else handlePlay();
    };

    const handleRightClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (active) setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const displayName = useMemo(() => {
        if (showSourceName && sourceName) return `[${sourceName}] ${channelName}`;
        return channelName || '';
    }, [showSourceName, sourceName, channelName]);

    return (
        <div className={`multiview-cell-container hls-cell-container${active ? ' hls-cell-active' : ''}`}>
            {/* Real <video> element — visible to the browser compositor */}
            <video
                ref={videoRef}
                className="hls-cell-video"
                style={{ objectFit: aspectRatio === 'fill' ? 'cover' : aspectRatio === 'stretch' ? 'fill' : 'contain' }}
                muted
                playsInline
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
            />

            {/* Transparent interaction overlay — same id used by geometry helpers */}
            <div
                id={`mpv-video-rect-${slotId}`}
                className={`multiview-cell hls-cell-overlay ${active ? 'multiview-cell-active' : 'multiview-cell-empty'}`}
                onClick={() => { if (active) onSwapWithMain(); }}
                onContextMenu={(e) => { e.preventDefault(); if (active) setContextMenu({ x: e.clientX, y: e.clientY }); }}
                title={active ? t('clickToSwapMain', { name: displayName }) : t('sendToViewer')}
            >
                {/* Empty slot placeholder */}
                {!active && (
                    <div className="multiview-cell-overlay">
                        <div className="multiview-cell-slot-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="2" y="7" width="20" height="15" rx="2" />
                                <polyline points="17 2 12 7 7 2" />
                            </svg>
                        </div>
                        <span className="multiview-cell-slot-label">{t('viewerLabel', { slot: slotId })}</span>
                        <span className="multiview-cell-hint">{t('sendToViewer')}</span>
                        <span className="hls-badge">HLS</span>
                    </div>
                )}

                {/* Active: channel name badge (shows on hover via CSS) */}
                {active && !hlsError && (
                    <div className="multiview-cell-badge">
                        <span className="multiview-cell-name">{displayName}</span>
                        <span className="multiview-cell-swap-hint">{t('clickToSwap')}</span>
                        <span className="hls-badge">HLS</span>
                    </div>
                )}
            </div>

            {/* Error badge — sits above the video, below controls bar */}
            {active && hlsError && (
                <div className="hls-error-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{hlsError}</span>
                    <span className="hls-error-name">{displayName}</span>
                </div>
            )}

            {/* Dedicated clean borderless controls overlay at bottom of cell */}
            {active && (
                <div className="multiview-cell-controls" onClick={(e) => e.stopPropagation()} onContextMenu={handleRightClick}>
                    <div className="multiview-cell-controls-left">
                        <span className="multiview-cell-controls-slot">{slotId}</span>
                        <span className="multiview-cell-controls-name" title={displayName}>{displayName}</span>
                    </div>
                    <div className="multiview-cell-controls-buttons">
                        <div className="multiview-cell-controls-volume" onClick={(e) => e.stopPropagation()}>
                            <button
                                className="multiview-cell-controls-btn"
                                onClick={handleMuteToggle}
                                title={muted || volume === 0 ? t('unmute') : t('mute')}
                            >
                                <VolumeIcon muted={muted} volume={volume} />
                            </button>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={muted ? 0 : volume}
                                onChange={handleVolumeChange}
                                className="multiview-cell-volume-slider"
                                title={`${volume}%`}
                            />
                        </div>

                        <button
                            className="multiview-cell-controls-btn"
                            onClick={handleTogglePlayPause}
                            title={playing ? t('pause') : t('play')}
                        >
                            {playing ? <PauseIcon /> : <PlayIcon />}
                        </button>

                        <div className="multiview-cell-aspect-wrapper">
                            <button
                                className="multiview-cell-controls-btn"
                                onClick={() => setShowAspectMenu(v => !v)}
                                title={`${t('aspectRatio')}: ${getAspectRatioLabel(aspectRatio)}`}
                            >
                                <AspectRatioIcon />
                            </button>
                            {showAspectMenu && (
                                <div className="multiview-cell-aspect-menu">
                                    {(['fit', 'fill', 'stretch', '16:9', '4:3'] as AspectRatioMode[]).map((mode) => (
                                        <button
                                            key={mode}
                                            className={`multiview-cell-aspect-item ${aspectRatio === mode ? 'active' : ''}`}
                                            onClick={() => {
                                                setAspectRatio(mode);
                                                setShowAspectMenu(false);
                                            }}
                                        >
                                            {getAspectRatioLabel(mode)}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <button
                            className="multiview-cell-controls-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                onReload();
                            }}
                            title={t('reloadStream')}
                        >
                            <ReloadIcon />
                        </button>

                        <button
                            className="multiview-cell-controls-btn danger"
                            onClick={(e) => {
                                e.stopPropagation();
                                onStop();
                            }}
                            title={t('stop')}
                        >
                            <StopIcon />
                        </button>
                    </div>
                </div>
            )}

            {contextMenu && (
                <HlsCellContextMenu
                    position={contextMenu}
                    channelName={channelName}
                    onPlay={() => { videoRef.current?.play().catch(() => {}); setContextMenu(null); }}
                    onPause={() => { videoRef.current?.pause(); setContextMenu(null); }}
                    onReload={() => { onReload(); setContextMenu(null); }}
                    onStop={() => { onStop(); setContextMenu(null); }}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}

function HlsCellContextMenu({
    position,
    channelName,
    onPlay,
    onPause,
    onReload,
    onStop,
    onClose,
}: {
    position: { x: number; y: number };
    channelName: string | null;
    onPlay: () => void;
    onPause: () => void;
    onReload: () => void;
    onStop: () => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const { t } = useTranslation('player');

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="cell-context-menu"
            style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 9999 }}
        >
            {channelName && <div className="cell-context-header">{channelName}</div>}
            <button className="cell-context-item" onClick={onPlay}>▶ {t('playStream')}</button>
            <button className="cell-context-item" onClick={onPause}>⏸ {t('pauseStream')}</button>
            <button className="cell-context-item" onClick={onReload}>🔄 {t('reloadStream')}</button>
            <button className="cell-context-item cell-context-danger" onClick={onStop}>⏹ {t('stopClearSlot')}</button>
        </div>
    );
}
