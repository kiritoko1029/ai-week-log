fn main() {
    add_macos_clang_runtime_search_path();
    // 由 tauri-build 注入构建时代码生成（capability 校验、icon 校验等）
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn add_macos_clang_runtime_search_path() {
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=SDKROOT");

    let output = std::process::Command::new("xcrun")
        .args(["clang", "-print-resource-dir"])
        .output()
        .or_else(|_| {
            std::process::Command::new("clang")
                .arg("-print-resource-dir")
                .output()
        });

    let Ok(output) = output else { return };
    if !output.status.success() {
        return;
    }

    let resource_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if resource_dir.is_empty() {
        return;
    }

    let darwin_runtime_dir = std::path::Path::new(&resource_dir).join("lib/darwin");
    if darwin_runtime_dir.exists() {
        println!(
            "cargo:rustc-link-search=native={}",
            darwin_runtime_dir.display()
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn add_macos_clang_runtime_search_path() {}
