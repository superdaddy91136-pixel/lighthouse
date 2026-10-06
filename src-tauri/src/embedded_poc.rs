use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Window, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PocStreamInfo {
    pub channel_id: i64,
    pub name: String,
    pub url: String,
    pub source_id: Option<i64>,
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    pub origin: Option<String>,
    #[serde(default)]
    pub ignore_ssl: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PocIpcCommand {
    pub command: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
}

#[derive(Clone)]
pub struct EmbeddedPocState {
    pub inner: Arc<Mutex<EmbeddedPocInner>>,
    pub active_pid: Arc<AtomicU32>,
    pub active_hwnd: Arc<AtomicUsize>,
    pub active_overlay_hwnd: Arc<AtomicUsize>,
    pub active_main_hwnd: Arc<AtomicUsize>,
}

pub struct EmbeddedPocInner {
    #[cfg(target_os = "windows")]
    pub child_hwnd: Option<usize>,
    #[cfg(target_os = "windows")]
    pub overlay_hwnd: Option<usize>,
    pub last_bounds: Option<(i32, i32, i32, i32)>,
    pub windowed_bounds: Option<(i32, i32, i32, i32)>,
    pub child_process: Option<Child>,
    pub child_pid: Option<u32>,
    pub ipc_tx: Option<mpsc::Sender<String>>,
    pub stream_info: Option<PocStreamInfo>,
    pub app_handle: Option<AppHandle>,
}

impl EmbeddedPocState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(EmbeddedPocInner {
                #[cfg(target_os = "windows")]
                child_hwnd: None,
                #[cfg(target_os = "windows")]
                overlay_hwnd: None,
                last_bounds: None,
                windowed_bounds: None,
                child_process: None,
                child_pid: None,
                ipc_tx: None,
                stream_info: None,
                app_handle: None,
            })),
            active_pid: Arc::new(AtomicU32::new(0)),
            active_hwnd: Arc::new(AtomicUsize::new(0)),
            active_overlay_hwnd: Arc::new(AtomicUsize::new(0)),
            active_main_hwnd: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn stop_sync(&self) {
        stop_embedded_player_sync(self);
    }

    pub fn sync_overlay_position_to_main_window(&self) {
        #[cfg(target_os = "windows")]
        {
            let mut main_hwnd = self.active_main_hwnd.load(Ordering::SeqCst);
            if main_hwnd == 0 {
                if let Some(h) = find_main_window_hwnd() {
                    self.active_main_hwnd.store(h, Ordering::SeqCst);
                    main_hwnd = h;
                }
            }
            let overlay_hwnd = self.active_overlay_hwnd.load(Ordering::SeqCst);
            if main_hwnd == 0 || overlay_hwnd == 0 {
                return;
            }

            unsafe {
                if win32::IsIconic(main_hwnd as win32::HWND) != 0 {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                    return;
                }
            }

            if let Ok(inner) = self.inner.try_lock() {
                let is_fs = if let Some(ref app) = inner.app_handle {
                    app.get_webview_window("main").and_then(|w| w.is_fullscreen().ok()).unwrap_or(false)
                } else {
                    false
                };
                if let Some((x, y, width, height)) = inner.last_bounds {
                    sync_overlay_rect(main_hwnd, overlay_hwnd, x, y, width, height, is_fs);
                }
            }
        }
    }

    pub fn handle_main_window_resized(&self, window: &Window) {
        #[cfg(target_os = "windows")]
        {
            let mut main_hwnd = self.active_main_hwnd.load(Ordering::SeqCst);
            if main_hwnd == 0 {
                if let Some(h) = find_main_window_hwnd() {
                    self.active_main_hwnd.store(h, Ordering::SeqCst);
                    main_hwnd = h;
                }
            }
            let overlay_hwnd = self.active_overlay_hwnd.load(Ordering::SeqCst);
            let child_hwnd = self.active_hwnd.load(Ordering::SeqCst);
            if main_hwnd == 0 || overlay_hwnd == 0 || child_hwnd == 0 {
                return;
            }

            unsafe {
                if win32::IsIconic(main_hwnd as win32::HWND) != 0 {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                    return;
                }
            }

            let is_fs = window.is_fullscreen().unwrap_or(false);

            let mut guard = None;
            for _ in 0..10 {
                if let Ok(inner) = self.inner.try_lock() {
                    guard = Some(inner);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }

            if let Some(mut inner) = guard {
                if is_fs {
                    // FULLSCREEN: Size directly from main client rect (GetClientRect) without waiting for Angular
                    let mut client_rc: win32::RECT = unsafe { std::mem::zeroed() };
                    unsafe {
                        win32::GetClientRect(main_hwnd as win32::HWND, &mut client_rc);
                    }
                    let client_w = client_rc.right - client_rc.left;
                    let client_h = client_rc.bottom - client_rc.top;

                    if client_w > 0 && client_h > 0 {
                        unsafe {
                            win32::SetWindowPos(
                                child_hwnd as win32::HWND,
                                win32::HWND_TOP,
                                0,
                                0,
                                client_w,
                                client_h,
                                win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                            );
                            win32::UpdateWindow(child_hwnd as win32::HWND);
                        }

                        // Size overlay directly to client rect (fullscreen = no 2px inset)
                        sync_overlay_rect(main_hwnd, overlay_hwnd, 0, 0, client_w, client_h, true);

                        // Show overlay again after the single sync
                        unsafe {
                            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_SHOW);
                        }

                        inner.last_bounds = Some((0, 0, client_w, client_h));
                        println!(
                            "[Lighthouse Fullscreen] Resized (fullscreen) synced directly from client rect: {}x{}",
                            client_w, client_h
                        );
                    }
                } else {
                    // WINDOWED MODE: Size directly to saved windowed bounds without waiting for Angular
                    let target_bounds = inner.windowed_bounds.or(inner.last_bounds);
                    if let Some((w_x, w_y, w_w, w_h)) = target_bounds {
                        unsafe {
                            win32::SetWindowPos(
                                child_hwnd as win32::HWND,
                                win32::HWND_TOP,
                                w_x,
                                w_y,
                                w_w,
                                w_h,
                                win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                            );
                            win32::UpdateWindow(child_hwnd as win32::HWND);
                        }

                        // Size overlay directly (windowed = keep 2px inset)
                        sync_overlay_rect(main_hwnd, overlay_hwnd, w_x, w_y, w_w, w_h, false);

                        // Show overlay again after the single sync
                        unsafe {
                            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_SHOW);
                        }

                        inner.last_bounds = Some((w_x, w_y, w_w, w_h));
                        println!(
                            "[Lighthouse Fullscreen] Resized (windowed) synced directly to windowed bounds: ({}, {}) {}x{}",
                            w_x, w_y, w_w, w_h
                        );
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub fn handle_main_window_resized(&self, _window: &Window) {}

    pub fn hide_overlay(&self) {
        #[cfg(target_os = "windows")]
        {
            let overlay_hwnd = self.active_overlay_hwnd.load(Ordering::SeqCst);
            if overlay_hwnd != 0 {
                unsafe {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                }
            }
        }
    }
}

impl Drop for EmbeddedPocInner {
    fn drop(&mut self) {
        if let Some(mut child) = self.child_process.take() {
            let _ = child.start_kill();
        }
        #[cfg(target_os = "windows")]
        if let Some(pid) = self.child_pid.take() {
            terminate_process_by_pid(pid);
        }
        #[cfg(target_os = "windows")]
        if let Some(hwnd) = self.child_hwnd.take() {
            destroy_child_window(hwnd);
        }
        #[cfg(target_os = "windows")]
        if let Some(overlay) = self.overlay_hwnd.take() {
            unsafe {
                win32::ShowWindow(overlay as win32::HWND, win32::SW_HIDE);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub mod win32 {
    use std::ffi::c_void;

    pub type HWND = *mut c_void;
    pub type HINSTANCE = *mut c_void;
    pub type HMENU = *mut c_void;
    pub type HDC = *mut c_void;
    pub type BOOL = i32;

    pub const WS_CHILD: u32 = 0x40000000;
    pub const WS_VISIBLE: u32 = 0x10000000;
    pub const WS_CLIPSIBLINGS: u32 = 0x04000000;
    pub const WS_CLIPCHILDREN: u32 = 0x02000000;
    pub const SWP_NOACTIVATE: u32 = 0x0010;
    pub const SWP_SHOWWINDOW: u32 = 0x0040;
    pub const SWP_NOZORDER: u32 = 0x0004;
    pub const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
    pub const HWND_TOP: HWND = 0 as HWND;
    pub const HWND_BOTTOM: HWND = 1 as HWND;

    pub const GWL_STYLE: i32 = -16;
    pub const GWL_EXSTYLE: i32 = -20;
    pub const GWLP_HWNDPARENT: i32 = -8;
    pub const GW_CHILD: u32 = 5;

    pub const WS_EX_LAYERED: u32 = 0x00080000;
    pub const WS_EX_TRANSPARENT: u32 = 0x00000020;
    pub const WS_EX_NOACTIVATE: u32 = 0x08000000;

    pub const SW_HIDE: i32 = 0;
    pub const SW_SHOW: i32 = 5;
    pub const SW_SHOWNA: i32 = 8;

    pub const WM_SIZE: u32 = 0x0005;
    pub const WM_PAINT: u32 = 0x000F;
    pub const WM_CLOSE: u32 = 0x0010;
    pub const WM_ERASEBKGND: u32 = 0x0014;

    pub const CS_VREDRAW: u32 = 0x0001;
    pub const CS_HREDRAW: u32 = 0x0002;
    pub const CS_OWNDC: u32 = 0x0020;

    #[repr(C)]
    pub struct POINT {
        pub x: i32,
        pub y: i32,
    }

    #[repr(C)]
    pub struct RECT {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    pub struct PAINTSTRUCT {
        pub hdc: HDC,
        pub f_erase: BOOL,
        pub rc_paint: RECT,
        pub f_restore: BOOL,
        pub f_inc_update: BOOL,
        pub rgb_reserved: [u8; 32],
    }

    pub type WNDENUMPROC = Option<unsafe extern "system" fn(HWND, isize) -> BOOL>;
    pub type WNDPROC = Option<unsafe extern "system" fn(HWND, u32, usize, isize) -> isize>;

    #[repr(C)]
    pub struct WNDCLASSW {
        pub style: u32,
        pub lpfnWndProc: WNDPROC,
        pub cbClsExtra: i32,
        pub cbWndExtra: i32,
        pub hInstance: HINSTANCE,
        pub hIcon: *mut c_void,
        pub hCursor: *mut c_void,
        pub hbrBackground: *mut c_void,
        pub lpszMenuName: *const u16,
        pub lpszClassName: *const u16,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn RegisterClassW(lpWndClass: *const WNDCLASSW) -> u16;

        pub fn DefWindowProcW(
            hWnd: HWND,
            Msg: u32,
            wParam: usize,
            lParam: isize,
        ) -> isize;

        pub fn CreateWindowExW(
            dwExStyle: u32,
            lpClassName: *const u16,
            lpWindowName: *const u16,
            dwStyle: u32,
            X: i32,
            Y: i32,
            nWidth: i32,
            nHeight: i32,
            hWndParent: HWND,
            hMenu: HMENU,
            hInstance: HINSTANCE,
            lpParam: *mut c_void,
        ) -> HWND;

        pub fn DestroyWindow(hWnd: HWND) -> BOOL;

        pub fn SetWindowPos(
            hWnd: HWND,
            hWndInsertAfter: HWND,
            X: i32,
            Y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> BOOL;

        pub fn GetWindowLongW(hWnd: HWND, nIndex: i32) -> i32;
        pub fn SetWindowLongW(hWnd: HWND, nIndex: i32, dwNewLong: i32) -> i32;
        #[cfg(target_pointer_width = "64")]
        pub fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: isize) -> isize;
        pub fn GetWindow(hWnd: HWND, uCmd: u32) -> HWND;

        pub fn EnumWindows(lpEnumFunc: WNDENUMPROC, lParam: isize) -> BOOL;
        pub fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut u32) -> u32;
        pub fn IsWindowVisible(hWnd: HWND) -> BOOL;
        pub fn GetParent(hWnd: HWND) -> HWND;
        pub fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> HWND;

        pub fn BeginPaint(hWnd: HWND, lpPaint: *mut PAINTSTRUCT) -> HDC;
        pub fn EndPaint(hWnd: HWND, lpPaint: *const PAINTSTRUCT) -> BOOL;
        pub fn InvalidateRect(hWnd: HWND, lpRect: *const RECT, bErase: BOOL) -> BOOL;
        pub fn UpdateWindow(hWnd: HWND) -> BOOL;
        pub fn LoadCursorW(hInstance: HINSTANCE, lpCursorName: *const u16) -> *mut c_void;
        pub fn ClientToScreen(hWnd: HWND, lpPoint: *mut POINT) -> BOOL;
        pub fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> BOOL;
        pub fn IsIconic(hWnd: HWND) -> BOOL;
        pub fn GetClientRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
    }

    #[allow(non_snake_case)]
    #[cfg(target_pointer_width = "32")]
    pub unsafe fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: isize) -> isize {
        unsafe { SetWindowLongW(hWnd, nIndex, dwNewLong as i32) as isize }
    }

    pub const IDC_ARROW: *const u16 = 32512 as *const u16;

    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const SYNCHRONIZE: u32 = 0x00100000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn GetCurrentProcessId() -> u32;
        pub fn GetModuleHandleW(lpModuleName: *const u16) -> HINSTANCE;
        pub fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: BOOL, dwProcessId: u32) -> *mut c_void;
        pub fn TerminateProcess(hProcess: *mut c_void, uExitCode: u32) -> BOOL;
        pub fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
        pub fn CloseHandle(hObject: *mut c_void) -> BOOL;
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn embed_wndproc(
    hwnd: win32::HWND,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    unsafe {
        match msg {
            // Suppress background erase to avoid erasing D3D11 swapchain backbuffer
            win32::WM_ERASEBKGND => 1,
            win32::WM_PAINT => {
                let mut ps: win32::PAINTSTRUCT = std::mem::zeroed();
                let _ = win32::BeginPaint(hwnd, &mut ps);
                let _ = win32::EndPaint(hwnd, &ps);
                0
            }
            win32::WM_SIZE => {
                let child = win32::GetWindow(hwnd, win32::GW_CHILD);
                if !child.is_null() {
                    let w = (lparam & 0xFFFF) as i32;
                    let h = ((lparam >> 16) & 0xFFFF) as i32;
                    win32::SetWindowPos(
                        child,
                        std::ptr::null_mut(),
                        0,
                        0,
                        w,
                        h,
                        win32::SWP_NOZORDER | win32::SWP_NOACTIVATE | win32::SWP_ASYNCWINDOWPOS,
                    );
                }
                win32::DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            win32::WM_CLOSE => {
                win32::DestroyWindow(hwnd);
                0
            }
            _ => win32::DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(target_os = "windows")]
pub fn register_embed_class() {
    static REGISTERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !REGISTERED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let class_name: Vec<u16> = "LighthouseMpvEmbedClass\0".encode_utf16().collect();
        let hinstance = unsafe { win32::GetModuleHandleW(std::ptr::null()) };
        let hcursor = unsafe { win32::LoadCursorW(std::ptr::null_mut(), win32::IDC_ARROW) };
        let wc = win32::WNDCLASSW {
            style: win32::CS_HREDRAW | win32::CS_VREDRAW | win32::CS_OWNDC,
            lpfnWndProc: Some(embed_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: hcursor,
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        unsafe {
            win32::RegisterClassW(&wc);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn find_main_window_hwnd() -> Option<usize> {
    struct Search {
        target_pid: u32,
        found_hwnd: usize,
    }
    unsafe extern "system" fn enum_proc(hwnd: win32::HWND, lparam: isize) -> win32::BOOL {
        let search = unsafe { &mut *(lparam as *mut Search) };
        let mut pid: u32 = 0;
        unsafe {
            win32::GetWindowThreadProcessId(hwnd, &mut pid);
        }
        if pid == search.target_pid && unsafe { win32::IsWindowVisible(hwnd) } != 0 {
            let parent = unsafe { win32::GetParent(hwnd) };
            if parent.is_null() {
                search.found_hwnd = hwnd as usize;
                return 0; // stop enumeration
            }
        }
        1 // continue enumeration
    }
    let mut search = Search {
        target_pid: unsafe { win32::GetCurrentProcessId() },
        found_hwnd: 0,
    };
    unsafe {
        win32::EnumWindows(Some(enum_proc), &mut search as *mut _ as isize);
    }
    if search.found_hwnd != 0 {
        Some(search.found_hwnd)
    } else {
        // Fallback: search by known window title prefix
        let title: Vec<u16> = "Lighthouse (v1.9.1)\0".encode_utf16().collect();
        let fallback = unsafe { win32::FindWindowW(std::ptr::null(), title.as_ptr()) };
        if !fallback.is_null() {
            Some(fallback as usize)
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub fn create_child_window(
    parent_hwnd_usize: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    _z_order: &str,
) -> Result<usize, String> {
    let parent_hwnd = parent_hwnd_usize as win32::HWND;

    // Register our custom embed window class
    register_embed_class();

    let custom_class: Vec<u16> = "LighthouseMpvEmbedClass\0".encode_utf16().collect();
    let static_class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let win_name: Vec<u16> = "LighthouseMpvEmbed\0".encode_utf16().collect();

    // Use WS_CLIPCHILDREN | WS_CLIPSIBLINGS so parent/child repaints never clash with MPV
    let style = win32::WS_CHILD | win32::WS_VISIBLE | win32::WS_CLIPSIBLINGS | win32::WS_CLIPCHILDREN;
    let hinstance = unsafe { win32::GetModuleHandleW(std::ptr::null()) };

    // No extended styles needed; window is fully opaque and handles its own mouse input
    let ex_style = 0;

    let mut child_hwnd = unsafe {
        win32::CreateWindowExW(
            ex_style,
            custom_class.as_ptr(),
            win_name.as_ptr(),
            style,
            x,
            y,
            width,
            height,
            parent_hwnd,
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null_mut(),
        )
    };

    if child_hwnd.is_null() {
        child_hwnd = unsafe {
            win32::CreateWindowExW(
                ex_style,
                static_class.as_ptr(),
                win_name.as_ptr(),
                style,
                x,
                y,
                width,
                height,
                parent_hwnd,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null_mut(),
            )
        };
    }

    if child_hwnd.is_null() {
        return Err("CreateWindowExW returned NULL".to_string());
    }

    // Must be positioned at HWND_TOP so it renders in front of sibling WebView2
    unsafe {
        win32::SetWindowPos(
            child_hwnd,
            win32::HWND_TOP,
            x,
            y,
            width,
            height,
            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW | win32::SWP_ASYNCWINDOWPOS,
        );
        win32::UpdateWindow(child_hwnd);
    }

    Ok(child_hwnd as usize)
}

#[cfg(target_os = "windows")]
pub fn destroy_child_window(hwnd_usize: usize) {
    if hwnd_usize == 0 {
        return;
    }
    let hwnd = hwnd_usize as win32::HWND;
    unsafe {
        let _ = win32::DestroyWindow(hwnd);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn destroy_child_window(_hwnd_usize: usize) {}

#[cfg(target_os = "windows")]
pub fn terminate_process_by_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    unsafe {
        let handle = win32::OpenProcess(
            win32::PROCESS_TERMINATE | win32::SYNCHRONIZE,
            0,
            pid,
        );
        if !handle.is_null() {
            let _ = win32::TerminateProcess(handle, 1);
            let _ = win32::WaitForSingleObject(handle, 1000);
            let _ = win32::CloseHandle(handle);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn terminate_process_by_pid(_pid: u32) {}

#[cfg(target_os = "windows")]
pub fn inspect_and_clean_overlay_exstyle(stage: &str, overlay_hwnd: usize) {
    if overlay_hwnd == 0 {
        return;
    }
    unsafe {
        let cur_ex = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_EXSTYLE);
        let has_transparent = (cur_ex & (win32::WS_EX_TRANSPARENT as i32)) != 0;
        let has_noactivate = (cur_ex & (win32::WS_EX_NOACTIVATE as i32)) != 0;
        let has_layered = (cur_ex & (win32::WS_EX_LAYERED as i32)) != 0;

        println!(
            "[Lighthouse Overlay HWND][{}] HWND: {:#x}, GWL_EXSTYLE: {:#x} (WS_EX_TRANSPARENT={}, WS_EX_NOACTIVATE={}, WS_EX_LAYERED={})",
            stage, overlay_hwnd, cur_ex, has_transparent, has_noactivate, has_layered
        );

        // Strip WS_EX_TRANSPARENT and WS_EX_NOACTIVATE if present. Do NOT force WS_EX_LAYERED.
        // Rely exclusively on Tauri's transparent window configuration to ensure WebView2 receives mouse input.
        let mut clean_ex = cur_ex;
        if has_transparent {
            clean_ex &= !(win32::WS_EX_TRANSPARENT as i32);
        }
        if has_noactivate {
            clean_ex &= !(win32::WS_EX_NOACTIVATE as i32);
        }
        if clean_ex != cur_ex {
            win32::SetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_EXSTYLE, clean_ex);
            println!(
                "[Lighthouse Overlay HWND][{}] Cleared prohibited flags -> new GWL_EXSTYLE: {:#x}",
                stage, clean_ex
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn inspect_and_clean_overlay_exstyle(_stage: &str, _overlay_hwnd: usize) {}

#[cfg(target_os = "windows")]
pub fn ensure_overlay_ownership(main_hwnd: usize, overlay_hwnd: usize) {
    if main_hwnd == 0 || overlay_hwnd == 0 {
        return;
    }
    unsafe {
        win32::SetWindowLongPtrW(
            overlay_hwnd as win32::HWND,
            win32::GWLP_HWNDPARENT,
            main_hwnd as isize,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_overlay_ownership(_main_hwnd: usize, _overlay_hwnd: usize) {}

#[cfg(target_os = "windows")]
pub fn sync_overlay_rect(
    main_hwnd: usize,
    overlay_hwnd: usize,
    mut x: i32,
    mut y: i32,
    mut width: i32,
    mut height: i32,
    is_fullscreen: bool,
) {
    if main_hwnd == 0 || overlay_hwnd == 0 || width <= 0 || height <= 0 {
        return;
    }
    unsafe {
        if win32::IsIconic(main_hwnd as win32::HWND) != 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        // 1. Get client area of main window
        let mut client_rc: win32::RECT = std::mem::zeroed();
        win32::GetClientRect(main_hwnd as win32::HWND, &mut client_rc);
        let client_w = client_rc.right - client_rc.left;
        let client_h = client_rc.bottom - client_rc.top;

        // 2. Safety bounds:
        // Keep the 2px inset ONLY in windowed mode. In fullscreen, fill the full client rect without inset.
        if !is_fullscreen {
            const INSET: i32 = 2;
            if x < INSET {
                width -= INSET - x;
                x = INSET;
            }
            if y < INSET {
                height -= INSET - y;
                y = INSET;
            }
            if client_w > 0 && x + width > client_w - INSET {
                width = (client_w - INSET - x).max(0);
            }
            if client_h > 0 && y + height > client_h - INSET {
                height = (client_h - INSET - y).max(0);
            }
        }

        if width <= 0 || height <= 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        // 3. Convert (x, y) from client coordinates to physical screen coordinates
        let mut pt = win32::POINT { x, y };
        win32::ClientToScreen(main_hwnd as win32::HWND, &mut pt);

        // 4. Log EXSTYLE and ensure WS_EX_TRANSPARENT/NOACTIVATE are cleared
        inspect_and_clean_overlay_exstyle("sync", overlay_hwnd);

        println!(
            "[Lighthouse Overlay] bounds sync -> client: ({}, {}), size: {}x{}, screen: ({}, {}) [main client area: {}x{}, fs={}]",
            x, y, width, height, pt.x, pt.y, client_w, client_h, is_fullscreen
        );

        // Remove SWP_ASYNCWINDOWPOS to eliminate lag
        win32::SetWindowPos(
            overlay_hwnd as win32::HWND,
            win32::HWND_TOP,
            pt.x,
            pt.y,
            width,
            height,
            win32::SWP_SHOWWINDOW,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync_overlay_rect(
    _main_hwnd: usize,
    _overlay_hwnd: usize,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _is_fullscreen: bool,
) {}

pub fn init_overlay_window(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        if let Some(overlay_win) = app.get_webview_window("player-overlay") {
            let _ = overlay_win.set_ignore_cursor_events(false);
            if let Ok(overlay_raw) = overlay_win.hwnd() {
                let overlay_hwnd = overlay_raw.0 as usize;
                let main_hwnd = app
                    .get_webview_window("main")
                    .and_then(|w| w.hwnd().ok().map(|h| h.0 as usize))
                    .or_else(find_main_window_hwnd)
                    .unwrap_or(0);

                if main_hwnd != 0 && overlay_hwnd != 0 {
                    ensure_overlay_ownership(main_hwnd, overlay_hwnd);
                }

                inspect_and_clean_overlay_exstyle("init", overlay_hwnd);

                if let Some(state) = app.try_state::<EmbeddedPocState>() {
                    state.active_overlay_hwnd.store(overlay_hwnd, Ordering::SeqCst);
                    if main_hwnd != 0 {
                        state.active_main_hwnd.store(main_hwnd, Ordering::SeqCst);
                    }
                }

                unsafe {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                }
            }
        }
    }
}

pub fn stop_embedded_player_sync(state: &EmbeddedPocState) {
    let atomic_pid = state.active_pid.swap(0, Ordering::SeqCst);
    let atomic_hwnd = state.active_hwnd.swap(0, Ordering::SeqCst);

    let overlay_hwnd = state.active_overlay_hwnd.load(Ordering::SeqCst);
    if overlay_hwnd != 0 {
        #[cfg(target_os = "windows")]
        unsafe {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
        }
    }

    let (child_opt, child_pid, hwnd_opt, app_opt) = {
        if let Ok(mut inner) = state.inner.try_lock() {
            let child = inner.child_process.take();
            let pid = inner.child_pid.take();
            #[cfg(target_os = "windows")]
            let hwnd = inner.child_hwnd.take();
            #[cfg(not(target_os = "windows"))]
            let hwnd: Option<usize> = None;
            let app = inner.app_handle.take();
            inner.ipc_tx = None;
            inner.stream_info = None;
            inner.last_bounds = None;
            inner.windowed_bounds = None;
            #[cfg(target_os = "windows")]
            {
                inner.overlay_hwnd = None;
            }
            (child, pid, hwnd, app)
        } else {
            (None, None, None, None)
        }
    };

    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
    }

    let target_pid = child_pid.or(if atomic_pid != 0 { Some(atomic_pid) } else { None });
    if let Some(pid) = target_pid {
        terminate_process_by_pid(pid);
    }

    let target_hwnd = hwnd_opt.or(if atomic_hwnd != 0 { Some(atomic_hwnd) } else { None });
    if let Some(hwnd) = target_hwnd {
        destroy_child_window(hwnd);
    }

    if let Some(ref app) = app_opt {
        if let Some(main_win) = app.get_webview_window("main") {
            if main_win.is_fullscreen().unwrap_or(false) {
                println!("[Lighthouse Fullscreen] Restoring non-fullscreen in stop_embedded_player_sync");
                let _ = main_win.set_fullscreen(false);
                let _ = app.emit("player-fullscreen-changed", false);
            }
        }
        let _ = app.emit("embedded-poc-stopped", ());
    }
}

fn find_poc_stream() -> Result<PocStreamInfo, String> {
    let conn = crate::sql::get_conn().map_err(|e| format!("DB pool error: {:?}", e))?;

    let exact_title = "AR-IN-Awarapan 2 (2026)";

    // Priority 1: Exact title match for "AR-IN-Awarapan 2 (2026)"
    // If multiple provider versions exist, use the first exact title match (ORDER BY id ASC LIMIT 1)
    let exact_query = "SELECT id, name, url, source_id FROM channels WHERE name = ?1 AND hidden = 0 ORDER BY id ASC LIMIT 1";
    if let Ok(mut stmt) = conn.prepare(exact_query) {
        if let Ok(mut rows) = stmt.query([exact_title]) {
            if let Ok(Some(row)) = rows.next() {
                if let (Ok(id), Ok(name), Ok(url)) = (
                    row.get::<_, i64>(0),
                    row.get::<_, String>(1),
                    row.get::<_, String>(2),
                ) {
                    let source_id: Option<i64> = row.get(3).ok();
                    return build_stream_info(id, name, url, source_id);
                }
            }
        }
    }

    // Priority 1b: Exact title match without hidden filter
    let exact_query_all = "SELECT id, name, url, source_id FROM channels WHERE name = ?1 ORDER BY id ASC LIMIT 1";
    if let Ok(mut stmt) = conn.prepare(exact_query_all) {
        if let Ok(mut rows) = stmt.query([exact_title]) {
            if let Ok(Some(row)) = rows.next() {
                if let (Ok(id), Ok(name), Ok(url)) = (
                    row.get::<_, i64>(0),
                    row.get::<_, String>(1),
                    row.get::<_, String>(2),
                ) {
                    let source_id: Option<i64> = row.get(3).ok();
                    return build_stream_info(id, name, url, source_id);
                }
            }
        }
    }

    // Priority 2: Fallback to exact provider catalog variation in local DB (e.g. "AR-IN-S - Awarapan 2 (2026)")
    let alt_titles = [
        "AR-IN-S - Awarapan 2 (2026)",
        "AR-IN - Awarapan 2 (2026)",
    ];
    for alt in alt_titles {
        let alt_query = "SELECT id, name, url, source_id FROM channels WHERE name = ?1 ORDER BY id ASC LIMIT 1";
        if let Ok(mut stmt) = conn.prepare(alt_query) {
            if let Ok(mut rows) = stmt.query([alt]) {
                if let Ok(Some(row)) = rows.next() {
                    if let (Ok(id), Ok(name), Ok(url)) = (
                        row.get::<_, i64>(0),
                        row.get::<_, String>(1),
                        row.get::<_, String>(2),
                    ) {
                        let source_id: Option<i64> = row.get(3).ok();
                        return build_stream_info(id, name, url, source_id);
                    }
                }
            }
        }
    }

    // Priority 3: Fallback like search for AR-IN...Awarapan 2 (2026)
    let like_query = "SELECT id, name, url, source_id FROM channels WHERE name LIKE '%AR-IN%Awarapan 2 (2026)%' ORDER BY id ASC LIMIT 1";
    if let Ok(mut stmt) = conn.prepare(like_query) {
        if let Ok(mut rows) = stmt.query([]) {
            if let Ok(Some(row)) = rows.next() {
                if let (Ok(id), Ok(name), Ok(url)) = (
                    row.get::<_, i64>(0),
                    row.get::<_, String>(1),
                    row.get::<_, String>(2),
                ) {
                    let source_id: Option<i64> = row.get(3).ok();
                    return build_stream_info(id, name, url, source_id);
                }
            }
        }
    }

    Err(format!("Catalog item '{}' not found in database", exact_title))
}

pub fn build_stream_info(
    channel_id: i64,
    name: String,
    url: String,
    source_id: Option<i64>,
) -> Result<PocStreamInfo, String> {
    let headers = crate::sql::get_channel_headers_by_id(channel_id).ok().flatten();
    let source = source_id.and_then(|id| crate::sql::get_source_from_id(id).ok());
    let user_agent = headers.as_ref().and_then(|h| h.user_agent.clone())
        .or_else(|| source.as_ref().and_then(|s| s.stream_user_agent.clone()));
    let referrer = headers.as_ref().and_then(|h| h.referrer.clone());
    let origin = headers.as_ref().and_then(|h| h.http_origin.clone());
    let ignore_ssl = headers.as_ref().and_then(|h| h.ignore_ssl);

    Ok(PocStreamInfo {
        channel_id,
        name,
        url,
        source_id,
        user_agent,
        referrer,
        origin,
        ignore_ssl,
    })
}

pub fn build_stream_info_from_channel(channel: &crate::types::Channel) -> Result<PocStreamInfo, String> {
    let channel_id = channel.id.ok_or_else(|| "Channel has no ID".to_string())?;
    let url = channel.url.clone().ok_or_else(|| "Channel has no URL".to_string())?;
    build_stream_info(channel_id, channel.name.clone(), url, channel.source_id)
}

pub fn build_embedded_mpv_args(
    child_hwnd: usize,
    pipe_name: &str,
    stream: &PocStreamInfo,
) -> Vec<String> {
    let mut args = Vec::new();
    args.push(format!("--wid={}", child_hwnd));
    args.push(format!("--input-ipc-server={}", pipe_name));
    args.push("--vo=gpu-next".to_string());
    args.push("--gpu-context=d3d11".to_string());
    args.push("--hwdec=auto".to_string());
    args.push("--msg-level=all=error".to_string());
    args.push("--input-default-bindings=no".to_string());
    args.push("--input-vo-keyboard=no".to_string());
    args.push("--input-cursor=no".to_string());
    args.push("--cursor-autohide=no".to_string());
    args.push("--no-terminal".to_string());
    args.push("--osc=no".to_string());
    args.push("--save-position-on-quit".to_string());

    if let Some(ref ua) = stream.user_agent {
        args.push(format!("--user-agent={}", ua));
    }
    let mut headers_vec = Vec::new();
    if let Some(ref orig) = stream.origin {
        headers_vec.push(format!("origin:{}", orig));
    }
    if let Some(ref refer) = stream.referrer {
        headers_vec.push(format!("referer:{}", refer));
    }
    if !headers_vec.is_empty() {
        args.push(format!("--http-header-fields={}", headers_vec.join(",")));
    }
    if stream.ignore_ssl == Some(true) {
        args.push("--ytdl-raw-options=no-check-certificates=True".to_string());
    }

    if let Ok(settings) = crate::settings::get_settings() {
        if settings.use_stream_caching == Some(false) {
            args.push("--cache=no".to_string());
        }
        if let Some(volume) = settings.volume {
            args.push(format!("--volume={}", volume));
        }
        if let Some(ref mpv_params) = settings.mpv_params {
            #[cfg(not(target_os = "windows"))]
            if let Ok(params) = shell_words::split(mpv_params) {
                args.extend(params);
            }
            #[cfg(target_os = "windows")]
            {
                let params = winsplit::split(mpv_params);
                args.extend(params);
            }
        }
    }

    args.push(stream.url.clone());
    args
}

pub async fn start_embedded_player_internal(
    window: WebviewWindow,
    stream: PocStreamInfo,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    z_order: Option<String>,
    state: State<'_, EmbeddedPocState>,
) -> Result<PocStreamInfo, String> {
    // 1. Clean up any previous embedded playback
    stop_embedded_poc_internal(&state).await;

    #[cfg(not(target_os = "windows"))]
    {
        return Err("Embedded Win32 player is currently supported on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        // 2. Find top-level Lighthouse HWND and create child HWND ON THE MAIN UI THREAD
        let z_order_val = z_order.unwrap_or_else(|| "top".to_string());
        let (tx_hwnd, rx_hwnd) = tokio::sync::oneshot::channel();
        let window_clone = window.clone();
        let z_order_for_create = z_order_val.clone();

        window
            .run_on_main_thread(move || {
                let parent_hwnd = window_clone
                    .hwnd()
                    .map(|h| h.0 as usize)
                    .or_else(|_| find_main_window_hwnd().ok_or(()))
                    .unwrap_or(0);

                if parent_hwnd == 0 {
                    let _ = tx_hwnd.send(Err("Could not locate Lighthouse top-level HWND".to_string()));
                    return;
                }

                // Ensure parent window clips children so repainting/resizing never causes DWM / swapchain deadlock
                unsafe {
                    let cur_style = win32::GetWindowLongW(parent_hwnd as win32::HWND, win32::GWL_STYLE);
                    win32::SetWindowLongW(
                        parent_hwnd as win32::HWND,
                        win32::GWL_STYLE,
                        cur_style | (win32::WS_CLIPCHILDREN as i32),
                    );
                }

                let res = create_child_window(parent_hwnd, x, y, width, height, &z_order_for_create);
                let _ = tx_hwnd.send(res);
            })
            .map_err(|e| format!("Failed to dispatch to main thread: {:?}", e))?;

        let child_hwnd = rx_hwnd
            .await
            .map_err(|e| format!("Channel receive error: {:?}", e))??;

        let parent_hwnd = window
            .hwnd()
            .map(|h| h.0 as usize)
            .or_else(|_| find_main_window_hwnd().ok_or(()))
            .unwrap_or(0);

        if parent_hwnd != 0 {
            state.active_main_hwnd.store(parent_hwnd, Ordering::SeqCst);
        }

        let overlay_hwnd = window
            .app_handle()
            .get_webview_window("player-overlay")
            .and_then(|w| w.hwnd().ok().map(|h| h.0 as usize))
            .unwrap_or(0);

        if overlay_hwnd != 0 {
            state.active_overlay_hwnd.store(overlay_hwnd, Ordering::SeqCst);
            if parent_hwnd != 0 {
                ensure_overlay_ownership(parent_hwnd, overlay_hwnd);
                sync_overlay_rect(parent_hwnd, overlay_hwnd, x, y, width, height, false);
            }
        }

        // 3. Locate bundled mpv.exe
        let mpv_path = crate::utils::get_bin("mpv");
        let pipe_name = format!(r"\\.\pipe\lighthouse-mpv-poc-{}", std::process::id());

        // 4. Build MPV arguments with identical stream/header options to external MPV
        let args = build_embedded_mpv_args(child_hwnd, &pipe_name, &stream);

        let mut cmd = tokio::process::Command::new(&mpv_path);
        cmd.args(&args);

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn mpv.exe at '{}': {:?}", mpv_path, e))?;

        let child_pid = child.id().unwrap_or(0);
        state.active_pid.store(child_pid, Ordering::SeqCst);
        state.active_hwnd.store(child_hwnd, Ordering::SeqCst);

        // 5. Connect to MPV Named Pipe JSON-IPC
        let mut client_opt = None;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Ok(client) = ClientOptions::new().open(&pipe_name) {
                client_opt = Some(client);
                break;
            }
        }
        let client = match client_opt {
            Some(c) => c,
            None => {
                {
                    let mut inner = state.inner.lock().await;
                    inner.child_process = Some(child);
                    inner.child_pid = if child_pid != 0 { Some(child_pid) } else { None };
                    inner.child_hwnd = Some(child_hwnd);
                    inner.app_handle = Some(window.app_handle().clone());
                }
                stop_embedded_poc_internal(&state).await;
                return Err("Timed out waiting for MPV Named Pipe server to initialize".to_string());
            }
        };

        let (reader, mut writer) = tokio::io::split(client);
        let (tx, mut rx) = mpsc::channel::<String>(32);

        // Background task: write commands to MPV named pipe
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let mut data = msg.into_bytes();
                if !data.ends_with(b"\n") {
                    data.push(b'\n');
                }
                if writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        // Background task: read IPC events from MPV and forward to Angular
        let app_handle = window.app_handle().clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_handle.emit("embedded-poc-event", line);
            }
            let _ = app_handle.emit("embedded-poc-stopped", ());
        });

        // Observe playback properties
        let _ = tx
            .send(r#"{"command": ["observe_property", 1, "time-pos"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 2, "pause"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 3, "duration"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 4, "volume"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 5, "mute"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 6, "track-list"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 7, "sid"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 8, "aid"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 9, "sub-scale"]}"#.to_string())
            .await;

        // 6. Ensure the embedded child window is presented on top and updated now that MPV has connected
        let child_hwnd_val = child_hwnd;
        let parent_hwnd_val = parent_hwnd;
        let overlay_hwnd_val = overlay_hwnd;
        let _ = window.run_on_main_thread(move || {
            unsafe {
                win32::SetWindowPos(
                    child_hwnd_val as win32::HWND,
                    win32::HWND_TOP,
                    x,
                    y,
                    width,
                    height,
                    win32::SWP_SHOWWINDOW | win32::SWP_NOACTIVATE,
                );
                win32::UpdateWindow(child_hwnd_val as win32::HWND);
            }
            if parent_hwnd_val != 0 && overlay_hwnd_val != 0 {
                sync_overlay_rect(parent_hwnd_val, overlay_hwnd_val, x, y, width, height, false);
            }
        });

        // Store state
        let mut inner = state.inner.lock().await;
        inner.child_hwnd = Some(child_hwnd);
        inner.overlay_hwnd = if overlay_hwnd != 0 { Some(overlay_hwnd) } else { None };
        inner.last_bounds = Some((x, y, width, height));
        inner.windowed_bounds = Some((x, y, width, height));
        inner.child_process = Some(child);
        inner.child_pid = if child_pid != 0 { Some(child_pid) } else { None };
        inner.ipc_tx = Some(tx);
        inner.stream_info = Some(stream.clone());
        inner.app_handle = Some(window.app_handle().clone());

        let _ = window.app_handle().emit("embedded-player-started", &stream);

        Ok(stream)
    }
}

#[tauri::command]
pub async fn start_embedded_poc(
    window: WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    z_order: Option<String>,
    state: State<'_, EmbeddedPocState>,
) -> Result<PocStreamInfo, String> {
    let stream = find_poc_stream()?;
    start_embedded_player_internal(window, stream, x, y, width, height, z_order, state).await
}

#[tauri::command]
pub async fn start_embedded_player(
    window: WebviewWindow,
    channel: crate::types::Channel,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    z_order: Option<String>,
    state: State<'_, EmbeddedPocState>,
) -> Result<PocStreamInfo, String> {
    let stream = build_stream_info_from_channel(&channel)?;
    start_embedded_player_internal(window, stream, x, y, width, height, z_order, state).await
}

#[tauri::command]
pub async fn open_in_external_mpv(
    channel: crate::types::Channel,
    app_state: State<'_, Mutex<crate::types::AppState>>,
    embedded_state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    // 1. Terminate any active embedded player session to release child HWND & audio
    stop_embedded_poc_internal(&embedded_state).await;

    // 2. Play via existing, proven external MPV engine (100% untouched)
    crate::mpv::play(channel, false, None, app_state)
        .await
        .map_err(|e| format!("External MPV playback error: {:?}", e))
}

#[tauri::command]
pub async fn resize_embedded_poc(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut main_hwnd = state.active_main_hwnd.load(Ordering::SeqCst);
        if main_hwnd == 0 {
            if let Some(h) = find_main_window_hwnd() {
                state.active_main_hwnd.store(h, Ordering::SeqCst);
                main_hwnd = h;
            }
        }
        let overlay_hwnd = state.active_overlay_hwnd.load(Ordering::SeqCst);

        let mut inner = state.inner.lock().await;

        let is_fs = if let Some(ref app) = inner.app_handle {
            app.get_webview_window("main").and_then(|w| w.is_fullscreen().ok()).unwrap_or(false)
        } else {
            false
        };

        // In fullscreen mode, ignore Angular measurements so we don't shrink the fullscreen video
        if is_fs {
            return Ok(());
        }

        inner.last_bounds = Some((x, y, width, height));
        inner.windowed_bounds = Some((x, y, width, height));

        if let Some(child_hwnd) = inner.child_hwnd {
            if let Some(ref app) = inner.app_handle {
                let _ = app.run_on_main_thread(move || {
                    unsafe {
                        win32::SetWindowPos(
                            child_hwnd as win32::HWND,
                            win32::HWND_TOP,
                            x,
                            y,
                            width,
                            height,
                            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                        );
                        win32::UpdateWindow(child_hwnd as win32::HWND);
                    }
                    if main_hwnd != 0 && overlay_hwnd != 0 {
                        sync_overlay_rect(main_hwnd, overlay_hwnd, x, y, width, height, false);
                    }
                });
            } else {
                unsafe {
                    win32::SetWindowPos(
                        child_hwnd as win32::HWND,
                        win32::HWND_TOP,
                        x,
                        y,
                        width,
                        height,
                        win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                    );
                    win32::UpdateWindow(child_hwnd as win32::HWND);
                }
                if main_hwnd != 0 && overlay_hwnd != 0 {
                    sync_overlay_rect(main_hwnd, overlay_hwnd, x, y, width, height, false);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn send_embedded_poc_ipc(
    command: String,
    state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    if let Some(ref tx) = inner.ipc_tx {
        tx.send(command).await.map_err(|e| format!("{:?}", e))?;
        Ok(())
    } else {
        Err("MPV IPC channel is not connected".to_string())
    }
}

#[tauri::command]
pub async fn stop_embedded_poc(
    state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    stop_embedded_poc_internal(&state).await;
    Ok(())
}

pub async fn stop_embedded_poc_internal(state: &EmbeddedPocState) {
    state.active_pid.store(0, Ordering::SeqCst);
    state.active_hwnd.store(0, Ordering::SeqCst);

    let overlay_hwnd = state.active_overlay_hwnd.load(Ordering::SeqCst);
    if overlay_hwnd != 0 {
        #[cfg(target_os = "windows")]
        unsafe {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
        }
    }

    let (child_opt, child_pid, hwnd_opt, app_opt) = {
        let mut inner = state.inner.lock().await;
        let child = inner.child_process.take();
        let pid = inner.child_pid.take();
        #[cfg(target_os = "windows")]
        let hwnd = inner.child_hwnd.take();
        #[cfg(not(target_os = "windows"))]
        let hwnd: Option<usize> = None;
        let app = inner.app_handle.take();
        inner.ipc_tx = None;
        inner.stream_info = None;
        inner.last_bounds = None;
        inner.windowed_bounds = None;
        #[cfg(target_os = "windows")]
        {
            inner.overlay_hwnd = None;
        }
        (child, pid, hwnd, app)
    };

    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    if let Some(pid) = child_pid {
        terminate_process_by_pid(pid);
    }

    if let Some(hwnd) = hwnd_opt {
        if let Some(ref app) = app_opt {
            let _ = app.run_on_main_thread(move || {
                destroy_child_window(hwnd);
            });
        } else {
            destroy_child_window(hwnd);
        }
    }

    if let Some(ref app) = app_opt {
        if let Some(main_win) = app.get_webview_window("main") {
            if main_win.is_fullscreen().unwrap_or(false) {
                println!("[Lighthouse Fullscreen] Restoring non-fullscreen in stop_embedded_poc_internal");
                let _ = main_win.set_fullscreen(false);
                let _ = app.emit("player-fullscreen-changed", false);
            }
        }
        let _ = app.emit("embedded-poc-stopped", ());
    }
}

#[tauri::command]
pub async fn get_embedded_player_info(
    state: State<'_, EmbeddedPocState>,
) -> Result<Option<PocStreamInfo>, String> {
    let inner = state.inner.lock().await;
    Ok(inner.stream_info.clone())
}

#[tauri::command]
pub async fn toggle_player_fullscreen(
    app: AppHandle,
) -> Result<bool, String> {
    println!("[Lighthouse Fullscreen] toggle_player_fullscreen called on backend");
    if let Some(main_win) = app.get_webview_window("main") {
        let current_fs = main_win.is_fullscreen().unwrap_or(false);
        let new_fs = !current_fs;

        // 1. Hide overlay before window transition so no intermediate sizing is visible
        if let Some(state) = app.try_state::<EmbeddedPocState>() {
            state.hide_overlay();
            if new_fs {
                if let Ok(mut inner) = state.inner.try_lock() {
                    if inner.windowed_bounds.is_none() {
                        inner.windowed_bounds = inner.last_bounds;
                    }
                }
            }
        }

        println!(
            "[Lighthouse Fullscreen] Current main is_fullscreen = {}, setting to {}",
            current_fs, new_fs
        );

        // 2. Change fullscreen state
        main_win.set_fullscreen(new_fs).map_err(|e| format!("Failed to set fullscreen: {:?}", e))?;
        let resulting_fs = main_win.is_fullscreen().unwrap_or(new_fs);
        println!(
            "[Lighthouse Fullscreen] Resulting main is_fullscreen = {}",
            resulting_fs
        );

        // 3. Emit event to frontend for UI icons/classes
        let _ = app.emit("player-fullscreen-changed", resulting_fs);

        // All timed resyncs (80ms, 200ms) removed.
        // The main window's Resized event will execute the single, instant sync.
        Ok(resulting_fs)
    } else {
        println!("[Lighthouse Fullscreen] Main window not found");
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub async fn set_main_window_fullscreen(
    fullscreen: bool,
    app: AppHandle,
) -> Result<bool, String> {
    println!("[Lighthouse Fullscreen] set_main_window_fullscreen called: {}", fullscreen);
    if let Some(main_win) = app.get_webview_window("main") {
        if let Some(state) = app.try_state::<EmbeddedPocState>() {
            state.hide_overlay();
            if fullscreen {
                if let Ok(mut inner) = state.inner.try_lock() {
                    if inner.windowed_bounds.is_none() {
                        inner.windowed_bounds = inner.last_bounds;
                    }
                }
            }
        }
        main_win.set_fullscreen(fullscreen).map_err(|e| format!("Failed to set fullscreen: {:?}", e))?;
        let resulting = main_win.is_fullscreen().unwrap_or(fullscreen);
        let _ = app.emit("player-fullscreen-changed", resulting);
        Ok(resulting)
    } else {
        Err("Main window not found".to_string())
    }
}
