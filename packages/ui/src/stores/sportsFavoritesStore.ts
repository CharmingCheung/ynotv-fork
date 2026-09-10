/**
 * Sports Favorites Store - Zustand store with localStorage persistence.
 *
 * ESPN IDs are only unique inside a league. Favorites without a resolvable
 * league are kept visible but are excluded from league-sensitive matching and
 * network requests until the user resolves them.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SportsTeam } from '@ynotv/core';
import { inferTeamLeagueResult } from '../services/sports/leagueInference';

export interface FavoriteTeam extends SportsTeam {
  addedAt: number;
  isPinned?: boolean;
  needsLeagueResolution?: boolean;
}

export function getFavoriteLeague(favorite: FavoriteTeam): string | undefined {
  return favorite.leagueId?.trim().toLowerCase() || inferTeamLeagueResult(favorite).leagueId;
}

export function matchesFavorite(f: FavoriteTeam, teamId: string, leagueId?: string): boolean {
  if (f.id !== teamId) return false;

  const fLeague = getFavoriteLeague(f);
  const targetLeague = leagueId?.trim().toLowerCase();

  // Never let an unresolved legacy ID match a game from an arbitrary sport.
  if (f.needsLeagueResolution || !fLeague || !targetLeague) return false;
  return fLeague === targetLeague;
}

interface SportsFavoritesState {
  favorites: FavoriteTeam[];
  repairPromptDismissed: boolean;
  addFavorite: (team: SportsTeam) => void;
  removeFavorite: (teamId: string, leagueId?: string) => void;
  isFavorite: (teamId: string, leagueId?: string) => boolean;
  clearFavorites: () => void;
  reorderFavorites: (newFavorites: FavoriteTeam[]) => void;
  moveFavorite: (teamId: string, direction: 'up' | 'down', leagueId?: string) => void;
  togglePinFavorite: (teamId: string, leagueId?: string) => void;
  resolveFavorite: (addedAt: number, team: SportsTeam) => void;
  dismissRepairPrompt: () => void;
  showRepairPrompt: () => void;
}

function migrateFavorite(favorite: any, index: number): FavoriteTeam {
  const result = inferTeamLeagueResult(favorite);
  const leagueId = favorite.leagueId?.trim().toLowerCase() || result.leagueId;

  return {
    ...favorite,
    addedAt: typeof favorite.addedAt === 'number' ? favorite.addedAt : index + 1,
    ...(leagueId ? { leagueId, needsLeagueResolution: false } : { needsLeagueResolution: true }),
  };
}

export const useSportsFavoritesStore = create<SportsFavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      repairPromptDismissed: false,

      addFavorite: (team) => set((state) => {
        const result = inferTeamLeagueResult(team);
        const leagueId = team.leagueId?.trim().toLowerCase() || result.leagueId;
        const normalizedTeam: FavoriteTeam = {
          ...team,
          ...(leagueId ? { leagueId, needsLeagueResolution: false } : { needsLeagueResolution: true }),
          addedAt: Date.now(),
        };

        if (leagueId && state.favorites.some((f) => matchesFavorite(f, normalizedTeam.id, leagueId))) {
          return state;
        }

        // An unresolved favorite is still useful as a repair candidate, but it
        // must not be treated as a valid favorite for event matching.
        return {
          favorites: [...state.favorites, normalizedTeam],
          repairPromptDismissed: leagueId ? state.repairPromptDismissed : false,
        };
      }),

      removeFavorite: (teamId, leagueId) => set((state) => ({
        favorites: state.favorites.filter((f) => {
          if (leagueId) return !matchesFavorite(f, teamId, leagueId);
          // Allow an unresolved legacy favorite to be removed without guessing its league.
          return !(f.id === teamId && !getFavoriteLeague(f));
        }),
      })),

      isFavorite: (teamId, leagueId) => get().favorites.some((f) => matchesFavorite(f, teamId, leagueId)),

      clearFavorites: () => set({ favorites: [], repairPromptDismissed: false }),

      reorderFavorites: (newFavorites) => set({ favorites: newFavorites }),

      moveFavorite: (teamId, direction, leagueId) => set((state) => {
        const index = state.favorites.findIndex((f) => matchesFavorite(f, teamId, leagueId));
        if (index === -1) return state;
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= state.favorites.length) return state;

        const updated = [...state.favorites];
        const [moved] = updated.splice(index, 1);
        updated.splice(targetIndex, 0, moved);
        return { favorites: updated };
      }),

      togglePinFavorite: (teamId, leagueId) => set((state) => ({
        favorites: state.favorites.map((f) =>
          matchesFavorite(f, teamId, leagueId) ? { ...f, isPinned: !f.isPinned } : f
        ),
      })),

      resolveFavorite: (addedAt, team) => set((state) => ({
        favorites: state.favorites.map((favorite) =>
          favorite.addedAt === addedAt
            ? {
                ...favorite,
                ...team,
                leagueId: team.leagueId?.toLowerCase(),
                needsLeagueResolution: false,
              }
            : favorite
        ),
      })),

      dismissRepairPrompt: () => set({ repairPromptDismissed: true }),
      showRepairPrompt: () => set({ repairPromptDismissed: false }),
    }),
    {
      name: 'sports-favorites',
      version: 2,
      migrate: (persistedState: any) => {
        if (!persistedState || !Array.isArray(persistedState.favorites)) {
          return persistedState;
        }

        const favorites: FavoriteTeam[] = persistedState.favorites.map(migrateFavorite);
        const hasUnresolved = favorites.some((favorite: FavoriteTeam) => Boolean(favorite.needsLeagueResolution));
        return {
          ...persistedState,
          favorites,
          repairPromptDismissed: hasUnresolved ? false : Boolean(persistedState.repairPromptDismissed),
        };
      },
    },
  ),
);

export const useFavoriteTeams = () => useSportsFavoritesStore((s) => s.favorites);
export const useAddFavorite = () => useSportsFavoritesStore((s) => s.addFavorite);
export const useRemoveFavorite = () => useSportsFavoritesStore((s) => s.removeFavorite);
export const useIsFavorite = (teamId: string, leagueId?: string) => useSportsFavoritesStore((s) => s.isFavorite(teamId, leagueId));
export const useMoveFavorite = () => useSportsFavoritesStore((s) => s.moveFavorite);
export const useTogglePinFavorite = () => useSportsFavoritesStore((s) => s.togglePinFavorite);
export const useReorderFavorites = () => useSportsFavoritesStore((s) => s.reorderFavorites);
export const useFavoriteRepairState = () => {
  const repairPromptDismissed = useSportsFavoritesStore((s) => s.repairPromptDismissed);
  const dismissRepairPrompt = useSportsFavoritesStore((s) => s.dismissRepairPrompt);
  const showRepairPrompt = useSportsFavoritesStore((s) => s.showRepairPrompt);
  return { repairPromptDismissed, dismissRepairPrompt, showRepairPrompt };
};
