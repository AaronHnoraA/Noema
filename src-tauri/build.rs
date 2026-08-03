fn main() {
    const COMMANDS: &[&str] = &[
        "open_files",
        "close_window",
        "open_target",
        "update_window_state",
        "show_menu",
        "reveal_path",
        "open_path",
        "open_external",
        "choose_save_path",
        "read_clipboard",
        "choose_directory",
        "list_plugins",
        "set_plugin_enabled",
        "read_dropped_files",
        "broadcast_app_config",
        "desktop_smoke_report",
    ];

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to build Noema Tauri metadata");
}
