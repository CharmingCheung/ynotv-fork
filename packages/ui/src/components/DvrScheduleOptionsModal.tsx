import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import './DvrScheduleOptionsModal.css';

interface DvrScheduleOptionsModalProps {
  isOpen: boolean;
  programTitle: string;
  channelName: string;
  timeString: string;
  defaultStartPadding: number; // in seconds
  defaultEndPadding: number;   // in seconds
  onConfirm: (options: {
    startPadding: number;
    endPadding: number;
    recurrence: string;
    title: string;
  }) => void;
  onCancel: () => void;
}

export const START_PRESETS = [
  { label: '0s', min: 0, sec: 0 },
  { label: '30s', min: 0, sec: 30 },
  { label: '1m', min: 1, sec: 0 },
  { label: '2m', min: 2, sec: 0 },
  { label: '5m', min: 5, sec: 0 },
];

export const END_PRESETS = [
  { label: '0s', min: 0, sec: 0 },
  { label: '2m', min: 2, sec: 0 },
  { label: '5m', min: 5, sec: 0 },
  { label: '15m', min: 15, sec: 0 },
  { label: '30m', min: 30, sec: 0 },
  { label: '40m', min: 40, sec: 0 },
];

export function computeTotalSeconds(minVal: number | string, secVal: number | string): number {
  const m = Math.max(0, parseInt(String(minVal), 10) || 0);
  const s = Math.max(0, parseInt(String(secVal), 10) || 0);
  return m * 60 + s;
}

export type PaddingDescription =
  | { kind: 'on-time'; totalSec: number }
  | { kind: 'starts-early' | 'ends-late'; totalSec: number; minutes: number; seconds: number };

/**
 * Pure decision + arithmetic for the padding status badge. Label assembly is
 * deliberately left to the component so the wording (and the minute/second
 * units) come from i18n instead of being hardcoded English.
 */
export function describePadding(
  minVal: number | string,
  secVal: number | string,
  isStart: boolean
): PaddingDescription {
  const totalSec = computeTotalSeconds(minVal, secVal);
  if (totalSec === 0) return { kind: 'on-time', totalSec };
  return {
    kind: isStart ? 'starts-early' : 'ends-late',
    totalSec,
    minutes: Math.floor(totalSec / 60),
    seconds: totalSec % 60,
  };
}

export function DvrScheduleOptionsModal({
  isOpen,
  programTitle,
  channelName,
  timeString,
  defaultStartPadding,
  defaultEndPadding,
  onConfirm,
  onCancel,
}: DvrScheduleOptionsModalProps) {
  const { t, i18n } = useTranslation('dvr');

  const [startMinutes, setStartMinutes] = useState<number | string>(() =>
    Math.floor((defaultStartPadding || 0) / 60)
  );
  const [startSeconds, setStartSeconds] = useState<number | string>(() =>
    (defaultStartPadding || 0) % 60
  );

  const [endMinutes, setEndMinutes] = useState<number | string>(() =>
    Math.floor((defaultEndPadding || 0) / 60)
  );
  const [endSeconds, setEndSeconds] = useState<number | string>(() =>
    (defaultEndPadding || 0) % 60
  );

  const [recurrence, setRecurrence] = useState('once');
  const [recurrenceDays, setRecurrenceDays] = useState(3);
  const [title, setTitle] = useState(programTitle);

  useEffect(() => {
    if (isOpen) {
      setStartMinutes(Math.floor((defaultStartPadding || 0) / 60));
      setStartSeconds((defaultStartPadding || 0) % 60);
      setEndMinutes(Math.floor((defaultEndPadding || 0) / 60));
      setEndSeconds((defaultEndPadding || 0) % 60);
      setRecurrence('once');
      setRecurrenceDays(3);
      setTitle(programTitle);
    }
  }, [isOpen, defaultStartPadding, defaultEndPadding, programTitle]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onCancel]);

  const handleMinutesChange = (
    val: string,
    setter: (v: number | string) => void
  ) => {
    if (val === '') {
      setter('');
      return;
    }
    const num = parseInt(val, 10);
    setter(isNaN(num) || num < 0 ? 0 : num);
  };

  const handleSecondsChange = (
    val: string,
    setter: (v: number | string) => void
  ) => {
    if (val === '') {
      setter('');
      return;
    }
    const num = parseInt(val, 10);
    setter(isNaN(num) || num < 0 ? 0 : num);
  };

  const handleConfirm = useCallback(() => {
    const finalRecurrence = recurrence === 'every' ? `every:${recurrenceDays}` : recurrence;
    const computedStartPadding = computeTotalSeconds(startMinutes, startSeconds);
    const computedEndPadding = computeTotalSeconds(endMinutes, endSeconds);

    onConfirm({
      startPadding: computedStartPadding,
      endPadding: computedEndPadding,
      recurrence: finalRecurrence,
      title: title.trim() || programTitle,
    });
  }, [
    onConfirm,
    startMinutes,
    startSeconds,
    endMinutes,
    endSeconds,
    recurrence,
    recurrenceDays,
    title,
    programTitle,
  ]);

  if (!isOpen) return null;

  const currentStartM = Math.max(0, parseInt(String(startMinutes), 10) || 0);
  const currentStartS = Math.max(0, parseInt(String(startSeconds), 10) || 0);
  const currentEndM = Math.max(0, parseInt(String(endMinutes), 10) || 0);
  const currentEndS = Math.max(0, parseInt(String(endSeconds), 10) || 0);

  // Duration fragments reuse the shared `time:durationM` / `time:durationS`
  // unit strings so a locale's minute/second wording stays consistent across
  // the app instead of being re-invented here.
  const formatDuration = (minutes: number, seconds: number): string => {
    const parts: string[] = [];
    if (minutes > 0) parts.push(i18n.t('time:durationM', { minutes }));
    if (seconds > 0) parts.push(i18n.t('time:durationS', { seconds }));
    return parts.join(' ');
  };

  const renderPaddingBadge = (minVal: number | string, secVal: number | string, isStart: boolean): string => {
    const desc = describePadding(minVal, secVal, isStart);
    if (desc.kind === 'on-time') {
      return t('paddingOnTime', { duration: i18n.t('time:durationS', { seconds: 0 }) });
    }
    const duration = formatDuration(desc.minutes, desc.seconds);
    return desc.kind === 'starts-early'
      ? t('paddingStartsEarly', { duration })
      : t('paddingEndsLate', { duration });
  };

  return createPortal(
    <div className="dvr-options-modal-overlay" onClick={onCancel}>
      <div className="dvr-options-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="dvr-options-modal-header">
          <div className="dvr-options-header-title-group">
            <div className="dvr-options-header-icon-wrap">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
            </div>
            <div>
              <h3>{t('scheduleOptionsTitle')}</h3>
              <span className="dvr-options-header-subtitle">{t('scheduleOptionsSubtitle')}</span>
            </div>
          </div>
          <button className="dvr-options-modal-close" onClick={onCancel} title={i18n.t('common:close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Modal Body */}
        <div className="dvr-options-modal-body">
          {/* Program Info Card */}
          <div className="dvr-options-program-info">
            <div className="dvr-options-program-badge-row">
              <span className="dvr-options-badge dvr-options-badge-channel">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                  <polyline points="17 2 12 7 7 2" />
                </svg>
                {channelName}
              </span>
              <span className="dvr-options-badge dvr-options-badge-time">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {timeString}
              </span>
            </div>
            <div className="dvr-options-program-title">{programTitle}</div>
          </div>

          {/* Title Edit */}
          <div className="dvr-options-form-group">
            <div className="dvr-options-label-row">
              <label className="dvr-options-label">{t('recordingTitle')}</label>
              {title !== programTitle && (
                <button
                  type="button"
                  className="dvr-options-reset-title-btn"
                  onClick={() => setTitle(programTitle)}
                  title={i18n.t('common:resetToDefault')}
                >
                  {t('resetTitle')}
                </button>
              )}
            </div>
            <div className="dvr-options-input-wrapper">
              <svg className="dvr-options-input-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="dvr-options-text-input"
                placeholder={t('recordingTitle')}
              />
            </div>
          </div>

          {/* Recurrence Selection */}
          <div className="dvr-options-form-group">
            <label className="dvr-options-label">{t('recurrence')}</label>
            <div className="dvr-options-select-wrapper">
              <svg className="dvr-options-input-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              <select
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                className="dvr-options-select"
              >
                <option value="once">{t('once')}</option>
                <option value="daily">{t('daily')}</option>
                <option value="weekly">{t('weekly')}</option>
                <option value="every">{t('everyXDays')}</option>
              </select>
              <svg className="dvr-options-select-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          {recurrence === 'every' && (
            <div className="dvr-options-form-group dvr-options-sub-group">
              <label className="dvr-options-label">{t('repeatEveryDays')}</label>
              <div className="dvr-options-time-field" style={{ width: '130px' }}>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={recurrenceDays}
                  onChange={(e) => setRecurrenceDays(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="dvr-options-number-input"
                />
                <span className="dvr-options-unit-badge">{t('days')}</span>
              </div>
            </div>
          )}

          {/* Padding Section */}
          <div className="dvr-options-padding-section">
            <div className="dvr-options-section-heading">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{t('paddingSettings')}</span>
            </div>

            {/* Start Padding */}
            <div className="dvr-options-padding-card">
              <div className="dvr-options-padding-header">
                <div className="dvr-options-padding-title-group">
                  <span className="dvr-options-padding-title">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="11 19 2 12 11 5 11 19" />
                      <polygon points="22 19 13 12 22 5 22 19" />
                    </svg>
                    {t('startPadding')}
                  </span>
                  <span className="dvr-options-hint">{t('startPaddingHint')}</span>
                </div>
                <span className="dvr-options-duration-tag">
                  {renderPaddingBadge(startMinutes, startSeconds, true)}
                </span>
              </div>

              <div className="dvr-options-padding-controls-row">
                <div className="dvr-options-time-inputs">
                  <div className="dvr-options-time-field">
                    <input
                      type="number"
                      min="0"
                      value={startMinutes}
                      onChange={(e) => handleMinutesChange(e.target.value, setStartMinutes)}
                      onBlur={() => {
                        if (startMinutes === '') setStartMinutes(0);
                      }}
                      className="dvr-options-number-input"
                      placeholder="0"
                    />
                    <span className="dvr-options-unit-badge">{i18n.t('settings:playback.minUnit')}</span>
                  </div>
                  <span className="dvr-options-time-colon">:</span>
                  <div className="dvr-options-time-field">
                    <input
                      type="number"
                      min="0"
                      value={startSeconds}
                      onChange={(e) => handleSecondsChange(e.target.value, setStartSeconds)}
                      onBlur={() => {
                        if (startSeconds === '') setStartSeconds(0);
                      }}
                      className="dvr-options-number-input"
                      placeholder="0"
                    />
                    <span className="dvr-options-unit-badge">{i18n.t('settings:playback.secUnit')}</span>
                  </div>
                </div>

                <div className="dvr-options-presets">
                  {START_PRESETS.map((p) => {
                    const isActive = currentStartM === p.min && currentStartS === p.sec;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        className={`dvr-options-preset-btn ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          setStartMinutes(p.min);
                          setStartSeconds(p.sec);
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* End Padding */}
            <div className="dvr-options-padding-card">
              <div className="dvr-options-padding-header">
                <div className="dvr-options-padding-title-group">
                  <span className="dvr-options-padding-title">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="13 19 22 12 13 5 13 19" />
                      <polygon points="2 19 11 12 2 5 2 19" />
                    </svg>
                    {t('endPadding')}
                  </span>
                  <span className="dvr-options-hint">{t('endPaddingHint')}</span>
                </div>
                <span className="dvr-options-duration-tag">
                  {renderPaddingBadge(endMinutes, endSeconds, false)}
                </span>
              </div>

              <div className="dvr-options-padding-controls-row">
                <div className="dvr-options-time-inputs">
                  <div className="dvr-options-time-field">
                    <input
                      type="number"
                      min="0"
                      value={endMinutes}
                      onChange={(e) => handleMinutesChange(e.target.value, setEndMinutes)}
                      onBlur={() => {
                        if (endMinutes === '') setEndMinutes(0);
                      }}
                      className="dvr-options-number-input"
                      placeholder="0"
                    />
                    <span className="dvr-options-unit-badge">{i18n.t('settings:playback.minUnit')}</span>
                  </div>
                  <span className="dvr-options-time-colon">:</span>
                  <div className="dvr-options-time-field">
                    <input
                      type="number"
                      min="0"
                      value={endSeconds}
                      onChange={(e) => handleSecondsChange(e.target.value, setEndSeconds)}
                      onBlur={() => {
                        if (endSeconds === '') setEndSeconds(0);
                      }}
                      className="dvr-options-number-input"
                      placeholder="0"
                    />
                    <span className="dvr-options-unit-badge">{i18n.t('settings:playback.secUnit')}</span>
                  </div>
                </div>

                <div className="dvr-options-presets">
                  {END_PRESETS.map((p) => {
                    const isActive = currentEndM === p.min && currentEndS === p.sec;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        className={`dvr-options-preset-btn ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          setEndMinutes(p.min);
                          setEndSeconds(p.sec);
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dvr-options-modal-footer">
          <button type="button" className="dvr-options-btn dvr-options-btn-secondary" onClick={onCancel}>
            {i18n.t('common:cancel')}
          </button>
          <button type="button" className="dvr-options-btn dvr-options-btn-primary" onClick={handleConfirm}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {i18n.t('common:contextMenu.schedule')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
