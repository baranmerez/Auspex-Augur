// Auspex Augur desktop viewer. Shows the shared viewer page (../src/viewer.html) in a
// window and serves its data through the `api` command: the audit log, the
// profiles, the report library and the schema memory under ~/.auspex. Read-only, never connects to a database, never
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

fn library_dir() -> PathBuf {
    env("AUSPEX_LIBRARY_DIR").map(PathBuf::from).unwrap_or_else(|| auspex_home().join("library"))
}

fn memory_dir() -> PathBuf {
    env("AUSPEX_MEMORY_DIR").map(PathBuf::from).unwrap_or_else(|| auspex_home().join("memory"))
}

// Profile names: same rule as config.js.
fn valid_profile(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some('a'..='z'))
        && s.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

// A table file of the schema memory: tables/<segment>/<segment>.json, with the
// segment alphabet of memory/store.js (fileSegment).
fn valid_memory_file(s: &str) -> bool {
    let seg = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_~-".contains(c));
    let parts: Vec<&str> = s.split('/').collect();
    parts.len() == 3 && parts[0] == "tables" && seg(parts[1]) && parts[2].strip_suffix(".json").is_some_and(seg)
}

fn read_json(path: &std::path::Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "File not found".to_string() } else { e.to_string() })?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// graph.json is the derived view written by the memory module after every change.
fn memory_summary() -> Value {
    let root = memory_dir();
    let mut profiles = Vec::new();
    for name in sub_dirs(&root).into_iter().filter(|n| valid_profile(n)) {
        if let Ok(view) = read_json(&root.join(&name).join("graph.json")) {
            let mut item = Map::new();
            item.insert("name".into(), json!(name));
            item.insert("generatedAt".into(), view.get("generatedAt").cloned().unwrap_or(Value::Null));
            if let Some(Value::Object(summary)) = view.get("summary") {
                item.extend(summary.clone());
            }
            profiles.push(Value::Object(item));
        }
    }
    json!({ "memoryDir": root.to_string_lossy(), "profiles": profiles })
}

fn memory_profile(query: &HashMap<String, String>) -> Result<PathBuf, String> {
    let name = query.get("profile").cloned().unwrap_or_default();
    if !valid_profile(&name) {
        return Err("Invalid profile name".into());
    }
    Ok(memory_dir().join(name))
}

const STAGES: [(&str, &str); 3] = [("draft", "_drafts"), ("approved", "SELECT"), ("execute", "EXECUTE")];

// One folder level (db, schema, category) or a report name; same rules as library.js.
fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= 80
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !s.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
}

fn sub_dirs(p: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(p)
        .map(|it| it.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn list_reports() -> Value {
    let root = library_dir();
    let mut out = Vec::new();
    for (stage, dir) in STAGES {
        let base = root.join(dir);
        for db in sub_dirs(&base) {
            for schema in sub_dirs(&base.join(&db)) {
                for category in sub_dirs(&base.join(&db).join(&schema)) {
                    let folder = base.join(&db).join(&schema).join(&category);
                    let mut files: Vec<String> = fs::read_dir(&folder)
                        .map(|it| it.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".sql")).collect())
                        .unwrap_or_default();
                    files.sort();
                    for f in files {
                        let name = f.trim_end_matches(".sql").to_string();
                        let meta: Value = if stage == "execute" {
                            Value::Null
                        } else {
                            fs::read_to_string(folder.join(format!("{name}.report.json"))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
                        };
                        let last = meta.get("runs").and_then(Value::as_array).and_then(|r| r.last()).cloned();
                        let updated = meta.get("updatedAt").cloned().unwrap_or(Value::Null);
                        out.push(json!({
                            "stage": stage, "db": db, "schema": schema, "category": category, "name": name,
                            "title": meta.get("title").cloned().unwrap_or(json!(name)),
                            "description": meta.get("description").cloned().unwrap_or(Value::Null),
                            "versions": meta.get("sqlVersions").and_then(Value::as_array).map(|a| a.len()),
                            "approvedVersion": meta.get("approvedVersion").cloned().unwrap_or(Value::Null),
                            "updatedAt": updated,
                            "runs": meta.get("runs").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
                            "lastRun": last.map(|r| json!({
                                "at": r.get("at"), "durationMs": r.get("durationMs"), "rows": r.get("rows"),
                                "analyzed": r.get("analyzed"), "warnings": r.get("warnings").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
                            })),
                        }));
                    }
                }
            }
        }
    }
    json!({ "libraryDir": root.to_string_lossy(), "reports": out })
}

fn report_content(query: &HashMap<String, String>) -> Result<Value, String> {
    let get = |k: &str| query.get(k).cloned().unwrap_or_default();
    let stage = get("stage");
    let dir = STAGES.iter().find(|(s, _)| *s == stage).map(|(_, d)| *d).ok_or("stage must be draft, approved or execute")?;
    let (db, schema, category, name) = (get("db").to_lowercase(), get("schema"), get("category"), get("name"));
    for s in [&db, &schema, &category, &name] {
        if !valid_segment(s) {
            return Err(format!("Invalid path segment \"{s}\""));
        }
    }
    let base = library_dir().join(dir).join(&db).join(&schema).join(&category);
    let html = base.join(format!("{name}.html"));
    if stage != "execute" && html.exists() {
        return fs::read_to_string(html).map(|c| json!({ "kind": "html", "content": c })).map_err(|e| e.to_string());
    }
    fs::read_to_string(base.join(format!("{name}.sql"))).map(|c| json!({ "kind": "sql", "content": c })).map_err(|e| e.to_string())
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
            // As node-postgres reads it (describeConnection): IPv6 without brackets, percent-decoded.
            let host = match u.host() {
                Some(url::Host::Ipv6(a)) => a.to_string(),
                _ => decode(u.host_str().unwrap_or("")),
            };
            m.insert("host".into(), json!(host));
            m.insert("port".into(), json!(u.port().map(|p| p.to_string()).unwrap_or_else(|| "5432".into())));
            m.insert("database".into(), json!(decode(u.path().trim_start_matches('/'))));
            m.insert("user".into(), json!(decode(u.username())));
            // A password option in the query string counts too, like describeConnection().
            let query_password = u.query_pairs().any(|(k, _)| matches!(k.to_lowercase().as_str(), "password" | "sslpassword"));
            m.insert("passwordInString".into(), json!(u.password().is_some() || query_password));
        }
        Err(_) => {
            m.insert("error".into(), json!("Connection string is not a URL (postgresql://user@host:port/db expected)."));
        }
    }
    m
}

// Per-profile ceiling override, as in loadConfig(): AUSPEX_MAX_STATEMENT_TIMEOUT_MS_<NAME>.
fn profile_max_ms(name: &str, fallback: u64) -> u64 {
    ms_env(&format!("AUSPEX_MAX_STATEMENT_TIMEOUT_MS_{}", name.to_uppercase()), fallback)
}

// Query budget per minute, as in loadConfig(): AUSPEX_MAX_QUERIES_PER_MINUTE_<NAME>
// overrides maxQueriesPerMinute from the file, which overrides the global value.
fn profile_max_queries(name: &str, file_value: Option<u64>, global: u64) -> u64 {
    ms_env(&format!("AUSPEX_MAX_QUERIES_PER_MINUTE_{}", name.to_uppercase()), file_value.unwrap_or(global))
}

// The checks the server applies at startup (validateProfileUrl in config.js);
// a profile failing them is shown with an error instead of as usable.
fn profile_problem(name: &str, url_text: &str) -> Option<String> {
    let mut chars = name.chars();
    let name_ok = name.len() <= 40
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !name_ok {
        return Some("Invalid profile name (a-z, 0-9, - and _, starting with a letter); the server will not start.".into());
    }
    let u = match url::Url::parse(url_text) {
        Ok(u) => u,
        Err(_) => return Some("Not a postgresql:// URL; the server will not start.".into()),
    };
    if u.scheme() != "postgresql" && u.scheme() != "postgres" {
        return Some("Not a postgresql:// URL; the server will not start.".into());
    }
    let query_password = u.query_pairs().any(|(k, _)| matches!(k.to_lowercase().as_str(), "password" | "sslpassword"));
    if u.password().is_some() || query_password {
        return Some("Password in the URL; move it to pgpass. The server will not start.".into());
    }
    // host/port would override the URL authority in node-postgres, so the
    // endpoint shown could differ from the one used; as in config.js.
    if let Some((k, _)) = u.query_pairs().find(|(k, _)| matches!(k.to_lowercase().as_str(), "host" | "port")) {
        return Some(format!("Query option \"{k}\" is not allowed; put the host and port in the URL authority (postgresql://user@host:port/db). The server will not start."));
    }
    // Same allowlist as allowedQueryOptions in config.js.
    const ALLOWED: [&str; 12] = [
        "ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat",
        "application_name", "fallback_application_name", "connect_timeout", "keepalives", "keepalives_idle",
    ];
    if let Some((k, _)) = u.query_pairs().find(|(k, _)| !ALLOWED.contains(&k.as_ref())) {
        return Some(format!("Query option \"{k}\" is not allowed in the URL; the server will not start."));
    }
    None
}

fn profiles() -> Value {
    let home = auspex_home().to_string_lossy().to_string();
    let file = profiles_file();
    let default_ms = ms_env("AUSPEX_STATEMENT_TIMEOUT_MS", 30_000);
    let max_ms = ms_env("AUSPEX_MAX_STATEMENT_TIMEOUT_MS", 300_000);
    let max_queries = ms_env("AUSPEX_MAX_QUERIES_PER_MINUTE", 60);
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
                        if let Some(problem) = profile_problem(&name.to_lowercase(), url_text) {
                            item.insert("error".into(), json!(problem));
                        }
                        let file_max = p.get("maxTimeoutSeconds").and_then(Value::as_u64).map(|s| s * 1000).unwrap_or(max_ms);
                        let max = profile_max_ms(&name, file_max);
                        item.insert("maxTimeoutSeconds".into(), json!(max / 1000));
                        item.insert("defaultTimeoutSeconds".into(), json!(default_ms.min(max) / 1000));
                        let file_queries = p.get("maxQueriesPerMinute").and_then(Value::as_u64);
                        item.insert("maxQueriesPerMinute".into(), json!(profile_max_queries(&name, file_queries, max_queries)));
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
            if let Some(problem) = profile_problem(&name.to_lowercase(), &value) {
                item.insert("error".into(), json!(problem));
            }
            let max = profile_max_ms(name, max_ms);
            item.insert("maxTimeoutSeconds".into(), json!(max / 1000));
            item.insert("defaultTimeoutSeconds".into(), json!(default_ms.min(max) / 1000));
            item.insert("maxQueriesPerMinute".into(), json!(profile_max_queries(name, None, max_queries)));
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
        "/api/reports" => Ok(list_reports()),
        "/api/report" => report_content(&query),
        "/api/memory" => Ok(memory_summary()),
        "/api/memory/graph" => read_json(&memory_profile(&query)?.join("graph.json")),
        "/api/memory/table" => {
            let file = query.get("file").cloned().unwrap_or_default();
            if !valid_memory_file(&file) {
                return Err("Invalid memory file".into());
            }
            read_json(&file.split('/').fold(memory_profile(&query)?, |p, part| p.join(part)))
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_paths_stay_inside_the_memory_folder() {
        assert!(valid_profile("shop-test_2"));
        for bad in ["", "Shop", "1shop", "../x", "a/b", "a.b"] {
            assert!(!valid_profile(bad), "{bad}");
        }
        assert!(valid_memory_file("tables/sales/orders.json"));
        assert!(valid_memory_file("tables/~41b/~con.json"));
        for bad in ["tables/../x.json", "tables/a/b/c.json", "tables/a/.json", "graph.json", "tables/a/b.JSON", "tables/A/b.json", r"tables\a\b.json"] {
            assert!(!valid_memory_file(bad), "{bad}");
        }
    }

    #[test]
    fn host_and_port_query_options_are_rejected() {
        assert_eq!(profile_problem("shop", "postgresql://u@db.example:5432/x?sslmode=require"), None);
        for q in ["host=production.invalid", "port=6543", "HOST=production.invalid", "sslmode=require&port=6543"] {
            let problem = profile_problem("shop", &format!("postgresql://u@staging.invalid:5432/x?{q}")).expect(q);
            assert!(problem.contains("URL authority"), "{problem}");
            assert!(!problem.contains("production.invalid") && !problem.contains("6543") && !problem.contains("staging"), "{problem}");
        }
        let m = describe("postgresql://u@[::1]:5433/x");
        assert_eq!(m["host"], json!("::1"));
        assert_eq!(m["port"], json!("5433"));
        assert_eq!(describe("postgresql://u@%2Fvar%2Frun%2Fpostgresql/x")["host"], json!("/var/run/postgresql"));
    }

    #[test]
    fn query_budget_prefers_env_then_file_then_global() {
        assert_eq!(profile_max_queries("budget-none", None, 60), 60);
        assert_eq!(profile_max_queries("budget-none", Some(30), 60), 30);
        std::env::set_var("AUSPEX_MAX_QUERIES_PER_MINUTE_BUDGET-ENV", "5");
        assert_eq!(profile_max_queries("budget-env", Some(30), 60), 5);
    }
}
