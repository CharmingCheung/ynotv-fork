import { useRef, useState, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { HlsMultiviewCell } from '../MultiviewCell/HlsMultiviewCell';
import { CanvasMultiviewCell } from '../MultiviewCell/CanvasMultiviewCell';
import { PlayIcon, PauseIcon, ReloadIcon, StopIcon, VolumeIcon, AspectRatioIcon } from '../MultiviewCell/MultiviewIcons';
import { type AspectRatioMode, getAspectRatioLabel } from '../../services/tauri-bridge';
import { ViewerSlot, type MultiviewEngineMode } from '../../hooks/useMultiview';
import { useDraggable } from '../../hooks/useDraggable';
import { useResizable } from '../../hooks/useResizable';
import { useSettingsStore } from '../../stores/settingsStore';
import '../MultiviewCell/multiviewCellShared.css';
import './MultiviewLayout.css';

interface HlsAbsoluteWrapperProps {
    slotId: 2 | 3 | 4;
    activeView: string;
    layout: string;
    hidden?: boolean;
    active: boolean;
    children: React.ReactNode;
}

function HlsAbsoluteWrapper({ slotId, activeView, layout, hidden, active, children }: HlsAbsoluteWrapperProps) {
    const [style, setStyle] = useState<React.CSSProperties>({ display: 'none' });
    const lastStyleKeyRef = useRef<string>('');
    const zoomRef = useRef<number>(1);

    // Pick the DOM container that defines where this slot's video lives:
    // the EPG preview grid (Guide), the Sports preview pane, or the Hero
    // multiview layout grids. All multiview engines render as DOM elements, so
    // any container works as long as it's on screen in the active view.
    const containerId = () => {
        if (activeView === 'guide') return `epg-slot-container-${slotId}`;
        if (activeView === 'sports') return `sports-slot-container-${slotId}`;
        return `multiview-slot-container-${slotId}`;
    };

    const zIndexFor = (view: string) => {
        if (view === 'guide') return 1000;
        if (view === 'sports') return 1000; // above .sports-hub (z-index: 100)
        return 10;
    };

    useLayoutEffect(() => {
        // Reset the cache whenever the effect re-runs (view/layout/container
        // change) so the first updatePosition call always paints fresh.
        lastStyleKeyRef.current = '';

        // Cache --app-zoom once per effect run + window resize instead of
        // reading getComputedStyle on every 50ms poll tick (forced style
        // recalculation churn across all slots).
        const readZoom = () => {
            zoomRef.current = parseFloat(
                getComputedStyle(document.documentElement).getPropertyValue('--app-zoom').trim()
            ) || 1;
        };
        readZoom();

        const updatePosition = () => {
            if (!active) {
                lastStyleKeyRef.current = '';
                // Skip the re-render when the wrapper is already hidden — the
                // old code set a fresh object every 50ms even while hidden.
                setStyle(prev => (prev.display === 'none' ? prev : { display: 'none' }));
                return;
            }

            const id = containerId();
            const el = document.getElementById(id);
            if (!el) {
                lastStyleKeyRef.current = '';
                setStyle(prev => (prev.display === 'none' ? prev : { display: 'none' }));
                return;
            }

            const zoom = zoomRef.current;
            const rect = el.getBoundingClientRect();
            const key = `${rect.left}|${rect.top}|${rect.width}|${rect.height}|${zoom}`;
            // The 50ms interval calls this constantly; skip the setState (and the
            // resulting video-layer re-composite) when the cell hasn't actually
            // moved. Re-rendering identical geometry 20x/sec is what made HLS
            // cells flicker/black-paint intermittently in WebView2.
            if (key === lastStyleKeyRef.current) return;
            lastStyleKeyRef.current = key;
            setStyle({
                position: 'fixed',
                left: `${rect.left / zoom}px`,
                top: `${rect.top / zoom}px`,
                width: `${rect.width / zoom}px`,
                height: `${rect.height / zoom}px`,
                zIndex: zIndexFor(activeView),
                pointerEvents: 'auto',
                borderRadius: window.getComputedStyle(el).borderRadius,
                overflow: 'hidden',
            });
        };

        updatePosition();

        let observer: ResizeObserver | null = null;
        const targetEl = document.getElementById(containerId());
        if (targetEl) {
            observer = new ResizeObserver(() => {
                requestAnimationFrame(updatePosition);
            });
            observer.observe(targetEl);
        }

        const onResize = () => {
            readZoom();
            updatePosition();
        };
        window.addEventListener('resize', onResize);
        
        // Sync position frequently to follow React layout transitions and state updates smoothly
        const intervalId = setInterval(updatePosition, 50);

        return () => {
            if (observer) observer.disconnect();
            window.removeEventListener('resize', onResize);
            clearInterval(intervalId);
        };
    }, [slotId, activeView, layout, hidden, active]);

    return (
        <div className="hls-absolute-wrapper" style={{ ...style, transition: 'none' }}>
            {children}
        </div>
    );
}

interface MultiviewLayoutProps {
    layout: 'main' | 'pip' | '2x2' | 'bigbottom' | 'sbs';
    slots: ViewerSlot[];
    engineMode: MultiviewEngineMode;
    mainChannelName: string | null;
    mainPlaying: boolean;
    mainMuted: boolean;
    mainVolume: number;
    mainAspectRatio?: AspectRatioMode;
    onMainSetAspectRatio?: (mode: AspectRatioMode) => void;
    onMainTogglePlayPause: () => void;
    onMainToggleMute: () => void;
    onMainSetVolume: (vol: number) => void;
    onSwapWithMain: (slotId: 2 | 3 | 4) => void;
    onMainStop: () => void;
    onMainReload: () => void;
    onStop: (slotId: 2 | 3 | 4) => void;
    onReload: (slotId: 2 | 3 | 4) => void;
    onSetProperty: (slotId: 2 | 3 | 4, property: string, value: any) => void;
    onReposition?: () => void;
    onSwitchLayout?: (layout: 'main' | 'pip' | '2x2' | 'bigbottom' | 'sbs') => void;
    hidden?: boolean;
    activeView: string;
    syncMpvGeometry?: () => void;
}

export function MultiviewLayout({
    layout,
    slots,
    engineMode,
    mainChannelName,
    mainPlaying,
    mainMuted,
    mainVolume,
    mainAspectRatio,
    onMainSetAspectRatio,
    onMainTogglePlayPause,
    onMainToggleMute,
    onMainSetVolume,
    onSwapWithMain,
    onMainStop,
    onMainReload,
    onStop,
    onReload,
    onSetProperty,
    onReposition,
    onSwitchLayout,
    hidden,
    activeView,
    syncMpvGeometry,
}: MultiviewLayoutProps) {
    const { t } = useTranslation('player');
    const [showMainAspectMenu, setShowMainAspectMenu] = useState(false);
    const audioMaxVolume = useSettingsStore((s) => s.subtitleSettings?.audioMaxVolume || 100);
    const slot2 = slots.find(s => s.id === 2)!;
    const slot3 = slots.find(s => s.id === 3)!;
    const slot4 = slots.find(s => s.id === 4)!;
    const pipDragRef = useRef<HTMLDivElement>(null);
    const pipResizeRef = useRef<HTMLDivElement>(null);
    useDraggable(pipDragRef, () => {
        onReposition?.();
    });
    useResizable(pipResizeRef, pipDragRef, () => {
        onReposition?.();
    }, 16 / 9, 36);

    // Sync native MPV geometry when placeholder renders on the Hero page.
    // Event-driven only (mount, window resize, placeholder size change) plus a
    // single post-paint pass — the old continuous 100ms polling interval is gone.
    useLayoutEffect(() => {
        if (activeView !== 'none' || layout === 'main') return;

        const placeholder = document.querySelector('.layout-mpv-placeholder');
        if (!placeholder) return;

        const updatePosition = () => {
            if (activeView === 'none') {
                syncMpvGeometry?.();
            }
        };

        const observer = new ResizeObserver(() => {
            requestAnimationFrame(updatePosition);
        });
        observer.observe(placeholder);

        window.addEventListener('resize', updatePosition);

        // Immediate sync on mount, plus one-shot after the next paint so the
        // geometry reflects the settled post-commit layout.
        updatePosition();
        const rafId = requestAnimationFrame(() => requestAnimationFrame(updatePosition));

        return () => {
            observer.disconnect();
            window.removeEventListener('resize', updatePosition);
            cancelAnimationFrame(rafId);
        };
    }, [layout, activeView, syncMpvGeometry]);

    const isHls = engineMode === 'hls';
    const isCanvas = engineMode === 'mpv_canvas';

    // Render slot placeholder inside the layouts for in-DOM positioning
    const cell = (slot: ViewerSlot) => (
        <div 
            key={slot.id}
            id={`multiview-slot-container-${slot.id}`} 
            className="multiview-cell-container hls-cell-container"
            style={{ background: 'transparent' }}
        />
    );

    if (layout === 'main') {
        // MPV fills the window — no cells visible
        return null;
    }

    const mainControls = (
        <div className="multiview-cell-controls primary-mpv-controls" onClick={(e) => e.stopPropagation()}>
            <div className="multiview-cell-controls-left">
                <span className="multiview-cell-controls-slot">1</span>
                <span className="multiview-cell-controls-name" title={mainChannelName || t('mainPlayer')}>
                    {mainChannelName || t('mainPlayer')}
                </span>
            </div>
            <div className="multiview-cell-controls-buttons">
                <div className="multiview-cell-controls-volume" onClick={(e) => e.stopPropagation()}>
                    <button
                        className="multiview-cell-controls-btn"
                        onClick={onMainToggleMute}
                        title={mainMuted || mainVolume === 0 ? t('unmute') : t('mute')}
                    >
                        <VolumeIcon muted={mainMuted} volume={mainVolume} />
                    </button>
                    <input
                        type="range"
                        className="multiview-cell-volume-slider"
                        min="0"
                        max={audioMaxVolume}
                        value={mainMuted ? 0 : mainVolume}
                        onChange={(e) => onMainSetVolume(parseInt(e.target.value))}
                        title={`${mainVolume}%`}
                    />
                </div>

                <button
                    className="multiview-cell-controls-btn"
                    onClick={onMainTogglePlayPause}
                    title={mainPlaying ? t('pause') : t('play')}
                >
                    {mainPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>

                <div className="multiview-cell-aspect-wrapper">
                    <button
                        className="multiview-cell-controls-btn"
                        onClick={() => setShowMainAspectMenu(v => !v)}
                        title={`${t('aspectRatio')}: ${getAspectRatioLabel(mainAspectRatio || 'fit')}`}
                    >
                        <AspectRatioIcon />
                    </button>
                    {showMainAspectMenu && (
                        <div className="multiview-cell-aspect-menu">
                            {(['fit', 'fill', 'stretch', '16:9', '4:3'] as AspectRatioMode[]).map((mode) => (
                                <button
                                    key={mode}
                                    className={`multiview-cell-aspect-item ${mainAspectRatio === mode ? 'active' : ''}`}
                                    onClick={() => {
                                        onMainSetAspectRatio?.(mode);
                                        setShowMainAspectMenu(false);
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
                    onClick={onMainReload}
                    title={t('reloadStream')}
                >
                    <ReloadIcon />
                </button>

                <button
                    className="multiview-cell-controls-btn danger"
                    onClick={onMainStop}
                    title={t('stop')}
                >
                    <StopIcon />
                </button>
            </div>
        </div>
    );

    const layoutContent = (() => {
        if (layout === 'pip') {
            return (
                <div 
                    className="layout-pip-overlay" 
                    data-engine={engineMode} 
                    ref={pipDragRef}
                    style={{ display: hidden || activeView !== 'none' ? 'none' : undefined }}
                >
                    <div className="layout-pip-container">
                        <button
                            className="layout-pip-close"
                            onClick={(e) => {
                                e.stopPropagation();
                                onStop(2);
                                // If the pip slot had no active stream, don't
                                // strand the user in an empty pip layout — the
                                // close button promises a return to Main View.
                                if (!slot2.active) {
                                    onSwitchLayout?.('main');
                                }
                            }}
                            title={t('closeReturnMain')}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>
                        {cell(slot2)}
                        <div className="layout-pip-resize" ref={pipResizeRef} title={t('dragToResize')} />
                    </div>
                </div>
            );
        }

        if (layout === '2x2') {
            return (
                <div className="layout-2x2-cells" data-engine={engineMode} style={{ display: hidden || activeView !== 'none' ? 'none' : undefined }}>
                    {/* Top-left grid cell: occupied by primary MPV (renders behind this div).
                        Must always be rendered so slots 2/3/4 land in the correct grid positions.
                        CSS removes the box-shadow curtain in HLS mode. */}
                    <div className="layout-mpv-placeholder layout-2x2-mpv">
                        {mainControls}
                    </div>
                    {cell(slot2)}
                    {cell(slot3)}
                    {cell(slot4)}
                </div>
            );
        }

        if (layout === 'sbs') {
            return (
                <div className="layout-sbs-cells" data-engine={engineMode} style={{ display: hidden || activeView !== 'none' ? 'none' : undefined }}>
                    <div className="layout-mpv-placeholder layout-sbs-mpv">
                        {mainControls}
                    </div>
                    {cell(slot2)}
                </div>
            );
        }

        if (layout === 'bigbottom') {
            return (
                <div 
                    className="layout-bigbottom-cells" 
                    data-engine={engineMode} 
                    style={{ display: hidden || activeView !== 'none' ? 'none' : undefined }}
                >
                    {/* Top grid row: primary MPV renders behind this placeholder.
                        Must always be rendered so layout-bottom-bar stays in grid row 2.
                        CSS removes the box-shadow curtain in HLS mode. */}
                    <div className="layout-mpv-placeholder layout-bigbottom-mpv">
                        {mainControls}
                    </div>
                    <div className="layout-bottom-bar">
                        {cell(slot2)}
                        {cell(slot3)}
                        {cell(slot4)}
                    </div>
                </div>
            );
        }

        return null;
    })();

    return (
        <>
            {isHls && slots.map(slot => (
                <HlsAbsoluteWrapper 
                    key={slot.id} 
                    slotId={slot.id as 2 | 3 | 4} 
                    activeView={activeView}
                    layout={layout}
                    hidden={hidden}
                    active={slot.active}
                >
                    <HlsMultiviewCell
                        slotId={slot.id as 2 | 3 | 4}
                        channelName={slot.channelName}
                        channelUrl={slot.channelUrl}
                        sourceName={slot.sourceName}
                        active={slot.active}
                        onSwapWithMain={() => onSwapWithMain(slot.id)}
                        onStop={() => onStop(slot.id)}
                        onReload={() => onReload(slot.id)}
                    />
                </HlsAbsoluteWrapper>
            ))}
            {isCanvas && slots.map(slot => (
                <HlsAbsoluteWrapper 
                    key={slot.id} 
                    slotId={slot.id as 2 | 3 | 4} 
                    activeView={activeView}
                    layout={layout}
                    hidden={hidden}
                    active={slot.active}
                >
                    <CanvasMultiviewCell
                        slotId={slot.id as 2 | 3 | 4}
                        channelName={slot.channelName}
                        channelUrl={slot.channelUrl}
                        nativeDash={slot.nativeDash}
                        sourceName={slot.sourceName}
                        active={slot.active}
                        onSwapWithMain={() => onSwapWithMain(slot.id)}
                        onStop={() => onStop(slot.id)}
                        onReload={() => onReload(slot.id)}
                        hidden={hidden}
                    />
                </HlsAbsoluteWrapper>
            ))}
            {layoutContent}
        </>
    );
}
