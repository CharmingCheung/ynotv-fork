import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SportsTeam } from '@ynotv/core';
import { getAvailableLeagues, getLeagueTeams } from '../../services/sports';
import type { FavoriteTeam } from '../../stores/sportsFavoritesStore';
import './FavoritesRepairModal.css';

interface FavoritesRepairModalProps {
  favorites: FavoriteTeam[];
  onResolve: (favorite: FavoriteTeam, team: SportsTeam) => void;
  onSkip: () => void;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function FavoritesRepairModal({ favorites, onResolve, onSkip }: FavoritesRepairModalProps) {
  const { t } = useTranslation('sports');
  const leagues = useMemo(() => getAvailableLeagues(), []);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedLeague, setSelectedLeague] = useState('');
  const [candidates, setCandidates] = useState<SportsTeam[]>([]);
  const [loading, setLoading] = useState(false);

  const favorite = favorites[activeIndex];

  useEffect(() => {
    setSelectedLeague('');
    setCandidates([]);
  }, [favorite?.addedAt]);

  useEffect(() => {
    if (!selectedLeague || !favorite) return;
    let cancelled = false;
    setLoading(true);
    getLeagueTeams(selectedLeague)
      .then((teams) => {
        if (cancelled) return;
        const wanted = normalize(favorite.name || favorite.shortName || '');
        const matching = teams.filter((team) => {
          if (team.id === favorite.id) return true;
          const candidateName = normalize(`${team.name} ${team.shortName || ''}`);
          return Boolean(wanted) && (candidateName.includes(wanted) || wanted.includes(candidateName));
        });
        setCandidates(matching);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedLeague, favorite]);

  if (!favorite) return null;

  const resolve = (team: SportsTeam) => {
    onResolve(favorite, { ...team, leagueId: selectedLeague });
    if (activeIndex >= favorites.length - 1) {
      onSkip();
    } else {
      setActiveIndex((index) => index + 1);
    }
  };

  const useOriginalIdentity = () => {
    resolve({
      id: favorite.id,
      name: favorite.name,
      shortName: favorite.shortName,
      logo: favorite.logo,
      leagueId: selectedLeague,
    });
  };

  return createPortal(
    <div className="sports-favorites-repair-overlay" role="dialog" aria-modal="true">
      <div className="sports-favorites-repair-modal">
        <div className="sports-favorites-repair-header">
          <div>
            <h2>{t('repairFavoritesTitle', { defaultValue: 'Confirm favorite teams' })}</h2>
            <p>{t('repairFavoritesDescription', { defaultValue: 'Some older favorites need their league confirmed so games are never mixed between sports.' })}</p>
          </div>
          <button className="sports-favorites-repair-close" onClick={onSkip} aria-label={t('close', { defaultValue: 'Close' })}>×</button>
        </div>

        <div className="sports-favorites-repair-progress">
          {t('repairFavoritesProgress', { defaultValue: '{{current}} of {{total}}', current: activeIndex + 1, total: favorites.length })}
        </div>

        <div className="sports-favorites-repair-team">
          {favorite.logo && <img src={favorite.logo} alt="" />}
          <div>
            <strong>{favorite.name || t('team', { defaultValue: 'Team' })}</strong>
            <span>{t('repairFavoriteId', { defaultValue: 'ESPN team ID: {{id}}', id: favorite.id })}</span>
          </div>
        </div>

        <label className="sports-favorites-repair-label" htmlFor="favorite-league-select">
          {t('repairFavoriteLeague', { defaultValue: 'Which league is this team in?' })}
        </label>
        <select
          id="favorite-league-select"
          className="sports-favorites-repair-select"
          value={selectedLeague}
          onChange={(event) => setSelectedLeague(event.target.value)}
        >
          <option value="">{t('repairFavoriteChooseLeague', { defaultValue: 'Choose a league…' })}</option>
          {leagues.map((league) => (
            <option key={league.id} value={league.id}>{league.name}</option>
          ))}
        </select>

        {selectedLeague && (
          <div className="sports-favorites-repair-candidates">
            {loading ? (
              <div className="sports-favorites-repair-loading">{t('loading', { defaultValue: 'Loading…' })}</div>
            ) : candidates.length > 0 ? (
              <>
                <span className="sports-favorites-repair-label">{t('repairFavoriteChooseTeam', { defaultValue: 'Choose the matching team:' })}</span>
                {candidates.map((candidate) => (
                  <button key={candidate.id} className="sports-favorites-repair-candidate" onClick={() => resolve(candidate)}>
                    {candidate.logo && <img src={candidate.logo} alt="" />}
                    <span>{candidate.name}</span>
                    <small>#{candidate.id}</small>
                  </button>
                ))}
              </>
            ) : (
              <p className="sports-favorites-repair-no-match">
                {t('repairFavoriteNoMatch', { defaultValue: 'No exact team match was found. You can still confirm this league using the saved team identity.' })}
              </p>
            )}
          </div>
        )}

        <div className="sports-favorites-repair-footer">
          <button className="sports-favorites-repair-skip" onClick={onSkip}>
            {t('repairFavoritesSkip', { defaultValue: 'Skip for now' })}
          </button>
          {selectedLeague && !loading && (
            <button className="sports-favorites-repair-confirm" onClick={useOriginalIdentity}>
              {t('repairFavoriteUseLeague', { defaultValue: 'Use this league' })}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
