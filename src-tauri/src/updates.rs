//! 自动更新（移植 src/main/updater.js 的手动 GitHub 路径，跨平台统一）。
//!
//! Electron：Windows 用 electron-updater（Squirrel 静默安装）、macOS 手动（GitHub API +
//! 下载 dmg + detached 替换脚本）。Tauri 这里**统一走手动流程**：GitHub API 查最新版 →
//! reqwest 下载安装包到下载目录（带进度）→ 打开安装包由 OS 运行（.exe 安装器 / 挂载 .dmg）。
//!
//! 与 Electron 的差异（已知局限）：
//! - 不依赖 tauri-plugin-updater + minisign 签名，也不消费 electron-updater 的 latest.yml；
//!   直接用 GitHub Releases 资产，无需签名密钥。
//! - 不做静默自动安装：install 打开安装器交由用户完成；mac 的 detached 替换脚本未移植。

use std::io::Write;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::utils;

const GITHUB_OWNER: &str = "kiritoko1029";
const GITHUB_REPO: &str = "ai-week-log";

pub struct UpdaterState {
    phase: String,
    latest_version: String,
    release_name: String,
    release_notes: String,
    error: String,
    progress: Option<Value>,
    pending_url: String,
    downloaded_path: String,
    updated_at: u128,
}

impl Default for UpdaterState {
    fn default() -> Self {
        UpdaterState {
            phase: "idle".to_string(),
            latest_version: String::new(),
            release_name: String::new(),
            release_notes: String::new(),
            error: String::new(),
            progress: None,
            pending_url: String::new(),
            downloaded_path: String::new(),
            updated_at: 0,
        }
    }
}

/// 是否为打包版本（release 构建）。dev（debug）下自动更新禁用，对齐 Electron isPackaged。
fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// semver 比较（仅 x.y.z，忽略预发布标签），对齐 compareVersions。
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> [u64; 3] {
        let clean = v.split(|c| c == '+' || c == '-').next().unwrap_or("");
        let mut out = [0u64; 3];
        for (i, part) in clean.split('.').take(3).enumerate() {
            out[i] = part.trim().parse().unwrap_or(0);
        }
        out
    };
    parse(a).cmp(&parse(b))
}

/// 从 Release 资产挑当前平台/架构的安装包。返回 (name, download_url)。
fn pick_asset(assets: &[Value]) -> Option<(String, String)> {
    let names: Vec<(&str, &str)> = assets
        .iter()
        .filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?)))
        .collect();

    #[cfg(target_os = "windows")]
    {
        // NSIS .exe 优先（排除 .blockmap），其次 .msi
        if let Some((n, u)) = names.iter().find(|(n, _)| {
            let l = n.to_lowercase();
            l.ends_with(".exe")
        }) {
            return Some((n.to_string(), u.to_string()));
        }
        return names
            .iter()
            .find(|(n, _)| n.to_lowercase().ends_with(".msi"))
            .map(|(n, u)| (n.to_string(), u.to_string()));
    }

    #[cfg(target_os = "macos")]
    {
        let dmgs: Vec<&(&str, &str)> = names
            .iter()
            .filter(|(n, _)| n.to_lowercase().ends_with(".dmg"))
            .collect();
        let arm = cfg!(target_arch = "aarch64");
        let arch_match = dmgs.iter().find(|(n, _)| {
            let l = n.to_lowercase();
            if arm {
                l.contains("arm64") || l.contains("aarch64")
            } else {
                l.contains("x64") || l.contains("x86_64") || l.contains("amd64")
            }
        });
        if let Some((n, u)) = arch_match {
            return Some((n.to_string(), u.to_string()));
        }
        return dmgs.first().map(|(n, u)| (n.to_string(), u.to_string()));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = names;
        None
    }
}

fn snapshot(app: &AppHandle, st: &Mutex<UpdaterState>) -> Value {
    let s = st.lock().unwrap();
    let packaged = is_packaged();
    let mut phase = if s.phase.is_empty() { "idle".to_string() } else { s.phase.clone() };
    let mut error = s.error.clone();
    if !packaged && phase == "idle" {
        phase = "disabled".to_string();
        if error.is_empty() {
            error = "自动更新仅在安装包版本中可用".to_string();
        }
    }
    let can_check = packaged && phase != "checking" && phase != "downloading";
    let can_download = packaged && phase == "available" && !s.pending_url.is_empty();
    let can_install = packaged && phase == "downloaded" && !s.downloaded_path.is_empty();
    json!({
        "phase": phase,
        "currentVersion": current_version(app),
        "latestVersion": s.latest_version,
        "releaseName": s.release_name,
        "releaseNotes": s.release_notes,
        "progress": s.progress.clone(),
        "error": error,
        "isPackaged": packaged,
        "updatedAt": s.updated_at as u64,
        "canCheck": can_check,
        "canDownload": can_download,
        "canInstall": can_install,
    })
}

fn patch<F: FnOnce(&mut UpdaterState)>(app: &AppHandle, st: &Mutex<UpdaterState>, f: F) -> Value {
    {
        let mut s = st.lock().unwrap();
        f(&mut s);
        s.updated_at = utils::now_ms();
    }
    let snap = snapshot(app, st);
    let _ = app.emit("updates:update", json!({ "type": "status", "status": snap.clone() }));
    snap
}

pub fn status(app: &AppHandle, st: &Mutex<UpdaterState>) -> Value {
    snapshot(app, st)
}

pub async fn check(app: &AppHandle, st: &Mutex<UpdaterState>) -> Value {
    if !is_packaged() {
        return patch(app, st, |s| {
            s.phase = "disabled".to_string();
            s.error = "自动更新仅在安装包版本中可用".to_string();
        });
    }
    {
        let s = st.lock().unwrap();
        if s.phase == "checking" || s.phase == "downloading" {
            return snapshot(app, st);
        }
    }
    patch(app, st, |s| {
        s.phase = "checking".to_string();
        s.error.clear();
        s.progress = None;
    });

    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        GITHUB_OWNER, GITHUB_REPO
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "weeklog-updater")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await;
    let rel: Value = match resp {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                return patch(app, st, |s| {
                    s.phase = "error".to_string();
                    s.error = format!("检查更新失败：{}", e);
                })
            }
        },
        Ok(r) => {
            let code = r.status().as_u16();
            return patch(app, st, |s| {
                s.phase = "error".to_string();
                s.error = format!("检查更新失败：HTTP {}", code);
            });
        }
        Err(e) => {
            return patch(app, st, |s| {
                s.phase = "error".to_string();
                s.error = format!("检查更新失败：{}", e);
            });
        }
    };

    let latest = rel["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    let release_name = rel["name"].as_str().unwrap_or("").to_string();
    let release_notes = rel["body"].as_str().unwrap_or("").to_string();
    let asset = rel["assets"].as_array().and_then(|a| pick_asset(a));
    let current = current_version(app);

    if latest.is_empty() {
        return patch(app, st, |s| {
            s.phase = "error".to_string();
            s.error = "未能解析最新版本号".to_string();
        });
    }
    let up_to_date = compare_versions(&latest, &current) != std::cmp::Ordering::Greater;
    patch(app, st, |s| {
        s.latest_version = latest.clone();
        s.release_name = release_name.clone();
        s.release_notes = release_notes.clone();
        s.pending_url = asset.as_ref().map(|(_, u)| u.clone()).unwrap_or_default();
        s.progress = None;
        if up_to_date {
            s.phase = "not-available".to_string();
            s.error.clear();
        } else if asset.is_none() {
            s.phase = "available".to_string();
            s.error = "未找到适用于本平台的安装包，请到 Release 页手动下载".to_string();
        } else {
            s.phase = "available".to_string();
            s.error.clear();
        }
    })
}

pub async fn download(app: &AppHandle, st: &Mutex<UpdaterState>) -> Value {
    if !is_packaged() {
        return snapshot(app, st);
    }
    let url = {
        let s = st.lock().unwrap();
        if s.phase != "available" || s.pending_url.is_empty() {
            String::new()
        } else {
            s.pending_url.clone()
        }
    };
    if url.is_empty() {
        return patch(app, st, |s| {
            s.phase = "error".to_string();
            s.error = "没有可下载的更新，请先检查更新".to_string();
        });
    }

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_config_dir())
        .unwrap_or_default();
    let name = url.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("weeklog-update");
    let dest = dir.join(name);

    patch(app, st, |s| {
        s.phase = "downloading".to_string();
        s.error.clear();
        s.progress = Some(json!({ "percent": 0 }));
    });

    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "weeklog-updater")
        .send()
        .await;
    let mut resp = match resp {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let code = r.status().as_u16();
            return patch(app, st, |s| {
                s.phase = "error".to_string();
                s.error = format!("下载失败：HTTP {}", code);
            });
        }
        Err(e) => {
            return patch(app, st, |s| {
                s.phase = "error".to_string();
                s.error = format!("下载失败：{}", e);
            });
        }
    };

    let total = resp.content_length().unwrap_or(0);
    let mut file = match std::fs::File::create(&dest) {
        Ok(f) => f,
        Err(e) => {
            return patch(app, st, |s| {
                s.phase = "error".to_string();
                s.error = format!("下载失败：无法创建文件 {}", e);
            })
        }
    };
    let mut received: u64 = 0;
    let mut last_percent: i64 = -1;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk) {
                    let _ = std::fs::remove_file(&dest);
                    return patch(app, st, |s| {
                        s.phase = "error".to_string();
                        s.error = format!("下载失败：写入错误 {}", e);
                    });
                }
                received += chunk.len() as u64;
                let percent = if total > 0 {
                    ((received * 100) / total) as i64
                } else {
                    0
                };
                if percent != last_percent {
                    last_percent = percent;
                    patch(app, st, |s| {
                        s.progress = Some(json!({
                            "percent": percent,
                            "transferred": received,
                            "total": total,
                            "bytesPerSecond": 0,
                        }));
                    });
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = std::fs::remove_file(&dest);
                return patch(app, st, |s| {
                    s.phase = "error".to_string();
                    s.error = format!("下载失败：{}", e);
                });
            }
        }
    }
    let dest_str = dest.to_string_lossy().to_string();
    patch(app, st, |s| {
        s.downloaded_path = dest_str;
        s.phase = "downloaded".to_string();
        s.error.clear();
        s.progress = Some(json!({ "percent": 100 }));
    })
}

pub fn install(app: &AppHandle, st: &Mutex<UpdaterState>) -> Value {
    if !is_packaged() {
        return snapshot(app, st);
    }
    let path = {
        let s = st.lock().unwrap();
        s.downloaded_path.clone()
    };
    if path.is_empty() || !std::path::Path::new(&path).exists() {
        return patch(app, st, |s| {
            s.phase = "error".to_string();
            s.error = "更新尚未下载完成".to_string();
        });
    }
    // 打开安装包：OS 运行 .exe 安装器 / 挂载 .dmg。用户完成安装。
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new(&path).spawn().map(|_| ()).map_err(|e| e.to_string());
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string());
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result: Result<(), String> = Err("当前平台不支持自动安装".to_string());

    if let Err(e) = result {
        return patch(app, st, |s| {
            s.error = format!("启动安装失败：{}", e);
        });
    }
    snapshot(app, st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn compare_versions_semver() {
        assert_eq!(compare_versions("1.3.9", "1.3.8"), Ordering::Greater);
        assert_eq!(compare_versions("1.3.8", "1.3.8"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.0", "1.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.3.8-beta", "1.3.8"), Ordering::Equal); // 忽略预发布
    }
}
