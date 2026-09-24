import { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  useMultiview,
  type LayoutMode,
  type MultiviewEngineMode,
  type ViewerSlot,
  type MainSlot,
} from './useMultiview';
import type { NativeDashPlaybackConfig } from '../services/native-dash';

// Re-export SavedLayoutState for convenience
export type { LayoutMode } from './useMultiview';
export type { MultiviewEngineMode } from './useMultiview';
export interface SavedLayoutState {
  layout: LayoutMode;
  engineMode?: MultiviewEngineMode; // optional — absent in older saves defaults to 'mpv'
  mainChannel: {
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
  };
  slots: {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
  }[];
}

interface UseLayoutPersistenceOptions {
  enabled: boolean;
  reopenLastOnStartup?: boolean;
  initialSavedState?: SavedLayoutState | null;
  settingsLoaded?: boolean;
  mpvReady?: boolean;
  onLoadMainChannel?: (channelName: string, channelUrl: string, sourceName?: string | null) => void;
}

/**
 * Extended version of useMultiview that adds layout state persistence.
 * When enabled, saves the current layout and channels when switching layouts
 * and can restore them on startup.
 */
export function useLayoutPersistence(options: UseLayoutPersistenceOptions) {
  const { enabled, reopenLastOnStartup, initialSavedState, settingsLoaded, mpvReady, onLoadMainChannel } = options;

  // Get base multiview functionality
  const multiview = useMultiview();
  const [isRestoring, setIsRestoring] = useState(false);
  const {
    layout,
    slots,
    switchLayout: baseSwitchLayout,
    sendToSlot: baseSendToSlot,
    swapWithMain: baseSwapWithMain,
    stopSlot: baseStopSlot,
    notifyMainLoaded: baseNotifyMainLoaded,
    setEngineMode: baseSetEngineMode,
    engineMode,
  } = multiview;

  // Track main slot state locally for persistence
  const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null, sourceName: null });

  // Keep a ref to the full saved state for cross-layout restoration
  const savedStateRef = useRef<SavedLayoutState | null>(null);

  // Master state that preserves ALL channel info across layout switches
  // This is never overwritten with partial data (like PiP state)
  const masterStateRef = useRef<SavedLayoutState | null>(null);

  // Track if we've done initial restore
  const hasRestoredRef = useRef(false);

  // Track slots in a ref so we always have latest values
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  // Initialize refs from props if available
  useEffect(() => {
    if (initialSavedState && !savedStateRef.current) {
      savedStateRef.current = initialSavedState;
      masterStateRef.current = initialSavedState;
    }
  }, [initialSavedState]);

  /**
   * Build the current state snapshot from refs and layout
   */
  const buildCurrentState = useCallback((): SavedLayoutState => {
    return {
      layout,
      engineMode,
      mainChannel: { ...mainSlotRef.current },
      // Never persist native DASH ClearKey material. It is re-derived from the
      // channel metadata whenever the user sends that channel to a slot.
      slots: slotsRef.current.map((s) => ({
        id: s.id,
        channelName: s.channelName,
        channelUrl: s.channelUrl,
        sourceName: s.sourceName,
        active: s.active,
      })),
    };
  }, [layout, engineMode]);

  /**
   * Helper to merge current active slots down to the master state
   */
  const updateMasterState = useCallback((currentState: SavedLayoutState): SavedLayoutState => {
    const masterState = masterStateRef.current;
    if (!masterState) {
      masterStateRef.current = currentState;
      return currentState;
    }

    // Start with master slots, overlay active current slots
    const mergedSlots = masterState.slots.map((masterSlot) => {
      const currentSlot = currentState.slots.find((s) => s.id === masterSlot.id);
      // If slot is active now, use current data. Otherwise keep master data
      if (currentSlot?.active) {
        return currentSlot;
      }
      return masterSlot;
    });

    const updatedMasterState: SavedLayoutState = {
      ...currentState,
      slots: mergedSlots,
    };
    masterStateRef.current = updatedMasterState;
    return updatedMasterState;
  }, []);

  /**
   * Helper to synchronize storage cleanly. LocalStorage is updated synchronously first 
   * to guarantee safety through window unloads, followed by an async Tauri push.
   */
  const persistToStorage = useCallback(async (stateToSave: SavedLayoutState) => {
    try {
      const existing = localStorage.getItem('app-settings');
      const parsed = existing ? JSON.parse(existing) : {};
      localStorage.setItem(
        'app-settings',
        JSON.stringify({
          ...parsed,
          savedLayoutState: stateToSave,
        })
      );
    } catch (e) {
      console.error('[useLayoutPersistence] Failed to save to localStorage:', e);
    }

    if (window.storage) {
      try {
        await window.storage.updateSettings({ savedLayoutState: stateToSave });
      } catch (e) {
        console.error('[useLayoutPersistence] Failed to save to Tauri storage:', e);
      }
    }
  }, []);

  /**
   * Save state using current refs (not React state which may be stale)
   * Updates master state incrementally to preserve channel info
   */
  const saveStateWithRefs = useCallback(async () => {
    if (!enabled) return;

    // Build new state from current refs
    const currentState = buildCurrentState();
    // State saved

    savedStateRef.current = currentState;
    const updatedMasterState = updateMasterState(currentState);
    await persistToStorage(updatedMasterState);
  }, [enabled, buildCurrentState, updateMasterState, persistToStorage]);

  /**
   * Notify that main channel loaded - tracks for persistence
   */
  const notifyMainLoaded = useCallback(
    (channelName: string, channelUrl: string, sourceName?: string | null) => {
      baseNotifyMainLoaded(channelName, channelUrl, sourceName);
      mainSlotRef.current = { channelName, channelUrl, sourceName: sourceName || null };

      // Save state immediately
      if (enabled) {
        saveStateWithRefs();
      }
    },
    [baseNotifyMainLoaded, enabled, saveStateWithRefs]
  );

  /**
   * Switch layouts with state persistence.
   * Simplified: just save before switch, let baseSwitchLayout handle the actual work.
   */
  const switchLayout = useCallback(
    async (newLayout: LayoutMode) => {
      // Save current state BEFORE the switch
      if (enabled) {
        const stateBeforeSwitch = buildCurrentState();
        savedStateRef.current = stateBeforeSwitch;
        const updatedMasterState = updateMasterState(stateBeforeSwitch);

        await persistToStorage(updatedMasterState);
      }

      // Perform the base layout switch - let useMultiview handle all the complexity
      await baseSwitchLayout(newLayout);

      // Post-switch: Update master state with the new layout so if we close,
      // the new layout is what we recall, rather than the stateBeforeSwitch.
      if (enabled && masterStateRef.current) {
        masterStateRef.current.layout = newLayout;
        await persistToStorage(masterStateRef.current);
      }

      // After switching (and after startup restore is complete), restore slots for multiview layouts
      // But only if we're NOT switching to 'main' (main should clear everything)
      if (hasRestoredRef.current && enabled && newLayout !== 'main') {
        // Wait for layout to render, then restore any slots that should be active
        setTimeout(async () => {
          const savedState = masterStateRef.current;
          if (!savedState) return;

          // Get currently active slots from the base multiview
          const currentlyActiveSlots = new Set(
            slotsRef.current.filter(s => s.active).map(s => s.id)
          );

          // Determine which slots should be restored based on new layout
          const slotsToRestore =
            newLayout === 'pip'
              ? savedState.slots.filter((s) => s.id === 2 && s.active && s.channelUrl)
              : savedState.slots.filter((s) => s.active && s.channelUrl);


          // Only restore slots that aren't already active
          for (const slot of slotsToRestore) {
            if (!currentlyActiveSlots.has(slot.id)) {
              await baseSendToSlot(slot.id, slot.channelName || '', slot.channelUrl || '', slot.sourceName || null);
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        }, 300);
      }
    },
    [baseSwitchLayout, baseSendToSlot, enabled, buildCurrentState, updateMasterState, persistToStorage]
  );

  /**
   * Send a channel to a slot with persistence
   */
  const sendToSlot = useCallback(
    async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null, nativeDash?: NativeDashPlaybackConfig) => {

      await baseSendToSlot(slotId, channelName, channelUrl, sourceName, nativeDash);

      // Save state after loading
      if (enabled) {
        // Manually update slotsRef so we don't save stale React state before the next render tick
        slotsRef.current = slotsRef.current.map(s =>
          s.id === slotId ? { ...s, channelName, channelUrl, sourceName: sourceName ?? null, nativeDash, active: true } : s
        );
        await saveStateWithRefs();
      }
    },
    [baseSendToSlot, enabled, saveStateWithRefs]
  );

  /**
   * Swap main with a slot with persistence
   */
  const swapWithMain = useCallback(
    async (slotId: 2 | 3 | 4, currentSlots: ViewerSlot[]) => {
      const slot = currentSlots.find((s) => s.id === slotId);
      const oldMain = { ...mainSlotRef.current };

      if (slot?.channelUrl) {
        mainSlotRef.current = {
          channelName: slot.channelName,
          channelUrl: slot.channelUrl,
          sourceName: slot.sourceName,
        };
        // Notify parent that main channel changed (for preview panel sync)
        onLoadMainChannel?.(slot.channelName || '', slot.channelUrl, slot.sourceName);
      }

      await baseSwapWithMain(slotId, currentSlots);

      if (enabled) {
        // Update slotsRef synchronously to swap old main stream into target slot before save
        slotsRef.current = slotsRef.current.map(s =>
          s.id === slotId ? {
            ...s,
            channelName: oldMain.channelName,
            channelUrl: oldMain.channelUrl,
            sourceName: oldMain.sourceName,
            active: !!oldMain.channelUrl
          } : s
        );
        await saveStateWithRefs();
      }
    },
    [baseSwapWithMain, enabled, saveStateWithRefs, onLoadMainChannel]
  );

  /**
   * Stop a slot with persistence
   */
  const stopSlot = useCallback(
    async (slotId: 2 | 3 | 4) => {
      await baseStopSlot(slotId);

      if (enabled) {
        // Zero out target slot manually before save tick
        slotsRef.current = slotsRef.current.map(s =>
          s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
        );
        await saveStateWithRefs();
      }
    },
    [baseStopSlot, enabled, saveStateWithRefs]
  );

  /**
   * Set engine mode, persist to storage, and reload active slots in the new engine
   */
  const setEngineMode = useCallback(
    async (mode: MultiviewEngineMode) => {
      const prev = engineMode;
      await baseSetEngineMode(mode);

      if (prev !== mode) {
        // Save new engine mode to persisted state immediately
        if (enabled && masterStateRef.current) {
          masterStateRef.current.engineMode = mode;
          await persistToStorage(masterStateRef.current);
        }

        // Wait for engine state to update and HLS/MPV views to unmount/mount
        setTimeout(async () => {
          const activeSlots = slotsRef.current.filter((s) => s.active && s.channelUrl);
          const slotDelay = mode === 'hls' ? 50 : 300;
          for (const slot of activeSlots) {
            await baseSendToSlot(
              slot.id,
              slot.channelName || '',
              slot.channelUrl || '',
              slot.sourceName || null
            );
            await new Promise((resolve) => setTimeout(resolve, slotDelay));
          }
        }, 300);
      }
    },
    [baseSetEngineMode, engineMode, enabled, baseSendToSlot, persistToStorage]
  );

  /**
   * Restore layout state on initial mount (for startup)
   * This runs ONCE when the app starts and restores the saved layout and channels.
   */
  const restoreLayoutState = useCallback(
    async (state: SavedLayoutState) => {
      if (hasRestoredRef.current) return;
      hasRestoredRef.current = true;

      const restoredEngineMode: MultiviewEngineMode = (state.engineMode === 'hls' || state.engineMode === 'mpv_canvas') ? state.engineMode : 'hls';

      // Step 1: Restore engine mode FIRST so engineModeRef is correct before any slot loading.
      await setEngineMode(restoredEngineMode);

      // Step 2: Switch to the saved layout (this mounts MultiviewLayout)
      await baseSwitchLayout(state.layout);

      // Step 3: Wait for layout to fully render
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Load main channel if present
      if (state.mainChannel.channelUrl) {
        if (onLoadMainChannel) {
          onLoadMainChannel(
            state.mainChannel.channelName || '',
            state.mainChannel.channelUrl,
            state.mainChannel.sourceName
          );
        } else {
          await invoke('mpv_load', { url: state.mainChannel.channelUrl }).catch(
            (e) => console.warn('[useLayoutPersistence] Failed to restore main:', e)
          );
        }
        mainSlotRef.current = { ...state.mainChannel };
        baseNotifyMainLoaded(
          state.mainChannel.channelName || '',
          state.mainChannel.channelUrl,
          state.mainChannel.sourceName
        );
      }

      // Step 5: Wait for main to load and React to render
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Step 6: Load secondary slots
      const slotsToRestore = state.slots.filter((s) => s.active && s.channelUrl);

      for (const slot of slotsToRestore) {
        await baseSendToSlot(
          slot.id,
          slot.channelName || '',
          slot.channelUrl || '',
          slot.sourceName || null
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Update saved state refs to match restored state
      savedStateRef.current = state;
      masterStateRef.current = state;
    },
    [baseSwitchLayout, baseNotifyMainLoaded, baseSendToSlot, onLoadMainChannel, setEngineMode]
  );


  // Restore on mount - run once when all conditions are met
  const restoreAttemptedRef = useRef(false);
  const initialStateRef = useRef(initialSavedState);
  initialStateRef.current = initialSavedState;
  const restoreFnRef = useRef(restoreLayoutState);
  restoreFnRef.current = restoreLayoutState;

  useEffect(() => {
    // Skip if already attempted or conditions not met
    if (
      restoreAttemptedRef.current ||
      !enabled ||
      !initialStateRef.current ||
      !settingsLoaded ||
      !mpvReady ||
      hasRestoredRef.current
    ) {
      return;
    }

    // If remember is on, but auto-reopen is off, fast-forward the restore sequence.
    // This allows manual layout switches to pull from masterStateRef properly.
    if (!reopenLastOnStartup) {
      restoreAttemptedRef.current = true;
      hasRestoredRef.current = true;
      return;
    }

    restoreAttemptedRef.current = true;
    setIsRestoring(true);
    restoreFnRef.current(initialStateRef.current).then(() => {
      setIsRestoring(false);
    });
    // Only depend on the boolean flags, not the objects/functions
  }, [enabled, reopenLastOnStartup, settingsLoaded, mpvReady]);

  // Save state before window closes
  useEffect(() => {
    if (!enabled) return;

    const handleBeforeUnload = () => {
      // Synchronously save master state to localStorage for reliability on shutdown
      // Use master state to ensure all channel info is preserved
      const stateToSave = masterStateRef.current || buildCurrentState();

      persistToStorage(stateToSave);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [enabled, buildCurrentState, persistToStorage]);

  return {
    ...multiview,
    switchLayout,
    sendToSlot,
    swapWithMain,
    stopSlot,
    notifyMainLoaded,
    saveLayoutState: saveStateWithRefs,
    restoreLayoutState,
    mainChannel: mainSlotRef.current,
    isRestoring,
    setEngineMode,
  };
}
