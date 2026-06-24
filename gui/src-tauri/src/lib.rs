// Tauri 入口：建主窗口 + 系统托盘 + 注册 IPC 命令
pub mod cli_path;
pub mod commands;
pub mod process;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::Mutex;

/// 防止"退出"对话框递归触发 close 事件
static EXITING: AtomicBool = AtomicBool::new(false);

const TRAY_MENU_SHOW: &str = "tray_show";
const TRAY_MENU_QUIT: &str = "tray_quit";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let proc_state: process::ProcessState = Arc::new(Mutex::new(process::Processes::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(proc_state)
        .setup(|app| {
            // 主窗口（create: false → setup 里手动 build）
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Copilot Codex Bridge")
            .inner_size(1000.0, 700.0)
            .min_inner_size(800.0, 560.0)
            .build()?;

            install_tray(app)?;
            register_close_handler(&win, app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::login_status,
            commands::proxy_status,
            commands::codex_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::list_models,
            commands::launch_codex,
            commands::stop_codex,
            commands::run_login,
            commands::run_logout,
            commands::run_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 注册关窗事件：点 ✕ 弹"退出 / 最小化到托盘"对话框
fn register_close_handler<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>, app: tauri::AppHandle<R>) {
    let win_for_event = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();

            let app_for_dialog = app.clone();
            let win_for_dialog = win_for_event.clone();
            app.dialog()
                .message("要完全退出 Copilot Codex Bridge，还是最小化到系统托盘？")
                .kind(MessageDialogKind::Info)
                .title("Copilot Codex Bridge")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "完全退出".into(),
                    "最小化到托盘".into(),
                ))
                .show(move |should_exit| {
                    if should_exit {
                        EXITING.store(true, Ordering::SeqCst);
                        app_for_dialog.exit(0);
                    } else {
                        let _ = win_for_dialog.hide();
                    }
                });
        }
        _ => {}
    });
}

/// 装系统托盘
fn install_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW, "显示窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT, "完全退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Copilot Codex Bridge")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_MENU_SHOW => show_main_window(app),
            TRAY_MENU_QUIT => {
                EXITING.store(true, Ordering::SeqCst);
                app.exit(0);
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

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// 显示主窗口（取消最小化 + 显示 + 聚焦）
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}
