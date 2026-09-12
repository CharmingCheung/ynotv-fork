// Only the Windows icon path keeps handles alive, so the import follows the same cfg.
#[cfg(target_os = "windows")]
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

// Keep installed HICON handles alive in memory so Windows Explorer / DWM does not
// read dangling pointers when repainting the taskbar / Alt+Tab.
//
// Flat list, two entries per switch (big, small), newest last. The previous generation is
// deliberately retained as well: handing the shell a new icon does not mean it has finished
// painting the button it last read the old handle from, and freeing that handle mid-paint is
// exactly the "blank icon" failure this module exists to prevent. Two generations cost roughly
// 300 KB per switch and the process frees them on exit.
#[cfg(target_os = "windows")]
static ACTIVE_ICONS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

/// Generations to keep before freeing: the installed one plus its predecessor.
#[cfg(target_os = "windows")]
const ICON_GENERATIONS_KEPT: usize = 2;

/// Drop everything except the newest `generations` generations (two handles each) from `handles`,
/// returning the handles the caller must destroy. Split out from the Win32 sequence so the
/// retention policy can be unit tested.
#[cfg(target_os = "windows")]
fn stale_icon_handles(handles: &mut Vec<usize>, generations: usize) -> Vec<usize> {
    let keep = generations * 2;
    if handles.len() <= keep {
        return Vec::new();
    }
    handles.drain(..handles.len() - keep).collect()
}

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

        // Small icon pre-scaled to system metric for titlebar / small icons.
        // On failure, destroy the big icon we already created rather than orphaning its handle.
        let hicon_small = match CreateIconFromResourceEx(
            icon_bytes,
            true,
            0x00030000,
            small_cx,
            small_cy,
            LR_DEFAULTCOLOR,
        ) {
            Ok(handle) => handle,
            Err(e) => {
                let _ = DestroyIcon(hicon_big);
                return Err(format!("Failed to create Win32 small icon: {e}"));
            }
        };

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

        // Adopt the new handles, then free anything older than the generations we retain — the
        // previous generation stays alive so a shell mid-repaint can still read its handle.
        lock.push(hicon_big.0 as usize);
        lock.push(hicon_small.0 as usize);
        for stale_handle in stale_icon_handles(&mut lock, ICON_GENERATIONS_KEPT) {
            let _ = DestroyIcon(HICON(stale_handle as *mut _));
        }
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
    #[cfg(target_os = "windows")]
    fn keeps_the_previous_icon_generation_alive() {
        // Two handles per switch (big, small), newest last. Values are never passed to Win32 here.
        let mut handles: Vec<usize> = Vec::new();

        // First and second switch: nothing is old enough to free, so a shell mid-repaint can
        // still be reading the handle it last saw.
        handles.extend([1, 2]);
        assert!(stale_icon_handles(&mut handles, ICON_GENERATIONS_KEPT).is_empty());
        handles.extend([3, 4]);
        assert!(stale_icon_handles(&mut handles, ICON_GENERATIONS_KEPT).is_empty());
        assert_eq!(handles, vec![1, 2, 3, 4]);

        // Third switch: only the generation from two switches back is released.
        handles.extend([5, 6]);
        assert_eq!(stale_icon_handles(&mut handles, ICON_GENERATIONS_KEPT), vec![1, 2]);
        assert_eq!(handles, vec![3, 4, 5, 6]);
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
