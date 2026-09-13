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

/// Wrap a PNG byte slice into a valid single-image ICO file format (Vista+ PNG-in-ICO standard).
pub fn png_to_ico(png_bytes: &[u8]) -> Vec<u8> {
    let mut ico = Vec::with_capacity(22 + png_bytes.len());
    // ICONDIR header: 6 bytes
    // idReserved: 2 bytes (0)
    ico.extend_from_slice(&0u16.to_le_bytes());
    // idType: 2 bytes (1 for icon)
    ico.extend_from_slice(&1u16.to_le_bytes());
    // idCount: 2 bytes (1 image)
    ico.extend_from_slice(&1u16.to_le_bytes());

    // ICONDIRENTRY: 16 bytes
    // bWidth: 1 byte (0 specifies 256 pixels)
    ico.push(0);
    // bHeight: 1 byte (0 specifies 256 pixels)
    ico.push(0);
    // bColorCount: 1 byte (0 if >= 8bpp)
    ico.push(0);
    // bReserved: 1 byte (0)
    ico.push(0);
    // wPlanes: 2 bytes (1)
    ico.extend_from_slice(&1u16.to_le_bytes());
    // wBitCount: 2 bytes (32-bit ARGB)
    ico.extend_from_slice(&32u16.to_le_bytes());
    // dwBytesInRes: 4 bytes (size of image data in bytes)
    ico.extend_from_slice(&(png_bytes.len() as u32).to_le_bytes());
    // dwImageOffset: 4 bytes (offset from beginning of file: 6 + 16 = 22)
    ico.extend_from_slice(&22u32.to_le_bytes());

    // Image data (PNG payload)
    ico.extend_from_slice(png_bytes);
    ico
}

#[cfg(target_os = "windows")]
pub fn get_current_ico_path() -> Option<std::path::PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|p| std::path::PathBuf::from(p).join("AppData").join("Local"))
        })?;
    Some(local_app_data.join("ynoTV").join("current_icon.ico"))
}

#[cfg(target_os = "windows")]
pub fn write_current_ico(png_bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let ico_path = get_current_ico_path().ok_or_else(|| "Could not resolve LOCALAPPDATA path".to_string())?;
    if let Some(parent) = ico_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let ico_bytes = png_to_ico(png_bytes);
    std::fs::write(&ico_path, ico_bytes)
        .map_err(|e| format!("Failed to write current_icon.ico to {:?}: {}", ico_path, e))?;
    Ok(ico_path)
}

#[cfg(target_os = "windows")]
fn get_target_shortcut_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA").map(std::path::PathBuf::from) {
        // Start Menu shortcut
        paths.push(
            app_data
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("ynoTV.lnk"),
        );
        // User Pinned Taskbar shortcut (if pinned)
        paths.push(
            app_data
                .join("Microsoft")
                .join("Internet Explorer")
                .join("Quick Launch")
                .join("User Pinned")
                .join("TaskBar")
                .join("ynoTV.lnk"),
        );
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from) {
        // Desktop shortcut
        paths.push(user_profile.join("Desktop").join("ynoTV.lnk"));
    }
    paths
}

#[cfg(target_os = "windows")]
fn update_shortcut_icon(shortcut_path: &std::path::Path, ico_path: &std::path::Path) -> Result<(), String> {
    use windows::core::{HSTRING, Interface};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, IPersistFile, STGM,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let hr_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let uninit_needed = hr_init.is_ok();

        let res = (|| -> windows::core::Result<()> {
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let persist: IPersistFile = shell_link.cast()?;

            let shortcut_hstr = HSTRING::from(shortcut_path.as_os_str());
            let ico_hstr = HSTRING::from(ico_path.as_os_str());

            persist.Load(&shortcut_hstr, STGM(2))?;
            shell_link.SetIconLocation(&ico_hstr, 0)?;
            persist.Save(&shortcut_hstr, true)?;
            Ok(())
        })();

        if uninit_needed {
            CoUninitialize();
        }

        res.map_err(|e| format!("Failed to update shortcut {:?}: {}", shortcut_path, e))
    }
}

#[cfg(target_os = "windows")]
pub fn update_windows_shortcuts(png_bytes: &[u8]) -> Result<(), String> {
    let ico_path = write_current_ico(png_bytes)?;
    let shortcuts = get_target_shortcut_paths();
    let mut updated_any = false;
    for sc in shortcuts {
        if sc.exists() {
            if let Err(e) = update_shortcut_icon(&sc, &ico_path) {
                log::warn!("[icon_switcher] {}", e);
            } else {
                log::info!("[icon_switcher] Updated shortcut icon for {:?}", sc);
                updated_any = true;
            }
        }
    }
    if updated_any {
        unsafe {
            windows::Win32::UI::Shell::SHChangeNotify(
                windows::Win32::UI::Shell::SHCNE_ASSOCCHANGED,
                windows::Win32::UI::Shell::SHCNF_IDLIST,
                None,
                None,
            );
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
        if let Err(e) = update_windows_shortcuts(icon_bytes) {
            log::warn!("[icon_switcher] Could not update shortcuts: {}", e);
        }
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

    #[test]
    fn test_png_to_ico_structure() {
        let fake_png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4];
        let ico = png_to_ico(&fake_png);
        assert_eq!(ico.len(), 22 + fake_png.len());
        // Header
        assert_eq!(&ico[0..2], &0u16.to_le_bytes()); // idReserved
        assert_eq!(&ico[2..4], &1u16.to_le_bytes()); // idType = 1 (icon)
        assert_eq!(&ico[4..6], &1u16.to_le_bytes()); // idCount = 1
        // Entry
        assert_eq!(ico[6], 0); // bWidth = 256
        assert_eq!(ico[7], 0); // bHeight = 256
        assert_eq!(ico[8], 0); // bColorCount = 0
        assert_eq!(ico[9], 0); // bReserved = 0
        assert_eq!(&ico[10..12], &1u16.to_le_bytes()); // wPlanes = 1
        assert_eq!(&ico[12..14], &32u16.to_le_bytes()); // wBitCount = 32
        assert_eq!(&ico[14..18], &(fake_png.len() as u32).to_le_bytes()); // dwBytesInRes
        assert_eq!(&ico[18..22], &22u32.to_le_bytes()); // dwImageOffset
        // Payload
        assert_eq!(&ico[22..], &fake_png[..]);
    }

    #[test]
    fn test_all_switcher_icons_convert_to_valid_ico() {
        for (id, bytes) in ICONS {
            let ico = png_to_ico(bytes);
            assert_eq!(ico.len(), 22 + bytes.len(), "ICO length mismatch for {}", id);
            assert_eq!(&ico[2..4], &1u16.to_le_bytes());
            assert_eq!(&ico[22..], *bytes);
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_current_ico_path_resolves() {
        let path = get_current_ico_path();
        assert!(path.is_some(), "get_current_ico_path should return a path on Windows");
        let path = path.unwrap();
        assert!(path.ends_with(std::path::Path::new("ynoTV").join("current_icon.ico")));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_write_current_ico_succeeds() {
        let fake_png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4];
        let res = write_current_ico(&fake_png);
        assert!(res.is_ok(), "write_current_ico failed: {:?}", res.err());
        let path = res.unwrap();
        assert!(path.exists(), "current_icon.ico should exist after write");
        let content = std::fs::read(&path).unwrap();
        assert_eq!(content, png_to_ico(&fake_png));
    }
}

