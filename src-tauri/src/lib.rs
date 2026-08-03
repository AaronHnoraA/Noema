use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    path::BaseDirectory,
    utils::config::{Color, WebviewUrl},
    Emitter, LogicalPosition, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    #[serde(default)]
    client: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    route: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    dirty: bool,
    #[serde(default)]
    save_in_flight: bool,
    #[serde(default)]
    conflict: bool,
    #[serde(default)]
    busy: bool,
    #[serde(default)]
    bounds: Option<WindowBounds>,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    full_screen: bool,
}

impl WindowState {
    fn risky(&self) -> bool {
        self.dirty || self.save_in_flight || self.conflict || self.busy
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct DesktopSession {
    #[serde(default = "session_version")]
    version: u8,
    #[serde(default)]
    windows: Vec<WindowState>,
}

fn session_version() -> u8 {
    1
}

struct DesktopState {
    host_url: Mutex<String>,
    host_child: Mutex<Option<CommandChild>>,
    windows: Mutex<HashMap<String, WindowState>>,
    next_window: AtomicU64,
    resource_root: PathBuf,
    data_root: PathBuf,
    note_root: PathBuf,
    quitting: AtomicBool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenTarget {
    #[serde(default)]
    file: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    disposition: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePathOptions {
    title: Option<String>,
    default_path: Option<String>,
    extension: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryOptions {
    root: String,
    default_path: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPlugin {
    id: String,
    name: String,
    description: String,
    version: String,
    enabled: bool,
    active: bool,
    built_in: bool,
    configurable: bool,
    locked: bool,
}

fn io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn cursor_position_slot(value: &Value) -> Option<String> {
    let file = value.get("file")?.as_str()?.trim();
    if file.is_empty() {
        return None;
    }
    let client = value
        .get("client")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    Some(format!("{file}\0{client}"))
}

fn cursor_position_updated_at(value: &Value) -> f64 {
    value
        .get("updatedAt")
        .and_then(Value::as_f64)
        .unwrap_or_default()
}

fn read_json_array(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let parsed: Value =
        serde_json::from_str(&fs::read_to_string(path).map_err(io_error)?).map_err(io_error)?;
    parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON array", path.display()))
}

fn write_json_array(path: &Path, values: &[Value]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let serialized = serde_json::to_string_pretty(values).map_err(io_error)?;
    let temporary = parent.join(format!(
        ".{}.migration-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("positions.json"),
        std::process::id(),
    ));
    fs::write(&temporary, format!("{serialized}\n")).map_err(io_error)?;
    #[cfg(target_os = "windows")]
    {
        if path.exists() {
            fs::copy(&temporary, path).map_err(io_error)?;
            fs::remove_file(&temporary).map_err(io_error)?;
        } else {
            fs::rename(&temporary, path).map_err(io_error)?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    fs::rename(&temporary, path).map_err(io_error)?;
    Ok(())
}

/// Merge Electron's cursor history into Tauri's state without replacing a
/// newer `(file, client)` slot created by the current host.
fn merge_legacy_cursor_positions(legacy: &Path, current: &Path) -> Result<bool, String> {
    if !legacy.exists() {
        return Ok(false);
    }
    let legacy_entries = read_json_array(legacy)?;
    let current_entries = read_json_array(current)?;
    let mut by_slot: HashMap<String, Value> = HashMap::new();

    // Current entries win timestamp ties. Legacy entries replace them only
    // when they are strictly newer.
    for entry in &current_entries {
        if let Some(slot) = cursor_position_slot(entry) {
            let should_replace = by_slot
                .get(&slot)
                .map(|saved| cursor_position_updated_at(entry) > cursor_position_updated_at(saved))
                .unwrap_or(true);
            if should_replace {
                by_slot.insert(slot, entry.clone());
            }
        }
    }
    for entry in legacy_entries {
        let Some(slot) = cursor_position_slot(&entry) else {
            continue;
        };
        let should_replace = by_slot
            .get(&slot)
            .map(|saved| cursor_position_updated_at(&entry) > cursor_position_updated_at(saved))
            .unwrap_or(true);
        if should_replace {
            by_slot.insert(slot, entry);
        }
    }

    let mut merged: Vec<(String, Value)> = by_slot.into_iter().collect();
    merged.sort_by(|(left_slot, left), (right_slot, right)| {
        cursor_position_updated_at(right)
            .partial_cmp(&cursor_position_updated_at(left))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_slot.cmp(right_slot))
    });
    let merged: Vec<Value> = merged
        .into_iter()
        .take(240)
        .map(|(_, value)| value)
        .collect();
    if merged == current_entries {
        return Ok(false);
    }
    write_json_array(current, &merged)?;
    Ok(true)
}

fn copy_legacy_file_if_missing(legacy: &Path, current: &Path) -> Result<bool, String> {
    if !legacy.is_file() || current.exists() {
        return Ok(false);
    }
    if let Some(parent) = current.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    fs::copy(legacy, current).map_err(io_error)?;
    Ok(true)
}

fn migrate_legacy_desktop_state(legacy_root: &Path, data_root: &Path) -> Result<(), String> {
    if legacy_root == data_root || !legacy_root.exists() {
        return Ok(());
    }
    let legacy_state = legacy_root.join("state");
    let current_state = data_root.join("state");
    let mut errors = Vec::new();
    if let Err(error) = merge_legacy_cursor_positions(
        &legacy_state.join("positions.json"),
        &current_state.join("positions.json"),
    ) {
        errors.push(format!("cursor positions: {error}"));
    }
    for name in ["recent.json", "languagetool.json"] {
        if let Err(error) =
            copy_legacy_file_if_missing(&legacy_state.join(name), &current_state.join(name))
        {
            errors.push(format!("{name}: {error}"));
        }
    }
    if let Err(error) = copy_legacy_file_if_missing(
        &legacy_root.join("plugins.json"),
        &data_root.join("plugins.json"),
    ) {
        errors.push(format!("plugins.json: {error}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn markdown_path(path: &str) -> bool {
    let lower = path.trim().to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn window_kind(url: &str, file: &str) -> String {
    if !file.is_empty() {
        return "note".into();
    }
    if let Ok(url) = Url::parse(url) {
        if url.path() == "/config" {
            return "config".into();
        }
        if url.path() == "/wiki"
            && url
                .query_pairs()
                .any(|(key, value)| key == "view" && value == "graph")
        {
            return "graph".into();
        }
        if url.query_pairs().any(|(key, _)| key == "file") {
            return "note".into();
        }
    }
    "wiki".into()
}

fn route_from_url(url: &str) -> String {
    Url::parse(url)
        .map(|mut url| {
            let query: Vec<_> = url
                .query_pairs()
                .filter(|(key, _)| key != "client")
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            url.set_query(None);
            if !query.is_empty() {
                let mut pairs = url.query_pairs_mut();
                for (key, value) in &query {
                    pairs.append_pair(key, value);
                }
            }
            match url.query() {
                Some(query) => format!("{}?{}", url.path(), query),
                None => url.path().to_string(),
            }
        })
        .unwrap_or_else(|_| "/wiki".into())
}

fn new_window_client(label: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("noema-desktop:{}:{timestamp}:{label}", std::process::id())
}

fn expanded_path(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest);
    }
    PathBuf::from(value)
}

fn app_config() -> Value {
    let path = std::env::var_os("NOEMA_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|path| path.join("noema")))
        .unwrap_or_else(|| PathBuf::from(".noema"))
        .join("config.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn configured_note_root(default_root: &Path) -> PathBuf {
    if let Some(path) =
        std::env::var_os("NOEMA_ROOT").or_else(|| std::env::var_os("AARONNOTE_ROOT"))
    {
        return expanded_path(&path.to_string_lossy());
    }
    let config = app_config();
    let configured = config
        .pointer("/workspace/root")
        .and_then(Value::as_str)
        .unwrap_or("");
    if configured.is_empty() {
        default_root.to_path_buf()
    } else {
        expanded_path(configured)
    }
}

fn workspace_layout() -> String {
    app_config()
        .pointer("/workspace/layout")
        .and_then(Value::as_str)
        .unwrap_or("legacy")
        .to_string()
}

fn url_for(state: &DesktopState, file: &str, route: &str, client: &str) -> Result<String, String> {
    let host = state.host_url.lock().map_err(io_error)?.clone();
    let mut url = if route.is_empty() {
        Url::parse(&host).map_err(io_error)?
    } else {
        Url::parse(&host)
            .map_err(io_error)?
            .join(route)
            .map_err(io_error)?
    };
    if route.is_empty() {
        url.set_path("/wiki");
    }
    url.query_pairs_mut().append_pair("host", "desktop");
    if !file.is_empty() {
        url.query_pairs_mut().append_pair("file", file);
    }
    if !client.is_empty() {
        url.query_pairs_mut().append_pair("client", client);
    }
    if std::env::var("NOEMA_DESKTOP_SMOKE").as_deref() == Ok("1") {
        url.query_pairs_mut().append_pair("desktopSmoke", "1");
    }
    Ok(url.into())
}

fn active_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.webview_windows().into_values().next())
}

fn emit_command(window: &WebviewWindow, command: &str) {
    let _ = window.emit("noema:command", json!({ "command": command }));
}

fn write_session(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    if std::env::var("NOEMA_DESKTOP_SMOKE").as_deref() == Ok("1") {
        return;
    }
    let mut snapshots = Vec::new();
    if let Ok(windows) = state.windows.lock() {
        for (label, window_state) in windows.iter() {
            if window_state.kind == "config" {
                continue;
            }
            let mut snapshot = window_state.clone();
            if let Some(window) = app.get_webview_window(label) {
                if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                    snapshot.bounds = Some(WindowBounds {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    });
                }
                snapshot.maximized = window.is_maximized().unwrap_or(false);
                snapshot.full_screen = window.is_fullscreen().unwrap_or(false);
            }
            snapshots.push(snapshot);
        }
    }
    let path = state.data_root.join("state/desktop-session.json");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&DesktopSession {
        version: 1,
        windows: snapshots,
    }) {
        let _ = fs::write(path, format!("{serialized}\n"));
    }
}

fn read_session(state: &DesktopState) -> DesktopSession {
    let path = state.data_root.join("state/desktop-session.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn create_window(
    app: &tauri::AppHandle,
    file: String,
    route: String,
    restore: Option<WindowState>,
) -> Result<WebviewWindow, String> {
    let desktop = app.state::<DesktopState>();
    let label = format!(
        "noema-{}",
        desktop.next_window.fetch_add(1, Ordering::Relaxed)
    );
    let restore = restore.unwrap_or_default();
    let client = if restore.client.trim().is_empty() {
        new_window_client(&label)
    } else {
        restore.client.clone()
    };
    let target = url_for(&desktop, &file, &route, &client)?;
    let kind = window_kind(&target, &file);
    let is_config = kind == "config";
    let mut builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(target.parse().map_err(io_error)?),
    )
    .title(if is_config {
        "Noema Configuration"
    } else {
        "Noema"
    })
    .inner_size(
        restore
            .bounds
            .map(|bounds| bounds.width as f64)
            .unwrap_or(if is_config { 960.0 } else { 1320.0 }),
        restore
            .bounds
            .map(|bounds| bounds.height as f64)
            .unwrap_or(if is_config { 760.0 } else { 920.0 }),
    )
    .min_inner_size(720.0, 560.0)
    .background_color(Color(246, 245, 241, 255));
    if let Some(bounds) = restore.bounds {
        builder = builder.position(bounds.x as f64, bounds.y as f64);
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::TitleBarStyle;
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(18.0, 18.0));
    }
    let origin =
        Url::parse(&desktop.host_url.lock().map_err(io_error)?.clone()).map_err(io_error)?;
    let navigation_origin = origin.clone();
    builder = builder.on_navigation(move |url| {
        let internal = url.scheme() == navigation_origin.scheme()
            && url.host_str() == navigation_origin.host_str()
            && url.port_or_known_default() == navigation_origin.port_or_known_default();
        if !internal {
            let _ = open::that_detached(url.as_str());
        }
        internal
    });
    let app_for_new = app.clone();
    builder = builder.on_new_window(move |url, _features| {
        let internal = url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port_or_known_default() == origin.port_or_known_default();
        if internal {
            let _ = create_window(
                &app_for_new,
                String::new(),
                route_from_url(url.as_str()),
                None,
            );
        } else {
            let _ = open::that_detached(url.as_str());
        }
        tauri::webview::NewWindowResponse::Deny
    });
    let window = builder.build().map_err(io_error)?;
    if restore.maximized {
        let _ = window.maximize();
    }
    if restore.full_screen {
        let _ = window.set_fullscreen(true);
    }
    desktop.windows.lock().map_err(io_error)?.insert(
        label.clone(),
        WindowState {
            client,
            kind,
            file,
            route: route_from_url(&target),
            ..restore
        },
    );
    let app_for_events = app.clone();
    let label_for_events = label.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Destroyed => {
            if let Ok(mut windows) = app_for_events.state::<DesktopState>().windows.lock() {
                windows.remove(&label_for_events);
            }
            write_session(&app_for_events);
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            write_session(&app_for_events)
        }
        _ => {}
    });
    Ok(window)
}

fn restore_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let pending = std::env::args().skip(1).find(|arg| markdown_path(arg));
    if let Some(file) = pending {
        create_window(
            app,
            fs::canonicalize(&file)
                .unwrap_or_else(|_| PathBuf::from(&file))
                .to_string_lossy()
                .into(),
            String::new(),
            None,
        )?;
        return Ok(());
    }
    let session = read_session(&state);
    let restorable: Vec<_> = session
        .windows
        .into_iter()
        .filter(|item| {
            matches!(item.kind.as_str(), "wiki" | "graph")
                || (item.kind == "note" && Path::new(&item.file).exists())
        })
        .take(20)
        .collect();
    if restorable.is_empty() {
        create_window(app, String::new(), "/wiki".into(), None)?;
    } else {
        for item in restorable {
            let route = if item.kind == "note" {
                String::new()
            } else {
                item.route.clone()
            };
            create_window(app, item.file.clone(), route, Some(item))?;
        }
    }
    Ok(())
}

fn host_environment(state: &DesktopState) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let root = &state.resource_root;
    let state_root = state.data_root.join("state");
    let temp_root = state_root.join("tmp");
    let resources = std::env::var_os("NOEMA_RESOURCES_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("resources"));
    let _ = fs::create_dir_all(&state.note_root);
    let _ = fs::create_dir_all(&temp_root);
    env.insert("AARONNOTE_HOST_MODE".into(), "desktop".into());
    env.insert("AARONNOTE_WEB_HOST".into(), "127.0.0.1".into());
    env.insert("AARONNOTE_WEB_PORT".into(), "0".into());
    env.insert(
        "AARONNOTE_WEB_DIR".into(),
        root.join("dist/aaronnote").to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_RUNTIME_ROOT".into(),
        root.to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_ROOT".into(),
        state.note_root.to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_WORKSPACE_ROOT".into(),
        state.note_root.to_string_lossy().into(),
    );
    env.insert("NOEMA_WORKSPACE_LAYOUT".into(), workspace_layout());
    env.insert(
        "AARONNOTE_STATE_DIR".into(),
        state_root.to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_TMP_DIR".into(),
        temp_root.to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_PUBLISH_JS_DIR".into(),
        root.join("js").to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_SNIPPETS_ROOT".into(),
        resources.join("snippets").to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_TEMPLATES_ROOT".into(),
        resources.join("templates/noema").to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_LATEX_TEMPLATES_ROOT".into(),
        resources.join("templates").to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_KATEX_MACROS_DIR".into(),
        resources.join("katex-macros").to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_PROSE_WORDS".into(),
        resources
            .join("prose-accepted-words.txt")
            .to_string_lossy()
            .into(),
    );
    let plugin_state = state.data_root.join("plugin-state/noema.copilot");
    let copilot_home = plugin_state.join("home");
    let copilot_cache = plugin_state.join("cache");
    for path in [&copilot_home, &copilot_cache] {
        let _ = fs::create_dir_all(path);
    }
    env.insert("NOEMA_COPILOT_PLUGIN".into(), "noema.copilot".into());
    env.insert(
        "AARONNOTE_COPILOT_HOME".into(),
        copilot_home.to_string_lossy().into(),
    );
    env.insert(
        "AARONNOTE_COPILOT_CACHE_HOME".into(),
        copilot_cache.to_string_lossy().into(),
    );
    let server = root.join("node_modules/@github/copilot-language-server/dist/language-server.js");
    if server.exists() {
        env.insert(
            "AARONNOTE_COPILOT_LANGUAGE_SERVER_MODULE".into(),
            server.to_string_lossy().into(),
        );
    }
    env
}

fn start_host(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let script = state.resource_root.join("web-host.mjs");
    let command = app
        .shell()
        .sidecar("noema-node")
        .map_err(io_error)?
        .arg(script)
        .envs(host_environment(&state));
    let (mut receiver, child) = command.spawn().map_err(io_error)?;
    *state.host_child.lock().map_err(io_error)? = Some(child);
    tauri::async_runtime::spawn(async move {
        let mut output = String::new();
        while let Some(event) = receiver.recv().await {
            let chunk = match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    print!("{text}");
                    Some(text)
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    eprint!("{text}");
                    Some(text)
                }
                CommandEvent::Terminated(payload) => {
                    if !app.state::<DesktopState>().quitting.load(Ordering::Relaxed) {
                        eprintln!("[noema-tauri] core stopped: {:?}", payload.code);
                        app.exit(1);
                    }
                    break;
                }
                _ => None,
            };
            if let Some(chunk) = chunk {
                output.push_str(&chunk);
                if let Some(start) = output.find("[aaronnote-web] http://127.0.0.1:") {
                    let tail = &output[start + "[aaronnote-web] ".len()..];
                    if let Some(url) = tail
                        .split_whitespace()
                        .next()
                        .filter(|value| Url::parse(value).is_ok())
                    {
                        let desktop = app.state::<DesktopState>();
                        let mut host = desktop.host_url.lock().expect("host url lock");
                        if host.is_empty() {
                            *host = url.to_string();
                            drop(host);
                            if let Err(error) = restore_windows(&app) {
                                eprintln!("[noema-tauri] window startup failed: {error}");
                                app.exit(1);
                            }
                        }
                    }
                }
                if output.contains("[noema-desktop-smoke] ") {
                    app.exit(0);
                }
                if output.len() > 32_000 {
                    output.drain(..output.len() - 16_000);
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn open_files(app: tauri::AppHandle, paths: Vec<String>) {
    for path in paths.into_iter().filter(|path| markdown_path(path)) {
        let _ = create_window(&app, path, String::new(), None);
    }
}

#[tauri::command]
fn open_target(
    app: tauri::AppHandle,
    window: WebviewWindow,
    target: OpenTarget,
) -> Result<bool, String> {
    let desktop = app.state::<DesktopState>();
    let file = if target.file.is_empty() {
        String::new()
    } else {
        fs::canonicalize(&target.file)
            .unwrap_or_else(|_| PathBuf::from(&target.file))
            .to_string_lossy()
            .into()
    };
    if !file.is_empty() {
        if let Some((label, _)) = desktop
            .windows
            .lock()
            .map_err(io_error)?
            .iter()
            .find(|(_, item)| item.kind == "note" && item.file == file)
            .map(|(a, b)| (a.clone(), b.clone()))
        {
            if let Some(existing) = app.get_webview_window(&label) {
                let _ = existing.set_focus();
                return Ok(true);
            }
        }
    }
    let explicit_new = matches!(
        target.disposition.as_str(),
        "new" | "split-right" | "split-down"
    ) || target.source == "drop";
    let route = if target.url.is_empty() {
        String::new()
    } else {
        let host = desktop.host_url.lock().map_err(io_error)?.clone();
        let url = Url::parse(&host)
            .map_err(io_error)?
            .join(&target.url)
            .map_err(io_error)?;
        if url.origin() != Url::parse(&host).map_err(io_error)?.origin() {
            return Ok(false);
        }
        route_from_url(url.as_str())
    };
    if !explicit_new {
        let replace = if matches!(target.source.as_str(), "wiki" | "graph" | "note-link") {
            Some(window.clone())
        } else {
            let reusable = desktop
                .windows
                .lock()
                .map_err(io_error)?
                .iter()
                .find(|(_, item)| item.kind == "wiki" && !item.risky())
                .map(|(label, _)| label.clone());
            reusable
                .and_then(|label| app.get_webview_window(&label))
                .or(Some(window.clone()))
        };
        if let Some(replace) = replace {
            let previous = desktop
                .windows
                .lock()
                .map_err(io_error)?
                .get(replace.label())
                .cloned()
                .unwrap_or_default();
            let client = if previous.client.is_empty() {
                new_window_client(replace.label())
            } else {
                previous.client.clone()
            };
            let url = url_for(&desktop, &file, &route, &client)?;
            replace
                .navigate(url.parse().map_err(io_error)?)
                .map_err(io_error)?;
            desktop.windows.lock().map_err(io_error)?.insert(
                replace.label().into(),
                WindowState {
                    client,
                    kind: window_kind(&url, &file),
                    file,
                    route: route_from_url(&url),
                    dirty: false,
                    save_in_flight: false,
                    conflict: false,
                    busy: false,
                    ..previous
                },
            );
            return Ok(true);
        }
    }
    let created = create_window(&app, file, route, None)?;
    if target.disposition.starts_with("split-") {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
            let half_width = (size.width / 2).max(720);
            let _ = window.set_size(PhysicalSize::new(half_width, size.height));
            let _ = created.set_position(PhysicalPosition::new(
                position.x + half_width as i32,
                position.y,
            ));
            let _ = created.set_size(PhysicalSize::new(half_width, size.height));
        }
    }
    Ok(true)
}

#[tauri::command]
fn update_window_state(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: WindowState,
) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    let current_url = window.url().map_err(io_error)?.to_string();
    let previous_client = desktop
        .windows
        .lock()
        .map_err(io_error)?
        .get(window.label())
        .map(|current| current.client.clone())
        .unwrap_or_default();
    let next = WindowState {
        client: if state.client.is_empty() {
            previous_client
        } else {
            state.client
        },
        kind: if state.kind.is_empty() {
            window_kind(&current_url, &state.file)
        } else {
            state.kind
        },
        route: route_from_url(&current_url),
        file: state.file,
        title: state.title,
        dirty: state.dirty,
        save_in_flight: state.save_in_flight,
        conflict: state.conflict,
        busy: state.busy,
        bounds: state.bounds,
        maximized: state.maximized,
        full_screen: state.full_screen,
    };
    desktop
        .windows
        .lock()
        .map_err(io_error)?
        .insert(window.label().into(), next);
    write_session(&app);
    Ok(())
}

fn command_menu(app: &tauri::AppHandle, kind: &str) -> Result<Menu<tauri::Wry>, String> {
    let mut builder = MenuBuilder::new(app);
    let items: &[(&str, &str)] = if kind == "window" {
        &[
            ("window:new", "New Window"),
            ("window:open", "Open…"),
            ("window:split-right", "Split Right"),
            ("window:split-down", "Split Below"),
            ("window:minimize", "Minimize"),
            ("window:zoom", "Zoom"),
            ("window:fullscreen", "Toggle Full Screen"),
            ("window:close", "Close"),
        ]
    } else {
        &[
            ("cmd:knowledge-search", "Search Knowledge…"),
            ("cmd:focus", "Focus Editor"),
            ("cmd:task-manager", "Task Manager"),
            ("cmd:toggle-toc", "Page Outline"),
            ("cmd:toggle-agenda", "Agenda"),
            ("cmd:toggle-graph", "Local Graph"),
            ("cmd:toggle-tools", "Tools"),
            ("cmd:jupyter-panel", "Jupyter Cells"),
            ("cmd:toggle-source", "Toggle Source"),
            ("cmd:prose-check", "Run Prose Check"),
            ("cmd:export-latex", "Export LaTeX…"),
            ("cmd:open-source-editor", "Open Source in VS Code"),
            ("cmd:reveal-current-file", "Reveal Note"),
            ("cmd:save", "Save"),
            ("cmd:trash-current-note", "Move Document to Trash"),
        ]
    };
    for (id, label) in items {
        builder = builder.text(*id, *label);
    }
    builder.build().map_err(io_error)
}

#[tauri::command]
fn show_menu(
    app: tauri::AppHandle,
    window: WebviewWindow,
    kind: String,
    point: MenuPoint,
) -> Result<bool, String> {
    let menu = command_menu(&app, &kind)?;
    window
        .popup_menu_at(
            &menu,
            LogicalPosition::new(point.x.max(0.0), point.y.max(0.0)),
        )
        .map_err(io_error)?;
    Ok(true)
}

#[tauri::command]
fn reveal_path(file: String) -> bool {
    let path = PathBuf::from(file);
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .is_ok();
    }
    #[cfg(not(target_os = "macos"))]
    {
        open::that_detached(path.parent().unwrap_or(&path)).is_ok()
    }
}

#[tauri::command]
fn open_path(file: String) -> Value {
    match open::that_detached(PathBuf::from(file)) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "message": error.to_string() }),
    }
}

#[tauri::command]
fn open_external(url: String) -> Value {
    let allowed = Url::parse(&url)
        .ok()
        .map(|url| {
            matches!(
                url.scheme(),
                "http" | "https" | "mailto" | "zotero" | "marginnote" | "marginnote3"
            )
        })
        .unwrap_or(false);
    if !allowed {
        return json!({ "ok": false, "message": "Unsupported external protocol" });
    }
    match open::that_detached(url) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "message": error.to_string() }),
    }
}

#[tauri::command]
fn choose_save_path(options: SavePathOptions) -> Value {
    let mut dialog =
        rfd::FileDialog::new().set_title(options.title.as_deref().unwrap_or("Save from Noema"));
    if let Some(path) = options.default_path {
        dialog = dialog.set_file_name(path);
    }
    if let Some(extension) = options.extension {
        let extension = extension.trim_matches('.').to_string();
        if !extension.is_empty() {
            dialog = dialog.add_filter(extension.to_ascii_uppercase(), &[extension]);
        }
    }
    match dialog.save_file() {
        Some(path) => json!({ "canceled": false, "path": path }),
        None => json!({ "canceled": true, "path": "" }),
    }
}

#[tauri::command]
fn choose_directory(options: DirectoryOptions) -> Value {
    let root = fs::canonicalize(&options.root).unwrap_or_else(|_| expanded_path(&options.root));
    let requested = options
        .default_path
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let initial = if requested.starts_with(&root) {
        requested
    } else {
        root.clone()
    };
    let selected = rfd::FileDialog::new()
        .set_title(options.title.as_deref().unwrap_or("Choose Wiki folder"))
        .set_directory(initial)
        .pick_folder();
    let Some(selected) = selected else {
        return json!({ "canceled": true, "path": "" });
    };
    let selected = fs::canonicalize(&selected).unwrap_or(selected);
    if !selected.starts_with(&root) {
        return json!({ "canceled": true, "path": "", "message": "Choose a folder inside the selected Wiki repository" });
    }
    let relative = selected
        .strip_prefix(&root)
        .unwrap_or(Path::new(""))
        .to_string_lossy();
    json!({ "canceled": false, "path": selected, "relativePath": relative })
}

#[tauri::command]
fn read_clipboard() -> Value {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return json!({ "kind": "empty" });
    };
    if let Ok(image) = clipboard.get_image() {
        let mut output = Vec::new();
        let encoded = (|| -> Result<(), png::EncodingError> {
            let mut encoder =
                png::Encoder::new(&mut output, image.width as u32, image.height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header()?;
            writer.write_image_data(&image.bytes)?;
            Ok(())
        })();
        if encoded.is_ok() {
            return json!({ "kind": "image", "type": "image/png", "data": BASE64.encode(output) });
        }
    }
    match clipboard.get_text() {
        Ok(text) if !text.is_empty() => json!({ "kind": "text", "text": text, "html": "" }),
        _ => json!({ "kind": "empty" }),
    }
}

#[tauri::command]
fn read_dropped_files(paths: Vec<String>) -> Result<Vec<Value>, String> {
    paths
        .into_iter()
        .take(64)
        .map(|path| {
            let canonical = fs::canonicalize(&path).map_err(io_error)?;
            let metadata = fs::metadata(&canonical).map_err(io_error)?;
            if !metadata.is_file() || metadata.len() > 128 * 1024 * 1024 {
                return Err(format!(
                    "Dropped file is not readable or is too large: {}",
                    canonical.display()
                ));
            }
            let data = fs::read(&canonical).map_err(io_error)?;
            Ok(json!({
                "path": canonical,
                "name": canonical.file_name().and_then(|name| name.to_str()).unwrap_or("file"),
                "type": mime_guess::from_path(&canonical).first_or_octet_stream().essence_str(),
                "data": BASE64.encode(data),
            }))
        })
        .collect()
}

fn id_set(value: Option<String>) -> HashSet<String> {
    value
        .unwrap_or_default()
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn plugins(app: &tauri::AppHandle) -> Vec<DesktopPlugin> {
    let state = app.state::<DesktopState>();
    let config_path = state.data_root.join("plugins.json");
    let config: Value = fs::read_to_string(config_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let configured_enabled: HashSet<_> = config
        .get("enabled")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let configured_disabled: HashSet<_> = config
        .get("disabled")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let env_enabled = id_set(std::env::var("NOEMA_ENABLED_PLUGINS").ok());
    let env_disabled = id_set(std::env::var("NOEMA_DISABLED_PLUGINS").ok());
    let mut roots = vec![
        (state.resource_root.join("plugins"), true),
        (state.data_root.join("plugins"), false),
    ];
    if let Some(extra) = std::env::var_os("NOEMA_PLUGIN_DIRS") {
        roots.extend(std::env::split_paths(&extra).map(|path| (path, false)));
    }
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for (root, built_in) in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let manifest: Value = match fs::read_to_string(entry.path().join("plugin.json"))
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
            {
                Some(value) => value,
                None => continue,
            };
            let Some(id) = manifest
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let configurable = manifest
                .get("configurable")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let locked = !configurable || env_enabled.contains(&id) || env_disabled.contains(&id);
            let enabled = if !configurable {
                manifest
                    .get("enabledByDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            } else if env_disabled.contains(&id) {
                false
            } else if env_enabled.contains(&id) || configured_enabled.contains(&id) {
                true
            } else if configured_disabled.contains(&id) {
                false
            } else {
                manifest
                    .get("enabledByDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            let native_adapter = built_in && matches!(id.as_str(), "noema.copilot" | "noema.zh-cn");
            found.push(DesktopPlugin {
                name: manifest
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .into(),
                description: manifest
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                version: manifest
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("0.0.0")
                    .into(),
                id,
                enabled,
                active: enabled && native_adapter,
                built_in,
                configurable,
                locked,
            });
        }
    }
    found
}

#[tauri::command]
fn list_plugins(app: tauri::AppHandle) -> Vec<DesktopPlugin> {
    plugins(&app)
}

#[tauri::command]
fn set_plugin_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<DesktopPlugin>, String> {
    let available = plugins(&app);
    let plugin = available
        .iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| format!("Unknown plugin: {id}"))?;
    if plugin.locked {
        return Err(format!(
            "{id} is controlled by the application or environment"
        ));
    }
    let state = app.state::<DesktopState>();
    let path = state.data_root.join("plugins.json");
    let mut config: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}));
    let mut enabled_ids: HashSet<_> = config
        .get("enabled")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let mut disabled_ids: HashSet<_> = config
        .get("disabled")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    if enabled {
        enabled_ids.insert(id.clone());
        disabled_ids.remove(&id);
    } else {
        disabled_ids.insert(id.clone());
        enabled_ids.remove(&id);
    }
    config["enabled"] = json!(enabled_ids);
    config["disabled"] = json!(disabled_ids);
    fs::create_dir_all(&state.data_root).map_err(io_error)?;
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&config).map_err(io_error)?
        ),
    )
    .map_err(io_error)?;
    Ok(plugins(&app))
}

#[tauri::command]
fn desktop_smoke_report(app: tauri::AppHandle, report: Value) {
    println!("[noema-desktop-smoke] {report}");
    app.exit(0);
}

fn menu_item(
    app: &tauri::AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> Result<MenuItem<tauri::Wry>, tauri::Error> {
    MenuItem::with_id(app, id, label, true, accelerator)
}

fn application_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let file = SubmenuBuilder::new(app, "File")
        .item(&menu_item(
            app,
            "nav:wiki",
            "Wiki Home",
            Some("CmdOrCtrl+Shift+H"),
        )?)
        .item(&menu_item(
            app,
            "nav:graph",
            "Knowledge Graph",
            Some("CmdOrCtrl+Shift+G"),
        )?)
        .separator()
        .item(&menu_item(
            app,
            "window:open",
            "Open…",
            Some("CmdOrCtrl+O"),
        )?)
        .item(&menu_item(
            app,
            "window:new",
            "New Window",
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .separator()
        .item(&menu_item(app, "cmd:save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&menu_item(
            app,
            "cmd:open-source-editor",
            "Open Source in VS Code",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .item(&menu_item(
            app,
            "window:close",
            "Close",
            Some("CmdOrCtrl+W"),
        )?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&menu_item(app, "cmd:undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&menu_item(
            app,
            "cmd:redo",
            "Redo",
            Some("Shift+CmdOrCtrl+Z"),
        )?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&menu_item(app, "cmd:find", "Find…", Some("CmdOrCtrl+F"))?)
        .build()?;
    let format = SubmenuBuilder::new(app, "Format")
        .item(&menu_item(app, "cmd:bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&menu_item(
            app,
            "cmd:italic",
            "Italic",
            Some("CmdOrCtrl+I"),
        )?)
        .item(&menu_item(
            app,
            "cmd:code",
            "Inline Code",
            Some("CmdOrCtrl+`"),
        )?)
        .separator()
        .item(&menu_item(app, "cmd:blockquote", "Blockquote", None)?)
        .item(&menu_item(app, "cmd:bullet-list", "Bullet List", None)?)
        .item(&menu_item(app, "cmd:ordered-list", "Ordered List", None)?)
        .item(&menu_item(app, "cmd:task-list", "Task List", None)?)
        .item(&menu_item(app, "cmd:insert-table", "Insert Table", None)?)
        .item(&menu_item(
            app,
            "cmd:insert-math-block",
            "Insert Math Block",
            None,
        )?)
        .build()?;
    let navigate = SubmenuBuilder::new(app, "Navigate")
        .item(&menu_item(
            app,
            "cmd:knowledge-search",
            "Search Knowledge…",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .separator()
        .item(&menu_item(app, "cmd:back", "Back", Some("CmdOrCtrl+["))?)
        .item(&menu_item(
            app,
            "cmd:forward",
            "Forward",
            Some("CmdOrCtrl+]"),
        )?)
        .item(&menu_item(
            app,
            "cmd:refresh",
            "Refresh",
            Some("CmdOrCtrl+R"),
        )?)
        .separator()
        .item(&menu_item(app, "cmd:toggle-toc", "Page Outline", None)?)
        .item(&menu_item(app, "cmd:toggle-agenda", "Agenda", None)?)
        .item(&menu_item(app, "cmd:toggle-graph", "Local Graph", None)?)
        .item(&menu_item(app, "cmd:toggle-tools", "Tools", None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&menu_item(
            app,
            "cmd:toggle-source",
            "Toggle Source",
            Some("CmdOrCtrl+/"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(
            app,
            Some("Toggle Full Screen"),
        )?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&menu_item(
            app,
            "window:new",
            "New Window",
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .item(&menu_item(
            app,
            "window:split-right",
            "Split Right",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&menu_item(
            app,
            "window:split-down",
            "Split Below",
            Some("Shift+CmdOrCtrl+\\"),
        )?)
        .separator()
        .minimize()
        .maximize()
        .build()?;
    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let noema = SubmenuBuilder::new(app, "Noema")
            .about(None)
            .item(&menu_item(
                app,
                "window:settings",
                "Settings…",
                Some("CmdOrCtrl+,"),
            )?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&noema);
    }
    menu.items(&[&file, &edit, &format, &navigate, &view, &window])
        .build()
}

fn handle_menu(app: &tauri::AppHandle, id: &str) {
    let current = active_window(app);
    if let Some(command) = id.strip_prefix("cmd:") {
        if let Some(window) = current {
            emit_command(&window, command);
        }
        return;
    }
    match id {
        "nav:wiki" => {
            let _ = create_window(app, String::new(), "/wiki".into(), None);
        }
        "nav:graph" => {
            let _ = create_window(app, String::new(), "/wiki?view=graph".into(), None);
        }
        "window:new" => {
            let _ = create_window(app, String::new(), "/wiki".into(), None);
        }
        "window:settings" => {
            let _ = create_window(app, String::new(), "/config".into(), None);
        }
        "window:open" => {
            if let Some(paths) = rfd::FileDialog::new()
                .add_filter("Markdown", &["md", "markdown"])
                .pick_files()
            {
                for path in paths {
                    let _ = create_window(app, path.to_string_lossy().into(), String::new(), None);
                }
            }
        }
        "window:close" => {
            if let Some(window) = current {
                let _ = window.close();
            }
        }
        "window:minimize" => {
            if let Some(window) = current {
                let _ = window.minimize();
            }
        }
        "window:zoom" => {
            if let Some(window) = current {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
        "window:fullscreen" => {
            if let Some(window) = current {
                let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
            }
        }
        "window:split-right" | "window:split-down" => {
            if let Some(window) = current {
                if let Ok(url) = window.url() {
                    let _ = open_target(
                        app.clone(),
                        window,
                        OpenTarget {
                            url: route_from_url(url.as_str()),
                            source: "window".into(),
                            disposition: id.trim_start_matches("window:").into(),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        _ => {}
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .menu(application_menu)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            open_files,
            open_target,
            update_window_state,
            show_menu,
            reveal_path,
            open_path,
            open_external,
            choose_save_path,
            read_clipboard,
            choose_directory,
            list_plugins,
            set_plugin_enabled,
            read_dropped_files,
            desktop_smoke_report,
        ])
        .setup(|app| {
            let resource_root = app.path().resolve("", BaseDirectory::Resource)?;
            let data_root = app.path().app_data_dir()?;
            if let Some(legacy_root) = dirs::config_dir().map(|path| path.join("noema")) {
                if let Err(error) = migrate_legacy_desktop_state(&legacy_root, &data_root) {
                    eprintln!("[noema-tauri] legacy state migration failed: {error}");
                }
            }
            let default_note_root = app.path().document_dir()?.join("Noema");
            let note_root = configured_note_root(&default_note_root);
            fs::create_dir_all(&note_root)?;
            app.manage(DesktopState {
                host_url: Mutex::new(String::new()),
                host_child: Mutex::new(None),
                windows: Mutex::new(HashMap::new()),
                next_window: AtomicU64::new(1),
                resource_root,
                data_root,
                note_root,
                quitting: AtomicBool::new(false),
            });
            start_host(app.handle().clone()).map_err(|error| io::Error::other(error))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Noema Tauri host");

    app.run(|handle, event| match event {
        tauri::RunEvent::Exit => {
            let state = handle.state::<DesktopState>();
            state.quitting.store(true, Ordering::Relaxed);
            write_session(handle);
            if let Ok(mut child) = state.host_child.lock() {
                if let Some(child) = child.take() {
                    let _ = child.kill();
                }
            };
        }
        _ => {}
    });
}

use std::io;

#[cfg(test)]
mod tests {
    use super::*;

    fn migration_test_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("noema-{name}-{}-{stamp}", std::process::id()))
    }

    #[test]
    fn merges_legacy_cursor_slots_without_replacing_newer_tauri_state() {
        let root = migration_test_root("cursor-migration");
        let legacy = root.join("legacy/state/positions.json");
        let current = root.join("current/state/positions.json");
        write_json_array(
            &legacy,
            &[
                json!({ "file": "/notes/a.md", "from": 10, "updatedAt": 10 }),
                json!({ "file": "/notes/b.md", "from": 20, "updatedAt": 20 }),
                json!({ "file": "/notes/c.md", "client": "left", "from": 50, "updatedAt": 50 }),
            ],
        )
        .unwrap();
        write_json_array(
            &current,
            &[
                json!({ "file": "/notes/a.md", "from": 30, "updatedAt": 30 }),
                json!({ "file": "/notes/c.md", "client": "left", "from": 40, "updatedAt": 40 }),
            ],
        )
        .unwrap();

        assert!(merge_legacy_cursor_positions(&legacy, &current).unwrap());
        let merged = read_json_array(&current).unwrap();
        assert_eq!(merged.len(), 3);
        assert_eq!(
            merged
                .iter()
                .find(|entry| entry["file"] == "/notes/a.md")
                .and_then(|entry| entry["from"].as_i64()),
            Some(30)
        );
        assert_eq!(
            merged
                .iter()
                .find(|entry| entry["file"] == "/notes/b.md")
                .and_then(|entry| entry["from"].as_i64()),
            Some(20)
        );
        assert_eq!(
            merged
                .iter()
                .find(|entry| entry["file"] == "/notes/c.md")
                .and_then(|entry| entry["from"].as_i64()),
            Some(50)
        );
        assert!(!merge_legacy_cursor_positions(&legacy, &current).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_missing_durable_state_without_overwriting_tauri_files() {
        let root = migration_test_root("durable-state-migration");
        let legacy = root.join("legacy");
        let current = root.join("current");
        fs::create_dir_all(legacy.join("state")).unwrap();
        fs::create_dir_all(current.join("state")).unwrap();
        fs::write(legacy.join("state/recent.json"), "legacy-recent").unwrap();
        fs::write(legacy.join("state/languagetool.json"), "legacy-language").unwrap();
        fs::write(legacy.join("plugins.json"), "legacy-plugins").unwrap();
        fs::write(current.join("state/languagetool.json"), "current-language").unwrap();

        migrate_legacy_desktop_state(&legacy, &current).unwrap();

        assert_eq!(
            fs::read_to_string(current.join("state/recent.json")).unwrap(),
            "legacy-recent"
        );
        assert_eq!(
            fs::read_to_string(current.join("state/languagetool.json")).unwrap(),
            "current-language"
        );
        assert_eq!(
            fs::read_to_string(current.join("plugins.json")).unwrap(),
            "legacy-plugins"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
