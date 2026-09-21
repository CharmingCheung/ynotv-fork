import { useEffect, useState, type KeyboardEvent } from 'react';
import { Bridge } from '../services/tauri-bridge';
import type { DashTrackCatalog } from '../services/native-dash';
import './TrackSelectionModal.css';

interface DashQualityModalProps { isOpen: boolean; onClose: () => void }

export function DashQualityModal({ isOpen, onClose }: DashQualityModalProps) {
  const [catalog, setCatalog] = useState<DashTrackCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true); setError(null);
    Bridge.getNativeDashTrackCatalog().then(setCatalog).catch((value) => setError(String(value))).finally(() => setLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;
  const choose = async (representationId: string) => {
    setError(null);
    try {
      await Bridge.setNativeDashVideoRepresentation(representationId);
      setCatalog((current) => current ? { ...current, selectedVideoRepresentationId: representationId } : current);
    } catch (value) { setError(String(value)); }
  };
  const key = (event: KeyboardEvent<HTMLElement>, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
  };

  return <div className="track-modal-overlay" onClick={onClose}>
    <div className="track-modal" onClick={(event) => event.stopPropagation()}>
      <div className="track-modal-header"><h3>Video Quality</h3><button className="track-modal-close" onClick={onClose}>×</button></div>
      <div className="track-modal-content">
        {loading ? <div className="track-modal-loading">Loading…</div> : !catalog?.active ? <div className="track-modal-empty">Manual quality is available for native DASH playback.</div> : <>
          {error && <div className="track-modal-empty">{error}</div>}
          <ul className="track-list">{catalog.videoRepresentations.map((representation) => {
            const selected = catalog.selectedVideoRepresentationId === representation.representationId;
            return <li key={representation.representationId} role="button" tabIndex={representation.compatible ? 0 : -1} aria-disabled={!representation.compatible}
              className={`track-item ${selected ? 'selected' : ''} ${!representation.compatible ? 'disabled' : ''}`}
              onClick={() => representation.compatible && choose(representation.representationId)}
              onKeyDown={(event) => representation.compatible && key(event, () => choose(representation.representationId))}>
              <span className="track-name">{representation.label}</span>
              <span className="track-info"><span className="track-codec">{representation.codec.toUpperCase()}</span><span className="track-lang">{Math.round(representation.bandwidth / 1000)} kbps</span>{!representation.compatible && <span className="track-badge">Incompatible</span>}</span>
            </li>;
          })}</ul>
        </>}
      </div>
    </div>
  </div>;
}
