//! In-process libmpv Software Rendering & Canvas Streaming for Multiview
//! Renders decoded frames to offscreen RGBA buffers and streams them via Tauri IPC Channels
//! directly to in-DOM <canvas> elements, allowing full React overlay and context menu support.

use std::collections::HashMap;
use std::ffi::{c_void, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use libmpv2::Mpv;
use libmpv2_sys::*;
use parking_lot::RwLock;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

const RENDER_UPDATE_FRAME: u64 = 1;

/// State for an active canvas streaming slot (2, 3, or 4)
pub struct CanvasSlot {
    pub mpv: Arc<Mpv>,
    pub render_ctx: *mut mpv_render_context,
    pub running: Arc<AtomicBool>,
    pub target_width: Arc<RwLock<u32>>,
    pub target_height: Arc<RwLock<u32>>,
    /// Backpressure flag: true when the JS canvas has consumed the last frame
    /// and another frame may be sent. The render loop only sends while this is
    /// set, so the IPC channel can never queue more than one frame per slot —
    /// large-cell layouts (2x2) previously pushed full RGBA frames at 60Hz into
    /// an unbounded channel, growing memory to multiple GB when the JS main
    /// thread fell behind.
    pub acked: Arc<AtomicBool>,
    pub thread_handle: Option<thread::JoinHandle<()>>,
    /// Keeps an independently prepared native DASH packet bridge alive for
    /// this slot. Each slot owns its session, so parallel DASH playback does
    /// not replace the primary player's global session.
    _native_dash: Option<crate::native_dash::DetachedNativeDashSession>,
}

unsafe impl Send for CanvasSlot {}
unsafe impl Sync for CanvasSlot {}

#[derive(Default)]
pub struct CanvasMultiviewState {
    pub slots: Arc<Mutex<HashMap<u8, CanvasSlot>>>,
}

impl CanvasMultiviewState {
    pub fn new() -> Self {
        Self {
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Helper to configure and create an in-process libmpv instance for offscreen canvas rendering
pub fn create_canvas_mpv_instance(slot_id: u8) -> Result<(Mpv, *mut mpv_render_context), String> {
    let mpv = Mpv::with_initializer(|init| {
        let _ = init.set_property("terminal", "no");
        let _ = init.set_property("msg-level", "all=error");
        let _ = init.set_property("force-window", "no");
        let _ = init.set_property("vo", "libmpv");
        let _ = init.set_property("hwdec", "auto-safe");
        let _ = init.set_property("audio-client-name", format!("ynotv-canvas-slot-{}", slot_id).as_str());
        let _ = init.set_property("idle", "yes");
        let _ = init.set_property("keep-open", "yes");
        let _ = init.set_property("demuxer-max-bytes", "50MiB");
        let _ = init.set_property("demuxer-max-back-bytes", "20MiB");
        let _ = init.set_property("cache-secs", "10");
        let _ = init.set_property("keepaspect", "no");
        // Low-latency profile for the small secondary windows: the canvas path
        // is software-rendered on the CPU, so cheap scalers and no dithering /
        // peak analysis keep per-frame cost down. Bilinear is visually fine at
        // slot sizes; hdr-compute-peak is off so HDR peak analysis never runs
        // even if tonemapping args are later injected into the slots.
        let _ = init.set_property("scale", "bilinear");
        let _ = init.set_property("cscale", "bilinear");
        let _ = init.set_property("dscale", "bilinear");
        let _ = init.set_property("dither", "no");
        let _ = init.set_property("deband", "no");
        let _ = init.set_property("interpolation", "no");
        let _ = init.set_property("hdr-compute-peak", "no");
        let _ = init.set_property("mute", "yes");
        Ok(())
    }).map_err(|e| format!("Failed to create mpv instance: {}", e))?;

    // Create software render context with standard SW rendering
    let mut render_ctx: *mut mpv_render_context = ptr::null_mut();
    let api_type_sw = CString::new("sw").map_err(|e| e.to_string())?;

    let mut params = [
        mpv_render_param {
            type_: mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
            data: api_type_sw.as_ptr() as *mut c_void,
        },
        mpv_render_param {
            type_: mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
            data: ptr::null_mut(),
        },
    ];

    let res = unsafe { mpv_render_context_create(&mut render_ctx, mpv.ctx.as_ptr(), params.as_mut_ptr()) };
    if res < 0 || render_ctx.is_null() {
        return Err(format!("mpv_render_context_create failed with code {}", res));
    }

    Ok((mpv, render_ctx))
}

#[tauri::command]
pub async fn multiview_canvas_start(
    slot_id: u8,
    url: String,
    native_dash: Option<crate::native_dash::NativeDashPlaybackConfig>,
    width: u32,
    height: u32,
    channel: Channel<InvokeResponseBody>,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    log::info!("[CanvasMultiview] Starting slot {} with resolution {}x{} for {}", slot_id, width, height, url);

    // Stop and clean up any existing slot under lock
    {
        let mut lock = state.slots.lock().unwrap();
        if let Some(mut existing) = lock.remove(&slot_id) {
            existing.running.store(false, Ordering::SeqCst);
            let _ = existing.mpv.command("stop", &[]);
            if let Some(h) = existing.thread_handle.take() {
                let _ = h.join();
            }
            if !existing.render_ctx.is_null() {
                unsafe { mpv_render_context_free(existing.render_ctx); }
                existing.render_ctx = ptr::null_mut();
            }
        }
    }

    // Ensure even dimensions aligned for SIMD. The slots are secondary views
    // (small cells in a grid), so cap the offscreen render resolution at 720p —
    // rendering them any larger multiplies per-frame IPC bytes without visible
    // benefit and is what pushes 2x2 multiview (large cells) into unbounded
    // channel buffering / multi-GB memory growth.
    let width = if width == 0 { 640 } else { ((width.min(1280) + 1) & !1).max(64) };
    let height = if height == 0 { 360 } else { ((height.min(720) + 1) & !1).max(64) };

    let (load_url, native_dash_session) = if let Some(config) = native_dash {
        if config.manifest_url != url {
            return Err("Native DASH manifest configuration mismatch".into());
        }
        let (packet_source, session) = crate::native_dash::prepare_detached(config).await?;
        (packet_source, Some(session))
    } else {
        (url, None)
    };

    let (mpv_instance, render_ctx) = create_canvas_mpv_instance(slot_id)?;
    let mpv = Arc::new(mpv_instance);

    // Load URL
    let load_result = if native_dash_session.is_some() {
        mpv.command("loadfile", &[&load_url, "replace", "-1", "demuxer=rustdash,demuxer-seekable-cache=no,sid=no"])
    } else {
        mpv.command("loadfile", &[&load_url, "replace"])
    };
    load_result
        .map_err(|e| format!("Failed to loadfile on canvas slot {}: {}", slot_id, e))?;

    let running = Arc::new(AtomicBool::new(true));
    let target_width = Arc::new(RwLock::new(width));
    let target_height = Arc::new(RwLock::new(height));
    let acked = Arc::new(AtomicBool::new(true));

    let run_flag = running.clone();
    let tw = target_width.clone();
    let th = target_height.clone();
    let ack_flag = acked.clone();
    let r_ctx_usize = render_ctx as usize;

    // Background render worker thread
    let thread_handle = thread::spawn(move || {
        let r_ctx = r_ctx_usize as *mut mpv_render_context;
        let sw_format = CString::new("rgb0").unwrap();
        
        let mut cur_w = 0u32;
        let mut cur_h = 0u32;
        let mut stride = 0usize;
        let mut pixel_buf: Vec<u8> = Vec::new();
        let mut payload_buf: Vec<u8> = Vec::new();

        while run_flag.load(Ordering::Relaxed) {
            let req_w = (*tw.read() + 1) & !1;
            let req_h = (*th.read() + 1) & !1;

            if req_w != cur_w || req_h != cur_h {
                cur_w = req_w.max(64);
                cur_h = req_h.max(64);
                stride = (cur_w * 4) as usize;
                let buf_size = stride * (cur_h as usize);
                // Extra padding to prevent any SIMD overruns
                pixel_buf.resize(buf_size + 1024, 0);
                payload_buf.resize(8 + buf_size, 0);
                // Header: [width: u32, height: u32]
                payload_buf[0..4].copy_from_slice(&cur_w.to_le_bytes());
                payload_buf[4..8].copy_from_slice(&cur_h.to_le_bytes());
            }

            if cur_w > 0 && cur_h > 0 && !r_ctx.is_null() {
                // Backpressure: only render+send while the JS canvas has consumed
                // the previous frame (ack_flag). Frames that arrive while a send is
                // in flight are dropped on the floor — the newest one wins — so the
                // channel stays bounded to a single in-flight frame and the slot
                // auto-throttles to whatever rate the main thread can actually
                // consume (60 FPS when idle, lower when React is busy).
                if ack_flag.swap(false, Ordering::AcqRel) {
                    let flags = unsafe { mpv_render_context_update(r_ctx) };
                    if (flags & RENDER_UPDATE_FRAME) != 0 {
                        let mut sw_size: [i32; 2] = [cur_w as i32, cur_h as i32];
                        let mut sw_stride: usize = stride;

                        let mut render_params = [
                            mpv_render_param {
                                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_SIZE,
                                data: sw_size.as_mut_ptr() as *mut c_void,
                            },
                            mpv_render_param {
                                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_FORMAT,
                                data: sw_format.as_ptr() as *mut c_void,
                            },
                            mpv_render_param {
                                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_STRIDE,
                                data: &mut sw_stride as *mut _ as *mut c_void,
                            },
                            mpv_render_param {
                                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_POINTER,
                                data: pixel_buf.as_mut_ptr() as *mut c_void,
                            },
                            mpv_render_param {
                                type_: mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                                data: ptr::null_mut(),
                            },
                        ];

                        let render_res = unsafe { mpv_render_context_render(r_ctx, render_params.as_mut_ptr()) };
                        if render_res >= 0 {
                            let num_pixels = (cur_w * cur_h) as usize;
                            let src = &pixel_buf[..num_pixels * 4];
                            let dst = &mut payload_buf[8..8 + num_pixels * 4];
                            dst.copy_from_slice(src);
                            // Force Alpha = 255 so HTML5 canvas ImageData renders fully opaque
                            for chunk in dst.chunks_exact_mut(4) {
                                chunk[3] = 255;
                            }

                            if let Err(e) = channel.send(InvokeResponseBody::Raw(payload_buf.clone())) {
                                log::debug!("[CanvasMultiview] Channel closed: {}", e);
                                break;
                            }
                        }
                    } else {
                        // No new frame this poll — restore the send permission so a
                        // frame arriving on the next poll isn't gated behind the ack
                        // of a frame that was never sent.
                        ack_flag.store(true, Ordering::Release);
                    }
                }
            }

            thread::sleep(Duration::from_millis(16)); // ~60 FPS update check
        }
    });

    let mut lock = state.slots.lock().unwrap();
    lock.insert(
        slot_id,
        CanvasSlot {
            mpv,
            render_ctx,
            running,
            target_width,
            target_height,
            acked,
            thread_handle: Some(thread_handle),
            _native_dash: native_dash_session,
        },
    );

    Ok(())
}

/// Called by the JS canvas after it has drawn a frame; releases the backpressure
/// gate so the render loop can send the next one.
#[tauri::command]
pub async fn multiview_canvas_ack(
    slot_id: u8,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let lock = state.slots.lock().unwrap();
    if let Some(slot) = lock.get(&slot_id) {
        slot.acked.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_stop(
    slot_id: u8,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let slot_opt = {
        let mut lock = state.slots.lock().unwrap();
        lock.remove(&slot_id)
    };

    if let Some(mut slot) = slot_opt {
        log::info!("[CanvasMultiview] Stopping slot {}", slot_id);
        slot.running.store(false, Ordering::SeqCst);
        let _ = slot.mpv.command("stop", &[]);
        if let Some(h) = slot.thread_handle.take() {
            let _ = h.join();
        }
        if !slot.render_ctx.is_null() {
            unsafe {
                mpv_render_context_free(slot.render_ctx);
            }
            slot.render_ctx = ptr::null_mut();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_resize(
    slot_id: u8,
    width: u32,
    height: u32,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let lock = state.slots.lock().unwrap();
    if let Some(slot) = lock.get(&slot_id) {
        // Keep the same 720p cap as multiview_canvas_start so a resize can never
        // balloon the slot back into the multi-GB channel-buffering territory.
        let w = ((width.min(1280) + 1) & !1).max(64);
        let h = ((height.min(720) + 1) & !1).max(64);
        *slot.target_width.write() = w;
        *slot.target_height.write() = h;
    }
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_set_property(
    slot_id: u8,
    property: String,
    value: Value,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let lock = state.slots.lock().unwrap();
    if let Some(slot) = lock.get(&slot_id) {
        match value {
            Value::Bool(b) => {
                let _ = slot.mpv.set_property(&property, b);
            }
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    let _ = slot.mpv.set_property(&property, i);
                } else if let Some(f) = n.as_f64() {
                    let _ = slot.mpv.set_property(&property, f);
                }
            }
            Value::String(s) => {
                let _ = slot.mpv.set_property(&property, s.as_str());
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_stop_all(
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let mut slots_to_stop = Vec::new();
    {
        let mut lock = state.slots.lock().unwrap();
        for (_, slot) in lock.drain() {
            slots_to_stop.push(slot);
        }
    }

    for mut slot in slots_to_stop {
        slot.running.store(false, Ordering::SeqCst);
        let _ = slot.mpv.command("stop", &[]);
        if let Some(h) = slot.thread_handle.take() {
            let _ = h.join();
        }
        if !slot.render_ctx.is_null() {
            unsafe {
                mpv_render_context_free(slot.render_ctx);
            }
            slot.render_ctx = ptr::null_mut();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_destroy_canvas_mpv() {
        let (mpv, render_ctx) = create_canvas_mpv_instance(2).expect("create canvas instance");
        assert!(!render_ctx.is_null());
        let _ = mpv.command("stop", &[]);
        unsafe {
            mpv_render_context_free(render_ctx);
        }
    }

    #[test]
    fn test_render_frame_to_buffer() {
        let (mpv, render_ctx) = create_canvas_mpv_instance(3).expect("create canvas instance");
        assert!(!render_ctx.is_null());

        let cur_w = 640u32;
        let cur_h = 360u32;
        let stride = (cur_w * 4) as usize;
        let buf_size = stride * (cur_h as usize);
        let mut pixel_buf = vec![0u8; buf_size + 1024];
        let sw_format = CString::new("rgb0").unwrap();

        let mut sw_size: [i32; 2] = [cur_w as i32, cur_h as i32];
        let mut sw_stride: usize = stride;

        let mut render_params = [
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_SIZE,
                data: sw_size.as_mut_ptr() as *mut c_void,
            },
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_FORMAT,
                data: sw_format.as_ptr() as *mut c_void,
            },
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_STRIDE,
                data: &mut sw_stride as *mut _ as *mut c_void,
            },
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_SW_POINTER,
                data: pixel_buf.as_mut_ptr() as *mut c_void,
            },
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];

        let render_res = unsafe { mpv_render_context_render(render_ctx, render_params.as_mut_ptr()) };
        assert!(render_res >= 0 || render_res == -1);

        let _ = mpv.command("stop", &[]);
        unsafe {
            mpv_render_context_free(render_ctx);
        }
    }
}
