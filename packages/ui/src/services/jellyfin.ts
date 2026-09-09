/**
 * jellyfin.ts
 *
 * Frontend client for the embedded Jellyfin integration.
 *
 * The Jellyfin web UI is rendered in a native child WebView (docked below the
 * app toolbar) instead of an <iframe>. This module exposes the small command
 * surface that drives that child WebView - opening it at a given bounds,
 * resizing it on window/toolbar changes, and closing it - plus the login
 * helper that pre-authenticates credentials against the server.
 *
 * Playback handoff: an init script injected into the Jellyfin page hooks the
 * player, writes the direct stream URL to `document.title`, and Rust forwards
 * it to this app's normal play pipeline (`jellyfin:play` event) so the
 * fullscreen player / Now Playing bar behave exactly like any other VOD.
 */

import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

/**
 * Stable per-install DeviceId for the ynoTV-side pre-auth login. The token this
 * login returns is discarded (the embedded webview keeps its own session), but
 * Jellyfin records a device for every AuthenticateByName, so keep the id stable
 * instead of spawning a new "ynoTV" device on every Connect.
 */
function jellyfinPreAuthDeviceId(): string {
  const KEY = 'ynotvJellyfinDeviceId';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'ynotv-desktop';
  }
}

/** Validate credentials against a Jellyfin server and obtain an API token. */
export async function jellyfinAuthenticate(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; userId: string | null; displayName: string | null } | null> {
  try {
    const base = serverUrl.replace(/\/+$/, '');
    // Jellyfin rejects AuthenticateByName requests that carry no MediaBrowser
    // identity, so send the same "ynoTV" / hostname identity the embedded
    // webview reports (keeps the device record labeled consistently).
    const [version, machineName] = await Promise.all([
      getVersion().catch(() => ''),
      invoke<string>('jellyfin_machine_name').catch(() => ''),
    ]);
    const identity = 'MediaBrowser ' + [
      'Client="ynoTV"',
      `Device="${(machineName || 'ynoTV').replace(/"/g, "'")}"`,
      `DeviceId="${jellyfinPreAuthDeviceId()}"`,
      `Version="${version || '1.0.0'}"`,
    ].join(', ');
    const res = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': identity,
        Authorization: identity,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      token: data?.AccessToken || '',
      userId: data?.User?.Id ?? null,
      displayName: data?.User?.Name ?? username,
    };
  } catch (e) {
    console.warn('[Jellyfin] Authenticate request failed:', e);
    return null;
  }
}

/** Open (or re-open) the embedded Jellyfin child WebView at logical bounds. */
export async function jellyfinEmbedOpen(
  url: string,
  bounds: { x: number; y: number; width: number; height: number },
  debugLogging?: boolean,
): Promise<void> {
  await invoke('jellyfin_embed_open', {
    url,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    debugLogging: debugLogging ?? false,
  });
}

/** Reposition / resize the embedded Jellyfin child WebView. */
export async function jellyfinEmbedResize(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<void> {
  await invoke('jellyfin_embed_resize', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
}

/** Close the embedded Jellyfin child WebView. */
export async function jellyfinEmbedClose(): Promise<void> {
  await invoke('jellyfin_embed_close');
}

/** Hide or reveal the embedded Jellyfin child WebView without destroying it. */
export async function jellyfinEmbedSetVisible(visible: boolean): Promise<void> {
  await invoke('jellyfin_embed_set_visible', { visible });
}

/** Check whether the embedded Jellyfin child WebView is currently open. */
export async function jellyfinEmbedIsOpen(): Promise<boolean> {
  try {
    return (await invoke('jellyfin_embed_is_open')) ?? false;
  } catch (e) {
    return false;
  }
}

/** Send a spatial navigation command to the embedded Jellyfin child WebView. */
export async function jellyfinEmbedNav(action: string): Promise<boolean> {
  try {
    return (await invoke('jellyfin_embed_nav', { action })) ?? false;
  } catch (e) {
    console.warn('[Jellyfin] Failed to send nav command:', e);
    return false;
  }
}

/**
 * Confirm that a handed-off Jellyfin stream is now playing through mpv.
 * Rust records the handoff (so its idle listener can later signal playback
 * end), starts reporting position/pause/stop to the Jellyfin API (resume
 * positions + dashboard), and re-asserts the full-window video surface.
 */
export async function jellyfinConfirmPlayback(url: string): Promise<void> {
  await invoke('jellyfin_confirm_playback', { url });
}

/**
 * Re-arm the injected page script after a failed handoff, so Jellyfin's own
 * web player can take over for the next attempt.
 */
export async function jellyfinEmbedReenable(): Promise<void> {
  await invoke('jellyfin_embed_reenable');
}

/**
 * Notify the embedded Jellyfin child WebView that video playback has stopped
 * or ended, dismissing any active loading spinners or player overlays and
 * restoring the page state.
 */
export async function jellyfinEmbedNotifyPlaybackEnded(
  positionTicks?: number,
  targetItemId?: string,
): Promise<void> {
  try {
    await invoke('jellyfin_embed_notify_playback_ended', {
      positionTicks: positionTicks && positionTicks > 0 ? positionTicks : undefined,
      targetItemId: targetItemId || undefined,
    });
  } catch (e) {
    // Ignore errors if the child webview is not running
  }
}

/** Toggle debug logging dynamically on the running Jellyfin child WebView. */
export async function jellyfinSetDebugLogging(enabled: boolean): Promise<void> {
  try {
    await invoke('jellyfin_set_debug_logging', { enabled });
  } catch (e) {
    console.warn('[Jellyfin] Failed to toggle debug logging:', e);
  }
}

/** Open DevTools inspector attached to the Jellyfin child WebView. */
export async function jellyfinEmbedOpenDevtools(): Promise<void> {
  await invoke('jellyfin_embed_open_devtools');
}

/** Open jellyfin.log in the system default text viewer. */
export async function jellyfinOpenLogFile(): Promise<void> {
  await invoke('jellyfin_open_log_file');
}

/** Open the directory containing jellyfin.log in the file explorer. */
export async function jellyfinOpenLogDir(): Promise<void> {
  await invoke('jellyfin_open_log_dir');
}

/** Clear the contents of jellyfin.log. */
export async function jellyfinClearLogFile(): Promise<void> {
  await invoke('jellyfin_clear_log_file');
}