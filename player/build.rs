fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["set_pinned", "quit_player", "set_on_top"])),
    )
    .expect("failed to run tauri build script");
}
