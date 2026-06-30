//! API Key / 密码加密存储：对齐 src/main/secrets.js 的语义。
//! Electron 用 safeStorage + secrets.json；Tauri 改用系统钥匙串（keyring crate）逐条目存储：
//! Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service。
//!
//! 注意：与 Electron 版 secrets.json 不互通，老用户迁移需重新填写 Key（后续可加导入逻辑）。

use keyring::Entry;
use serde_json::Value;

/// 钥匙串 service 名（对齐 tauri.conf.json identifier）。
const SERVICE: &str = "com.weeklog.desktop";

/// 允许的密钥 provider（对齐 ipc.js SECRET_PROVIDERS）。
const SECRET_PROVIDERS: [&str; 3] = ["openai", "anthropic", "webdav"];

/// 钥匙串后端是否可用。keyring 在 Windows/macOS/Linux(Secret Service) 通常可用；
/// 无法精确探测，保守返回 true（失败会在具体读写时反馈）。
pub fn is_available() -> bool {
    true
}

/// 规范化 provider：不在白名单则回退（对齐 ipc.js normalizeSecretProvider）。
pub fn normalize_provider(provider: &str, fallback: &str) -> String {
    let p = provider.trim();
    if SECRET_PROVIDERS.contains(&p) {
        p.to_string()
    } else {
        fallback.to_string()
    }
}

/// 读取某 provider 的 key（缺失返回空串）。
pub fn get_key(provider: &str) -> String {
    Entry::new(SERVICE, provider)
        .and_then(|e| e.get_password())
        .unwrap_or_default()
}

/// 是否已存某 provider 的 key。
pub fn has_key(provider: &str) -> bool {
    !get_key(provider).is_empty()
}

/// 设置 key；空值等价删除（对齐 secrets.js setKey）。
pub fn set_key(provider: &str, plain: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider).map_err(|e| e.to_string())?;
    if plain.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(plain).map_err(|e| e.to_string())
}

/// 删除 key（对齐 secrets.js clearKey）。
pub fn clear_key(provider: &str) -> Result<(), String> {
    if let Ok(entry) = Entry::new(SERVICE, provider) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// API Key 解析结果（对齐 config.js resolveApiKey）。
pub struct ResolvedKey {
    pub key: String,
    pub has: bool,
    pub env_name: String,
}

/// 解析指定 provider 的 API Key：可选先查 dedicated_slot（专用钥匙串槽，
/// 如「小记总结模型」的 `noteSummary`），再回退该 provider 的主 key（钥匙串 → 环境变量）。
pub fn resolve_key_for(provider: &str, dedicated_slot: Option<&str>) -> ResolvedKey {
    if let Some(slot) = dedicated_slot {
        let dedicated = get_key(slot);
        if !dedicated.is_empty() {
            return ResolvedKey {
                key: dedicated,
                has: true,
                env_name: "（软件内填写）".to_string(),
            };
        }
    }
    let stored = get_key(provider);
    if !stored.is_empty() {
        return ResolvedKey {
            key: stored,
            has: true,
            env_name: "（软件内填写）".to_string(),
        };
    }
    let candidates: [&str; 2] = if provider == "openai" {
        ["WEEKLOG_OPENAI_KEY", "OPENAI_API_KEY"]
    } else {
        ["WEEKLOG_ANTHROPIC_KEY", "ANTHROPIC_API_KEY"]
    };
    for name in candidates {
        if let Ok(v) = std::env::var(name) {
            if !v.trim().is_empty() {
                return ResolvedKey {
                    key: v.trim().to_string(),
                    has: true,
                    env_name: name.to_string(),
                };
            }
        }
    }
    ResolvedKey {
        key: String::new(),
        has: false,
        env_name: candidates[1].to_string(),
    }
}

/// 解析当前主 AI provider 的 API Key：优先钥匙串，回退环境变量（对齐 config.js resolveApiKey）。
pub fn resolve_api_key(cfg: &Value) -> ResolvedKey {
    let provider = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
    resolve_key_for(provider, None)
}

/// 「小记总结模型」provider 名：noteSummary.provider 非空则用之，否则回退主 AI provider。
pub fn note_summary_provider(cfg: &Value) -> String {
    let ns = cfg["noteSummary"]["provider"].as_str().unwrap_or("").trim();
    if !ns.is_empty() {
        ns.to_string()
    } else {
        cfg["ai"]["provider"].as_str().unwrap_or("anthropic").to_string()
    }
}

/// 解析「小记总结模型」的 API Key：先查专用槽 `noteSummary`，再回退对应 provider 的主 key/env。
pub fn resolve_note_summary_key(cfg: &Value) -> ResolvedKey {
    let provider = note_summary_provider(cfg);
    resolve_key_for(&provider, Some("noteSummary"))
}

/// 当前 provider 的 key 是否就绪（对齐 config.js apiKeyStatus）。
pub fn api_key_status(cfg: &Value) -> bool {
    resolve_api_key(cfg).has
}
