//! System tray support.
//!
//! Provides a tray icon with a small menu and the "minimize to tray" behavior.
//! The user enables/disables minimize-to-tray from Settings -> UI; the frontend
//! notifies us via the `set_minimize_to_tray` command so the Rust side never has
//! to parse the settings store itself.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    AppHandle, Manager, Runtime,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

/// Runtime UI flags that the frontend keeps in sync with the persisted settings.
#[derive(Default)]
pub struct TrayState {
    pub minimize_to_tray: AtomicBool,
}

/// Whether the main window should hide to the tray when closed.
pub fn minimize_to_tray_enabled(app: &AppHandle<impl Runtime>) -> bool {
    app.state::<TrayState>()
        .minimize_to_tray
        .load(Ordering::Relaxed)
}

/// Fallback: read the persisted "minimize to tray" setting straight from the
/// settings store.
///
/// The frontend normally seeds the in-memory flag via `set_minimize_to_tray`
/// once on startup and again whenever the toggle changes. If that handshake
/// never lands (startup seed raced or was skipped, Settings was never opened
/// this session, the invoke failed), the flag would stay false and closing the
/// window would exit the app instead of hiding to the tray. Reading the store
/// here makes close-to-tray work regardless of the handshake.
pub fn minimize_to_tray_from_store(app: &AppHandle<impl Runtime>) -> bool {
    use tauri_plugin_store::StoreExt;

    match app.store(".settings.dat") {
        Ok(store) => store
            .get("settings")
            // Clone the settings object so the chain doesn't borrow from a
            // temporary (mirrors get_mpv_params_from_store in lib.rs).
            .and_then(|v| v.as_object().cloned())
            .and_then(|o| o.get("minimizeToTray").and_then(|v| v.as_bool()))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Bring the main window back on screen and give it focus.
pub fn show_main_window(app: &AppHandle<impl Runtime>) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        if let Some(tracker) = app.try_state::<crate::WindowStateTracker>() {
            if tracker.pending_startup_maximize.swap(false, Ordering::Relaxed) {
                let _ = window.maximize();
            }
            if tracker.pending_startup_fullscreen.swap(false, Ordering::Relaxed) {
                let _ = window.set_fullscreen(true);
            }
        }
        let _ = window.set_focus();
    }
}

/// Create the tray icon and register the in-memory setting via a managed state.
pub fn setup<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    app.manage(TrayState::default());

    let show_item = MenuItem::with_id(app, "show", "Show ynoTV", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ynoTV")
        .menu(&menu)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "show" => show_main_window(app_handle),
            // Do NOT touch `minimize_to_tray` here. The exit can be cancelled by the
            // DVR exit-guard dialog ("Keep open"), which would leave the flag cleared
            // against the user's setting. The flag is only mutated via set_minimize_to_tray.
            "quit" => {
                // Persist the window geometry before exiting: app.exit(0) destroys the
                // windows without firing CloseRequested, so save_window_state (which
                // normally runs on close) would otherwise never run and the app would
                // reopen at a stale position/size.
                crate::save_window_state(app_handle);
                app_handle.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// Set whether the main window should minimize to the tray on close.
///
/// The frontend calls this whenever the "Minimize to tray" UI setting changes,
/// and once on startup, so this stays in sync with the persisted setting.
#[tauri::command]
pub fn set_minimize_to_tray(app: AppHandle, enabled: bool) -> bool {
    app.state::<TrayState>()
        .minimize_to_tray
        .store(enabled, Ordering::Relaxed);
    enabled
}

/// Whether this process was launched by Windows startup with the tray option
/// ("Launch to tray on startup"): the HKCU Run entry written by
/// `set_launch_at_startup` appends `--startup-tray` only when the tray option
/// is enabled, so the app knows to start hidden in the tray instead of
/// showing its window. A plain "Launch on Windows startup" entry has no such
/// argument and shows the window normally.
pub fn is_startup_tray_launch() -> bool {
    std::env::args().any(|a| a == "--startup-tray")
}

/// Enable/disable "Launch on Windows startup".
///
/// Registers (or removes) the HKCU `...\CurrentVersion\Run` entry pointing at
/// the current executable. When `tray` is true the command line includes the
/// `--startup-tray` argument so Windows starts ynoTV hidden in the system
/// tray on logon; when false the app starts with its normal window. No-op on
/// non-Windows platforms.
#[tauri::command]
pub fn set_launch_at_startup(enabled: bool, tray: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    set_launch_at_startup_windows(enabled, tray)?;

    #[cfg(not(target_os = "windows"))]
    log::info!(
        "[Tray] Launch-at-startup is only supported on Windows; ignoring toggle ({enabled}, tray: {tray})"
    );

    Ok(enabled)
}

/// Write/remove the per-user Windows startup entry. The Run key always exists
/// under HKCU, so we only need to open it with write access.
#[cfg(target_os = "windows")]
fn set_launch_at_startup_windows(enabled: bool, tray: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "ynoTV";

    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve executable path: {e}"))?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu
        .open_subkey_with_flags(RUN_KEY_PATH, KEY_READ | KEY_SET_VALUE)
        .map_err(|e| format!("Failed to open Windows Run key: {e}"))?;

    if enabled {
        let command_line = if tray {
            format!("\"{}\" --startup-tray", exe.to_string_lossy())
        } else {
            format!("\"{}\"", exe.to_string_lossy())
        };
        run_key
            .set_value(VALUE_NAME, &command_line)
            .map_err(|e| format!("Failed to write Windows startup entry: {e}"))?;
        log::info!("[Tray] Launch-at-startup enabled: {command_line}");
    } else {
        // Ignore "value not found" — disabling an already-disabled entry is fine.
        match run_key.delete_value(VALUE_NAME) {
            Ok(()) => log::info!("[Tray] Launch-at-startup disabled."),
            Err(e) => {
                log::warn!("[Tray] Failed to remove Windows startup entry (may already be absent): {e}")
            }
        }
    }
    Ok(())
}
