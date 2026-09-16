/**
 * The post-sync alignment must only delete rows it is about to replace.
 *
 * This is a SQL-semantics bug, so it is tested against a real SQLite rather than
 * a mocked adapter: the three statements `alignOverriddenChannelPrograms` runs
 * are executed in order on a seeded `channels` / `epg_channel_overrides` /
 * `programs` schema, and the assertions are about rows, not about call counts.
 *
 * The invariant under test: for every channel the DELETE touches, the INSERTs
 * write at least one row back. The cases below are the ones that used to break it
 * — a carrier that is itself overridden, a carrier whose guide is entirely
 * expired (an empty or truncated provider feed), and a pinned channel whose
 * pinned feed has nothing.
 */
import { describe, expect, it } from 'vitest';
import { buildAlignmentStatements } from '../../db/sync';

// `node:sqlite` needs Node 22.5+ and, on 22.x, the --experimental-sqlite flag.
// Skipped rather than failed where it isn't available.
let DatabaseSync: (new (path: string) => any) | null = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const suite = DatabaseSync ? describe : describe.skip;

const SRC_A = 'source-a';
const SRC_B = 'source-b';

const SCHEMA = `
  CREATE TABLE channels (
    stream_id TEXT PRIMARY KEY,
    source_id TEXT,
    epg_channel_id TEXT,
    name TEXT
  );
  CREATE TABLE epg_channel_overrides (
    stream_id TEXT PRIMARY KEY,
    epg_channel_id TEXT,
    epg_source_id TEXT
  );
  CREATE TABLE programs (
    id TEXT PRIMARY KEY,
    stream_id TEXT,
    title TEXT,
    subtitle TEXT,
    description TEXT,
    start TEXT,
    end TEXT,
    source_id TEXT
  );
`;

/**
 * RFC 3339 ends, exactly as the app stores them.
 *
 * `expired` is deliberately two days back: the cutoff is compared as text
 * (`'2026-09-16T…'` vs `datetime('now','-1 hour')` → `'2026-09-16 08:00:00'`), and
 * `'T'` sorts above `' '`, so a row ending *any* time on the cutoff's calendar
 * day still counts as inside the window. That's the app's existing behaviour and
 * both the DELETE and the INSERTs share it — the fixtures just have to sit on the
 * right side of it to mean what they say.
 */
const expired = () => new Date(Date.now() - 48 * 3600_000).toISOString();
const future = (hours = 5) => new Date(Date.now() + hours * 3600_000).toISOString();

type Channel = { streamId: string; source: string; epgId?: string | null; name?: string | null };
type Override = { streamId: string; epgId: string; pin?: string | null };
type Row = { streamId: string; start: string; end: string };

/**
 * Pin clause without unservable feeds — the same text the sync passes when every
 * pin names a feed that still exists.
 */
const PIN_SQL = `(
           eco.epg_source_id IS NULL
           OR (substr(eco.epg_source_id, 1, 11) != 'global_epg_' AND eco.epg_source_id = sc.source_id)
         )`;

function seed(channels: Channel[], overrides: Override[], programs: Row[]) {
  const db = new (DatabaseSync as any)(':memory:');
  db.exec(SCHEMA);
  const insCh = db.prepare(
    'INSERT INTO channels (stream_id, source_id, epg_channel_id, name) VALUES ($1, $2, $3, $4)'
  );
  // `node:sqlite` binds `$n` parameters by name only, mirroring how the app's
  // adapter passes them.
  for (const c of channels) {
    insCh.run({ $1: c.streamId, $2: c.source, $3: c.epgId ?? null, $4: c.name ?? c.streamId });
  }
  const insOv = db.prepare(
    'INSERT INTO epg_channel_overrides (stream_id, epg_channel_id, epg_source_id) VALUES ($1, $2, $3)'
  );
  for (const o of overrides) insOv.run({ $1: o.streamId, $2: o.epgId, $3: o.pin ?? null });
  const insP = db.prepare(
    'INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)'
  );
  programs.forEach((p, i) => {
    insP.run({
      $1: `p${i}`,
      $2: p.streamId,
      $3: `show-${i}`,
      $4: p.start,
      $5: p.end,
      $6: SRC_A,
    });
  });
  return db;
}

/** Run the alignment for `sourceId`, returning which channels lost rows and where rows came back. */
function align(db: any, sourceId: string) {
  const { deleteProgramsSql, insertByIdSql, insertByNameSql } = buildAlignmentStatements(PIN_SQL);
  const params = { $1: sourceId };
  const before = countRows(db);
  db.prepare(deleteProgramsSql).run(params);
  const deleted = diff(before, countRows(db));
  const inserted = db.prepare(insertByIdSql).run(params).changes
    + db.prepare(insertByNameSql).run(params).changes;
  return { deleted, inserted, after: countRows(db) };
}

function countRows(db: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare('SELECT stream_id, COUNT(*) AS c FROM programs GROUP BY stream_id').all()) {
    out.set(r.stream_id as string, Number(r.c));
  }
  return out;
}

function diff(before: Map<string, number>, after: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [streamId, count] of before) {
    if ((after.get(streamId) ?? 0) < count) out.push(streamId);
  }
  return out;
}

suite('alignOverriddenChannelPrograms: delete only what it replaces', () => {
  it('refills a target whose carrier holds rows in the window', () => {
    const db = seed(
      [
        { streamId: 'a-target', source: SRC_A, epgId: 'id-x', name: 'Target' },
        { streamId: 'b-copy', source: SRC_B, epgId: 'id-x', name: 'Copy' },
      ],
      [{ streamId: 'a-target', epgId: 'id-x' }],
      [
        { streamId: 'a-target', start: expired(), end: expired() },
        { streamId: 'b-copy', start: future(1), end: future(2) },
      ]
    );

    const { deleted, after } = align(db, SRC_A);

    expect(deleted).toEqual(['a-target']);
    // The carrier's row landed on the target: nothing was deleted without a replacement.
    expect(after.get('a-target')).toBe(1);
      const row = db.prepare('SELECT source_id, title FROM programs WHERE stream_id = $1').get({ $1: 'a-target' });
    expect(row.source_id).toBe(SRC_A);
    expect(row.title).toBe('show-1');
  });

  it('keeps a target whose only carrier carries nothing in the window', () => {
    const db = seed(
      [
        { streamId: 'a-target', source: SRC_A, epgId: 'id-x', name: 'Target' },
        { streamId: 'b-copy', source: SRC_B, epgId: 'id-x', name: 'Copy' },
      ],
      [{ streamId: 'a-target', epgId: 'id-x' }],
      [
        // The target's own pass just wrote this, and the carrier is stale — the
        // shape that used to be emptied and never refilled.
        { streamId: 'a-target', start: future(1), end: future(2) },
        { streamId: 'b-copy', start: expired(), end: expired() },
      ]
    );

    const { deleted, after } = align(db, SRC_A);

    expect(deleted).toEqual([]);
    expect(after.get('a-target')).toBe(1);
  });

  it('keeps a target whose only carrier is itself overridden', () => {
    const db = seed(
      [
        { streamId: 'a-target', source: SRC_A, epgId: 'id-x', name: 'Target' },
        { streamId: 'b-copy', source: SRC_B, epgId: 'id-x', name: 'Copy' },
        { streamId: 'b-copy-2', source: SRC_B, epgId: 'id-x', name: 'Copy 2' },
      ],
      [
        { streamId: 'a-target', epgId: 'id-x' },
        { streamId: 'b-copy', epgId: 'id-x' },
      ],
      [
        { streamId: 'a-target', start: future(1), end: future(2) },
        { streamId: 'b-copy', start: future(1), end: future(2) },
      ]
    );

    const { deleted, after } = align(db, SRC_A);

    expect(deleted).toEqual([]);
    expect(after.get('a-target')).toBe(1);
    expect(after.get('b-copy')).toBe(1);
    expect(after.get('b-copy-2')).toBeUndefined();
  });

  it('keeps a pinned target whose pinned feed is empty', () => {
    const db = seed(
      [
        { streamId: 'a-pinned', source: SRC_A, epgId: 'id-x', name: 'Pinned' },
        { streamId: 'b-copy', source: SRC_B, epgId: 'id-x', name: 'Copy' },
      ],
      [{ streamId: 'a-pinned', epgId: 'id-x', pin: SRC_B }],
      [
        { streamId: 'a-pinned', start: future(1), end: future(2) },
        // B's download came back empty (the 108-byte XMLTV case): no rows at all.
      ]
    );

    const { deleted, after } = align(db, SRC_A);

    expect(deleted).toEqual([]);
    expect(after.get('a-pinned')).toBe(1);
  });

  it('replaces a name-matched target, and leaves other sources alone', () => {
    const db = seed(
      [
        { streamId: 'a-target', source: SRC_A, epgId: 'Some Channel', name: 'Some Channel' },
        { streamId: 'b-same-name', source: SRC_B, epgId: null, name: 'Some Channel' },
        { streamId: 'c-untouched', source: 'source-c', epgId: 'id-z', name: 'Other' },
      ],
      [{ streamId: 'a-target', epgId: 'Some Channel' }],
      [
        { streamId: 'a-target', start: expired(), end: expired() },
        { streamId: 'b-same-name', start: future(1), end: future(2) },
        { streamId: 'c-untouched', start: future(1), end: future(2) },
      ]
    );

    const { deleted, after } = align(db, SRC_A);

    expect(deleted).toEqual(['a-target']);
    expect(after.get('a-target')).toBe(1);
    expect(after.get('c-untouched')).toBe(1);
  });

  it('holds the invariant across a mixed fixture', () => {
    const db = seed(
      [
        { streamId: 'a-live', source: SRC_A, epgId: 'id-live', name: 'Live' },
        { streamId: 'a-stale', source: SRC_A, epgId: 'id-stale', name: 'Stale' },
        { streamId: 'a-pinned', source: SRC_A, epgId: 'id-pin', name: 'Pinned' },
        { streamId: 'a-name', source: SRC_A, epgId: 'Name Only', name: 'Name Only' },
        { streamId: 'b-live', source: SRC_B, epgId: 'id-live', name: 'Live' },
        { streamId: 'b-stale', source: SRC_B, epgId: 'id-stale', name: 'Stale' },
        { streamId: 'b-ov', source: SRC_B, epgId: 'id-pin', name: 'Pinned' },
        { streamId: 'b-name', source: SRC_B, epgId: null, name: 'Name Only' },
      ],
      [
        { streamId: 'a-live', epgId: 'id-live' },
        { streamId: 'a-stale', epgId: 'id-stale' },
        { streamId: 'a-pinned', epgId: 'id-pin', pin: SRC_B },
        { streamId: 'a-name', epgId: 'Name Only' },
        { streamId: 'b-ov', epgId: 'id-pin' },
      ],
      [
        { streamId: 'a-live', start: expired(), end: expired() },
        { streamId: 'a-stale', start: future(1), end: future(2) },
        { streamId: 'a-pinned', start: future(1), end: future(2) },
        { streamId: 'a-name', start: expired(), end: expired() },
        { streamId: 'b-live', start: future(1), end: future(2) },
        { streamId: 'b-stale', start: expired(), end: expired() },
        { streamId: 'b-ov', start: future(1), end: future(2) },
        { streamId: 'b-name', start: future(1), end: future(2) },
      ]
    );

    const { deleted, after } = align(db, SRC_A);

    // The two carriers with data in the window are the only targets emptied…
    expect(deleted.sort()).toEqual(['a-live', 'a-name']);
    // …and both got a row back, while every other target kept its guide.
    for (const streamId of deleted) {
      expect(after.get(streamId)).toBeGreaterThan(0);
    }
    expect(after.get('a-stale')).toBe(1);
    expect(after.get('a-pinned')).toBe(1);
    expect(after.get('b-stale')).toBe(1);
  });
});
