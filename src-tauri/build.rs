fn main() {
    let standalone = std::path::Path::new("../.next/standalone");
    if !standalone.exists() {
        let _ = std::fs::create_dir_all(standalone);
    }
    tauri_build::build()
}
