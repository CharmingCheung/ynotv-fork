import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { NativeDashPlaybackConfig } from '../services/native-dash';

export type LayoutMode = 'main' | 'pip' | '2x2' | 'bigbottom' | 'sbs';
export type MultiviewEngineMode = 'mpv_canvas' | 'hls';

export interface ViewerSlot {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
    nativeDash?: NativeDashPlaybackConfig;
}

export interface MainSlot {
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
}

const EMPTY_SLOTS: ViewerSlot[] = [
    { id: 2, channelName: null, channelUrl: null, sourceName: null, active: false },
    { id: 3, channelName: null, channelUrl: null, sourceName: null, active: false },
    { id: 4, channelName: null, channelUrl: null, sourceName: null, active: false },
];

/** Scale factor applied to mpv_set_geometry coordinates to account for DPR */
function dpr() {
    return window.devicePixelRatio || 1;
}

/** Compute the target rect (in physical pixels) for the primary MPV slot on the Hero page */
export function primaryRect(mode: LayoutMode, _engineMode?: MultiviewEngineMode): { x: number; y: number; w: number; h: number } {
    const d = dpr();
    const W = Math.round(window.innerWidth * d);
    const H = Math.round(window.innerHeight * d);
    const gap = Math.round(2 * d);

    switch (mode) {
        case '2x2': {
            const cw = Math.floor((W - gap) / 2);
            const ch = Math.floor((H - gap) / 2);
            return { x: 0, y: 0, w: cw, h: ch };
        }
        case 'bigbottom': {
            const cellW = Math.floor((W - 2 * gap) / 3);
            const cellH = Math.floor(cellW * 9 / 16);
            return { x: 0, y: 0, w: W, h: H - cellH };
        }
        case 'sbs': {
            const maxW = Math.floor((W - gap) / 2);
            const maxH = H;
            let cellW = maxW;
            let cellH = Math.floor(cellW * 9 / 16);
            if (cellH > maxH) {
                cellH = maxH;
                cellW = Math.floor(cellH * 16 / 9);
            }
            const totalW = cellW * 2 + gap;
            const offsetX = Math.floor((W - totalW) / 2);
            const offsetY = Math.floor((H - cellH) / 2);
            return { x: offsetX, y: offsetY, w: cellW, h: cellH };
        }
        default:
            // main / pip — fill window
            return { x: 0, y: 0, w: 0, h: 0 };
    }
}

export function useMultiview() {
    const [layout, setLayout] = useState<LayoutMode>('main');
    const [slots, setSlots] = useState<ViewerSlot[]>(EMPTY_SLOTS.map(s => ({ ...s })));
    const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null, sourceName: null });
    const layoutRef = useRef<LayoutMode>('main');
    const slotsRef = useRef<ViewerSlot[]>(slots);

    // Engine mode: 'mpv_canvas' uses in-DOM <canvas> via libmpv; 'hls' uses in-DOM <video> via hls.js
    const [engineMode, setEngineModeState] = useState<MultiviewEngineMode>(() => {
        const saved = localStorage.getItem('multiviewEngineMode');
        // HLS is the default engine; only an explicit 'mpv_canvas' choice opts
        // into the canvas engine.
        return saved === 'mpv_canvas' ? 'mpv_canvas' : 'hls';
    });
    const engineModeRef = useRef<MultiviewEngineMode>(engineMode);
    useEffect(() => { engineModeRef.current = engineMode; }, [engineMode]);

    const setEngineMode = useCallback(async (mode: MultiviewEngineMode) => {
        const prev = engineModeRef.current;
        engineModeRef.current = mode;
        setEngineModeState(mode);
        localStorage.setItem('multiviewEngineMode', mode);

        // When switching away from canvas mode, stop canvas streaming slots
        if (prev === 'mpv_canvas' && mode !== 'mpv_canvas') {
            await invoke('multiview_canvas_stop_all').catch(() => { });
        }
    }, []);

    useEffect(() => { layoutRef.current = layout; }, [layout]);
    useEffect(() => { slotsRef.current = slots; }, [slots]);

    /** Resize primary MPV HWND to match the current layout mode on Hero page */
    const syncMpvGeometry = useCallback(async (mode?: LayoutMode) => {
        const m = mode ?? layoutRef.current;
        const placeholder = m !== 'main' ? document.querySelector('.layout-mpv-placeholder') : null;
        
        let r = { x: 0, y: 0, w: 0, h: 0 };
        let hasPlaceholder = false;

        if (placeholder) {
            try {
                const rect = placeholder.getBoundingClientRect();
                const d = dpr();
                r = {
                    x: Math.round(rect.left * d),
                    y: Math.round(rect.top * d),
                    w: Math.round(rect.width * d),
                    h: Math.round(rect.height * d),
                };
                hasPlaceholder = true;
            } catch (e) {
                // Fallback to primaryRect
            }
        }

        if (!hasPlaceholder) {
            // Only use primaryRect math if we are on the hero page and not in a tab view
            const pr = primaryRect(m, engineModeRef.current);
            r = { x: pr.x, y: pr.y, w: pr.w, h: pr.h };
        }

        try {
            const { Bridge } = await import('../services/tauri-bridge');

            if (m !== 'main') {
                try {
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                    await Bridge.setProperty('keepaspect', m !== '2x2');
                } catch (e) {}
            } else {
                try {
                    await Bridge.setProperty('keepaspect', true);
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                } catch (e) {}
            }

            if (r.w > 0 && r.h > 0) {
                await invoke('mpv_set_geometry', { x: r.x, y: r.y, width: r.w, height: r.h });
            } else {
                await invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 });
            }
        } catch (e) {}
    }, []);

    const notifyMainLoaded = useCallback((channelName: string, channelUrl: string, sourceName?: string | null) => {
        mainSlotRef.current = { channelName, channelUrl, sourceName: sourceName || null };
    }, []);

    const switchLayout = useCallback(async (newLayout: LayoutMode) => {
        if (newLayout === 'main') {
            // Only canvas engine keeps native streams in the backend; HLS cells stop on unmount
            if (engineModeRef.current === 'mpv_canvas') {
                await invoke('multiview_canvas_stop_all').catch(() => { });
            }
            setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
        } else if (newLayout === 'pip' || newLayout === 'sbs') {
            // Stop and clear slots 3 and 4
            for (const id of [3, 4]) {
                if (slotsRef.current.find(s => s.id === id)?.active && engineModeRef.current === 'mpv_canvas') {
                    invoke('multiview_canvas_stop', { slotId: id }).catch(() => { });
                }
            }
            setSlots(prev => prev.map(s => (s.id === 3 || s.id === 4) ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s));
        }

        setLayout(newLayout);
        await syncMpvGeometry(newLayout);
        // One-shot re-sync after React commits the new layout and any CSS
        // transitions settle — replaces the old continuous 100ms polling in
        // MultiviewLayout. Idempotent, so extra calls are harmless.
        setTimeout(() => { syncMpvGeometry(newLayout); }, 100);
    }, [syncMpvGeometry]);

    /** Load a stream URL into a secondary slot */
    const sendToSlot = useCallback(async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName: string | null = null, nativeDash?: NativeDashPlaybackConfig) => {
        // Encrypted DASH needs the native packet pipeline. Select the canvas
        // engine automatically; browser video/HLS cannot consume that source.
        if (nativeDash && engineModeRef.current !== 'mpv_canvas') {
            engineModeRef.current = 'mpv_canvas';
            setEngineModeState('mpv_canvas');
            localStorage.setItem('multiviewEngineMode', 'mpv_canvas');
        }
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName, channelUrl, sourceName, nativeDash, active: true } : s
        ));
    }, []);

    /** Swap: load a secondary slot's stream into the primary MPV and vice versa */
    const swapWithMain = useCallback(async (slotId: 2 | 3 | 4, currentSlots: ViewerSlot[]) => {
        const slot = currentSlots.find(s => s.id === slotId);
        if (!slot?.channelUrl) return;

        const prevMain = { ...mainSlotRef.current };
        const newMainUrl = slot.channelUrl;
        const newMainName = slot.channelName;
        const newMainSourceName = slot.sourceName;

        // Load the secondary stream on Main MPV
        try {
            await invoke('mpv_load', { url: newMainUrl, nativeDash: slot.nativeDash });
        } catch (e) {}
        mainSlotRef.current = { channelName: newMainName, channelUrl: newMainUrl, sourceName: newMainSourceName };

        // Put the old main stream into the secondary slot
        if (prevMain.channelUrl) {
            setSlots(prev => prev.map(s =>
                s.id === slotId
                    ? { ...s, channelName: prevMain.channelName, channelUrl: prevMain.channelUrl, sourceName: prevMain.sourceName, active: true }
                    : s
            ));
        } else {
            if (engineModeRef.current === 'mpv_canvas') {
                invoke('multiview_canvas_stop', { slotId }).catch(() => { });
            }
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
            ));
        }

        // The primary MPV window is a child HWND that's physically resized to its
        // cell via SetWindowPos. When mpv loads the swapped stream it re-fits that
        // child window to the new video's natural size (it doesn't know the window
        // was resized externally), so the video ends up fullscreen-sized and the
        // grid's black backdrop only exposes its top-left corner inside cell 1.
        // Every other load path re-applies geometry afterward (the guide re-syncs
        // via ChannelPanel's own effect on multiviewSlots change; returning to the
        // hero re-syncs via App.tsx), but the swap does not — so re-apply here.
        // Delayed passes outlast mpv's async window re-fit, which happens once the
        // new stream's first frame lands (network-dependent). Idempotent, so extra
        // passes are harmless.
        const reapplyGeometry = () => {
            const d = window.devicePixelRatio || 1;

            // Hero page: the layout placeholder only exists with a real rect while
            // activeView === 'none'. syncMpvGeometry also re-asserts the video
            // properties (keepaspect/video-zoom) for the layout, so prefer it.
            const placeholder = document.querySelector<HTMLElement>('.layout-mpv-placeholder');
            if (placeholder) {
                const r = placeholder.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    void syncMpvGeometry(layoutRef.current);
                    return;
                }
            }

            // Sports preview: main cell for 2x2/sbs, or the whole pane for pip.
            const sportsTarget = document.querySelector<HTMLElement>('.sports-mv-main')
                ?? document.querySelector<HTMLElement>('.sports-preview-pane');
            if (sportsTarget) {
                const r = sportsTarget.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    void invoke('mpv_set_geometry', {
                        x: Math.round(r.left * d),
                        y: Math.round(r.top * d),
                        width: Math.round(r.width * d),
                        height: Math.round(r.height * d),
                    }).catch(() => { });
                }
            }
        };
        reapplyGeometry();
        setTimeout(reapplyGeometry, 300);
        setTimeout(reapplyGeometry, 900);
        setTimeout(reapplyGeometry, 1800);
        setTimeout(reapplyGeometry, 3000);
    }, [syncMpvGeometry]);

    const stopSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        // Only canvas engine keeps native streams in the backend; HLS cells stop on unmount
        if (engineModeRef.current === 'mpv_canvas') {
            invoke('multiview_canvas_stop', { slotId }).catch(() => { });
        }
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, nativeDash: undefined, active: false } : s
        ));
    }, []);

    const setSlotProperty = useCallback(async (slotId: 2 | 3 | 4, property: string, value: any) => {
        try {
            await invoke('multiview_canvas_set_property', { slotId, property, value });
        } catch (e) {}
    }, []);

    /** Reload a slot's stream by re-loading the same URL */
    const reloadSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        const slot = slotsRef.current.find(s => s.id === slotId);
        if (!slot?.channelUrl || !slot?.channelName) return;

        // Briefly clear URL then restore to trigger re-initialization
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelUrl: null, active: false } : s
        ));
        setTimeout(() => {
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelUrl: slot.channelUrl, channelName: slot.channelName, sourceName: slot.sourceName, active: true } : s
            ));
        }, 150);
    }, []);

    const visibleSlotIds = ((): Array<2 | 3 | 4> => {
        switch (layout) {
            case 'pip': return [2];
            case 'sbs': return [2];
            case '2x2': return [2, 3, 4];
            case 'bigbottom': return [2, 3, 4];
            default: return [];
        }
    })();

    return {
        layout,
        slots,
        visibleSlots: slots.filter(s => (visibleSlotIds as number[]).includes(s.id)),
        engineMode,
        setEngineMode,
        switchLayout,
        sendToSlot,
        swapWithMain,
        stopSlot,
        reloadSlot,
        setSlotProperty,
        notifyMainLoaded,
        syncMpvGeometry,
    };
}
