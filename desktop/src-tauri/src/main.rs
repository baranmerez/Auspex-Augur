// Auspex Augur desktop viewer. Shows the shared viewer page (../src/viewer.html) in a
// window and serves its data through the `api` command: the audit log and the
// profiles under ~/.auspex. Read-only, never connects to a database, never
// returns passwords. Mirrors the routes of src/viewer.js; the Node config in
// src/config.js stays the source of truth for validation.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use percent_encoding::percent_decode_str;
use serde_json::{json, Map, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const HIDDEN_ARG: &str = "--hidden";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn auspex_home() -> PathBuf {
    if let Some(h) = env("AUSPEX_HOME") {
        return PathBuf::from(h);
    }
    let user = env("USERPROFILE").or_else(|| env("HOME")).unwrap_or_else(|| ".".into());
    PathBuf::from(user).join(".auspex")
}

fn data_dir() -> PathBuf {
    env("AUSPEX_DATA_DIR").map(PathBuf::from).unwrap_or_else(auspex_home)
}

fn log_dir() -> PathBuf {
    env("AUSPEX_LOG_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir().join("logs"))
}

fn export_dir() -> PathBuf {
    env("AUSPEX_EXPORT_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir().join("exports"))
}

fn profiles_file() -> PathBuf {
    env("AUSPEX_PROFILES_FILE").map(PathBuf::from).unwrap_or_else(|| auspex_home().join("profiles.json"))
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn list_days() -> Vec<(String, usize)> {
    let mut days: Vec<(String, usize)> = fs::read_dir(log_dir())
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let day = name.strip_suffix(".jsonl")?.to_string();
                    if !is_day(&day) {
                        return None;
                    }
                    let count = fs::read_to_string(e.path())
                        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count())
                        .unwrap_or(0);
                    Some((day, count))
                })
                .collect()
        })
        .unwrap_or_default();
    days.sort_by(|a, b| b.0.cmp(&a.0));
    days
}

fn read_day(day: &str) -> Vec<Value> {
    let text = fs::read_to_string(log_dir().join(format!("{day}.jsonl"))).unwrap_or_default();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, line)| {
            serde_json::from_str(line)
                .unwrap_or_else(|_| json!({ "ts": null, "tool": "?", "error": format!("Unreadable log line {}", i + 1) }))
        })
        .collect()
}

fn ms_env(name: &str, fallback: u64) -> u64 {
    env(name).and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

// Connection summary without the password, same shape as describeConnection().
fn describe(url_text: &str) -> Map<String, Value> {
    let mut m = Map::new();
    match url::Url::parse(url_text) {
        Ok(u) => {
            let decode = |s: &str| percent_decode_str(s).decode_utf8_lossy().to_string();
            m.insert("host".into(), json!(u.host_str().unwrap_or("")));
            m.insert("port".into(), json!(u.port().map(|p| p.to_string()).unwrap_or_else(|| "5432".into())));
            m.insert("database".into(), json!(decode(u.path().trim_start_matches('/'))));
            m.insert("user".into(), json!(decode(u.username())));
            m.insert("passwordInString".into(), json!(u.password().is_some()));
        }
        Err(_) => {
            m.insert("error".into(), json!("Connection string is not a URL (postgresql://user@host:port/db expected)."));
        }
    }
    m
}

fn profiles() -> Value {
    let home = auspex_home().to_string_lossy().to_string();
    let file = profiles_file();
    let default_ms = ms_env("AUSPEX_STATEMENT_TIMEOUT_MS", 30_000);
    let max_ms = ms_env("AUSPEX_MAX_STATEMENT_TIMEOUT_MS", 300_000);
    let mut list: Vec<Value> = Vec::new();

    match fs::read_to_string(&file) {
        Ok(text) => {
            let parsed: Result<Value, _> = serde_json::from_str(text.trim_start_matches('\u{feff}'));
            match parsed {
                Ok(Value::Object(entries)) => {
                    for (name, p) in entries {
                        let url_text = p.get("url").and_then(Value::as_str).unwrap_or("");
                        let mut item = Map::new();
                        item.insert("name".into(), json!(name.to_lowercase()));
                        item.insert("description".into(), p.get("description").cloned().unwrap_or(Value::Null));
                        item.insert("source".into(), json!("file"));
                        item.extend(describe(url_text));
                        let max = p.get("maxTimeoutSeconds").and_then(Value::as_u64).map(|s| s * 1000).unwrap_or(max_ms);
                        item.insert("maxTimeoutSeconds".into(), json!(max / 1000));
                        list.push(Value::Object(item));
                    }
                }
                Ok(_) => return json!({ "home": home, "error": format!("{} must be a JSON object of profiles.", file.display()) }),
                Err(e) => return json!({ "home": home, "error": format!("{} is not valid JSON: {e}", file.display()) }),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return json!({ "home": home, "error": format!("Cannot read {}: {e}", file.display()) }),
    }

    for (key, value) in std::env::vars() {
        if let Some(name) = key.to_uppercase().strip_prefix("AUSPEX_DB_") {
            if value.is_empty() {
                continue;
            }
            let mut item = Map::new();
            item.insert("name".into(), json!(name.to_lowercase()));
            item.insert("description".into(), Value::Null);
            item.insert("source".into(), json!("env"));
            item.extend(describe(&value));
            item.insert("maxTimeoutSeconds".into(), json!(max_ms / 1000));
            list.push(Value::Object(item));
        }
    }

    json!({
        "home": home,
        "profilesFile": file.to_string_lossy(),
        "logDir": log_dir().to_string_lossy(),
        "exportDir": export_dir().to_string_lossy(),
        "defaultTimeoutSeconds": default_ms / 1000,
        "profiles": list,
    })
}

#[tauri::command]
fn api(path: String, query: HashMap<String, String>) -> Result<Value, String> {
    match path.as_str() {
        "/api/days" => Ok(json!(list_days().into_iter().map(|(day, count)| json!({ "day": day, "count": count })).collect::<Vec<_>>())),
        "/api/health" => {
            let days = list_days();
            Ok(json!({ "ok": true, "latestDay": days.first().map(|d| d.0.clone()), "latestCount": days.first().map(|d| d.1).unwrap_or(0), "totalDays": days.len() }))
        }
        "/api/profiles" => Ok(profiles()),
        "/api/logs" => {
            let day = query.get("day");
            let from = day.or_else(|| query.get("from")).cloned().unwrap_or_default();
            let to = day.or_else(|| query.get("to")).cloned().unwrap_or_default();
            if !is_day(&from) || !is_day(&to) {
                return Err("day, or from and to, must be YYYY-MM-DD".into());
            }
            if from > to {
                return Err("from must not be after to".into());
            }
            let mut days: Vec<String> = list_days().into_iter().map(|d| d.0).filter(|d| *d >= from && *d <= to).collect();
            if days.len() > 400 {
                return Err("range too large".into());
            }
            days.sort();
            Ok(json!(days.iter().flat_map(|d| read_day(d)).collect::<Vec<_>>()))
        }
        _ => Err(format!("Not found: {path}")),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .invoke_handler(tauri::generate_handler![api])
        .setup(|app| {
            let enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let open = MenuItem::with_id(app, "open", "Open Auspex Augur", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, enabled, None::<&str>)?;
            let folder = MenuItem::with_id(app, "folder", "Show log folder", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&open, &folder, &PredefinedMenuItem::separator(app)?, &autostart, &PredefinedMenuItem::separator(app)?, &quit],
            )?;
            let autostart_item = autostart.clone();
            TrayIconBuilder::with_id("auspex")
                .icon(app.default_window_icon().cloned().expect("window icon"))
                .tooltip("Auspex Augur")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "folder" => {
                        let dir = log_dir();
                        let _ = fs::create_dir_all(&dir);
                        let _ = std::process::Command::new("explorer").arg(dir).spawn();
                    }
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let on = launcher.is_enabled().unwrap_or(false);
                        let _ = if on { launcher.disable() } else { launcher.enable() };
                        let _ = autostart_item.set_checked(launcher.is_enabled().unwrap_or(false));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if !std::env::args().any(|a| a == HIDDEN_ARG) {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Auspex in the tray; quit from the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Auspex Augur");
}
