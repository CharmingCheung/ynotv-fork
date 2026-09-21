use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "windows" {
        println!("cargo:rerun-if-env-changed=YNOTV_NATIVE_DASH_LIBMPV_DIR");
        let libmpv = std::env::var_os("YNOTV_NATIVE_DASH_LIBMPV_DIR")
            .map(PathBuf::from)
            .filter(|dir| dir.join("mpv.lib").is_file())
            .unwrap_or_else(|| manifest.join("libmpv"));
        if libmpv.join("mpv.lib").exists() {
            println!("cargo:rustc-link-search=native={}", libmpv.display());
            println!(
                "cargo:rerun-if-changed={}",
                libmpv.join("mpv.lib").display()
            );
        }
    }

    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    if target_os == "macos" {
        // Native DASH development may explicitly point at a patched libmpv.
        // This is a build-time search path only: embedding the developer's
        // absolute directory as an rpath makes the resulting app non-portable.
        println!("cargo:rerun-if-env-changed=YNOTV_NATIVE_DASH_LIBMPV_DIR");
        let native_dash_libmpv = std::env::var_os("YNOTV_NATIVE_DASH_LIBMPV_DIR")
            .map(PathBuf::from)
            .filter(|dir| dir.join("libmpv.2.dylib").is_file());
        if let Some(dir) = &native_dash_libmpv {
            println!("cargo:rustc-link-search=native={}", dir.display());
        }

        let mut prefixes: Vec<String> = Vec::new();
        if let Ok(p) = std::env::var("HOMEBREW_PREFIX") {
            if !p.is_empty() {
                prefixes.push(p);
            }
        }
        for p in ["/opt/homebrew", "/usr/local", "/opt/local"] {
            prefixes.push(p.to_string());
        }
        for prefix in &prefixes {
            for sub in ["lib", "opt/mpv/lib", "opt/libmpv/lib"] {
                let dir = std::path::Path::new(prefix).join(sub);
                if dir.exists() {
                    println!("cargo:rustc-link-search=native={}", dir.display());
                }
            }
        }
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks");
    }

    tauri_build::build()
}
