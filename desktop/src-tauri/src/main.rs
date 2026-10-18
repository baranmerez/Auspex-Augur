// Auspex Augur desktop viewer. Shows the shared viewer page (../src/viewer.html) in a
// window and serves its data through the `api` command: the audit log, the
// profiles, the report library and the schema memory under ~/.auspex. Read-only, never connects to a database, never
// returns passwords. Mirrors the routes of src/viewer.js; the Node config in
// src/config.js stays the source of truth for validation.
// The only writes: `approve_report` / `revoke_report` run the Node stage CLI
// (src/stageCli.js of the Auspex checkout), which moves one report in the
// local library exactly like the viewer's approval routes, and `archive_note`
// runs its archive-note command, which archives one schema-memory note like
// the viewer's POST /api/memory/archive, and `score_column` runs its
// score-column command, which sets or removes one user column score like the
// viewer's POST /api/memory/column-score. Reads through the same CLI: the
// schedules of approved reports and their trend points (`schedules`, `trend`),
// so both viewers share one schedule implementation.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

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

// One folder level (db, schema, one category level) or a report name, with
// the checks of validateSegment in library.js: at most 80 UTF-16 units, no
// leading or trailing dot, none of <>:"/\|?* or U+0000-U+001F. Not checked
// here: NFC normalization (Rust std has none), so a non-NFC folder name may be
// listed by the desktop app, but a stage change of it is refused by Node
// (validateRefInput: the location must equal its normalized form).
fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.encode_utf16().count() <= 80
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !s.chars().any(|c| c <= '\u{1f}' || "<>:\"/\\|?*".contains(c))
}

// The characters String.prototype.trim removes in JavaScript (WhiteSpace and
// LineTerminator): unlike char::is_whitespace it includes U+FEFF and not U+0085.
fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

// s equals its JavaScript trim().
fn js_trimmed(s: &str) -> bool {
    s.trim_matches(is_js_space) == s
}

// A Windows device name with or without an extension, case-insensitive
// (windowsReservedName in library.js): CON, PRN, AUX, NUL, COM0-9, LPT0-9 and
// COM/LPT with a superscript 1-3.
fn windows_reserved(s: &str) -> bool {
    let stem = s.split('.').next().unwrap_or("").to_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "com" || prefix == "lpt") && rest.len() == 1 && (rest[0].is_ascii_digit() || "¹²³".contains(rest[0]))
}

// Category levels below <db>/<schema>, as in library.js (maxCategoryLevels).
const MAX_CATEGORY_LEVELS: usize = 3;

// One category level as the library writes it: a valid segment without
// surrounding spaces that is no Windows device name (categorySegments in library.js).
fn valid_category_level(s: &str) -> bool {
    valid_segment(s) && js_trimmed(s) && !windows_reserved(s)
}

// A category: 1 to MAX_CATEGORY_LEVELS levels joined by "/", each level valid
// on its own, so "a//b", "/a", "a/../b" and "a/ b" are refused.
fn category_levels(s: &str) -> Option<Vec<&str>> {
    let levels: Vec<&str> = s.split('/').collect();
    (levels.len() <= MAX_CATEGORY_LEVELS && levels.iter().all(|l| valid_category_level(l))).then_some(levels)
}

// Real subfolders only: the entry's own type, so symbolic links and junctions
// are not followed (like Dirent.isDirectory() in Node).
fn sub_dirs(p: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(p)
        .map(|it| it.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn list_reports() -> Value {
    let mut list = list_reports_in(library_dir());
    if schedules_file().is_file() {
        apply_schedules(&mut list, cached_schedules());
    }
    list
}

// The `stageCli.js schedules` result, reused for up to a minute while
// schedules.json and schedule-state.json are unchanged (size and modification
// time), so a list refresh (every 5 s in live mode) does not start Node each
// time; next slots move at most once a minute anyway.
fn cached_schedules() -> Result<Value, Value> {
    type Stamp = Vec<Option<(u64, Option<SystemTime>)>>;
    static CACHE: OnceLock<Mutex<Option<(Stamp, Instant, Result<Value, Value>)>>> = OnceLock::new();
    let stamp: Stamp = [schedules_file(), auspex_home().join("schedule-state.json")]
        .iter()
        .map(|f| fs::metadata(f).ok().map(|m| (m.len(), m.modified().ok())))
        .collect();
    let cache = CACHE.get_or_init(Default::default);
    if let Ok(guard) = cache.lock() {
        if let Some((s, at, result)) = guard.as_ref() {
            if *s == stamp && at.elapsed() < Duration::from_secs(60) {
                return result.clone();
            }
        }
    }
    let result = run_read_cli(&["schedules".to_string()]);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((stamp, Instant::now(), result.clone()));
    }
    result
}

fn list_reports_in(root: PathBuf) -> Value {
    let mut out = Vec::new();
    for (stage, dir) in STAGES {
        let base = root.join(dir);
        for db in sub_dirs(&base) {
            for schema in sub_dirs(&base.join(&db)) {
                let schema_dir = base.join(&db).join(&schema);
                for category in sub_dirs(&schema_dir).into_iter().filter(|c| valid_category_level(c)) {
                    list_category(stage, &db, &schema, &schema_dir, vec![category], &mut out);
                }
            }
        }
    }
    json!({ "libraryDir": root.to_string_lossy(), "reports": out })
}

// The reports of one category folder, then its nested category folders (up to
// MAX_CATEGORY_LEVELS levels, like list() in library.js). category is the
// levels joined by "/", categoryPath the levels.
fn list_category(stage: &str, db: &str, schema: &str, schema_dir: &std::path::Path, levels: Vec<String>, out: &mut Vec<Value>) {
    let folder = levels.iter().fold(schema_dir.to_path_buf(), |p, l| p.join(l));
    let category = levels.join("/");
    let mut files: Vec<String> = fs::read_dir(&folder)
        .map(|it| it.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".sql")).collect())
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
        // Drafts carry the SQL version an approval would approve (confirm dialog).
        let active = if stage == "draft" { meta.get("activeVersion").cloned().unwrap_or(Value::Null) } else { Value::Null };
        // Drafts and approved reports carry the SQL hash they stand for now;
        // the page compares it with the opened content's hash.
        let active_hash = if stage == "execute" { Value::Null } else { meta_hash(&meta) };
        out.push(json!({
            "stage": stage, "db": db, "schema": schema, "category": category, "categoryPath": levels, "name": name,
            "title": meta.get("title").cloned().unwrap_or(json!(name)),
            "description": meta.get("description").cloned().unwrap_or(Value::Null),
            "versions": meta.get("sqlVersions").and_then(Value::as_array).map(|a| a.len()),
            "approvedVersion": meta.get("approvedVersion").cloned().unwrap_or(Value::Null),
            "activeVersion": active,
            "activeHash": active_hash,
            "updatedAt": updated,
            "runs": meta.get("runs").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
            "lastRun": last.map(|r| json!({
                "at": r.get("at"), "durationMs": r.get("durationMs"), "rows": r.get("rows"),
                "analyzed": r.get("analyzed"), "warnings": r.get("warnings").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
            })),
        }));
    }
    if levels.len() < MAX_CATEGORY_LEVELS {
        for child in sub_dirs(&folder).into_iter().filter(|c| valid_category_level(c)) {
            let mut next = levels.clone();
            next.push(child);
            list_category(stage, db, schema, schema_dir, next, out);
        }
    }
}

// The SQL hash in a report's metadata (activeHash), or null for reports saved
// before that field existed. No hashing here: the Node library is the only
// place that computes sqlHash.
fn meta_hash(meta: &Value) -> Value {
    meta.get("activeHash").and_then(Value::as_str).filter(|h| valid_hash(h)).map_or(Value::Null, |h| json!(h))
}

// The SQL hash a rendered report HTML stands for: activeHash of the metadata
// embedded in its auspex-report script (reportHtmlHash in src/reports/service.js).
fn html_hash(html: &str) -> Value {
    const OPEN: &str = "<script id=\"auspex-report\" type=\"application/json\">";
    let Some(start) = html.find(OPEN).map(|i| i + OPEN.len()) else { return Value::Null };
    let Some(len) = html[start..].find("</script>") else { return Value::Null };
    serde_json::from_str::<Value>(&html[start..start + len]).ok().and_then(|d| d.get("report").map(meta_hash)).unwrap_or(Value::Null)
}

fn report_content(query: &HashMap<String, String>) -> Result<Value, String> {
    report_content_in(library_dir(), query)
}

fn report_content_in(root: PathBuf, query: &HashMap<String, String>) -> Result<Value, String> {
    let get = |k: &str| query.get(k).cloned().unwrap_or_default();
    let stage = get("stage");
    let dir = STAGES.iter().find(|(s, _)| *s == stage).map(|(_, d)| *d).ok_or("stage must be draft, approved or execute")?;
    let (db, schema, category, name) = (get("db").to_lowercase(), get("schema"), get("category"), get("name"));
    for s in [&db, &schema, &name] {
        if !valid_segment(s) {
            return Err(format!("Invalid path segment \"{s}\""));
        }
    }
    let levels = category_levels(&category).ok_or_else(|| format!("Invalid category \"{category}\""))?;
    let base = levels.iter().fold(root.join(dir).join(&db).join(&schema), |p, l| p.join(l));
    let html = base.join(format!("{name}.html"));
    // sqlHash: the version this content shows, sent back on approve/revoke.
    if stage != "execute" && html.exists() {
        return fs::read_to_string(html).map(|c| json!({ "kind": "html", "sqlHash": html_hash(&c), "content": c })).map_err(|e| e.to_string());
    }
    let hash = if stage == "execute" {
        Value::Null
    } else {
        fs::read_to_string(base.join(format!("{name}.report.json"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map_or(Value::Null, |m| meta_hash(&m))
    };
    fs::read_to_string(base.join(format!("{name}.sql"))).map(|c| json!({ "kind": "sql", "sqlHash": hash, "content": c })).map_err(|e| e.to_string())
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

// Line count of a log file, reused while its size and modification time stay
// the same (as in src/viewer.js): past days never change, so a refresh
// (every 5 s in live mode) reads only the file that grew.
fn count_log_lines(file: &std::path::Path) -> usize {
    static COUNTS: OnceLock<Mutex<HashMap<PathBuf, (u64, Option<SystemTime>, usize)>>> = OnceLock::new();
    let stamp = fs::metadata(file).ok().map(|m| (m.len(), m.modified().ok()));
    let cache = COUNTS.get_or_init(Default::default);
    if let (Some((len, modified)), Ok(map)) = (stamp, cache.lock()) {
        if let Some(&(l, m, count)) = map.get(file) {
            if l == len && m == modified {
                return count;
            }
        }
    }
    let count = fs::read_to_string(file).map(|t| t.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0);
    if let (Some((len, modified)), Ok(mut map)) = (stamp, cache.lock()) {
        map.insert(file.to_path_buf(), (len, modified, count));
    }
    count
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
                    Some((day, count_log_lines(&e.path())))
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
    // Host, user and database are required: the server never takes them from
    // the environment (PGHOST, PGUSER, PGDATABASE); as in config.js.
    let missing: Vec<&str> = [
        ("host", u.host_str().map_or(true, str::is_empty)),
        ("user", u.username().is_empty()),
        ("database", u.path().trim_start_matches('/').is_empty()),
    ].into_iter().filter(|(_, gone)| *gone).map(|(part, _)| part).collect();
    if !missing.is_empty() {
        return Some(format!("The URL needs {} (postgresql://user@host:port/db); the server will not start.", missing.join(", ")));
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
                        // Named folders for change scripts and source code, the notes language and the
                        // Auspex checkout: settings, not profiles.
                        if name == "scriptRoots" || name == "codeRoots" || name == "notesLanguage" || name == AUSPEX_ROOT_KEY {
                            continue;
                        }
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

// Runs off the main thread: a route may start the Node CLI (schedules, trend).
#[tauri::command]
async fn api(path: String, query: HashMap<String, String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || api_route(&path, &query)).await.map_err(|e| e.to_string())?
}

fn api_route(path: &str, query: &HashMap<String, String>) -> Result<Value, String> {
    match path {
        "/api/days" => Ok(json!(list_days().into_iter().map(|(day, count)| json!({ "day": day, "count": count })).collect::<Vec<_>>())),
        "/api/health" => {
            let days = list_days();
            Ok(json!({ "ok": true, "latestDay": days.first().map(|d| d.0.clone()), "latestCount": days.first().map(|d| d.1).unwrap_or(0), "totalDays": days.len() }))
        }
        "/api/profiles" => Ok(profiles()),
        "/api/reports" => Ok(list_reports()),
        "/api/reports/trend" => report_trend(query),
        "/api/report" => report_content(query),
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

// ---------- report stage changes (approve / revoke) ----------
// The library logic stays in Node: these commands run
// `node <auspexRoot>/src/stageCli.js approve|revoke --db=.. --schema=.. --category=.. --name=.. --expected-hash=..`
// without a shell, with a fixed program and script, and read its one-line JSON
// result. This is the app's only process execution besides opening Explorer.

const AUSPEX_ROOT_KEY: &str = "auspexRoot";
const STAGE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CLI_OUTPUT: u64 = 64 * 1024;
const REF_KEYS: [&str; 4] = ["db", "schema", "category", "name"];

fn stage_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

// One part of a report location as the library lists it (validateRefInput and
// normalizeRef in src/reports): non-empty, at most MAX_REF_PART UTF-16 units,
// no surrounding spaces, a folder segment (the category 1 to 3 levels joined
// by "/"); the database in lower case; the name a slug (a-z, 0-9, single
// dashes inside). Node checks again (NFC, slugify).
const MAX_REF_PART: usize = 260;

fn valid_ref_part(key: &str, s: &str) -> bool {
    if s.is_empty() || s.encode_utf16().count() > MAX_REF_PART || !js_trimmed(s) {
        return false;
    }
    if key == "category" {
        return category_levels(s).is_some();
    }
    if !valid_segment(s) {
        return false;
    }
    match key {
        "db" => s.to_lowercase() == s,
        "name" => {
            s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !s.starts_with('-')
                && !s.ends_with('-')
                && !s.contains("--")
        }
        _ => true,
    }
}

// The SQL hash of the version the person reviewed, in the format of sqlHash
// in src/reports/library.js: 12 lower-case hex characters.
fn valid_hash(s: &str) -> bool {
    s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// Node: AUSPEX_NODE (absolute path of the executable), else `node` found in
// an absolute PATH entry (never the current or the app folder).
fn node_program() -> Result<PathBuf, Value> {
    if let Some(p) = env("AUSPEX_NODE") {
        let p = PathBuf::from(p);
        let exe_ok = !cfg!(windows) || p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        if p.is_absolute() && exe_ok && p.is_file() {
            return Ok(p);
        }
        return Err(stage_error("NODE_NOT_FOUND", "AUSPEX_NODE must be the absolute path of the Node executable (node.exe)."));
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).filter(|d| d.is_absolute()).map(|d| d.join(exe)).find(|p| p.is_file()))
        .ok_or_else(|| stage_error("NODE_NOT_FOUND", "Node was not found on PATH; install Node 20+ or set AUSPEX_NODE to node.exe."))
}

// "auspexRoot" from the profiles file, if present.
fn auspex_root_from_file() -> Option<Value> {
    let text = fs::read_to_string(profiles_file()).ok()?;
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    data.get(AUSPEX_ROOT_KEY).cloned()
}

// The Auspex checkout: AUSPEX_ROOT, else "auspexRoot" in profiles.json; an
// absolute directory holding src/stageCli.js (same check as config.js).
fn auspex_root() -> Result<PathBuf, Value> {
    let (value, source) = match env("AUSPEX_ROOT") {
        Some(v) => (Value::String(v), "AUSPEX_ROOT".to_string()),
        None => match auspex_root_from_file() {
            Some(v) => (v, format!("\"{AUSPEX_ROOT_KEY}\" in {}", profiles_file().display())),
            None => {
                return Err(stage_error(
                    "AUSPEX_ROOT_MISSING",
                    format!(
                        "Auspex folder not found. Set \"{AUSPEX_ROOT_KEY}\" in {} (or the AUSPEX_ROOT environment variable) to the Auspex folder that holds src/stageCli.js.",
                        profiles_file().display()
                    ),
                ))
            }
        },
    };
    let text = value.as_str().unwrap_or("");
    let dir = PathBuf::from(text);
    if text.is_empty() || text.chars().any(char::is_control) || !dir.is_absolute() || !dir.join("src").join("stageCli.js").is_file() {
        return Err(stage_error("AUSPEX_ROOT_INVALID", format!("{source} must be the absolute path of the Auspex folder that holds src/stageCli.js.")));
    }
    Ok(dir)
}

fn read_capped<R: Read + Send + 'static>(r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.take(MAX_CLI_OUTPUT).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
}

// The CLI's result: its last stdout line as JSON. ok:true -> Ok, ok:false ->
// Err({ code, message }), anything else -> CLI_FAILED with the exit code.
fn parse_cli_output(stdout: &str, stderr: &str, exit: Option<i32>) -> Result<Value, Value> {
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    match serde_json::from_str::<Value>(line) {
        Ok(v) if v.get("ok") == Some(&Value::Bool(true)) => Ok(v),
        Ok(v) if v.get("ok") == Some(&Value::Bool(false)) => Err(stage_error(
            v.get("code").and_then(Value::as_str).unwrap_or("INTERNAL"),
            v.get("message").and_then(Value::as_str).unwrap_or("The stage change failed."),
        )),
        _ => {
            let detail: String = stderr.trim().chars().take(300).collect();
            let code = exit.map(|c| c.to_string()).unwrap_or_else(|| "none".into());
            Err(stage_error(
                "CLI_FAILED",
                format!("src/stageCli.js gave no result (exit code {code}); the change may or may not have been applied. Reload the list. {detail}").trim_end().to_string(),
            ))
        }
    }
}

const NO_HASH: &str = "This report has no SQL hash yet (saved by an older Auspex). Run it with run_report or re-render the library with render_reports, then reload; if its SQL file was edited by hand, save it with save_report first.";

fn run_stage_cli(action: &str, parts: &[String; 4], expected_hash: Option<&str>) -> Result<Value, Value> {
    if action != "approve" && action != "revoke" {
        return Err(stage_error("INVALID_INPUT", "Unknown stage action."));
    }
    for (key, value) in REF_KEYS.iter().zip(parts.iter()) {
        if !valid_ref_part(key, value) {
            return Err(stage_error("INVALID_INPUT", format!("Invalid report {key}.")));
        }
    }
    // Checked before Node or the Auspex folder is looked up: nothing starts.
    let Some(expected_hash) = expected_hash else { return Err(stage_error("INVALID_INPUT", NO_HASH)) };
    if !valid_hash(expected_hash) {
        return Err(stage_error("INVALID_INPUT", "Invalid expected SQL hash; reload the list."));
    }
    // One argv entry per part, as --key=value so a value can never read as an option.
    let mut args = vec![action.to_string()];
    for (key, value) in REF_KEYS.iter().zip(parts.iter()) {
        args.push(format!("--{key}={value}"));
    }
    args.push(format!("--expected-hash={expected_hash}"));
    run_cli(&args, &stage_audit_base(action, parts))
}

// Runs `node <auspexRoot>/src/stageCli.js <args>` (already validated) without a
// shell and collects its output, or reports that it ran out of time (then it
// was stopped).
enum CliRun {
    Done { stdout: String, stderr: String, code: Option<i32> },
    TimedOut,
}

fn exec_cli(args: &[String], timeout: Duration) -> Result<(CliRun, Duration), Value> {
    let node = node_program()?;
    let root = auspex_root()?;
    let mut cmd = Command::new(&node);
    cmd.arg(root.join("src").join("stageCli.js")).args(args);
    cmd.current_dir(&root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window flashes up
    }
    let mut child = cmd.spawn().map_err(|e| stage_error("NODE_START_FAILED", format!("Could not start {}: {e}", node.display())))?;
    let out = read_capped(child.stdout.take().expect("piped stdout"));
    let err = read_capped(child.stderr.take().expect("piped stderr"));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok((CliRun::TimedOut, started.elapsed()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(stage_error("INTERNAL", e.to_string())),
        }
    };
    let run = CliRun::Done { stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default(), code: status.code() };
    Ok((run, started.elapsed()))
}

// A change through the CLI, mapped from its one-line JSON result; an unknown
// outcome (timeout, no result) is audited with `audit` (tool, profile and
// target of the change) as the base entry.
fn run_cli(args: &[String], audit: &Value) -> Result<Value, Value> {
    let (run, elapsed) = exec_cli(args, STAGE_TIMEOUT)?;
    let CliRun::Done { stdout, stderr, code } = run else {
        let e = stage_error(
            "TIMEOUT",
            format!("src/stageCli.js did not finish within {} s and was stopped; the change may or may not have been applied. Reload the list.", STAGE_TIMEOUT.as_secs()),
        );
        audit_uncertain(audit, elapsed, &e);
        return Err(e);
    };
    let result = parse_cli_output(&stdout, &stderr, code);
    if let Err(e) = &result {
        if e["code"] == json!("CLI_FAILED") {
            audit_uncertain(audit, elapsed, e);
        }
    }
    result
}

// A read through the CLI (schedules, trend): nothing to audit, and a missing
// result only means the data is not shown.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

fn run_read_cli(args: &[String]) -> Result<Value, Value> {
    let (run, _) = exec_cli(args, READ_TIMEOUT)?;
    let CliRun::Done { stdout, stderr, code } = run else {
        return Err(stage_error("TIMEOUT", format!("src/stageCli.js did not answer within {} s.", READ_TIMEOUT.as_secs())));
    };
    parse_cli_output(&stdout, &stderr, code).map_err(|e| {
        if e["code"] == json!("CLI_FAILED") {
            let detail: String = stderr.trim().chars().take(300).collect();
            let exit = code.map_or_else(|| "none".to_string(), |c| c.to_string());
            stage_error("CLI_FAILED", format!("src/stageCli.js gave no result (exit code {exit}). {detail}").trim_end().to_string())
        } else {
            e
        }
    })
}

// ---------- schedules and trends (read through the Node checkout) ----------
// Same data as the browser viewer (src/schedule/viewerData.js): cadences and
// next slots need the local clock and the Node schedule rules, so they are
// not re-implemented here. Without a schedules file nothing is started.

fn schedules_file() -> PathBuf {
    auspex_home().join("schedules.json")
}

// Adds each approved report's schedules from the `stageCli.js schedules`
// result (byReport: [key, schedules] pairs, key db|schema|category|name) and
// the error of a broken schedules file, like GET /api/reports.
fn apply_schedules(list: &mut Value, result: Result<Value, Value>) {
    let data = match result {
        Ok(v) => v,
        Err(e) => {
            list["schedulesError"] = json!(format!("{} (schedules need Node and the Auspex folder)", e["message"].as_str().unwrap_or("not available")));
            return;
        }
    };
    if let Some(err) = data.get("error").and_then(Value::as_str) {
        list["schedulesError"] = json!(err);
    }
    let by: HashMap<String, Value> = data
        .get("byReport")
        .and_then(Value::as_array)
        .map(|pairs| pairs.iter().filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.clone()))).collect())
        .unwrap_or_default();
    if let Some(reports) = list.get_mut("reports").and_then(Value::as_array_mut) {
        for r in reports.iter_mut().filter(|r| r["stage"] == json!("approved")) {
            let key = REF_KEYS.iter().map(|k| r[*k].as_str().unwrap_or("")).collect::<Vec<_>>().join("|");
            if let Some(s) = by.get(&key).filter(|s| s.is_array()) {
                r["schedules"] = s.clone();
            }
        }
    }
}

// Trend points of one report, like GET /api/reports/trend: the location is
// checked here first, then again by Node (trendFile).
fn report_trend(query: &HashMap<String, String>) -> Result<Value, String> {
    let mut args = vec!["trend".to_string()];
    for key in REF_KEYS {
        let value = query.get(key).map(String::as_str).unwrap_or("");
        if !valid_ref_part(key, value) {
            return Err("Invalid report".into());
        }
        args.push(format!("--{key}={value}"));
    }
    let v = run_read_cli(&args).map_err(|e| e["message"].as_str().unwrap_or("Trend not available").to_string())?;
    Ok(json!({ "points": v.get("points").filter(|p| p.is_array()).cloned().unwrap_or(json!([])) }))
}

// Days since 1970-01-01 -> (year, month, day), proleptic Gregorian (H. Hinnant's civil_from_days).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

// UTC timestamp as JavaScript's toISOString() writes it: 2026-10-16T08:00:00.000Z.
fn iso_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", s / 3600, s % 3600 / 60, s % 60, now.subsec_millis())
}

// When the CLI timed out or gave no result it may not have written its own
// audit line, so the app writes one in the same format and place as
// src/auditLog.js (<log dir>/<UTC day>.jsonl). Best effort, like the JS log.
// The audit fields of a stage change: tool, stages, profile and report.
fn stage_audit_base(action: &str, parts: &[String; 4]) -> Value {
    let (tool, from, to) = if action == "approve" { ("approve_report", "draft", "approved") } else { ("revoke_report", "approved", "draft") };
    json!({ "tool": tool, "fromStage": from, "toStage": to, "profile": parts[0], "report": parts.join("/") })
}

fn audit_uncertain(base: &Value, elapsed: Duration, err: &Value) {
    let ts = iso_now();
    let mut entry = json!({ "ts": ts, "source": "desktop", "actor": "desktop" });
    if let (Some(e), Some(b)) = (entry.as_object_mut(), base.as_object()) {
        e.extend(b.clone());
        e.insert("ms".into(), json!(elapsed.as_millis() as u64));
        e.insert("error".into(), err["message"].clone());
        e.insert("errorCode".into(), err["code"].clone());
    }
    let dir = log_dir();
    let _ = fs::create_dir_all(&dir).and_then(|_| {
        use std::io::Write;
        let mut f = fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{}.jsonl", &ts[..10])))?;
        f.write_all(format!("{entry}\n").as_bytes())
    });
}

async fn stage_command(action: &'static str, parts: [String; 4], expected_hash: Option<String>) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || run_stage_cli(action, &parts, expected_hash.as_deref()))
        .await
        .map_err(|e| stage_error("INTERNAL", e.to_string()))?
}

// expected_hash (expectedHash from the page): the SQL hash of the opened
// report content; required (missing or null: INVALID_INPUT, re-run the report).
#[tauri::command]
async fn approve_report(db: String, schema: String, category: String, name: String, expected_hash: Option<String>) -> Result<Value, Value> {
    stage_command("approve", [db, schema, category, name], expected_hash).await
}

#[tauri::command]
async fn revoke_report(db: String, schema: String, category: String, name: String, expected_hash: Option<String>) -> Result<Value, Value> {
    stage_command("revoke", [db, schema, category, name], expected_hash).await
}

// ---------- schema-memory note archive ----------
// Same rules as validateArchiveInput in src/memory/noteArchive.js; Node checks
// again. The reason: trimmed like JavaScript, 1 to MAX_REASON UTF-16 units,
// no control characters (one line).
const MAX_REASON: usize = 200;
const MAX_NOTE_ID: u64 = (1 << 53) - 1;

fn valid_reason(s: &str) -> bool {
    !s.trim_matches(is_js_space).is_empty() && js_trimmed(s) && s.encode_utf16().count() <= MAX_REASON && !s.chars().any(char::is_control)
}

fn run_archive_cli(profile: &str, id: u64, reason: &str) -> Result<Value, Value> {
    if !valid_profile(profile) {
        return Err(stage_error("PROFILE_INVALID", "Invalid profile name."));
    }
    if id == 0 || id > MAX_NOTE_ID {
        return Err(stage_error("INVALID_INPUT", "Invalid note id."));
    }
    if !valid_reason(reason) {
        return Err(stage_error("INVALID_INPUT", format!("The reason is required: one line of at most {MAX_REASON} characters.")));
    }
    let args = vec!["archive-note".to_string(), format!("--profile={profile}"), format!("--id={id}"), format!("--reason={reason}")];
    run_cli(&args, &json!({ "tool": "remember", "action": "archive", "profile": profile, "noteId": id }))
}

// The page's archive request: { profile, id, reason } (src/viewer.html).
#[tauri::command]
async fn archive_note(profile: String, id: u64, reason: String) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || run_archive_cli(&profile, id, &reason))
        .await
        .map_err(|e| stage_error("INTERNAL", e.to_string()))?
}

// ---------- user column score ----------
// Same rules as validateUserScoreInput in src/memory/userScore.js; Node checks
// again. Names: 1 to MAX_NAME_BYTES UTF-8 bytes (PostgreSQL identifiers), no
// control characters. Exactly one of score (1-5) or clear (true); roles only
// with a score, each a known role at most once.
const MAX_NAME_BYTES: usize = 63;
const COLUMN_ROLES: [&str; 6] = ["key", "join", "filter", "display", "aggregate", "sort/group"];

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_NAME_BYTES && !s.chars().any(char::is_control)
}

fn score_column_args(profile: &str, schema: &str, table: &str, column: &str, score: Option<i64>, clear: Option<bool>, roles: Option<&[String]>) -> Result<Vec<String>, Value> {
    if !valid_profile(profile) {
        return Err(stage_error("PROFILE_INVALID", "Invalid profile name."));
    }
    for (key, value) in [("schema", schema), ("table", table), ("column", column)] {
        if !valid_name(value) {
            return Err(stage_error("INVALID_INPUT", format!("Invalid {key} name: 1 to {MAX_NAME_BYTES} bytes without control characters.")));
        }
    }
    let mut args = vec!["score-column".to_string(), format!("--profile={profile}"), format!("--schema={schema}"), format!("--table={table}"), format!("--column={column}")];
    match (score, clear) {
        (None, Some(true)) => {
            if roles.is_some() {
                return Err(stage_error("INVALID_INPUT", "roles go with a score, not with clear."));
            }
            args.push("--clear=true".to_string());
        }
        (Some(score), None) => {
            if !(1..=5).contains(&score) {
                return Err(stage_error("INVALID_INPUT", "score must be an integer from 1 to 5."));
            }
            args.push(format!("--score={score}"));
            if let Some(roles) = roles {
                if roles.iter().any(|r| !COLUMN_ROLES.contains(&r.as_str())) {
                    return Err(stage_error("INVALID_INPUT", format!("roles must be any of {}.", COLUMN_ROLES.join(", "))));
                }
                if roles.iter().enumerate().any(|(i, r)| roles[..i].contains(r)) {
                    return Err(stage_error("INVALID_INPUT", "roles lists a role twice."));
                }
                args.push(format!("--roles={}", roles.join(",")));
            }
        }
        (None, Some(false)) => return Err(stage_error("INVALID_INPUT", "clear must be true.")),
        _ => return Err(stage_error("INVALID_INPUT", "Give exactly one of score or clear.")),
    }
    Ok(args)
}

fn run_score_cli(profile: &str, schema: &str, table: &str, column: &str, score: Option<i64>, clear: Option<bool>, roles: Option<&[String]>) -> Result<Value, Value> {
    let args = score_column_args(profile, schema, table, column, score, clear, roles)?;
    let action = if clear.is_some() { "clear" } else { "set" };
    run_cli(&args, &json!({ "tool": "score_columns", "layer": "user", "action": action, "profile": profile, "schema": schema, "table": table, "column": column, "columns": 1 }))
}

// The page's score request: { profile, schema, table, column, score | clear, roles? } (src/viewer.html).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn score_column(profile: String, schema: String, table: String, column: String, score: Option<i64>, clear: Option<bool>, roles: Option<Vec<String>>) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || run_score_cli(&profile, &schema, &table, &column, score, clear, roles.as_deref()))
        .await
        .map_err(|e| stage_error("INTERNAL", e.to_string()))?
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
        .invoke_handler(tauri::generate_handler![api, approve_report, revoke_report, archive_note, score_column])
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
    fn schedules_attach_to_approved_reports_only_like_the_browser_viewer() {
        let report = |stage: &str, name: &str| json!({ "stage": stage, "db": "exampledb", "schema": "example", "category": "Orders/Delivery", "name": name });
        let mut list = json!({ "reports": [report("approved", "weekly"), report("draft", "weekly"), report("approved", "other")] });
        let item = json!([{ "id": "weekly-example", "enabled": true, "cadence": "weekly monday 08:00", "next": "2026-10-26T08:00", "last": null }]);
        apply_schedules(&mut list, Ok(json!({ "ok": true, "error": null, "byReport": [["exampledb|example|Orders/Delivery|weekly", item], ["broken"], [1, []]] })));
        assert_eq!(list["reports"][0]["schedules"], item);
        assert!(list["reports"][1].get("schedules").is_none(), "drafts carry no schedules");
        assert!(list["reports"][2].get("schedules").is_none());
        assert!(list.get("schedulesError").is_none());

        let mut broken = json!({ "reports": [report("approved", "weekly")] });
        apply_schedules(&mut broken, Ok(json!({ "ok": true, "error": "schedules.json is not valid JSON", "byReport": [] })));
        assert_eq!(broken["schedulesError"], json!("schedules.json is not valid JSON"));

        let mut no_node = json!({ "reports": [] });
        apply_schedules(&mut no_node, Err(stage_error("NODE_NOT_FOUND", "Node was not found on PATH")));
        assert!(no_node["schedulesError"].as_str().unwrap().starts_with("Node was not found on PATH"));
    }

    #[test]
    fn trend_requests_with_a_bad_report_location_start_nothing() {
        let q = |db: &str, name: &str| HashMap::from([("db", db), ("schema", "example"), ("category", "Orders"), ("name", name)].map(|(k, v)| (k.to_string(), v.to_string())));
        for (db, name) in [("../x", "weekly"), ("Exampledb", "weekly"), ("exampledb", "Weekly Report"), ("exampledb", "")] {
            assert_eq!(report_trend(&q(db, name)), Err("Invalid report".to_string()), "{db} {name}");
        }
    }

    #[test]
    fn memory_paths_stay_inside_the_memory_folder() {
        assert!(valid_profile("example-test_2"));
        for bad in ["", "Example", "1example", "../x", "a/b", "a.b"] {
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
        assert_eq!(profile_problem("example", "postgresql://u@db.example.test:5432/x?sslmode=require"), None);
        for q in ["host=production.invalid", "port=6543", "HOST=production.invalid", "sslmode=require&port=6543"] {
            let problem = profile_problem("example", &format!("postgresql://u@staging.invalid:5432/x?{q}")).expect(q);
            assert!(problem.contains("URL authority"), "{problem}");
            assert!(!problem.contains("production.invalid") && !problem.contains("6543") && !problem.contains("staging"), "{problem}");
        }
        let m = describe("postgresql://u@[::1]:5433/x");
        assert_eq!(m["host"], json!("::1"));
        assert_eq!(m["port"], json!("5433"));
        assert_eq!(describe("postgresql://u@%2Fvar%2Frun%2Fpostgresql/x")["host"], json!("/var/run/postgresql"));
    }

    #[test]
    fn host_user_and_database_are_required_as_on_the_server() {
        for ok in ["postgresql://u@db.example.test/x", "postgresql://u@[::1]:5433/x", "postgresql://u@%2Fvar%2Frun%2Fpostgresql/x"] {
            assert_eq!(profile_problem("example", ok), None, "{ok}");
        }
        for (bad, part) in [
            ("postgresql://localhost", "user, database"),
            ("postgresql://db.example.test/exampledb", "user"),
            ("postgresql://report_reader@db.example.test", "database"),
            ("postgresql:///exampledb", "host, user"),
        ] {
            let problem = profile_problem("example", bad).expect(bad);
            assert!(problem.contains(&format!("needs {part} (")), "{bad}: {problem}");
        }
    }

    #[test]
    fn report_parts_are_library_locations_only() {
        assert!(valid_ref_part("db", "exampledb"));
        assert!(valid_ref_part("schema", "example"));
        assert!(valid_ref_part("category", "Example Reports"));
        assert!(valid_ref_part("category", "Örnek Raporlar"));
        assert!(valid_ref_part("name", "example-report-2"));
        for (key, bad) in [
            ("db", ""), ("db", "ExampleDB"), ("db", "../x"), ("schema", ".."), ("schema", "../../SELECT"), ("schema", " example"),
            ("category", "Example Reports/../.."), ("category", r"a\b"), ("category", "a\nb"), ("category", "x."),
            ("name", "Example Report"), ("name", "../example-report"), ("name", "-x"), ("name", "x-"), ("name", "a--b"), ("name", "--db=x"),
        ] {
            assert!(!valid_ref_part(key, bad), "{key}={bad}");
        }
        assert!(!valid_ref_part("category", &"a".repeat(81)));
        assert!(valid_ref_part("category", "Orders/Delivery"));
        assert!(valid_ref_part("category", "Orders/Delivery/Örnek Çalışma"));
        assert!(valid_ref_part("category", &["a".repeat(80), "b".repeat(80), "c".repeat(80)].join("/")));
        for bad in ["a/b/c/d", "a/../b", "/a", "a/", "a//b", "a/ b", "a /b", "a/.", r"a/b\c"] {
            assert!(!valid_ref_part("category", bad), "category={bad}");
        }
        assert!(!valid_ref_part("schema", "a/b"));
        assert!(!valid_ref_part("name", "a/b"));
        let bad_name = ["exampledb".to_string(), "example".into(), "Example Reports".into(), "Bad Name".into()];
        assert_eq!(run_stage_cli("approve", &bad_name, Some("0123456789ab")).unwrap_err()["code"], json!("INVALID_INPUT"));
        let ok = ["exampledb".to_string(), "example".into(), "Example Reports".into(), "example-report".into()];
        assert_eq!(run_stage_cli("delete", &ok, Some("0123456789ab")).unwrap_err()["code"], json!("INVALID_INPUT"));
    }

    #[test]
    fn nested_categories_are_listed_and_opened() {
        let root = std::env::temp_dir().join(format!("auspex-nested-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let schema = root.join("SELECT").join("exampledb").join("example");
        let write = |rel: &str, text: &str| {
            let f = schema.join(rel);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, text).unwrap();
        };
        write("Orders/top.sql", "select 1");
        write("Orders/Delivery/late.sql", "select 2");
        write("Orders/Delivery/Weekly/week.sql", "select 3");
        write("Orders/Delivery/Weekly/Deeper/ignored.sql", "select 4");
        write(".hidden/skipped.sql", "select 5");
        let listed = list_reports_in(root.clone());
        let mut got: Vec<String> = listed["reports"].as_array().unwrap().iter()
            .map(|r| format!("{}|{}|{}", r["category"].as_str().unwrap(), r["categoryPath"].as_array().unwrap().len(), r["name"].as_str().unwrap()))
            .collect();
        got.sort();
        assert_eq!(got, vec!["Orders/Delivery/Weekly|3|week", "Orders/Delivery|2|late", "Orders|1|top"]);
        let q = |category: &str, name: &str| HashMap::from([
            ("stage".to_string(), "approved".to_string()), ("db".into(), "exampledb".into()),
            ("schema".into(), "example".into()), ("category".into(), category.to_string()), ("name".into(), name.to_string()),
        ]);
        assert_eq!(report_content_in(root.clone(), &q("Orders/Delivery", "late")).unwrap()["content"], json!("select 2"));
        assert_eq!(report_content_in(root.clone(), &q("Orders/Delivery/Weekly", "week")).unwrap()["content"], json!("select 3"));
        for bad in ["Orders/../Orders", "Orders/Delivery/Weekly/Deeper", "/Orders", "Orders//Delivery"] {
            assert!(report_content_in(root.clone(), &q(bad, "late")).is_err(), "{bad}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn category_levels_follow_the_node_rules() {
        // Length in UTF-16 units: 40 astral characters are 80 units, 41 are 82.
        assert!(valid_category_level(&"😀".repeat(40)));
        assert!(!valid_category_level(&"😀".repeat(41)));
        assert!(valid_category_level(&"é".repeat(80)));
        // Control characters: U+0000-U+001F refused, U+007F-U+009F allowed like in Node.
        for bad in ["a\u{0}b", "a\u{1f}b", "a\tb"] {
            assert!(!valid_category_level(bad), "{bad:?}");
        }
        assert!(valid_category_level("a\u{7f}b"));
        assert!(valid_category_level("a\u{85}b"), "U+0085 is not trimmed by JavaScript");
        // Trim like JavaScript: U+FEFF and U+00A0 count as spaces.
        for bad in ["\u{feff}Orders", "Orders\u{a0}", "\u{3000}Orders"] {
            assert!(!valid_category_level(bad), "{bad:?}");
        }
        // Windows device names on every level, with or without extension.
        for bad in ["CON", "nul", "Aux.txt", "com1", "LPT9", "com¹", "prn.a.b"] {
            assert!(!valid_category_level(bad), "{bad}");
            assert!(!valid_ref_part("category", &format!("Orders/{bad}")), "{bad}");
        }
        for ok in ["Console", "Nullable", "COM10", "LPT", "auxiliary"] {
            assert!(valid_category_level(ok), "{ok}");
        }
    }

    #[test]
    fn listing_does_not_follow_links() {
        let root = std::env::temp_dir().join(format!("auspex-link-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let schema = root.join("SELECT").join("exampledb").join("example");
        let outside = root.join("outside");
        fs::create_dir_all(schema.join("Orders")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(schema.join("Orders").join("kept.sql"), "select 1").unwrap();
        fs::write(outside.join("linked.sql"), "select 2").unwrap();
        // Symbolic links on Windows need Developer Mode or elevation; a
        // junction (mklink /J) does not, and Node and Rust both treat it as a link.
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, schema.join("Linked"))
            .and(std::os::windows::fs::symlink_file(outside.join("linked.sql"), schema.join("Orders").join("file-link.sql")))
            .or_else(|_| {
                let status = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"]).arg(schema.join("Junction")).arg(&outside)
                    .stdout(std::process::Stdio::null()).status()?;
                if status.success() { Ok(()) } else { Err(std::io::Error::other("mklink /J failed")) }
            });
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, schema.join("Linked"))
            .and(std::os::unix::fs::symlink(outside.join("linked.sql"), schema.join("Orders").join("file-link.sql")));
        // When no link could be created the test only checks the plain listing.
        let names: Vec<String> = list_reports_in(root.clone())["reports"].as_array().unwrap().iter()
            .map(|r| format!("{}|{}", r["category"].as_str().unwrap(), r["name"].as_str().unwrap())).collect();
        assert_eq!(names, vec!["Orders|kept"], "links created: {}", linked.is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn expected_hash_has_the_sql_hash_format_and_is_checked_before_spawning() {
        assert!(valid_hash("0123456789ab"));
        assert!(valid_hash("abcdef012345"));
        for bad in ["", "0123456789a", "0123456789abc", "0123456789AB", "0123456789ag", "--name=x1234", "01234 56789a", "０１２３４５６７８９ab"] {
            assert!(!valid_hash(bad), "{bad}");
        }
        // Refused before Node or the Auspex folder is looked up, so no process starts.
        let ok = ["exampledb".to_string(), "example".into(), "Example Reports".into(), "example-report".into()];
        for bad in ["", "0123456789AB", "--db=other"] {
            let e = run_stage_cli("approve", &ok, Some(bad)).unwrap_err();
            assert_eq!((e["code"].clone(), e["message"].clone()), (json!("INVALID_INPUT"), json!("Invalid expected SQL hash; reload the list.")), "{bad}");
        }
        // A legacy report without a hash: the page sends none.
        let e = run_stage_cli("revoke", &ok, None).unwrap_err();
        assert_eq!((e["code"].clone(), e["message"].clone()), (json!("INVALID_INPUT"), json!(NO_HASH)));
    }

    #[test]
    fn report_hashes_come_from_metadata_and_the_served_html_only() {
        assert_eq!(meta_hash(&json!({ "activeHash": "0123456789ab" })), json!("0123456789ab"));
        assert_eq!(meta_hash(&json!({ "activeHash": "not-a-hash" })), Value::Null);
        assert_eq!(meta_hash(&json!({ "sqlVersions": [{ "hash": "0123456789ab" }] })), Value::Null, "no fallback for older reports");
        let html = |data: &str| format!("<html><script id=\"auspex-report\" type=\"application/json\">{data}</script></html>");
        assert_eq!(html_hash(&html(r#"{"templateVersion":2,"report":{"activeHash":"abcdef012345","sqlVersions":[]}}"#)), json!("abcdef012345"));
        assert_eq!(html_hash(&html(r#"{"report":{"title":"older report"}}"#)), Value::Null);
        assert_eq!(html_hash(&html("not json")), Value::Null);
        assert_eq!(html_hash("<html></html>"), Value::Null);
    }

    #[test]
    fn cli_output_maps_to_result_or_error() {
        let ok = parse_cli_output("{\"ok\":true,\"stage\":\"approved\",\"version\":1}\n", "", Some(0)).unwrap();
        assert_eq!(ok["version"], json!(1));
        let e = parse_cli_output("{\"ok\":false,\"code\":\"PRECONDITION_FAILED\",\"message\":\"is approved, not draft\"}\n", "", Some(1)).unwrap_err();
        assert_eq!((e["code"].clone(), e["message"].clone()), (json!("PRECONDITION_FAILED"), json!("is approved, not draft")));
        let e = parse_cli_output("", "SyntaxError: x", Some(1)).unwrap_err();
        assert_eq!(e["code"], json!("CLI_FAILED"));
        assert!(e["message"].as_str().unwrap().contains("SyntaxError"));
    }

    #[test]
    fn uncertain_outcomes_are_audited_like_the_js_log() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_742), (2026, 10, 16));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        let ts = iso_now();
        assert_eq!((ts.len(), &ts[10..11], &ts[23..]), (24, "T", "Z"), "{ts}");
        let dir = std::env::temp_dir().join(format!("auspex-audit-test-{}", std::process::id()));
        std::env::set_var("AUSPEX_LOG_DIR", &dir);
        let parts = ["exampledb".to_string(), "example".into(), "Example Reports".into(), "example-report".into()];
        audit_uncertain(&stage_audit_base("approve", &parts), Duration::from_millis(30_001), &stage_error("TIMEOUT", "may or may not have been applied"));
        std::env::remove_var("AUSPEX_LOG_DIR");
        let file = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        assert!(file.file_name().unwrap().to_string_lossy().ends_with(".jsonl"));
        let line: Value = serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
        assert_eq!(
            (line["source"].clone(), line["actor"].clone(), line["tool"].clone(), line["report"].clone(), line["errorCode"].clone(), line["ms"].clone()),
            (json!("desktop"), json!("desktop"), json!("approve_report"), json!("exampledb/example/Example Reports/example-report"), json!("TIMEOUT"), json!(30_001))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_requests_are_checked_before_spawning() {
        assert!(valid_reason("Outdated after the example.orders migration"));
        assert!(valid_reason("Eski kural, artık geçerli değil"));
        assert!(valid_reason(&"é".repeat(200)));
        for bad in ["", " ", " leading", "trailing ", "\u{feff}x", "two\nlines", "tab\there", "c1\u{85}x", "del\u{7f}x"] {
            assert!(!valid_reason(bad), "{bad:?}");
        }
        assert!(!valid_reason(&"a".repeat(201)));
        assert!(!valid_reason(&"😀".repeat(101)), "UTF-16 units, like JavaScript");
        // Refused before Node or the Auspex folder is looked up, so no process starts.
        assert_eq!(run_archive_cli("Example", 1, "outdated").unwrap_err()["code"], json!("PROFILE_INVALID"));
        assert_eq!(run_archive_cli("../x", 1, "outdated").unwrap_err()["code"], json!("PROFILE_INVALID"));
        assert_eq!(run_archive_cli("exampledb", 0, "outdated").unwrap_err()["code"], json!("INVALID_INPUT"));
        assert_eq!(run_archive_cli("exampledb", MAX_NOTE_ID + 1, "outdated").unwrap_err()["code"], json!("INVALID_INPUT"));
        assert_eq!(run_archive_cli("exampledb", 1, "").unwrap_err()["code"], json!("INVALID_INPUT"));
        assert_eq!(run_archive_cli("exampledb", 1, "a\nb").unwrap_err()["code"], json!("INVALID_INPUT"));
    }

    #[test]
    fn score_requests_are_checked_before_spawning() {
        let r = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let ok = score_column_args("exampledb", "example", "orders", "status_code", Some(5), None, Some(&r(&["join", "filter"]))).unwrap();
        assert_eq!(ok, r(&["score-column", "--profile=exampledb", "--schema=example", "--table=orders", "--column=status_code", "--score=5", "--roles=join,filter"]));
        assert_eq!(score_column_args("exampledb", "example", "orders", "amount", Some(1), None, Some(&[])).unwrap().last().unwrap(), "--roles=");
        assert_eq!(score_column_args("exampledb", "example", "orders", "amount", None, Some(true), None).unwrap().last().unwrap(), "--clear=true");
        assert!(score_column_args("exampledb", "example", "orders", "teslim_durum_kodu", Some(3), None, None).is_ok());
        assert!(score_column_args("exampledb", "example", "orders", &"\u{15f}".repeat(31), Some(3), None, None).is_ok(), "62 bytes");
        let code = |res: Result<Vec<String>, Value>| res.unwrap_err()["code"].clone();
        assert_eq!(code(score_column_args("Example", "example", "orders", "amount", Some(3), None, None)), json!("PROFILE_INVALID"));
        let long = "a".repeat(64);
        let long_tr = "\u{15f}".repeat(32);
        for bad in ["", "two\nlines", "del\u{7f}x", "c1\u{85}x", long.as_str(), long_tr.as_str()] {
            assert_eq!(code(score_column_args("exampledb", "example", bad, "amount", Some(3), None, None)), json!("INVALID_INPUT"), "{bad:?}");
            assert_eq!(code(score_column_args("exampledb", "example", "orders", bad, Some(3), None, None)), json!("INVALID_INPUT"), "{bad:?}");
        }
        for score in [0, 6, -1] {
            assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", Some(score), None, None)), json!("INVALID_INPUT"));
        }
        assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", None, None, None)), json!("INVALID_INPUT"));
        assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", Some(3), Some(true), None)), json!("INVALID_INPUT"));
        assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", None, Some(false), None)), json!("INVALID_INPUT"));
        assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", None, Some(true), Some(&[]))), json!("INVALID_INPUT"));
        assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", Some(3), None, Some(&r(&["owner"])))), json!("INVALID_INPUT"));
        assert_eq!(code(score_column_args("exampledb", "example", "orders", "amount", Some(3), None, Some(&r(&["join", "join"])))), json!("INVALID_INPUT"));
        // Refused before Node or the Auspex folder is looked up, so no process starts.
        assert_eq!(run_score_cli("exampledb", "example", "orders", "amount", Some(9), None, None).unwrap_err()["code"], json!("INVALID_INPUT"));
    }

    #[test]
    fn auspex_root_must_hold_the_stage_cli() {
        let dir = std::env::temp_dir().join(format!("auspex-root-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("src")).unwrap();
        std::env::set_var("AUSPEX_ROOT", &dir);
        assert_eq!(auspex_root().unwrap_err()["code"], json!("AUSPEX_ROOT_INVALID"));
        fs::write(dir.join("src").join("stageCli.js"), "").unwrap();
        assert_eq!(auspex_root().unwrap(), dir);
        std::env::set_var("AUSPEX_ROOT", "relative/auspex");
        assert_eq!(auspex_root().unwrap_err()["code"], json!("AUSPEX_ROOT_INVALID"));
        std::env::remove_var("AUSPEX_ROOT");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn query_budget_prefers_env_then_file_then_global() {
        assert_eq!(profile_max_queries("budget-none", None, 60), 60);
        assert_eq!(profile_max_queries("budget-none", Some(30), 60), 30);
        std::env::set_var("AUSPEX_MAX_QUERIES_PER_MINUTE_BUDGET-ENV", "5");
        assert_eq!(profile_max_queries("budget-env", Some(30), 60), 5);
    }
}
