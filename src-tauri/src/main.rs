#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

const OVERLAY_JS: &str = include_str!("../overlay.js");
const START_URL: &str = "https://m.youtube.com";
const WIN_W: f64 = 400.0;
const WIN_H: f64 = 300.0;

// 老闆鍵：切換視窗顯示/隱藏；隱藏時暫停影片(避免聲音穿幫)
fn toggle_boss<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(true) {
            let _ = win.eval(
                "document.querySelectorAll('video').forEach(function(v){try{v.pause()}catch(e){}})",
            );
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

// 書籤：存成 app 資料夾下的 bookmarks.json（跨站共用；localStorage 會被各網域隔開）
fn bookmarks_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bookmarks.json"))
}

#[tauri::command]
fn load_bookmarks(app: tauri::AppHandle) -> String {
    bookmarks_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "[]".into())
}

#[tauri::command]
fn save_bookmarks(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let p = bookmarks_path(&app).ok_or("no app data dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, data).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_bookmarks, save_bookmarks])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_boss(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let win = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(START_URL.parse().unwrap()),
            )
            .title("YT Float")
            .decorations(false)
            .always_on_top(true)
            .resizable(true)
            .inner_size(WIN_W, WIN_H)
            .min_inner_size(220.0, 160.0)
            .initialization_script(OVERLAY_JS)
            .build()?;

            // 預設放到螢幕右下角
            if let Ok(Some(monitor)) = win.current_monitor() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let pw = WIN_W * scale;
                let ph = WIN_H * scale;
                let x = size.width as f64 - pw - 24.0;
                let y = size.height as f64 - ph - 64.0;
                let _ = win.set_position(PhysicalPosition::new(x.max(0.0), y.max(0.0)));
            }

            // 系統匣
            let show = MenuItem::with_id(app, "show", "顯示", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("YT Float")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // 註冊老闆鍵 Ctrl+Shift+Z（全域）
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let boss = Shortcut::new(
                    Some(Modifiers::CONTROL | Modifiers::SHIFT),
                    Code::KeyZ,
                );
                // 已被佔用（例如另一個實例在跑）時不要讓整個程式閃退,只是沒有老闆鍵
                if let Err(e) = app.global_shortcut().register(boss) {
                    eprintln!("老闆鍵 Ctrl+Shift+Z 註冊失敗: {e}");
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
