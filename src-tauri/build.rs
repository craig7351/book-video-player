fn main() {
    // 宣告自訂指令的 ACL；遠端網址（YouTube 等）呼叫自訂指令必須在 capability 授權
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["load_bookmarks", "save_bookmarks"]),
    ))
    .expect("failed to run tauri-build");
}
