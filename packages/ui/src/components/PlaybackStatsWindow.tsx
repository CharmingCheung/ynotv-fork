import { useCallback, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import { PlaybackStatsModal } from './PlaybackStatsModal';

export function PlaybackStatsWindow() {
  const { t } = useTranslation('player');

  useEffect(() => {
    document.title = t('playbackStats.title');
    document.documentElement.classList.add('playback-stats-window-root');
    document.body.classList.add('playback-stats-window-root');
    return () => {
      document.documentElement.classList.remove('playback-stats-window-root');
      document.body.classList.remove('playback-stats-window-root');
    };
  }, [t]);

  const closeWindow = useCallback(() => {
    void getCurrentWindow().close();
  }, []);

  return <PlaybackStatsModal isOpen standalone onClose={closeWindow} />;
}
