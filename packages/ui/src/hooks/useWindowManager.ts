import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bridge } from '../services/tauri-bridge';

export interface WindowManagerState {
  handleMinimize: () => void;
  handleMaximize: () => void;
  handleClose: () => void;
  isMaximized: boolean;
  isFullscreen: boolean;
}

export function useWindowManager(): WindowManagerState {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let updateTimer: ReturnType<typeof setTimeout> | null = null;

    const updateWindowState = async () => {
      const [maximized, fullscreen] = await Promise.all([
        Bridge.isMaximized(),
        appWindow.isFullscreen(),
      ]);
      if (!disposed) {
        setIsMaximized(maximized);
        setIsFullscreen(fullscreen);
      }
    };

    updateWindowState().catch(() => {});
    const unlistenPromise = appWindow.onResized(() => {
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = setTimeout(() => {
        updateTimer = null;
        updateWindowState().catch(() => {});
      }, 50);
    });

    return () => {
      disposed = true;
      if (updateTimer) clearTimeout(updateTimer);
      unlistenPromise.then(unlisten => unlisten()).catch(() => {});
    };
  }, []);

  const handleMinimize = useCallback(() => {
    Bridge.minimize();
  }, []);

  const handleMaximize = useCallback(async () => {
    try {
      if (await Bridge.isFullscreen()) {
        await Bridge.setFullscreen(false);
        return;
      }
      await Bridge.toggleMaximize();
    } catch (err) {
      console.error('[WindowManager] maximize failed:', err);
    }
  }, []);

  const handleClose = useCallback(() => {
    Bridge.close();
  }, []);

  return {
    handleMinimize,
    handleMaximize,
    handleClose,
    isMaximized,
    isFullscreen,
  };
}
