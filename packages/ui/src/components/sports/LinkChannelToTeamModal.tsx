import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SportsTeam } from '@ynotv/core';
import type { StoredChannel, TeamChannelLink } from '../../db';
import { CATEGORY_NAMES, getLeagueTeams } from '../../services/sports';
import { INDIVIDUAL_SPORT_LEAGUES } from '../../services/sports/teamChannelMatcher';
import type { LeagueConfig } from '../../stores/sportsSettingsStore';
import { ALL_LEAGUES, useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useTeamChannelLinksStore, useTeamLinks } from '../../stores/teamChannelLinksStore';
import { useToastStore } from '../../stores/toastStore';
import './LinkChannelToTeamModal.css';

/** Order team categories are offered in (individual sports have no team matchups). */
const TEAM_CATEGORY_ORDER = [
  'football',
  'basketball',
  'baseball',
  'hockey',
  'soccer',
  'rugby',
  'rugby-league',
  'australian-football',
];

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h} 60% 45%)`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function TeamLogoSmall({ team }: { team: SportsTeam }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [team.logo]);

  if (team.logo && !failed) {
    return <img className="lct-team-logo" src={team.logo} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <div className="lct-team-logo lct-team-logo-fallback" style={{ background: stringToColor(team.name) }}>
      {getInitials(team.name)}
    </div>
  );
}

interface SlotRow {
  /** Resulting priority index when this row is chosen. */
  index: number;
  /** Channel currently occupying this slot (undefined for the append row). */
  occupant?: TeamChannelLink;
  /** True when this stream already sits in this exact slot. */
  isCurrent: boolean;
  /** True when this is the "add a new backup at the end" row. */
  isAppend: boolean;
}

interface LinkChannelToTeamModalProps {
  channel: StoredChannel;
  onClose: () => void;
}

export function LinkChannelToTeamModal({ channel, onClose }: LinkChannelToTeamModalProps) {
  const { t } = useTranslation('sports');
  const enabledLeagues = useSportsSettingsStore((s) => s.enabledLeagues);

  const linksLoaded = useTeamChannelLinksStore((s) => s.loaded);
  const ensureLoaded = useTeamChannelLinksStore((s) => s.ensureLoaded);
  const linkTeamAtSlot = useTeamChannelLinksStore((s) => s.linkTeamAtSlot);

  const [category, setCategory] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [team, setTeam] = useState<SportsTeam | null>(null);
  const [teamQuery, setTeamQuery] = useState('');
  const [teams, setTeams] = useState<SportsTeam[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState(false);
  const [teamsAttempt, setTeamsAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const slotPanelRef = useRef<HTMLDivElement>(null);

  const channelLabel = channel.alias || channel.name;

  // Team leagues mirror the Team Channel Settings page: enabled team leagues,
  // falling back to every team league when the user has none enabled.
  const teamLeagues = useMemo(() => {
    const base = ALL_LEAGUES.filter((l) => !INDIVIDUAL_SPORT_LEAGUES.has(l.id));
    if (enabledLeagues.length === 0) return base;
    return base.filter((l) => enabledLeagues.includes(l.id));
  }, [enabledLeagues]);

  const leagueName = useMemo(
    () => teamLeagues.find((l) => l.id === leagueId)?.name ?? leagueId ?? '',
    [teamLeagues, leagueId]
  );

  // Categories present among the available team leagues, in display order.
  const categories = useMemo(() => {
    const byCat = new Map<string, LeagueConfig[]>();
    for (const l of teamLeagues) {
      const arr = byCat.get(l.category);
      if (arr) arr.push(l);
      else byCat.set(l.category, [l]);
    }
    const ordered = TEAM_CATEGORY_ORDER.filter((c) => byCat.has(c));
    for (const c of byCat.keys()) {
      if (!ordered.includes(c)) ordered.push(c);
    }
    return ordered.map((id) => ({ id, leagues: byCat.get(id)!, name: CATEGORY_NAMES[id] || id }));
  }, [teamLeagues]);

  const leaguesForCategory = useMemo(() => {
    const found = categories.find((c) => c.id === category);
    return found ? found.leagues : [];
  }, [categories, category]);

  // Fresh start every time the modal opens.
  useEffect(() => {
    setCategory(null);
    setLeagueId(null);
    setTeam(null);
    setTeamQuery('');
    setTeams([]);
    setTeamsError(false);
  }, [channel.stream_id]);

  useEffect(() => {
    if (!category && categories.length === 1) {
      setCategory(categories[0].id);
    }
  }, [category, categories]);

  // Auto-advance when a category has exactly one league.
  useEffect(() => {
    if (category && !leagueId && leaguesForCategory.length === 1) {
      setLeagueId(leaguesForCategory[0].id);
    }
  }, [category, leagueId, leaguesForCategory]);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  // Fetch teams for the selected league (re-runs on manual retry via teamsAttempt).
  useEffect(() => {
    if (!leagueId) {
      setTeams([]);
      setTeam(null);
      setTeamQuery('');
      return;
    }
    let cancelled = false;
    setTeamsLoading(true);
    setTeamsError(false);
    setTeam(null);
    setTeamQuery('');
    getLeagueTeams(leagueId)
      .then((res) => {
        if (!cancelled) setTeams(res);
      })
      .catch((err) => {
        console.error('[LinkChannelToTeam] Failed to load teams:', err);
        if (!cancelled) setTeamsError(true);
      })
      .finally(() => {
        if (!cancelled) setTeamsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId, teamsAttempt]);

  const filteredTeams = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(
      (tm) =>
        tm.name.toLowerCase().includes(q) ||
        (tm.shortName && tm.shortName.toLowerCase().includes(q))
    );
  }, [teams, teamQuery]);

  const teamLinks = useTeamLinks(leagueId ?? '', team?.id ?? '');

  // Build the selectable slot rows for the chosen team:
  //  - Not linked yet  → one row per existing slot (insert pushes the occupant
  //    down) plus an append row for a brand-new backup.
  //  - Already linked  → every slot with the occupant; the current slot is marked isCurrent.
  const slotRows = useMemo<SlotRow[]>(() => {
    if (!team) return [];
    const currentStreamId = channel.stream_id;
    const count = teamLinks.length;
    const curIdx = teamLinks.findIndex((l) => l.stream_id === currentStreamId);

    if (curIdx === -1) {
      const rows: SlotRow[] = [];
      for (let i = 0; i <= count; i++) {
        rows.push({
          index: i,
          occupant: i < count ? teamLinks[i] : undefined,
          isCurrent: false,
          isAppend: i === count,
        });
      }
      return rows;
    }

    const rows: SlotRow[] = [];
    for (let i = 0; i < count; i++) {
      rows.push({
        index: i,
        occupant: teamLinks[i],
        isCurrent: i === curIdx,
        isAppend: false,
      });
    }
    return rows;
  }, [team, teamLinks, channel.stream_id]);

  // Scroll the slot panel into view once a team is picked.
  useEffect(() => {
    if (team) {
      slotPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [team]);

  // Apply the chosen slot. Semantics are "insert into this position":
  // anything currently at or below the slot is pushed down one, so linking
  // into a team never silently drops an existing channel.
  const handleLinkHere = useCallback(
    async (slot: number) => {
      if (!team || !leagueId || busy || !linksLoaded) return;
      setBusy(true);
      try {
        await linkTeamAtSlot(
          {
            league_id: leagueId,
            team_id: team.id,
            stream_id: channel.stream_id,
            channel_name: channelLabel,
            source_id: channel.source_id,
            auto: 0,
            confidence: 1,
          },
          slot
        );

        useToastStore.getState().addToast(
          t('linkedTeamToChannel', { team: team.name, channel: channelLabel }),
          'success'
        );
        onClose();
      } catch (err) {
        console.error('[LinkChannelToTeam] Failed to link channel:', err);
        useToastStore.getState().addToast(t('linkChannelFailed', 'Failed to link channel'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [team, leagueId, busy, linksLoaded, channel.stream_id, channelLabel, channel.source_id, linkTeamAtSlot, t, onClose]
  );

  // Escape closes the modal.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="lct-overlay" onClick={onClose}>
      <div
        className="lct-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('linkCurrentChannelToTeam', 'Link Current Channel to Team')}
      >
        {/* Header */}
        <div className="lct-header">
          <div className="lct-title-row">
            <span className="lct-title">{t('linkCurrentChannelToTeam', 'Link Current Channel to Team')}</span>
            <button className="lct-close-btn" onClick={onClose} aria-label={t('close', 'Close')}>
              ✕
            </button>
          </div>
          <p className="lct-desc">
            {t('linkChannelToTeamDesc', 'Pick a team, then choose where {{channel}} plays in its channel list.', {
              channel: channelLabel,
            })}
          </p>
          <div className="lct-channel-chip" title={channelLabel}>
            <span className="lct-channel-chip-icon">📺</span>
            <span className="lct-channel-chip-name">{channelLabel}</span>
          </div>
        </div>

        <div className="lct-body">
          {/* Sport (category) picker — hidden when only one team category is available */}
          {categories.length > 1 && (
            <div className="lct-field">
              <span className="lct-field-label">{t('sport', 'Sport')}</span>
              <div className="lct-pills">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    className={`lct-pill ${category === c.id ? 'active' : ''}`}
                    onClick={() => {
                      setCategory(c.id);
                      setLeagueId(null);
                      setTeam(null);
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* League picker */}
          {category && leaguesForCategory.length > 0 && (
            <div className="lct-field">
              <span className="lct-field-label">{t('selectLeague', 'Select league')}</span>
              <div className="lct-pills">
                {leaguesForCategory.map((l) => (
                  <button
                    key={l.id}
                    className={`lct-pill ${leagueId === l.id ? 'active' : ''}`}
                    onClick={() => {
                      setLeagueId(l.id);
                      setTeam(null);
                    }}
                  >
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Team picker */}
          {leagueId && (
            <div className="lct-field lct-teams-field">
              <span className="lct-field-label">{t('team', 'Team')}</span>
              {teamsLoading ? (
                <div className="lct-teams-state">
                  <span className="lct-spinner" />
                  <span>{t('loadingTeamsFor', 'Loading teams for {{league}}…', { league: leagueName })}</span>
                </div>
              ) : teamsError ? (
                <div className="lct-teams-state">
                  <span>{t('noTeamsFound', 'No teams found')}</span>
                  <button className="lct-retry-btn" onClick={() => setTeamsAttempt((a) => a + 1)}>
                    {t('retry', 'Retry')}
                  </button>
                </div>
              ) : (
                <>
                  {teams.length > 8 && (
                    <input
                      className="lct-team-search"
                      type="text"
                      placeholder={t('searchTeamsPlaceholder', 'Search teams by name or location…')}
                      value={teamQuery}
                      onChange={(e) => setTeamQuery(e.target.value)}
                    />
                  )}
                  {filteredTeams.length === 0 ? (
                    <div className="lct-teams-state">
                      <span>{t('noTeamsFound', 'No teams found')}</span>
                    </div>
                  ) : (
                    <div className="lct-team-list">
                      {filteredTeams.map((tm) => (
                        <button
                          key={tm.id}
                          className={`lct-team-row ${team?.id === tm.id ? 'active' : ''}`}
                          onClick={() => setTeam(tm)}
                        >
                          <TeamLogoSmall team={tm} />
                          <span className="lct-team-name" title={tm.name}>
                            {tm.shortName || tm.name}
                          </span>
                          <span className="lct-team-check">✓</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Slot picker for the chosen team */}
          {team && (
            <div ref={slotPanelRef} className="lct-slots-panel">
              <div className="lct-slots-heading">
                <TeamLogoSmall team={team} />
                <span className="lct-slots-team-name" title={team.name}>
                  {team.name}
                </span>
              </div>
              {!linksLoaded ? (
                <div className="lct-teams-loading">
                  <div className="lct-spinner" />
                  <span>{t('loadingSlots', 'Loading slots...')}</span>
                </div>
              ) : slotRows.length > 0 ? (
                <>
                  <div className="lct-slots-list">
                    {slotRows.map((row) => {
                      const isAppend = row.isAppend;
                      return (
                        <button
                          key={row.index}
                          className={`lct-slot-row ${row.index === 0 ? 'primary' : 'backup'} ${row.isCurrent ? 'current' : ''}`}
                          disabled={row.isCurrent || busy}
                          onClick={() => handleLinkHere(row.index)}
                          title={
                            row.isCurrent
                              ? t('inThisSpot', 'In this spot')
                              : `${t('linkHere', 'Link here')} — ${channelLabel}`
                          }
                        >
                          <span className="lct-slot-badge">
                            {row.index === 0
                              ? t('primaryChannel', 'Primary')
                              : t('backupChannel', { num: row.index, defaultValue: `Backup ${row.index}` })}
                          </span>
                          <span className="lct-slot-occupant" title={row.occupant ? row.occupant.channel_name : undefined}>
                            {row.occupant ? row.occupant.channel_name : ''}
                          </span>
                          <span className="lct-slot-action">
                            {row.isCurrent ? (
                              <span className="lct-slot-current-label">● {t('inThisSpot', 'In this spot')}</span>
                            ) : isAppend ? (
                              t('addBackupChannel', '+ Add Backup')
                            ) : (
                              t('linkHere', 'Link here')
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="lct-slots-note">
                    {t('linkChannelSlotsNote', 'Linking into an occupied slot moves that channel down one spot.')}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
