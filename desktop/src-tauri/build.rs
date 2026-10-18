// The app's own commands get allow-/deny- permissions, so the window can only
// call those its capability lists (capabilities/default.json).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["api", "approve_report", "revoke_report", "archive_note", "score_column"])),
    )
    .expect("failed to run tauri-build")
}
