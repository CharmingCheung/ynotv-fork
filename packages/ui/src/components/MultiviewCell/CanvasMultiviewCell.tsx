/**
 * CanvasMultiviewCell — Secondary slot cell using in-process libmpv Software Rendering into HTML5 <canvas>.
 *
 * Renders decoded video frames directly onto an in-DOM <canvas> element.
 * Because the canvas is part of the React DOM, overlays, context menus, badges,
 * hover cards, and modals render naturally on top using standard CSS z-index stacking.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, Channel } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/settingsStore';
import { PlayIcon, PauseIcon, ReloadIcon, StopIcon, VolumeIcon, AspectRatioIcon } from './MultiviewIcons';
import { type AspectRatioMode, getAspectRatioLabel } from '../../services/tauri-bridge';
import type { NativeDashPlaybackConfig } from '../../services/native-dash';
import './multiviewCellShared.css';
import './CanvasMultiviewCell.css';

interface CanvasMultiviewCellProps {
    slotId: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    nativeDash?: NativeDashPlaybackConfig;
    sourceName: string | null;
    active: boolean;
    onSwapWithMain: () => void;
    onStop: () => void;
    onReload: () => void;
    hidden?: boolean;
}

export function CanvasMultiviewCell({
    slotId,
    channelName,
    channelUrl,
    nativeDash,
    sourceName,
    active,
    onSwapWithMain,
    onStop,
    onReload,
    hidden,
}: CanvasMultiviewCellProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation('player');

    const [volume, setVolume] = useState(100);
    const [muted, setMuted] = useState(true);
    const [playing, setPlaying] = useState(true);
    const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>('fit');
    const [showAspectMenu, setShowAspectMenu] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const showSourceName = useSettingsStore((s) => s.includeSourceInSearch);

    const handleSetAspectRatio = useCallback((mode: AspectRatioMode) => {
        setAspectRatio(mode);
        setShowAspectMenu(false);
        switch (mode) {
            case 'fit':
                invoke('multiview_canvas_set_property', { slotId, property: 'video-aspect-override', value: '-1' }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'panscan', value: 0 }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'keepaspect', value: true }).catch(() => {});
                break;
            case 'fill':
                invoke('multiview_canvas_set_property', { slotId, property: 'video-aspect-override', value: '-1' }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'panscan', value: 1 }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'keepaspect', value: true }).catch(() => {});
                break;
            case 'stretch':
                invoke('multiview_canvas_set_property', { slotId, property: 'video-aspect-override', value: '-1' }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'panscan', value: 0 }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'keepaspect', value: false }).catch(() => {});
                break;
            case '16:9':
                invoke('multiview_canvas_set_property', { slotId, property: 'video-aspect-override', value: '16:9' }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'panscan', value: 0 }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'keepaspect', value: true }).catch(() => {});
                break;
            case '4:3':
                invoke('multiview_canvas_set_property', { slotId, property: 'video-aspect-override', value: '4:3' }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'panscan', value: 0 }).catch(() => {});
                invoke('multiview_canvas_set_property', { slotId, property: 'keepaspect', value: true }).catch(() => {});
                break;
        }
    }, [slotId]);

    // Start / Stop canvas stream whenever channelUrl, active, or hidden status changes
    useEffect(() => {
        if (!channelUrl || !active || hidden) {
            invoke('multiview_canvas_stop', { slotId }).catch(() => {});
            return;
        }

        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        const rect = container ? container.getBoundingClientRect() : { width: 640, height: 360 };
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const reqW = Math.max(320, Math.round(rect.width * dpr));
        const reqH = Math.max(180, Math.round(rect.height * dpr));

        canvas.width = reqW;
        canvas.height = reqH;

        const channel = new Channel<Uint8Array | number[]>();
        channel.onmessage = (data) => {
            try {
                const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
                if (uint8.byteLength < 8) return;

                const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
                const frameW = view.getUint32(0, true);
                const frameH = view.getUint32(4, true);

                if (frameW === 0 || frameH === 0) return;

                const expectedBytes = 8 + frameW * frameH * 4;
                if (uint8.byteLength < expectedBytes) return;

                const canvas = canvasRef.current;
                if (!canvas) return;

                if (canvas.width !== frameW || canvas.height !== frameH) {
                    canvas.width = frameW;
                    canvas.height = frameH;
                }

                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                const pixelSlice = uint8.subarray(8, expectedBytes);
                const pixels = new Uint8ClampedArray(pixelSlice.buffer, pixelSlice.byteOffset, frameW * frameH * 4);
                const imgData = new ImageData(pixels as any, frameW, frameH);
                ctx.putImageData(imgData, 0, 0);
            } catch (e) {
                // Ignore transient frame draw error
            } finally {
                // Release the backpressure gate so the Rust render loop can send
                // the next frame. Without this ack, frames pile up in the (unbounded)
                // IPC channel faster than the main thread can draw them — large-cell
                // layouts like 2x2 multiview ballooned to multi-GB memory.
                invoke('multiview_canvas_ack', { slotId }).catch(() => {});
            }
        };

        invoke('multiview_canvas_start', {
            slotId,
            url: channelUrl,
            nativeDash,
            width: reqW,
            height: reqH,
            channel,
        }).catch((err) => {
            console.error(`[CanvasMultiviewCell] Failed to start slot ${slotId}:`, err);
        });

        // Set initial mute & volume
        invoke('multiview_canvas_set_property', { slotId, property: 'mute', value: muted }).catch(() => {});
        invoke('multiview_canvas_set_property', { slotId, property: 'volume', value: volume }).catch(() => {});

        return () => {
            invoke('multiview_canvas_stop', { slotId }).catch(() => {});
        };
    }, [slotId, channelUrl, nativeDash, active, hidden]);

    // Handle container resize (debounced to avoid rapid reallocation during layout transitions)
    useEffect(() => {
        const container = containerRef.current;
        if (!container || !active || hidden) return;

        let resizeTimer: ReturnType<typeof setTimeout> | null = null;

        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    if (resizeTimer) clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(() => {
                        const dpr = Math.min(window.devicePixelRatio || 1, 2);
                        const reqW = Math.round(width * dpr);
                        const reqH = Math.round(height * dpr);
                        invoke('multiview_canvas_resize', { slotId, width: reqW, height: reqH }).catch(() => {});
                    }, 50);
                }
            }
        });

        resizeObserver.observe(container);
        return () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
        };
    }, [slotId, active, hidden]);

    // Volume & Mute helpers
    const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation();
        const val = Number(e.target.value);
        setVolume(val);
        if (muted && val > 0) {
            setMuted(false);
            invoke('multiview_canvas_set_property', { slotId, property: 'mute', value: false }).catch(() => {});
        }
        invoke('multiview_canvas_set_property', { slotId, property: 'volume', value: val }).catch(() => {});
    }, [slotId, muted]);

    const handleToggleMute = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !muted;
        setMuted(next);
        invoke('multiview_canvas_set_property', { slotId, property: 'mute', value: next }).catch(() => {});
    }, [slotId, muted]);

    const handleTogglePlayPause = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !playing;
        setPlaying(next);
        invoke('multiview_canvas_set_property', { slotId, property: 'pause', value: !next }).catch(() => {});
    }, [slotId, playing]);

    const handleRightClick = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    }, []);

    const displayName = useMemo(() => {
        if (!channelName) return '';
        if (showSourceName && sourceName) {
            return `${channelName} (${sourceName})`;
        }
        return channelName;
    }, [channelName, sourceName, showSourceName]);

    return (
        <div ref={containerRef} className="multiview-cell-container canvas-cell-container">
            {/* The in-DOM canvas surface */}
            <canvas
                ref={canvasRef}
                className="canvas-cell-canvas"
                style={{ objectFit: aspectRatio === 'fill' ? 'cover' : aspectRatio === 'stretch' ? 'fill' : 'contain' }}
            />

            {/* Transparent click/interaction overlay */}
            <div
                className={`canvas-cell-overlay ${active ? 'multiview-cell-active' : 'multiview-cell-empty'}`}
                onClick={active ? onSwapWithMain : undefined}
                onContextMenu={active ? handleRightClick : undefined}
                title={active ? t('clickToSwapMain', { name: displayName || channelName || '' }) : undefined}
            >
                {active && (
                    <div className="multiview-cell-badge">
                        <span className="multiview-cell-slot-num">{slotId}</span>
                        <span className="canvas-badge">LIBMPV</span>
                        <span className="multiview-cell-channel-name">{displayName}</span>
                    </div>
                )}
            </div>

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
                                onClick={handleToggleMute}
                                title={muted || volume === 0 ? t('unmute') : t('mute')}
                            >
                                <VolumeIcon muted={muted} volume={volume} />
                            </button>
                            <input
                                type="range"
                                className="multiview-cell-volume-slider"
                                min="0"
                                max="100"
                                value={muted ? 0 : volume}
                                onChange={handleVolumeChange}
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
                                            onClick={() => handleSetAspectRatio(mode)}
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

            {/* Context Menu on right click */}
            {contextMenu && (
                <CanvasCellContextMenu
                    position={contextMenu}
                    channelName={channelName}
                    onPlay={() => {
                        setPlaying(true);
                        invoke('multiview_canvas_set_property', { slotId, property: 'pause', value: false }).catch(() => {});
                        setContextMenu(null);
                    }}
                    onPause={() => {
                        setPlaying(false);
                        invoke('multiview_canvas_set_property', { slotId, property: 'pause', value: true }).catch(() => {});
                        setContextMenu(null);
                    }}
                    onReload={() => {
                        onReload();
                        setContextMenu(null);
                    }}
                    onStop={() => {
                        onStop();
                        setContextMenu(null);
                    }}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}

function CanvasCellContextMenu({
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
