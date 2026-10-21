use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

const MAIN_WINDOW_STATE_KEY: &str = "main_window_state";

#[derive(Debug, Deserialize, Serialize)]
struct MainWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
    fullscreen: bool,
}

pub fn restore_main_window(window: &WebviewWindow) {
    let Some(saved_state) = load_main_window_state() else {
        return;
    };

    if let Some((size, position)) = validated_bounds(window, &saved_state) {
        let _ = window.set_size(size);
        let _ = window.set_position(position);
    }

    if saved_state.fullscreen {
        let _ = window.set_fullscreen(true);
    } else if saved_state.maximized {
        let _ = window.maximize();
    }
}

pub fn save_main_window_state(window: &WebviewWindow) {
    if window.label() != "main" || window.is_minimized().unwrap_or(true) {
        return;
    }

    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(maximized) = window.is_maximized() else {
        return;
    };
    let Ok(fullscreen) = window.is_fullscreen() else {
        return;
    };

    if size.width == 0 || size.height == 0 {
        return;
    }

    let state = MainWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized,
        fullscreen,
    };

    let Ok(serialized_state) = serde_json::to_string(&state) else {
        return;
    };
    let _ = crate::sql::update_settings(HashMap::from([(
        MAIN_WINDOW_STATE_KEY.to_string(),
        Some(serialized_state),
    )]));
}

fn load_main_window_state() -> Option<MainWindowState> {
    crate::sql::get_settings()
        .ok()?
        .get(MAIN_WINDOW_STATE_KEY)
        .and_then(|value| serde_json::from_str(value).ok())
}

fn validated_bounds(
    window: &WebviewWindow,
    state: &MainWindowState,
) -> Option<(PhysicalSize<u32>, PhysicalPosition<i32>)> {
    let monitors = window.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|monitor| saved_center_is_in_work_area(monitor, state))
        .or_else(|| monitors.first())?;
    let work_area = monitor.work_area();

    if work_area.size.width == 0 || work_area.size.height == 0 {
        return None;
    }

    let width = state.width.clamp(1, work_area.size.width);
    let height = state.height.clamp(1, work_area.size.height);
    let left = i64::from(work_area.position.x);
    let top = i64::from(work_area.position.y);
    let right = left + i64::from(work_area.size.width) - i64::from(width);
    let bottom = top + i64::from(work_area.size.height) - i64::from(height);
    let x = i64::from(state.x).clamp(left, right) as i32;
    let y = i64::from(state.y).clamp(top, bottom) as i32;

    Some((
        PhysicalSize::new(width, height),
        PhysicalPosition::new(x, y),
    ))
}

fn saved_center_is_in_work_area(monitor: &tauri::Monitor, state: &MainWindowState) -> bool {
    let work_area = monitor.work_area();
    let center_x = i64::from(state.x) + i64::from(state.width) / 2;
    let center_y = i64::from(state.y) + i64::from(state.height) / 2;
    let left = i64::from(work_area.position.x);
    let top = i64::from(work_area.position.y);
    let right = left + i64::from(work_area.size.width);
    let bottom = top + i64::from(work_area.size.height);

    center_x >= left && center_x < right && center_y >= top && center_y < bottom
}
