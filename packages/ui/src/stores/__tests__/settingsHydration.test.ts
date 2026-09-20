/**
 * Hydration tests for the settings store's single boot-time load
 * (settingsStoreHydration.ts, Phase 1/5 of the settings-store migration).
 *
 * The store seeds synchronously from the localStorage mirror at module load,
 * then the one boot load reconciles the authoritative Tauri-storage values.
 * These tests pin down:
 *
 *   - storage is authoritative (a stored theme wins over the mirror seed),
 *   - missing/undefined values keep the store's defaults (never null),
 *   - corrupted shapes are rejected so a mismatched blob can't hydrate in,
 *   - localStorage is the fallback when Tauri storage has no data,
 *   - the one-time timeshift migration persists its flag exactly once,
 *   - a stored logo Tile Layout choice survives every boot: the default is only
 *     ever applied to an *absent* value, never written over a chosen one.
 *
 * Environment: node (no DOM needed — the applier no-ops without `document`,
 * and the store's persist helpers no-op without a real bridge).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock bridge ──────────────────────────────────────────────────────────────
// A tiny plugin-store stand-in: updateSettings merges into an in-memory map
// (the same semantics Bridge.updateSettings has against the Rust backend) and
// mirrors to localStorage (Bridge does this for synchronous seeding).
const storageBackend: Record<string, unknown> = {};

const mockUpdate = vi.fn(async (patch: Record<string, unknown>) => {
  Object.assign(storageBackend, patch);
  try {
    const existing = JSON.parse(localStorage.getItem('app-settings') || '{}');
    localStorage.setItem('app-settings', JSON.stringify({ ...existing, ...patch }));
  } catch (e) {
    /* ignore */
  }
});

const mockGet = vi.fn(async () => ({ success: true, data: { ...storageBackend } }));

Object.defineProperty(globalThis, 'window', {
  value: {
    storage: {
      getSettings: mockGet,
      updateSettings: mockUpdate,
      debouncedUpdateSettings: mockUpdate,
    },
    dispatchEvent: () => true,
  },
  configurable: true,
  writable: true,
});

type StoreModule = typeof import('../settingsStore');
type HydrationModule = typeof import('../settingsStoreHydration');
let useSettingsStore: StoreModule['useSettingsStore'];
let ensureSettingsHydration: HydrationModule['ensureSettingsHydration'];

function seedLocalStorage(obj: Record<string, unknown>): void {
  localStorage.setItem('app-settings', JSON.stringify(obj));
}

beforeEach(async () => {
  Object.keys(storageBackend).forEach((k) => delete storageBackend[k]);
  mockGet.mockClear();
  mockUpdate.mockClear();
  localStorage.clear();
  // Fresh store per test: module-level state (store, applier subscription,
  // hydration latch) must not leak between cases.
  vi.resetModules();
  ({ useSettingsStore } = await import('../settingsStore'));
  ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));
});

describe('settings store hydration', () => {
  it('reconciles authoritative storage values into the store', async () => {
    seedLocalStorage({ theme: 'dark-cyan' });
    storageBackend.theme = 'dark-crimson';
    storageBackend.language = 'fr';
    storageBackend.oledBlack = true;
    storageBackend.channelLogoSize = 60;

    await ensureSettingsHydration();
    // Let the async load settle.
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.theme).toBe('dark-crimson'); // storage beats the localStorage seed
    expect(s.language).toBe('fr');
    expect(s.oledBlack).toBe(true);
    expect(s.channelLogoSize).toBe(60);
  });

  it('keeps store defaults for missing values (no null leaks into state)', async () => {
    // Storage exists but is sparse — like a fresh install or partial import.
    storageBackend.theme = 'dark';
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.channelLogoSize).toBe(42);
    expect(s.oledBlack).toBe(false);
    expect(s.timeshiftEnabled).toBe(true);
    expect(s.maxSearchResults).toBe(1000);
    expect(s.language).toBe('en');
  });

  it('hydrates widget/sports scale + opacity vars from storage (survives restart)', async () => {
    storageBackend.widgetScale = 1.25;
    storageBackend.widgetBgOpacity = 0.4;
    storageBackend.sportsScale = 0.8;
    storageBackend.sportsBgOpacity = 0.6;

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.widgetScale).toBe(1.25);
    expect(s.widgetBgOpacity).toBe(0.4);
    expect(s.sportsScale).toBe(0.8);
    expect(s.sportsBgOpacity).toBe(0.6);
  });

  it('rejects corrupted widget-scale shapes instead of hydrating them in', async () => {
    storageBackend.widgetScale = 'big' as unknown as number;
    storageBackend.sportsBgOpacity = {} as unknown as number;

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.widgetScale).toBe(1);
    expect(s.sportsBgOpacity).toBe(0.7);
  });

  it('hydrates the mirror-only settings from disk (survives restart without localStorage)', async () => {
    // These settings previously survived restart only via the localStorage
    // mirror; disk must now be authoritative so a cleared mirror (recovery
    // screen / debug clear) cannot silently reset them to defaults.
    storageBackend.mpvQuality = 'quality';
    storageBackend.defaultCategory = 'sports';
    storageBackend.epgProgramFontSize = 18;
    storageBackend.tmdbLanguage = 'de-DE';
    storageBackend.controllerRepeatDelayMs = 500;
    storageBackend.controllerRepeatIntervalMs = 180;
    storageBackend.controllerVisualizerLayout = 'playstation';
    storageBackend.customGamepadProfiles = { '1234': { A: 'ok' } };

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.mpvQuality).toBe('quality');
    expect(s.defaultCategory).toBe('sports');
    expect(s.epgProgramFontSize).toBe(18);
    expect(s.tmdbLanguage).toBe('de-DE');
    expect(s.controllerRepeatDelayMs).toBe(500);
    expect(s.controllerRepeatIntervalMs).toBe(180);
    expect(s.controllerVisualizerLayout).toBe('playstation');
    expect(s.customGamepadProfiles).toEqual({ '1234': { A: 'ok' } });
  });

  it('keeps the localStorage-mirror seed when disk lacks the key', async () => {
    // Disk has no mpvQuality but the mirror does — the seeded value must
    // survive the hydration setState rather than being clobbered by a default.
    seedLocalStorage({ mpvQuality: 'performance' });
    storageBackend.theme = 'dark';
    // Re-import so the store's synchronous seed sees the mirror (production
    // boot order: mirror exists from the previous session before module load).
    vi.resetModules();
    ({ useSettingsStore } = await import('../settingsStore'));
    ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().mpvQuality).toBe('performance');
  });

  it('hydrates the favorites A-Z sort flag from storage (survives restart)', async () => {
    storageBackend.alwaysSortFavoritesAlphabetically = true;

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().alwaysSortFavoritesAlphabetically).toBe(true);
  });

  it('rejects corrupted values for the favorites A-Z sort flag', async () => {
    // A malformed persisted shape must be sanitized to the boolean default,
    // not leak through the hydration path.
    storageBackend.alwaysSortFavoritesAlphabetically = 'yes' as unknown as boolean;

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().alwaysSortFavoritesAlphabetically).toBe(false);
  });

  it('rejects corrupted shapes instead of hydrating them in', async () => {
    // Corrupted persisted values must not take over the store.
    storageBackend.theme = { not: 'a string' } as unknown as string;
    storageBackend.oledBlack = 'yes' as unknown as boolean;
    storageBackend.channelLogoSize = 'huge' as unknown as number;
    storageBackend.language = 'klingon'; // not a supported locale

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    // theme falls back to the localStorage mirror, else the default
    expect(s.theme).toBe('dark-cyan');
    expect(s.oledBlack).toBe(false);
    expect(s.channelLogoSize).toBe(42);
    expect(s.language).toBe('en');
  });

  it('falls back to the localStorage mirror when storage has no data', async () => {
    seedLocalStorage({
      theme: 'dark-purple',
      savedLayoutState: { activeView: 'livetv' },
      customThemeConfig: { accentColor: '#ff00ff' },
      appFontFamily: 'switzer',
    });

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.theme).toBe('dark-purple');
    expect(s.savedLayoutState).toEqual({ activeView: 'livetv' });
    expect(s.customThemeConfig).toEqual({ accentColor: '#ff00ff' });
    expect(s.appFontFamily).toBe('switzer');
  });

  it('runs the one-time timeshift migration and persists its flag exactly once', async () => {
    // Storage exists without the migration flag → the migration should write
    // the flag back exactly once.
    storageBackend.timeshiftEnabled = false;
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().timeshiftEnabled).toBe(true);
    expect(useSettingsStore.getState().timeshiftCacheBytes).toBe(268_435_456);

    const flagWrites = mockUpdate.mock.calls.filter(([patch]) => (patch as Record<string, unknown>).timeshiftMigrationCheck === true);
    expect(flagWrites).toHaveLength(1);

    // A second boot with the flag present must not re-run the migration.
    mockUpdate.mockClear();
    storageBackend.timeshiftMigrationCheck = true;
    storageBackend.timeshiftEnabled = false;
    vi.resetModules();
    ({ useSettingsStore } = await import('../settingsStore'));
    ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().timeshiftEnabled).toBe(false); // untouched
    const secondFlagWrites = mockUpdate.mock.calls.filter(([patch]) => (patch as Record<string, unknown>).timeshiftMigrationCheck === true);
    expect(secondFlagWrites).toHaveLength(0);
  });

  it('runs the v3-default migration once and persists its flag (moved from the autosync boot)', async () => {
    // Storage without v3DefaultMigrated → force v3 + latch the flag exactly once.
    storageBackend.modernUiEnabled = 'v2';
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().modernUiEnabled).toBe('v3');
    expect(useSettingsStore.getState().v3DefaultMigrated).toBe(true);

    const migrationWrites = mockUpdate.mock.calls.filter(([patch]) =>
      (patch as Record<string, unknown>).v3DefaultMigrated === true);
    expect(migrationWrites).toHaveLength(1);

    // A second boot with the flag present must not re-run the migration.
    mockUpdate.mockClear();
    storageBackend.v3DefaultMigrated = true;
    storageBackend.modernUiEnabled = 'v2';
    vi.resetModules();
    ({ useSettingsStore } = await import('../settingsStore'));
    ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().modernUiEnabled).toBe('v2'); // untouched
    const secondMigrationWrites = mockUpdate.mock.calls.filter(([patch]) =>
      (patch as Record<string, unknown>).v3DefaultMigrated === true);
    expect(secondMigrationWrites).toHaveLength(0);
  });

  it('never rewrites a stored Tile Layout choice, including full-bleed', async () => {
    // 'none' was this setting's shipped default for a while, so it is as likely to
    // be a deliberate Full-Bleed choice as any other value — and a user who picked
    // it must find it still picked after an update. Nothing on the boot path may
    // rewrite the setting: the store default only ever fills in an *absent* value.
    storageBackend.modernUiEnabled = 'v3';
    storageBackend.channelLogoPadding = 'none';
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().channelLogoPadding).toBe('none');
    const paddingWrites = mockUpdate.mock.calls.filter(
      ([patch]) => 'channelLogoPadding' in (patch as Record<string, unknown>)
    );
    expect(paddingWrites).toHaveLength(0);

    // …and the same on a later boot, for every UI generation.
    for (const ui of ['v2', 'v3'] as const) {
      vi.resetModules();
      ({ useSettingsStore } = await import('../settingsStore'));
      ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));
      storageBackend.modernUiEnabled = ui;
      await ensureSettingsHydration();
      await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));
      expect(useSettingsStore.getState().channelLogoPadding).toBe('none');
    }
  });

  it('gives an install that never chose a Tile Layout the padded default', async () => {
    // The flip side: a user who never opened the toggle has no stored value, so the
    // new default applies — and stays unpersisted, so a future change of mind about
    // the default can still reach them.
    delete storageBackend.channelLogoPadding;
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().channelLogoPadding).toBe('padded');
    expect(
      mockUpdate.mock.calls.some(([patch]) => 'channelLogoPadding' in (patch as Record<string, unknown>))
    ).toBe(false);
  });

  it('keeps an explicit padded Tile Layout as padded', async () => {
    storageBackend.channelLogoPadding = 'padded';
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().channelLogoPadding).toBe('padded');
  });

  it('hydrates the new CSS-var fields with defaults (no null leaks)', async () => {
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.channelFontSize).toBe(12);
    expect(s.categoryFontSize).toBe(13);
    expect(s.epgTitleFontSize).toBe(32);
    expect(s.epgBodyFontSize).toBe(16);
    expect(s.epgProgramFontSize).toBe(14);
    expect(s.uiScale).toBe(100);
    expect(s.transparentGuideHeight).toBe(40);
    expect(s.transparentGuideHideHeader).toBe(false);
    expect(s.transparentGuideOverlayOpacity).toBe(55);
    expect(s.transparentGuideSidebarOpacity).toBe(55);
    expect(s.defaultCategory).toBe('__last__');
    expect(s.allowLanSources).toBe(false);
  });

  it('defaults Jellyfin to disabled on fresh installs', async () => {
    // Empty storage — a brand-new install has never configured Jellyfin.
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().jellyfinEnabled).toBe(false);
  });

  it('keeps Jellyfin enabled for existing installs that configured a server (migration)', async () => {
    // Pre-existing install that already saved a server URL from the tab/panel:
    // the tab must stay visible until the user explicitly turns it off.
    storageBackend.jellyfinServerUrl = 'http://192.168.1.10:8096';
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().jellyfinEnabled).toBe(true);
  });

  it('lets an explicit user choice override the Jellyfin migration heuristic', async () => {
    // A user who explicitly disabled Jellyfin keeps it off even though a
    // server URL exists from earlier use.
    storageBackend.jellyfinServerUrl = 'http://192.168.1.10:8096';
    storageBackend.jellyfinEnabled = false;
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().jellyfinEnabled).toBe(false);
  });

  it('defaults Jellyfin Trakt/Simkl scrobbling to disabled on fresh installs', async () => {
    // Jellyfin scrobbling is opt-in so users running the server-side Trakt or
    // Simkl Jellyfin plugins don't double-scrobble by default.
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().jellyfinTraktScrobbleEnabled).toBe(false);
    expect(useSettingsStore.getState().jellyfinSimklScrobbleEnabled).toBe(false);
  });

  it('hydrates explicit Jellyfin scrobbling choices across restarts', async () => {
    storageBackend.jellyfinTraktScrobbleEnabled = true;
    storageBackend.jellyfinSimklScrobbleEnabled = false;
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().jellyfinTraktScrobbleEnabled).toBe(true);
    expect(useSettingsStore.getState().jellyfinSimklScrobbleEnabled).toBe(false);
  });

  it('is idempotent: calling ensureSettingsHydration twice performs one load', async () => {
    storageBackend.theme = 'dark';
    await ensureSettingsHydration();
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
