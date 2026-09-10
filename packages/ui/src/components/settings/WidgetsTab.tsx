import './PlaybackTab.css';
import './WidgetsTab.css';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface WidgetsTabProps {
  widgetScale: number;
  onWidgetScaleChange: (scale: number) => void;
  widgetBgOpacity: number; // 0–1
  onWidgetBgOpacityChange: (opacity: number) => void;
  sportsScale: number;
  onSportsScaleChange: (scale: number) => void;
  sportsBgOpacity: number; // 0–1
  onSportsBgOpacityChange: (opacity: number) => void;
}

// ── Small reusable slider row ──────────────────────────────────────
function SliderRow({
  label,
  hint,
  min, max, step,
  value,
  display,
  onChange,
}: {
  label: string; hint?: string;
  min: number; max: number; step: number;
  value: number; display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="form-group" style={{ marginBottom: '18px' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        {label}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{
          minWidth: '52px', textAlign: 'center',
          color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.92rem',
          background: 'var(--surface-color)', borderRadius: '6px', padding: '3px 8px',
        }}>
          {display}
        </span>
      </div>
      {hint && <p className="form-hint" style={{ marginTop: '0.4rem' }}>{hint}</p>}
    </div>
  );
}

export function WidgetsTab({
  widgetScale, onWidgetScaleChange,
  widgetBgOpacity, onWidgetBgOpacityChange,
  sportsScale, onSportsScaleChange,
  sportsBgOpacity, onSportsBgOpacityChange,
}: WidgetsTabProps) {
  useTranslation();
  const scalePercent   = Math.round(widgetScale * 100);
  // Cap the preview so extreme scales (up to 400%) don't blow out the settings
  // panel with clipped content — the real overlay still scales fully.
  const previewScale   = Math.min(widgetScale, 2.5);
  const opacityPercent = Math.round(widgetBgOpacity * 100);
  const sScalePct      = Math.round(sportsScale * 100);
  const sOpacityPct    = Math.round(sportsBgOpacity * 100);
  // Cap the preview so extreme scales (up to 400%) don't blow out the settings
  // panel with clipped content — the real overlay still scales fully.
  const sPreviewScale  = Math.min(sportsScale, 2.5);

  return (
    <div className="settings-tab-content playback-tab-content">

      {/* ══ Recent & Favorites Widgets ══════════════════════════════ */}
      <div className="settings-section">
        <div className="section-header"><h3>{i18n.t('settings:livetv.widgets.overlayWidgets')}</h3></div>
        <p className="section-description">
          {i18n.t('settings:livetv.widgets.overlayWidgetsSub')}
        </p>

        <div className="timeshift-settings">
          {/* Scale */}
          <SliderRow
            label={i18n.t('settings:livetv.widgets.widgetScale')}
            hint={i18n.t('settings:livetv.widgets.widgetScaleHint')}
            min={50} max={400} step={5}
            value={scalePercent}
            display={`${scalePercent}%`}
            onChange={(v) => onWidgetScaleChange(v / 100)}
          />

          {/* Quick presets */}
          <div className="timeshift-presets-label">{i18n.t('settings:livetv.widgets.scalePresets')}</div>
          <div className="timeshift-presets" style={{ marginBottom: '18px' }}>
            {[75, 100, 125, 150].map((pct) => (
              <button
                key={pct}
                className={`timeshift-preset-btn${scalePercent === pct ? ' active' : ''}`}
                onClick={() => onWidgetScaleChange(pct / 100)}
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* Background Opacity */}
          <SliderRow
            label={i18n.t('settings:livetv.widgets.bgOpacity')}
            hint={i18n.t('settings:livetv.widgets.bgOpacityHint')}
            min={5} max={95} step={5}
            value={opacityPercent}
            display={`${opacityPercent}%`}
            onChange={(v) => onWidgetBgOpacityChange(v / 100)}
          />

          {/* Resets */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
            <button
              className="sync-btn"
              onClick={() => { onWidgetScaleChange(1); onWidgetBgOpacityChange(0.55); }}
              style={{ maxWidth: '200px' }}
            >
              {i18n.t('common:resetToDefaults')}
            </button>
          </div>
        </div>
      </div>

      {/* ── Preview ── */}
      <div className="settings-section">
        <div className="section-header"><h3>{i18n.t('common:preview')}</h3></div>
        <p className="section-description">{i18n.t('settings:livetv.widgets.previewSub')}</p>

        <div className="widget-preview-area">
          <div
            className="widget-preview-scaled"
            style={{ transform: `scale(${previewScale})`, transformOrigin: 'top left' }}
          >
            {/* Recent mock */}
            <div className="widget-preview-box">
              <div className="widget-preview-header" style={{ background: `rgba(0,0,0,${widgetBgOpacity})` }}>
                {i18n.t('settings:livetv.widgets.recent5')}
              </div>
              <div className="widget-preview-list" style={{ background: `rgba(0,0,0,${widgetBgOpacity})` }}>
                {['Animal Planet  -  I Was Prey','BET  -  Martin','Animal Planet HD  -  I Was Prey','ASPiRE TV  -  The Bernie Mac Show','US | ABC  -  The Golden Girls'].map((item,i)=>(
                  <div key={i} className="widget-preview-item">
                    <span className="widget-preview-name">{item.split('  -  ')[0]}</span>
                    {item.includes('  -  ') && (<><span className="widget-preview-sep"> - </span><span className="widget-preview-prog">{item.split('  -  ')[1]}</span></>)}
                  </div>
                ))}
              </div>
            </div>
            {/* Favorites mock */}
            <div className="widget-preview-box">
              <div className="widget-preview-header" style={{ background: `rgba(0,0,0,${widgetBgOpacity})` }}>
                {i18n.t('common:favorites')}
              </div>
              <div className="widget-preview-list" style={{ background: `rgba(0,0,0,${widgetBgOpacity})` }}>
                {['US | ABC  -  The Golden Girls','BUZZER  -  Match Game Hollywood','US | Discovery  -  Caught!','Comedy Central  -  Family Guy','US | Fox HD  -  Kelly Clarkson'].map((item,i)=>(
                  <div key={i} className="widget-preview-item widget-preview-item--fav">
                    <span className="widget-preview-name">{item.split('  -  ')[0]}</span>
                    {item.includes('  -  ') && (<><span className="widget-preview-sep"> - </span><span className="widget-preview-prog">{item.split('  -  ')[1]}</span></>)}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {/* Height spacer */}
          <div aria-hidden="true" style={{
            height: `calc(${Math.round((172 + 36) * previewScale)}px + 8px)`,
            width:  `calc(${Math.round(700      * previewScale)}px)`,
            pointerEvents: 'none',
          }} />
        </div>
      </div>

      {/* ══ Sports Scores Overlay ═══════════════════════════════════ */}
      <div className="settings-section">
        <div className="section-header"><h3>{i18n.t('settings:livetv.widgets.sportsOverlay')}</h3></div>
        <p className="section-description">
          {i18n.t('settings:livetv.widgets.sportsOverlaySub')}
        </p>

        <div className="timeshift-settings">
          {/* Scale */}
          <SliderRow
            label={i18n.t('settings:livetv.widgets.overlayScale')}
            hint={i18n.t('settings:livetv.widgets.overlayScaleHint')}
            min={50} max={400} step={5}
            value={sScalePct}
            display={`${sScalePct}%`}
            onChange={(v) => onSportsScaleChange(v / 100)}
          />

          {/* Quick presets */}
          <div className="timeshift-presets-label">{i18n.t('settings:livetv.widgets.scalePresets')}</div>
          <div className="timeshift-presets" style={{ marginBottom: '18px' }}>
            {[75, 100, 125, 150].map((pct) => (
              <button
                key={pct}
                className={`timeshift-preset-btn${sScalePct === pct ? ' active' : ''}`}
                onClick={() => onSportsScaleChange(pct / 100)}
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* Background Opacity */}
          <SliderRow
            label={i18n.t('settings:livetv.widgets.bgOpacity')}
            hint={i18n.t('settings:livetv.widgets.sportsBgOpacityHint')}
            min={5} max={95} step={5}
            value={sOpacityPct}
            display={`${sOpacityPct}%`}
            onChange={(v) => onSportsBgOpacityChange(v / 100)}
          />

          {/* Resets */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
            <button
              className="sync-btn"
              onClick={() => { onSportsScaleChange(1); onSportsBgOpacityChange(0.7); }}
              style={{ maxWidth: '200px' }}
            >
              {i18n.t('common:resetToDefaults')}
            </button>
          </div>
        </div>

        {/* Sports preview */}
        <div style={{ marginTop: '16px' }}>
          <div style={{
            background: `linear-gradient(to bottom, rgba(0,0,0,${sportsBgOpacity}) 0%, rgba(0,0,0,${(sportsBgOpacity*0.5).toFixed(2)}) 60%, transparent 100%)`,
            padding: '8px 12px 20px',
            borderRadius: '8px',
            transform: `scaleY(${sPreviewScale})`,
            transformOrigin: 'top center',
            overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', gap: '12px', overflowX: 'hidden' }}>
              {[
                { league: 'NFL', away: 'KC', awayScore: 17, home: 'SF', homeScore: 14, status: 'Q3 8:42' },
                { league: 'NBA', away: 'LAL', awayScore: 89, home: 'BOS', homeScore: 92, status: 'Q4 2:15' },
                { league: 'NHL', away: 'TBL', awayScore: 2, home: 'NYR', homeScore: 2, status: '3rd 6:30' },
              ].map((g, i) => (
                <div key={i} style={{
                  background: 'var(--bg-tertiary)',
                  backdropFilter: 'blur(8px)',
                  borderRadius: '8px',
                  padding: '4px 10px',
                  border: '1px solid var(--surface-border)',
                  display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
                }}>
                  <span style={{ fontSize: '9px', fontWeight: 600, textTransform: 'uppercase',                   color: 'var(--text-secondary)' }}>{g.league}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>{g.away}</span>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', minWidth: '16px', textAlign: 'center' }}>{g.awayScore}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>vs</span>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', minWidth: '16px', textAlign: 'center' }}>{g.homeScore}</span>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>{g.home}</span>
                  </div>
                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#ef4444' }}>{g.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
