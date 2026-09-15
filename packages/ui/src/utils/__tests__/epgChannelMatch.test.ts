import { describe, it, expect } from 'vitest';
import {
  cleanChannelName,
  cleanMatchKey,
  extractRegionTags,
  parseStripTags,
  matchByCleanName,
  prepareCleanNameIndex,
  MAX_REFUSAL_CHOICES,
} from '../epgChannelMatch';

const candidate = (display_name: string, id = display_name) => ({ id, display_name });

describe('cleaning channel names for EPG matching', () => {
  it('cleans the names from the report down to what the feed calls them', () => {
    // `|DE| ARD-ALPHA HD` never matched the feed's `ARD-alpha` before this tier.
    expect(cleanMatchKey('|DE| ARD-ALPHA HD')).toBe(cleanMatchKey('ARD-alpha'));
    expect(cleanMatchKey('|DE| TAGESSCHAU 24 FHD')).toBe(cleanMatchKey('Tagesschau 24'));
    expect(cleanMatchKey('UK | SKY CINEMA ACTION')).toBe(cleanMatchKey('Sky Cinema Action'));
    expect(cleanMatchKey('[US] Nick')).toBe(cleanMatchKey('Nick'));
  });

  it('keeps the original casing and words it does not remove', () => {
    expect(cleanChannelName('|DE| ARD-ALPHA HD')).toBe('ARD-ALPHA');
    expect(cleanChannelName('PELÍCULAS |ES| 4K')).toBe('PELÍCULAS');
    expect(cleanChannelName('|DE| TELE 5 FHD')).toBe('TELE 5');
  });

  it('never strips a bare region-looking word from a real name', () => {
    // Deutsche Welle, Nick DE: a 2-letter word inside a name is not a marker.
    expect(cleanChannelName('DEUTSCHE WELLE')).toBe('DEUTSCHE WELLE');
    expect(cleanChannelName('Nick DE')).toBe('Nick DE');
    expect(cleanChannelName('Sky Cinema DE HD')).toBe('Sky Cinema DE');
    expect(extractRegionTags('DEUTSCHE WELLE')).toEqual([]);
    expect(extractRegionTags('Nick DE')).toEqual([]);
  });

  it('reads region markers in every shape the providers use', () => {
    expect(extractRegionTags('|DE| TAGESSCHAU 24 FHD')).toEqual(['DE']);
    expect(extractRegionTags('UK | SKY CINEMA ACTION')).toEqual(['UK']);
    expect(extractRegionTags('[US] Nick')).toEqual(['US']);
    expect(extractRegionTags('(FR) RTL9')).toEqual(['FR']);
    expect(extractRegionTags('DE: Sky Sport')).toEqual(['DE']);
    expect(extractRegionTags('Sky Sport |DE')).toEqual(['DE']);
    expect(extractRegionTags('Sky Sport DE')).toEqual([]);
  });

  it('does not mistake a quality marker in brackets for a region', () => {
    // `(HD)` / `|SD|` are 2-letter markers that are tags, not countries.
    expect(extractRegionTags('Nick (HD)')).toEqual([]);
    expect(extractRegionTags('Nick (SD)')).toEqual([]);
    expect(cleanChannelName('Nick (HD)')).toBe('Nick');
    expect(cleanChannelName('|FR| Disney Channel (HD)')).toBe('Disney Channel');
  });

  it('strips codecs, packaging words and the user’s own tags', () => {
    expect(cleanMatchKey('|DE| SKY SPORT HEVC')).toBe(cleanMatchKey('Sky Sport'));
    expect(cleanMatchKey('|DE| SKY SPORT BACKUP')).toBe(cleanMatchKey('Sky Sport'));
    expect(cleanMatchKey('|DE| SKY SPORT VIP', ['vip'])).toBe(cleanMatchKey('Sky Sport'));
    expect(cleanMatchKey('|DE| SKY SPORT XX', ['xx'])).toBe(cleanMatchKey('Sky Sport'));
    expect(parseStripTags('VIP, RAW\nHEVC')).toEqual(['vip', 'raw', 'hevc']);
  });

  it('returns nothing at all when the name is only decorations', () => {
    expect(cleanChannelName('|DE| FHD')).toBe('');
    expect(cleanMatchKey('FHD')).toBe('');
  });
});

describe('cleaned matching: unique or not at all', () => {
  const threshold = 0.4;

  it('matches when the cleaned name fits exactly one EPG channel', () => {
    const result = matchByCleanName('|DE| ARD-ALPHA HD', [candidate('ARD-alpha')], threshold);
    expect(result.match?.display_name).toBe('ARD-alpha');
    expect(result.match?.via).toBe('clean-exact');
    expect(result.match?.score).toBe(1);
    expect(result.ambiguous).toBe(false);
  });

  it('refuses when two EPG channels share the cleaned name and the region cannot split them', () => {
    const result = matchByCleanName(
      'Nick',
      [candidate('|US| Nick'), candidate('|UK| Nick')],
      threshold,
    );
    expect(result.match).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.choices.map(c => c.display_name)).toEqual(['|US| Nick', '|UK| Nick']);
    expect(result.totalChoices).toBe(2);
  });

  it('hands the refusing candidates back so a refusal can be settled by hand', () => {
    // The worklist needs something it can *apply*, not just a name to show, so
    // the ids and feed ids have to survive the round trip.
    const result = matchByCleanName(
      'Nick',
      [
        { id: 'us.nick', display_name: '|US| Nick', source_id: 'feed-a' },
        { id: 'uk.nick', display_name: '|UK| Nick', source_id: 'feed-b' },
      ],
      threshold,
    );
    expect(result.choices).toEqual([
      { id: 'us.nick', display_name: '|US| Nick', source_id: 'feed-a' },
      { id: 'uk.nick', display_name: '|UK| Nick', source_id: 'feed-b' },
    ]);
  });

  it('lists the region-agreeing candidate first, since it is usually the right one', () => {
    // The channel is `|DE|`, so only two of these can be right: the DE one and
    // the regionless one. Every candidate is still offered — the user decides —
    // but the DE feed leads.
    const result = matchByCleanName(
      '|DE| Sky Sport',
      [candidate('|CH| Sky Sport'), candidate('|DE| Sky Sport'), candidate('Sky Sport')],
      threshold,
    );
    expect(result.ambiguous).toBe(true);
    expect(result.choices[0].display_name).toBe('|DE| Sky Sport');
    expect(result.choices[1].display_name).toBe('Sky Sport');
    expect(result.choices[2].display_name).toBe('|CH| Sky Sport');
    expect(result.totalChoices).toBe(3);
  });

  it('caps the offered choices but reports the real count', () => {
    // All twelve clean to `Nick`, so none of them can win — the cap has to bite.
    const codes = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH', 'II', 'JJ', 'KK', 'LL'];
    const many = codes.map(code => candidate(`|${code}| Nick`));
    expect(many.length).toBeGreaterThan(MAX_REFUSAL_CHOICES);
    const result = matchByCleanName('Nick', many, threshold);
    expect(result.ambiguous).toBe(true);
    expect(result.choices).toHaveLength(MAX_REFUSAL_CHOICES);
    expect(result.totalChoices).toBe(many.length);
  });

  it('offers nothing to choose from when it did not refuse', () => {
    const exact = matchByCleanName('|DE| ARD-ALPHA HD', [candidate('ARD-alpha')], threshold);
    expect(exact.choices).toEqual([]);
    expect(exact.totalChoices).toBe(0);
    const none = matchByCleanName('|DE| ARD-ALPHA HD', [candidate('WDR Fernsehen')], threshold);
    expect(none.choices).toEqual([]);
    expect(none.totalChoices).toBe(0);
  });

  it('uses the region marker to split a collision the cleaner created', () => {
    // |FR| Disney Channel and |ES| Disney Channel both clean to `disneychannel`
    // — the French one is unambiguous *once the regions are compared*.
    const result = matchByCleanName(
      '|FR| Disney Channel',
      [candidate('|ES| Disney Channel'), candidate('|FR| Disney Channel')],
      threshold,
    );
    expect(result.match?.display_name).toBe('|FR| Disney Channel');
    expect(result.ambiguous).toBe(false);
  });

  it('refuses when the regions actively disagree', () => {
    // usnick vs uknick: only the UK feed is present, so the US channel is wrong.
    const result = matchByCleanName('|US| Nick', [candidate('|UK| Nick')], threshold);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it('still scores on cleaned names when nothing is identical', () => {
    // Cleaned to `SKY CINEMA ACTION` vs `Sky Cinema`: not identical, but the
    // decorations are gone by the time the scorer sees them.
    const result = matchByCleanName(
      '|DE| SKY CINEMA ACTION HD',
      [candidate('Sky Cinema')],
      threshold,
    );
    expect(result.match?.via).toBe('clean-scored');
    expect(result.match?.score).toBeGreaterThanOrEqual(threshold);
  });

  it('returns nothing when the cleaned name matches nothing above the threshold', () => {
    const result = matchByCleanName('|DE| ARD-ALPHA HD', [candidate('WDR Fernsehen')], threshold);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.cleanedName).toBe('ARD-ALPHA');
  });

  it('never matches an all-decoration channel name, however permissive the feed', () => {
    const result = matchByCleanName('|DE| FHD', [candidate('FHD'), candidate('HD')], threshold);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it('never matches a channel to its own row', () => {
    // M3U mode lists the playlist's own channels, so the channel is always one
    // of its own candidates — matching it would resolve nothing but look like a
    // success. With only itself available there is no match at all.
    const self = { id: '|DE| ZDF HD', display_name: '|DE| ZDF HD', stream_id: 's1' };
    const withSelf = matchByCleanName('|DE| ZDF HD', [self], threshold, undefined, 's1');
    expect(withSelf.match).toBeNull();
    expect(withSelf.ambiguous).toBe(false);

    // A sibling on the same name still counts — it can carry the guide.
    const sibling = { id: 'ZDF', display_name: 'ZDF', stream_id: 's2' };
    const withSibling = matchByCleanName('|DE| ZDF HD', [self, sibling], threshold, undefined, 's1');
    expect(withSibling.match?.display_name).toBe('ZDF');
    expect(withSibling.ambiguous).toBe(false);
  });

  it('gives the same answers through a reused index as through a bare array', () => {
    // The index is the whole reason a run over a large feed is fast, so it has
    // to be a pure optimisation — same match, same refusal, same choices.
    const pool = [
      { id: 'a', display_name: '|DE| Sky Sport', source_id: 'feed' },
      { id: 'b', display_name: '|AT| Sky Sport', source_id: 'feed' },
      { id: 'c', display_name: 'ARD-alpha', source_id: 'feed' },
    ];
    const index = prepareCleanNameIndex(pool);
    for (const name of ['|DE| Sky Sport', '|DE| ARD-ALPHA HD', '|DE| FHD', 'Nothing Here']) {
      const viaArray = matchByCleanName(name, pool, threshold);
      const viaIndex = matchByCleanName(name, index, threshold);
      expect(viaIndex.match?.id).toBe(viaArray.match?.id);
      expect(viaIndex.ambiguous).toBe(viaArray.ambiguous);
      expect(viaIndex.choices.map(c => c.id)).toEqual(viaArray.choices.map(c => c.id));
      expect(viaIndex.totalChoices).toBe(viaArray.totalChoices);
      expect(viaIndex.cleanedName).toBe(viaArray.cleanedName);
    }
  });

  it('excludes the channel itself through the index too', () => {
    const self = { id: '|DE| ZDF HD', display_name: '|DE| ZDF HD', stream_id: 's1' };
    const sibling = { id: 'ZDF', display_name: 'ZDF', stream_id: 's2' };
    const index = prepareCleanNameIndex([self, sibling]);
    expect(matchByCleanName('|DE| ZDF HD', index, threshold, undefined, 's1').match?.display_name)
      .toBe('ZDF');
    const onlySelf = prepareCleanNameIndex([self]);
    expect(matchByCleanName('|DE| ZDF HD', onlySelf, threshold, undefined, 's1').match).toBeNull();
  });

  it('only scans the whole feed at the thresholds where the substring bonus can decide', () => {
    // `Espn2` vs `Espn` shares no token, but the scorer's substring bonus gives
    // 0.2 — reachable only from a slider set at or below 20%, which is exactly
    // when the token-seeded shortlist is abandoned for a full scan.
    const pool = [candidate('Espn')];
    const index = prepareCleanNameIndex(pool);
    expect(matchByCleanName('Espn2', index, 0.4).match).toBeNull();
    const low = matchByCleanName('Espn2', index, 0.2);
    expect(low.match?.display_name).toBe('Espn');
    expect(low.match?.via).toBe('clean-scored');
  });

  it('copes with no candidates or no candidates sharing a cleaned key', () => {
    expect(matchByCleanName('|DE| ZDF HD', [], threshold).match).toBeNull();
    expect(matchByCleanName('|DE| ZDF HD', [candidate('FHD')], threshold).match).toBeNull();
  });

  it('reports the cleaned name so the run can show what was tried', () => {
    const result = matchByCleanName('|DE| TAGESSCHAU 24 FHD', [candidate('Tagesschau 24')], threshold);
    expect(result.cleanedName).toBe('TAGESSCHAU 24');
  });
});
