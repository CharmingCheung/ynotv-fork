import { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

export interface TimeshiftState {
    cacheStart: number;   // seconds from start of stream
    cacheEnd: number;     // live edge (seconds from start)
    timePos: number;      // current playback position (seconds from start)
    behindLive: number;   // how far behind live edge we are
    cachedDuration: number; // total cached window size in seconds
    nativeDash?: boolean;
}

export function dvrProgressPercent(state: Pick<TimeshiftState, 'cacheStart' | 'cacheEnd' | 'timePos'>): number {
    const duration = state.cacheEnd - state.cacheStart;
    if (!(duration > 0)) return 0;
    return Math.max(0, Math.min(100, ((state.timePos - state.cacheStart) / duration) * 100));
}

interface NativeDashTimelineState {
    seekRangeStart: number;
    seekRangeEnd: number;
    currentTime: number;
    liveEdge: number;
    isLive: boolean;
    isAtLiveEdge: boolean;
    windowDuration: number;
    generation: number;
}

/**
 * Subscribes to the `timeshift-update` Tauri event emitted by mpv_windows.rs
 * whenever the demuxer-cache-state property changes.
 *
 * Returns null when timeshift is disabled or no cache state is available yet.
 */
export function useTimeshift(enabled: boolean): TimeshiftState | null {
    const [state, setState] = useState<TimeshiftState | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        let cancelled = false;
        let nativeDashActive = false;
        let unlistenCache: (() => void) | null = null;
        let unlistenDash: (() => void) | null = null;
        let unlistenDashEnded: (() => void) | null = null;

        listen<TimeshiftState>('timeshift-update', (event) => {
            if (!cancelled && enabled && !nativeDashActive) {
                const payload = event.payload;
                // Only update if we have meaningful cache data
                if (payload.cachedDuration > 1) {
                    setState(payload);
                }
            }
        }).then((unlisten) => {
            if (cancelled) {
                unlisten();
            } else {
                unlistenCache = unlisten;
                unlistenRef.current = () => {
                    unlistenCache?.();
                    unlistenDash?.();
                    unlistenDashEnded?.();
                };
            }
        });

        listen<NativeDashTimelineState>('native-dash-timeline', (event) => {
            if (cancelled) return;
            const timeline = event.payload;
            nativeDashActive = true;
            setState({
                cacheStart: timeline.seekRangeStart,
                cacheEnd: timeline.seekRangeEnd,
                timePos: timeline.currentTime,
                behindLive: Math.max(0, timeline.liveEdge - timeline.currentTime),
                cachedDuration: timeline.windowDuration,
                nativeDash: true,
            });
        }).then((unlisten) => {
            if (cancelled) {
                unlisten();
            } else {
                unlistenDash = unlisten;
                unlistenRef.current = () => {
                    unlistenCache?.();
                    unlistenDash?.();
                    unlistenDashEnded?.();
                };
            }
        });

        listen('native-dash-timeline-ended', () => {
            if (!cancelled) {
                nativeDashActive = false;
                setState(null);
            }
        }).then((unlisten) => {
            if (cancelled) {
                unlisten();
            } else {
                unlistenDashEnded = unlisten;
                unlistenRef.current = () => {
                    unlistenCache?.();
                    unlistenDash?.();
                    unlistenDashEnded?.();
                };
            }
        });

        return () => {
            cancelled = true;
            if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
            }
            setState(null);
        };
    }, [enabled]);

    return state;
}
