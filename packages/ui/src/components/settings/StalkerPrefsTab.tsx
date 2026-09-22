import { useState } from 'react';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';

// Cache timer presets, in minutes. The 5m+ durations reuse the existing
// dataRefresh wording ("Every 5 minutes", "Every 1 hour", ...), which is
// already translated in every locale; only the no-cache option is new.
const CACHE_OPTIONS: { minutes: number; labelKey: string }[] = [
  { minutes: 0, labelKey: 'settings:sources.stalkerPrefs.cacheAlwaysRefresh' },
  { minutes: 5, labelKey: 'settings:dataRefresh.every5m' },
  { minutes: 30, labelKey: 'settings:dataRefresh.every30m' },
  { minutes: 60, labelKey: 'settings:dataRefresh.every1h' },
  { minutes: 180, labelKey: 'settings:dataRefresh.every3h' },
  { minutes: 360, labelKey: 'settings:dataRefresh.every6h' },
  { minutes: 720, labelKey: 'settings:dataRefresh.every12h' },
  { minutes: 1440, labelKey: 'settings:dataRefresh.every24h' },
  { minutes: 2880, labelKey: 'settings:dataRefresh.every2d' },
  { minutes: 10080, labelKey: 'settings:dataRefresh.everyWeek' },
];

export function StalkerPrefsTab() {
  const concurrency = useSettingsStore((s) => s.stalkerVodPageConcurrency);
  const setConcurrency = useSettingsStore((s) => s.setStalkerVodPageConcurrency);
  const cacheMinutes = useSettingsStore((s) => s.stalkerCategoryCacheMinutes);
  const setCacheMinutes = useSettingsStore((s) => s.setStalkerCategoryCacheMinutes);
  const serverSearchEnabled = useSettingsStore((s) => s.stalkerServerSearchEnabled);
  const setServerSearchEnabled = useSettingsStore((s) => s.setStalkerServerSearchEnabled);

  // Local draft keeps the number input editable while focused; it commits on
  // blur / Enter so intermediate states (empty, "1", partial typing) never
  // fight the store's clamped value.
  const [concurrencyDraft, setConcurrencyDraft] = useState<string | null>(null);

  const commitConcurrency = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      setConcurrency(parsed);
    }
    setConcurrencyDraft(null);
  };

  const labelStyle: React.CSSProperties = { fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' };
  const hintStyle: React.CSSProperties = { fontSize: '0.75rem', opacity: 0.6, lineHeight: 1.3 };

  return (
    <div className="settings-tab-content">
      <div className="settings-section" style={{ paddingTop: '8px' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:sources.stalkerPrefs.title')}</h3>
        </div>
        <p className="section-description" style={{ opacity: 0.8, fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: '1.4' }}>
          {i18n.t('settings:sources.stalkerPrefs.desc')}
        </p>

        <div className="settings-form" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '620px' }}>
          {/* Pages fetched in parallel when a VOD category opens */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <label style={labelStyle}>
              {i18n.t('settings:sources.stalkerPrefs.pageConcurrency')}
            </label>
            <span style={hintStyle}>
              {i18n.t('settings:sources.stalkerPrefs.pageConcurrencyDesc')}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <input
                id="stalker-page-concurrency"
                type="number"
                inputMode="numeric"
                min={1}
                max={12}
                step={1}
                value={concurrencyDraft ?? String(concurrency)}
                onChange={(e) => setConcurrencyDraft(e.target.value)}
                onBlur={(e) => commitConcurrency(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitConcurrency((e.target as HTMLInputElement).value);
                }}
                style={{ width: '70px', textAlign: 'center' }}
              />
            </div>
          </div>

          {/* How long an opened category's items stay cached */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <label style={labelStyle}>
              {i18n.t('settings:sources.stalkerPrefs.categoryCache')}
            </label>
            <span style={hintStyle}>
              {i18n.t('settings:sources.stalkerPrefs.categoryCacheDesc')}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <select
                value={cacheMinutes}
                onChange={(e) => setCacheMinutes(parseInt(e.target.value, 10))}
                style={{ maxWidth: '280px' }}
              >
                {CACHE_OPTIONS.map((opt) => (
                  <option key={opt.minutes} value={opt.minutes}>
                    {i18n.t(opt.labelKey as any)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Adds a "Server Search" button to the Movies/Series pages, which searches the
              portal's own catalogue instead of only what has been cached locally. */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }}>
              <input
                id="stalker-server-search"
                type="checkbox"
                checked={serverSearchEnabled}
                onChange={(e) => setServerSearchEnabled(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              <span style={labelStyle}>
                {i18n.t('settings:sources.stalkerPrefs.serverSearch')}
              </span>
            </label>
            <span style={hintStyle}>
              {i18n.t('settings:sources.stalkerPrefs.serverSearchDesc')}
            </span>
            {/* What the feature can't do, before it is switched on: which portals answer,
                what a multi-word query really matches, and what it costs to ask. */}
            <span
              style={{
                ...hintStyle,
                display: 'block',
                marginTop: '0.75rem',
                fontWeight: 600,
              }}
            >
              {i18n.t('settings:sources.stalkerPrefs.serverSearchConsTitle')}
            </span>
            <span
              style={{
                ...hintStyle,
                display: 'block',
                marginTop: '0.15rem',
                whiteSpace: 'pre-line',
              }}
            >
              {i18n.t('settings:sources.stalkerPrefs.serverSearchCons')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
