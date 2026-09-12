use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, DestroyIcon, GetSystemMetrics, SendMessageW, SetClassLongPtrW,
        SetWindowPos, GCLP_HICON, GCLP_HICONSM, HICON, ICON_BIG, ICON_SMALL, LR_DEFAULTCOLOR,
        SM_CXSMICON, SM_CYSMICON, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        WM_SETICON,
    },
};

// Keep active HICON handles alive in memory so Windows Explorer / DWM does not
// read dangling pointers when repainting the taskbar / Alt+Tab.
#[cfg(target_os = "windows")]
static ACTIVE_ICONS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

pub const ICONS: &[(&str, &[u8])] = &[
    ("midnight-4b", include_bytes!("../icons/switcher/midnight-4b.png")),
    ("midnight-4a", include_bytes!("../icons/switcher/midnight-4a.png")),
    ("vibrant-cyber", include_bytes!("../icons/switcher/vibrant-cyber.png")),
    ("medium-bright", include_bytes!("../icons/switcher/medium-bright.png")),
    ("dark-screen", include_bytes!("../icons/switcher/dark-screen.png")),
    ("neon-robot", include_bytes!("../icons/switcher/neon-robot.png")),
    ("minimal-play", include_bytes!("../icons/switcher/minimal-play.png")),
    ("classic-original", include_bytes!("../icons/switcher/classic-original.png")),
    ("original-tv", include_bytes!("../icons/switcher/neon-robot.png")),
];

#[cfg(target_os = "windows")]
fn update_windows_icons(app: &AppHandle, icon_bytes: &[u8]) -> Result<(), String> {
    let mut lock = ACTIVE_ICONS
        .lock()
        .map_err(|e| format!("ACTIVE_ICONS lock error: {e}"))?;

    unsafe {
        let small_cx = GetSystemMetrics(SM_CXSMICON);
        let small_cy = GetSystemMetrics(SM_CYSMICON);

        // Native 256x256 ARGB 32-bit icon for taskbar / Alt+Tab (Windows DWM scales down smoothly)
        let hicon_big = CreateIconFromResourceEx(
            icon_bytes,
            true,
            0x00030000,
            0,
            0,
            LR_DEFAULTCOLOR,
        )
        .map_err(|e| format!("Failed to create Win32 big icon: {e}"))?;

        // Small icon pre-scaled to system metric for titlebar / small icons
        let hicon_small = CreateIconFromResourceEx(
            icon_bytes,
            true,
            0x00030000,
            small_cx,
            small_cy,
            LR_DEFAULTCOLOR,
        )
        .map_err(|e| format!("Failed to create Win32 small icon: {e}"))?;

        let windows = app.webview_windows();
        for (_, win) in windows {
            if let Ok(hwnd) = win.hwnd() {
                let hwnd = HWND(hwnd.0);
                // 1. Send WM_SETICON for large (taskbar, Alt+Tab) and small (titlebar) icons
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    WPARAM(ICON_BIG as usize),
                    LPARAM(hicon_big.0 as isize),
                );
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    WPARAM(ICON_SMALL as usize),
                    LPARAM(hicon_small.0 as isize),
                );

                // 2. Update window class icons so Explorer and taskbar fallbacks query the new icon
                SetClassLongPtrW(hwnd, GCLP_HICON, hicon_big.0 as isize);
                SetClassLongPtrW(hwnd, GCLP_HICONSM, hicon_small.0 as isize);

                // 3. Trigger frame and non-client area refresh
                let _ = SetWindowPos(
                    hwnd,
                    HWND::default(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            }
        }

        // Manage lifecycle: destroy old handles after assigning new ones, and preserve new ones
        for &old_handle in lock.iter() {
            let _ = DestroyIcon(HICON(old_handle as *mut _));
        }
        lock.clear();
        lock.push(hicon_big.0 as usize);
        lock.push(hicon_small.0 as usize);
    }
    Ok(())
}

pub fn apply_icon(app: &AppHandle, icon_id: &str) -> Result<(), String> {
    let (_, icon_bytes) = ICONS
        .iter()
        .find(|(id, _)| *id == icon_id)
        .ok_or_else(|| format!("Unknown icon_id: {}", icon_id))?;

    let image = tauri::image::Image::from_bytes(icon_bytes)
        .map_err(|e| format!("Failed to parse icon image: {}", e))?;

    // Update system tray icon
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(image.clone()));
    }

    #[cfg(target_os = "windows")]
    {
        update_windows_icons(app, icon_bytes)?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        for (_, win) in app.webview_windows() {
            let _ = win.set_icon(image.clone());
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_app_icon(app: AppHandle, icon_id: String) -> Result<(), String> {
    apply_icon(&app, &icon_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_icons_load_in_tauri() {
        for (id, bytes) in ICONS {
            let img = tauri::image::Image::from_bytes(bytes);
            assert!(img.is_ok(), "Icon '{}' failed to parse as tauri image: {:?}", id, img.err());
            let img = img.unwrap();
            assert_eq!(img.width(), 256, "Icon '{}' width should be 256", id);
            assert_eq!(img.height(), 256, "Icon '{}' height should be 256", id);
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_all_icons_win32_resources() {
        for (id, bytes) in ICONS {
            unsafe {
                let big = CreateIconFromResourceEx(
                    bytes,
                    true,
                    0x00030000,
                    0,
                    0,
                    LR_DEFAULTCOLOR,
                );
                assert!(big.is_ok(), "Icon '{}' failed to create Win32 256x256 icon: {:?}", id, big.err());

                let small_cx = GetSystemMetrics(SM_CXSMICON);
                let small_cy = GetSystemMetrics(SM_CYSMICON);
                let small = CreateIconFromResourceEx(
                    bytes,
                    true,
                    0x00030000,
                    small_cx,
                    small_cy,
                    LR_DEFAULTCOLOR,
                );
                assert!(small.is_ok(), "Icon '{}' failed to create Win32 small icon: {:?}", id, small.err());

                let _ = DestroyIcon(big.unwrap());
                let _ = DestroyIcon(small.unwrap());
            }
        }
    }

    #[test]
    fn test_required_frontend_icon_ids_exist() {
        let frontend_ids = [
            "midnight-4b",
            "midnight-4a",
            "vibrant-cyber",
            "medium-bright",
            "dark-screen",
            "neon-robot",
            "minimal-play",
            "classic-original",
        ];
        for id in frontend_ids {
            assert!(
                ICONS.iter().any(|(icon_id, _)| *icon_id == id),
                "Missing required icon ID '{}' in ICONS array",
                id
            );
        }
    }
}
