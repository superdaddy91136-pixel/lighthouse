use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PocIpcCommand {
    pub command: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
}

pub struct EmbeddedPocState {
    pub inner: Arc<Mutex<EmbeddedPocInner>>,
}

pub struct EmbeddedPocInner {
    #[cfg(target_os = "windows")]
    pub child_hwnd: Option<usize>,
    pub child_process: Option<Child>,
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
                child_process: None,
                ipc_tx: None,
                stream_info: None,
                app_handle: None,
            })),
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
    pub const GW_CHILD: u32 = 5;

    pub const WM_SIZE: u32 = 0x0005;
    pub const WM_PAINT: u32 = 0x000F;
    pub const WM_CLOSE: u32 = 0x0010;
    pub const WM_ERASEBKGND: u32 = 0x0014;

    pub const CS_VREDRAW: u32 = 0x0001;
    pub const CS_HREDRAW: u32 = 0x0002;
    pub const CS_OWNDC: u32 = 0x0020;

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
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn GetCurrentProcessId() -> u32;
        pub fn GetModuleHandleW(lpModuleName: *const u16) -> HINSTANCE;
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
        let wc = win32::WNDCLASSW {
            style: win32::CS_HREDRAW | win32::CS_VREDRAW | win32::CS_OWNDC,
            lpfnWndProc: Some(embed_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
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

    let mut child_hwnd = unsafe {
        win32::CreateWindowExW(
            0,
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
                0,
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
    let hwnd = hwnd_usize as win32::HWND;
    unsafe {
        win32::DestroyWindow(hwnd);
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

fn build_stream_info(
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

    Ok(PocStreamInfo {
        channel_id,
        name,
        url,
        source_id,
        user_agent,
        referrer,
        origin,
    })
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
    // 1. Clean up any previous POC playback
    stop_embedded_poc_internal(&state).await;

    // 2. Query known working stream from project DB
    let stream = find_poc_stream()?;

    #[cfg(not(target_os = "windows"))]
    {
        return Err("Embedded Win32 POC is only supported on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        // 3. Find top-level Lighthouse HWND and create child HWND ON THE MAIN UI THREAD
        let z_order_val = z_order.unwrap_or_else(|| "bottom".to_string());
        let (tx_hwnd, rx_hwnd) = tokio::sync::oneshot::channel();
        let window_clone = window.clone();
        let z_order_clone = z_order_val.clone();

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

                let res = create_child_window(parent_hwnd, x, y, width, height, &z_order_clone);
                let _ = tx_hwnd.send(res);
            })
            .map_err(|e| format!("Failed to dispatch to main thread: {:?}", e))?;

        let child_hwnd = rx_hwnd
            .await
            .map_err(|e| format!("Channel receive error: {:?}", e))??;

        // 5. Locate bundled mpv.exe
        let mpv_path = crate::utils::get_bin("mpv");
        let pipe_name = format!(r"\\.\pipe\lighthouse-mpv-poc-{}", std::process::id());

        // 6. Build MPV arguments with --wid and headers
        let mut cmd = tokio::process::Command::new(&mpv_path);
        cmd.arg(format!("--wid={}", child_hwnd));
        cmd.arg(format!("--input-ipc-server={}", pipe_name));
        cmd.arg("--vo=gpu-next");
        cmd.arg("--gpu-context=d3d11");
        cmd.arg("--hwdec=auto");
        cmd.arg("--msg-level=all=error");
        cmd.arg("--input-default-bindings=no");
        cmd.arg("--input-vo-keyboard=no");
        cmd.arg("--input-cursor=no");
        cmd.arg("--cursor-autohide=no");
        cmd.arg("--no-terminal");

        if let Some(ref ua) = stream.user_agent {
            cmd.arg(format!("--user-agent={}", ua));
        }
        let mut headers_vec = Vec::new();
        if let Some(ref orig) = stream.origin {
            headers_vec.push(format!("Origin: {}", orig));
        }
        if let Some(ref refer) = stream.referrer {
            headers_vec.push(format!("Referer: {}", refer));
        }
        if !headers_vec.is_empty() {
            cmd.arg(format!("--http-header-fields={}", headers_vec.join(",")));
        }
        cmd.arg(&stream.url);

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn mpv.exe at '{}': {:?}", mpv_path, e))?;

        // 7. Connect to MPV Named Pipe JSON-IPC
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
                let mut inner = state.inner.lock().await;
                inner.child_process = Some(child);
                inner.child_hwnd = Some(child_hwnd);
                inner.app_handle = Some(window.app_handle().clone());
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

        // 8. Ensure the embedded child window is presented on top and updated now that MPV has connected
        let child_hwnd_val = child_hwnd;
        let _ = window.run_on_main_thread(move || {
            unsafe {
                win32::SetWindowPos(
                    child_hwnd_val as win32::HWND,
                    win32::HWND_TOP,
                    x,
                    y,
                    width,
                    height,
                    win32::SWP_SHOWWINDOW | win32::SWP_NOACTIVATE | win32::SWP_ASYNCWINDOWPOS,
                );
                win32::UpdateWindow(child_hwnd_val as win32::HWND);
            }
        });

        // Store state
        let mut inner = state.inner.lock().await;
        inner.child_hwnd = Some(child_hwnd);
        inner.child_process = Some(child);
        inner.ipc_tx = Some(tx);
        inner.stream_info = Some(stream.clone());
        inner.app_handle = Some(window.app_handle().clone());

        Ok(stream)
    }
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
        let inner = state.inner.lock().await;
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
                            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW | win32::SWP_ASYNCWINDOWPOS,
                        );
                        win32::UpdateWindow(child_hwnd as win32::HWND);
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
                        win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW | win32::SWP_ASYNCWINDOWPOS,
                    );
                    win32::UpdateWindow(child_hwnd as win32::HWND);
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

async fn stop_embedded_poc_internal(state: &State<'_, EmbeddedPocState>) {
    let mut inner = state.inner.lock().await;
    if let Some(mut child) = inner.child_process.take() {
        let _ = child.kill().await;
    }
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = inner.child_hwnd.take() {
        if let Some(ref app) = inner.app_handle {
            let _ = app.run_on_main_thread(move || {
                destroy_child_window(hwnd);
            });
        } else {
            destroy_child_window(hwnd);
        }
    }
    inner.ipc_tx = None;
    inner.stream_info = None;
    inner.app_handle = None;
}
