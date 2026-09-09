import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { jellyfinAuthenticate } from '../jellyfin';

const invokeMock = vi.mocked(invoke);
const getVersionMock = vi.mocked(getVersion);

describe('jellyfinAuthenticate', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue('DESKTOP-TEST');
    getVersionMock.mockReset().mockResolvedValue('2.5.3');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a MediaBrowser identity header (ynoTV / hostname / version) on AuthenticateByName', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ AccessToken: 'tok-1', User: { Id: 'u1', Name: 'bob' } }),
    });

    const result = await jellyfinAuthenticate('http://jf:8096/', 'bob', 'pw');

    expect(result?.token).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://jf:8096/Users/AuthenticateByName');
    const headers = init.headers as Record<string, string>;
    const embyAuth = headers['X-Emby-Authorization'];
    const standardAuth = headers['Authorization'];
    expect(embyAuth).toBeDefined();
    expect(standardAuth).toBe(embyAuth);
    expect(embyAuth).toMatch(/^MediaBrowser Client="ynoTV", Device="DESKTOP-TEST", DeviceId="[^"]+", Version="2\.5\.3"$/);
  });

  it('returns null when the server rejects the credentials', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await jellyfinAuthenticate('http://jf:8096/', 'bob', 'bad');
    expect(result).toBeNull();
  });

  it('still authenticates with fallback identity when version/machine lookups fail', async () => {
    invokeMock.mockResolvedValueOnce(null);
    getVersionMock.mockResolvedValueOnce('');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ AccessToken: 'tok-2', User: { Id: 'u1', Name: 'bob' } }),
    });

    const result = await jellyfinAuthenticate('http://jf:8096/', 'bob', 'pw');

    expect(result?.token).toBe('tok-2');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://jf:8096/Users/AuthenticateByName');
    const headers = init.headers as Record<string, string>;
    const auth = headers['X-Emby-Authorization'];
    expect(auth).toMatch(/^MediaBrowser Client="ynoTV", Device="ynoTV", DeviceId="[^"]+", Version="1\.0\.0"$/);
  });
});