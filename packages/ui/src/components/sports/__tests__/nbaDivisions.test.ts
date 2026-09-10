import { describe, it, expect } from 'vitest';
import type { SportsTeam } from '@ynotv/core';
import { groupTeamsByDivision } from '../LeaguesTab';

function makeTeam(id: string, name: string, location: string, shortName: string, abbreviation?: string): SportsTeam {
  return {
    id,
    name,
    location,
    shortName,
    abbreviation: abbreviation || shortName,
    league: 'nba',
  } as any;
}

describe('groupTeamsByDivision NBA', () => {
  const hornets = makeTeam('30', 'Hornets', 'Charlotte', 'Hornets', 'CHA');
  const nets = makeTeam('17', 'Nets', 'Brooklyn', 'Nets', 'BKN');
  const celtics = makeTeam('2', 'Celtics', 'Boston', 'Celtics', 'BOS');
  const knicks = makeTeam('18', 'Knicks', 'New York', 'Knicks', 'NYK');
  const sixers = makeTeam('20', '76ers', 'Philadelphia', '76ers', 'PHI');
  const raptors = makeTeam('28', 'Raptors', 'Toronto', 'Raptors', 'TOR');

  const hawks = makeTeam('1', 'Hawks', 'Atlanta', 'Hawks', 'ATL');
  const heat = makeTeam('14', 'Heat', 'Miami', 'Heat', 'MIA');
  const magic = makeTeam('19', 'Magic', 'Orlando', 'Magic', 'ORL');
  const wizards = makeTeam('27', 'Wizards', 'Washington', 'Wizards', 'WAS');

  it('correctly places Charlotte Hornets in Southeast Division', () => {
    const groups = groupTeamsByDivision([hornets], 'nba');
    expect(groups.has('Southeast Division')).toBe(true);
    expect(groups.get('Southeast Division')?.map((t) => t.name)).toContain('Hornets');
    expect(groups.has('Atlantic Division')).toBe(false);
  });

  it('correctly places Brooklyn Nets in Atlantic Division without capturing Hornets', () => {
    const groups = groupTeamsByDivision([nets, hornets], 'nba');
    expect(groups.get('Atlantic Division')?.map((t) => t.name)).toEqual(['Nets']);
    expect(groups.get('Southeast Division')?.map((t) => t.name)).toEqual(['Hornets']);
  });

  it('correctly groups all 5 Atlantic Division teams and all 5 Southeast Division teams', () => {
    const allTeams = [
      celtics, nets, knicks, sixers, raptors,
      hawks, hornets, heat, magic, wizards,
    ];
    const groups = groupTeamsByDivision(allTeams, 'nba');

    const atlanticNames = groups.get('Atlantic Division')?.map((t) => t.name);
    expect(atlanticNames).toEqual(expect.arrayContaining(['Celtics', 'Nets', 'Knicks', '76ers', 'Raptors']));
    expect(atlanticNames?.length).toBe(5);
    expect(atlanticNames).not.toContain('Hornets');

    const southeastNames = groups.get('Southeast Division')?.map((t) => t.name);
    expect(southeastNames).toEqual(expect.arrayContaining(['Hawks', 'Hornets', 'Heat', 'Magic', 'Wizards']));
    expect(southeastNames?.length).toBe(5);
  });
});
