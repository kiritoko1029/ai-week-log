//! WeekLog 内置 MCP（Model Context Protocol）HTTP 服务，取代旧的 hook 本地 HTTP 入口。
//!
//! 各 AI agent（codex / claude code / zcode）通过内置 skill 在对话收尾时把「已清洗的对话」
//! （仅用户提问 + AI 回复）经 MCP `submit_conversation` 工具发回本服务；本服务用「小记总结
//! 模型」（cfg.noteSummary）将其总结成一条中文小记，写入统一待处理池（notes_pool），由用户在
//! 前端确认后再写入 notes/YYYY-MM-DD.md。
//!
//! 传输：rmcp `StreamableHttpService` 挂在 axum `/mcp`，仅绑 127.0.0.1，并加 Bearer token 中间件。

use std::sync::Mutex;

use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{self, Next},
    response::Response,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{session::local::LocalSessionManager, StreamableHttpService},
    ServerHandler,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::{config, llm, logger, notes_pool, secrets};

/// 钥匙串里 MCP Bearer token 的 provider 名。
const MCP_PROVIDER: &str = "weeklogMcp";
const DEFAULT_PORT: u16 = 17300;

// ── token / endpoint ──

/// 取已有 MCP token，没有则生成并存入钥匙串。
pub fn ensure_token() -> String {
    let mut token = secrets::get_key(MCP_PROVIDER);
    if token.is_empty() {
        token = crate::utils::random_token();
        let _ = secrets::set_key(MCP_PROVIDER, &token);
    }
    token
}

pub fn has_token() -> bool {
    secrets::has_key(MCP_PROVIDER)
}

fn valid_port(p: Option<i64>) -> u16 {
    match p {
        Some(n) if (1..=65535).contains(&n) => n as u16,
        _ => DEFAULT_PORT,
    }
}

/// 配置中期望的 MCP 端口。
pub fn configured_port(cfg: &Value) -> u16 {
    valid_port(cfg["mcp"]["port"].as_i64())
}

pub fn endpoint_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{}/mcp", port)
}

// ── 对话总结 ──

const SUBMIT_SYSTEM: &str = "你是一名研发工作小记整理助手。下面是一段开发者与 AI 编程助手的对话（已去除思考过程与工具调用，仅保留用户提问与 AI 回复）。\n请基于对话内容，提炼开发者本次实际完成或推进的工作，输出一条适合写入日报/周报素材的中文小记。\n要求：客观、简洁、书面化；聚焦真实完成事项与价值；不要罗列对话过程；不要编造未提供的信息；不要输出代码块。\n如果这段对话只是闲聊、纯咨询或没有任何实质开发工作，请只输出两个字：无。\n否则直接输出小记内容本身，不要标题、不要解释、不要项目名前缀、不要分点。";

/// 把结构化消息或整段文本拼成送给总结模型的对话原文。
fn conversation_text(args: &SubmitArgs) -> String {
    if let Some(msgs) = &args.messages {
        let mut lines: Vec<String> = vec![];
        for m in msgs {
            let text = m.text.as_deref().unwrap_or("").trim();
            if text.is_empty() {
                continue;
            }
            let role = m.role.as_deref().unwrap_or("").to_lowercase();
            let label = match role.as_str() {
                "user" | "human" => "用户",
                "assistant" | "ai" | "model" => "AI",
                "" => "对话",
                other => other,
            };
            lines.push(format!("{}：{}", label, text));
        }
        if !lines.is_empty() {
            return lines.join("\n\n");
        }
    }
    args.conversation.as_deref().unwrap_or("").trim().to_string()
}

// ── MCP 服务实现 ──

#[derive(Clone)]
pub struct WeeklogMcp {
    app: AppHandle,
    tool_router: ToolRouter<WeeklogMcp>,
}

/// `submit_conversation` 的入参（字段名 camelCase，匹配 skill 脚本发送的 JSON）。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubmitArgs {
    /// 已清洗的完整对话文本（与 messages 二选一；仅含用户提问与 AI 回复）。
    #[serde(default)]
    pub conversation: Option<String>,
    /// 结构化对话消息（role + text），与 conversation 二选一。
    #[serde(default)]
    pub messages: Option<Vec<ConvMsg>>,
    /// 会话工作目录（用于匹配项目）。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 显式项目名（留空则按 cwd 匹配 repos）。
    #[serde(default)]
    pub project: Option<String>,
    /// 当前 git 分支。
    #[serde(default)]
    pub branch: Option<String>,
    /// 本次改动的文件列表。
    #[serde(default)]
    pub changed_files: Option<Vec<String>>,
    /// 来源 agent：codex / claude / zcode。
    #[serde(default)]
    pub source: Option<String>,
    /// 会话标题或首条用户提问（可选）。
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConvMsg {
    /// 角色：user 或 assistant。
    #[serde(default)]
    pub role: Option<String>,
    /// 该条消息的纯文本（不含思考/工具调用）。
    #[serde(default)]
    pub text: Option<String>,
}

#[tool_router]
impl WeeklogMcp {
    pub fn new(app: AppHandle) -> Self {
        WeeklogMcp {
            app,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "提交一段开发者与 AI 的对话（仅用户提问与 AI 回复，不含思考与工具调用），WeekLog 会用配置的小记总结模型将其总结为一条中文工作小记，存入待处理池等待人工确认。请在一次实质性的开发对话收尾时调用。"
    )]
    async fn submit_conversation(
        &self,
        Parameters(args): Parameters<SubmitArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let convo = conversation_text(&args);
        if convo.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                json!({ "ok": false, "error": "对话内容为空，未生成小记" }).to_string(),
            )]));
        }

        let cfg = config::load_config(&self.app);
        let source = args
            .source
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("ai")
            .to_string();

        // 用「小记总结模型」总结；无 key 或失败则回退为原始对话（截断后入池），保证不丢素材。
        let summary_enabled = cfg["noteSummary"]["enabled"].as_bool().unwrap_or(true);
        let mut summary = String::new();
        let mut model_used = String::new();
        if summary_enabled {
            let resolved = secrets::resolve_note_summary_key(&cfg);
            if resolved.has {
                match llm::create_note_summary_provider(&cfg, &resolved.key) {
                    Ok(provider) => match provider.summarize(SUBMIT_SYSTEM, &convo).await {
                        Ok(r) => {
                            let trimmed = r.text.trim().to_string();
                            if trimmed.is_empty() || trimmed == "无" {
                                logger::write_log(
                                    &self.app,
                                    "info",
                                    "mcp.submit",
                                    "对话无实质开发内容，跳过小记",
                                    json!({ "source": source }),
                                );
                                return Ok(CallToolResult::success(vec![Content::text(
                                    json!({ "ok": true, "skipped": true, "reason": "无实质开发内容" }).to_string(),
                                )]));
                            }
                            summary = trimmed;
                            model_used = r.model;
                        }
                        Err(e) => {
                            logger::write_log(
                                &self.app,
                                "warn",
                                "mcp.submit",
                                &format!("小记总结失败，回退原始对话：{}", e.message()),
                                json!({ "source": source }),
                            );
                        }
                    },
                    Err(e) => {
                        logger::write_log(
                            &self.app,
                            "warn",
                            "mcp.submit",
                            &format!("构造小记总结模型失败：{}", e.message()),
                            json!({ "source": source }),
                        );
                    }
                }
            }
        }
        if summary.is_empty() {
            summary = convo;
        }

        let payload = json!({
            "source": source,
            "summary": summary,
            "cwd": args.cwd.unwrap_or_default(),
            "project": args.project.unwrap_or_default(),
            "branch": args.branch.unwrap_or_default(),
            "changedFiles": args.changed_files.unwrap_or_default(),
            "title": args.title.unwrap_or_default(),
        });

        match notes_pool::add_pending(&self.app, &payload, &cfg) {
            Ok(item) => {
                logger::write_log(
                    &self.app,
                    "info",
                    "mcp.submit",
                    "收到 AI 待处理小记",
                    json!({ "id": item["id"], "source": item["source"], "project": item["project"], "model": model_used }),
                );
                Ok(CallToolResult::success(vec![Content::text(
                    json!({
                        "ok": true,
                        "id": item["id"],
                        "summary": item["summary"],
                        "project": item["project"],
                    })
                    .to_string(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                json!({ "ok": false, "error": e }).to_string(),
            )])),
        }
    }
}

#[tool_handler]
impl ServerHandler for WeeklogMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2025_03_26,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "weeklog".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                title: Some("WeekLog".to_string()),
                website_url: None,
                icons: None,
            },
            instructions: Some(
                "WeekLog 工作小记服务。请在一次实质性的开发对话收尾时调用 submit_conversation，把本次对话（仅用户提问与 AI 回复）发回，WeekLog 会总结成中文工作小记。".to_string(),
            ),
        }
    }
}

// ── Bearer token 中间件 ──

async fn bearer_auth(token: String, req: Request, next: Next) -> Result<Response, StatusCode> {
    if token.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let provided = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")))
        .map(|s| s.trim())
        .unwrap_or("");
    if provided == token {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

// ── 服务生命周期 ──

struct Inner {
    running: bool,
    port: u16,
    error: String,
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct McpServer {
    inner: Mutex<Inner>,
}

impl Default for McpServer {
    fn default() -> Self {
        McpServer {
            inner: Mutex::new(Inner {
                running: false,
                port: 0,
                error: String::new(),
                shutdown: None,
            }),
        }
    }
}

impl McpServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前运行状态（含 endpoint / hasToken），供前端展示与一键安装读取。
    pub fn status_value(&self, app: &AppHandle) -> Value {
        let cfg = config::load_config(app);
        let enabled = cfg["mcp"]["enabled"].as_bool().unwrap_or(true);
        let g = self.inner.lock().unwrap();
        let port = if g.port > 0 { g.port } else { configured_port(&cfg) };
        json!({
            "enabled": enabled,
            "running": g.running,
            "host": "127.0.0.1",
            "port": port,
            "endpoint": endpoint_for_port(port),
            "hasToken": has_token(),
            "error": g.error,
        })
    }

    /// 按 cfg.mcp.enabled/port 启停。
    pub fn apply_config(&self, app: &AppHandle) -> Value {
        let cfg = config::load_config(app);
        let enabled = cfg["mcp"]["enabled"].as_bool().unwrap_or(true);
        if !enabled {
            self.stop();
            return self.status_value(app);
        }
        let desired = configured_port(&cfg);
        // 注意：必须先释放锁再调用 status_value（其内部同样会 lock inner）。
        // std::sync::Mutex 非重入，同线程重复加锁会死锁——保存设置时 MCP 通常已在
        // 运行且端口未变，正是会进入此分支的场景，曾导致 config_save 卡死、UI 无响应。
        let unchanged = {
            let g = self.inner.lock().unwrap();
            g.running && g.port == desired
        };
        if unchanged {
            return self.status_value(app);
        }
        self.stop();
        self.start(app, desired);
        self.status_value(app)
    }

    fn start(&self, app: &AppHandle, port: u16) {
        let std_listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(e) => {
                let mut g = self.inner.lock().unwrap();
                g.running = false;
                g.port = 0;
                g.error = format!("MCP 服务启动失败：{}", e);
                logger::write_log(app, "error", "mcp", &g.error, json!({ "port": port }));
                return;
            }
        };
        if let Err(e) = std_listener.set_nonblocking(true) {
            let mut g = self.inner.lock().unwrap();
            g.running = false;
            g.port = 0;
            g.error = format!("MCP 监听设置失败：{}", e);
            return;
        }
        let token = ensure_token();
        let (tx, rx) = oneshot::channel::<()>();
        let app_for_service = app.clone();
        let app_for_log = app.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    logger::write_log(
                        &app_for_log,
                        "error",
                        "mcp",
                        &format!("MCP 监听转换失败：{}", e),
                        json!({ "port": port }),
                    );
                    return;
                }
            };
            let service = StreamableHttpService::new(
                move || Ok(WeeklogMcp::new(app_for_service.clone())),
                LocalSessionManager::default().into(),
                Default::default(),
            );
            let router = axum::Router::new()
                .nest_service("/mcp", service)
                .layer(middleware::from_fn(move |req: Request, next: Next| {
                    bearer_auth(token.clone(), req, next)
                }));
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await;
        });
        let mut g = self.inner.lock().unwrap();
        g.running = true;
        g.port = port;
        g.error = String::new();
        g.shutdown = Some(tx);
        logger::write_log(app, "info", "mcp", "MCP 服务已启动", json!({ "port": port }));
    }

    pub fn stop(&self) {
        let tx = {
            let mut g = self.inner.lock().unwrap();
            g.running = false;
            g.port = 0;
            g.error = String::new();
            g.shutdown.take()
        };
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_text_from_messages_labels_roles() {
        let args = SubmitArgs {
            conversation: None,
            messages: Some(vec![
                ConvMsg { role: Some("user".into()), text: Some("帮我加个按钮".into()) },
                ConvMsg { role: Some("assistant".into()), text: Some("已添加按钮组件".into()) },
                ConvMsg { role: Some("assistant".into()), text: Some("   ".into()) },
            ]),
            cwd: None,
            project: None,
            branch: None,
            changed_files: None,
            source: None,
            title: None,
        };
        let text = conversation_text(&args);
        assert_eq!(text, "用户：帮我加个按钮\n\nAI：已添加按钮组件");
    }

    #[test]
    fn conversation_text_falls_back_to_raw() {
        let args = SubmitArgs {
            conversation: Some("  整段对话原文  ".into()),
            messages: None,
            cwd: None,
            project: None,
            branch: None,
            changed_files: None,
            source: None,
            title: None,
        };
        assert_eq!(conversation_text(&args), "整段对话原文");
    }

    #[test]
    fn configured_port_defaults_when_invalid() {
        assert_eq!(configured_port(&json!({ "mcp": { "port": 0 } })), DEFAULT_PORT);
        assert_eq!(configured_port(&json!({ "mcp": { "port": 18000 } })), 18000);
        assert_eq!(configured_port(&json!({})), DEFAULT_PORT);
    }

    #[test]
    fn endpoint_format() {
        assert_eq!(endpoint_for_port(17300), "http://127.0.0.1:17300/mcp");
    }
}
