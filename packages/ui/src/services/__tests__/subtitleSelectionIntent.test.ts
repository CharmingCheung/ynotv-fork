import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type BridgeModule = typeof import('../tauri-bridge');

let bridgeModule: BridgeModule;
const dispatchEvent = vi.fn<(event: Event) => boolean>(() => true);

beforeAll(async () => {
  Object.defineProperty(window, 'dispatchEvent', {
    value: dispatchEvent,
    configurable: true,
    writable: true,
  });
  bridgeModule = await import('../tauri-bridge');
});

beforeEach(() => {
  dispatchEvent.mockClear();
});

describe('manual subtitle selection intent', () => {
  it('announces a user-selected track before applying it', async () => {
    await bridgeModule.Bridge.setSubtitleTrack(4, { userInitiated: true });

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ id: number }>;
    expect(event.type).toBe(bridgeModule.MANUAL_SUBTITLE_SELECTION_EVENT);
    expect(event.detail).toEqual({ id: 4 });
  });

  it('does not announce automatic subtitle selection', async () => {
    await bridgeModule.Bridge.setSubtitleTrack(4);

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('treats the subtitle-cycle control as a manual choice', async () => {
    await bridgeModule.Bridge.cycleSubtitle();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ id: null }>;
    expect(event.type).toBe(bridgeModule.MANUAL_SUBTITLE_SELECTION_EVENT);
    expect(event.detail).toEqual({ id: null });
  });
});
