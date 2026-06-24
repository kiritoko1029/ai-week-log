//! LLM 抽象层：对齐 src/main/llm/{base,openai,anthropic,index,stream}.js。
//! 用 reqwest 发请求，统一异常体系 + 指数退避重试。
//! 上层依赖 summarize(system, user) 与 stream_chat（SSE 流式多轮对话）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::utils;

const ANTHROPIC_VERSION: &str = "2023-06-01";

/// LLM 异常（对齐 base.js 的异常体系；429/5xx/超时可重试，其余不可）。
#[derive(Debug)]
pub enum LlmError {
    Timeout,
    RateLimited(String),
    ServerError(String),
    Auth(String),
    BadRequest(String),
    Aborted(String),
    Other(String),
}

impl LlmError {
    fn retriable(&self) -> bool {
        matches!(
            self,
            LlmError::RateLimited(_) | LlmError::ServerError(_) | LlmError::Timeout
        )
    }

    /// 友好错误文案（前端展示用）。
    pub fn message(&self) -> String {
        match self {
            LlmError::Timeout => "请求超时".to_string(),
            LlmError::RateLimited(m)
            | LlmError::ServerError(m)
            | LlmError::Auth(m)
            | LlmError::BadRequest(m)
            | LlmError::Aborted(m)
            | LlmError::Other(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

/// 截断长文本（对齐 base.js snippet）。
fn snippet(text: &str, n: usize) -> String {
    if text.chars().count() > n {
        format!("{}…", text.chars().take(n).collect::<String>())
    } else {
        text.to_string()
    }
}

/// HTTP 状态码 → 统一异常（对齐 base.js errorForStatus）。
fn error_for_status(status: u16, text: &str) -> LlmError {
    let msg = snippet(text, 200);
    match status {
        401 | 403 => LlmError::Auth(format!("鉴权失败 {status}：{msg}")),
        400 => LlmError::BadRequest(format!("请求错误 400：{msg}")),
        429 => LlmError::RateLimited(format!("429 限流：{msg}")),
        s if s >= 500 => LlmError::ServerError(format!("{status} 服务端错误：{msg}")),
        _ => LlmError::Other(format!("未预期状态码 {status}：{msg}")),
    }
}

/// 0–800ms 抖动（对齐 base.js 退避的 Math.random()*800）。
fn jitter_ms() -> u64 {
    (utils::now_ms() % 800) as u64
}

/// 带重试的 POST（对齐 base.js requestWithRetry）。
async fn request_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, String)],
    body: &Value,
    timeout: u64,
    retries: u32,
) -> Result<Value, LlmError> {
    let mut last_err = LlmError::Other("请求失败".to_string());
    for attempt in 0..=retries {
        let mut req = client
            .post(url)
            .timeout(Duration::from_secs(timeout))
            .json(body);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                let data: Value =
                    serde_json::from_str(&text).unwrap_or_else(|_| json!({ "_raw": text }));
                if (200..300).contains(&status) {
                    return Ok(data);
                }
                let err = error_for_status(status, &text);
                if err.retriable() {
                    last_err = err;
                } else {
                    return Err(err);
                }
            }
            Err(e) => {
                if e.is_timeout() {
                    last_err = LlmError::Timeout;
                } else {
                    last_err = LlmError::ServerError(format!("网络错误：{e}"));
                }
            }
        }
        if attempt < retries {
            let backoff = 2u64.saturating_pow(attempt).min(30) * 1000 + jitter_ms();
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
    }
    Err(last_err)
}

/// 总结结果（对齐 provider.summarize 返回值）。也用作 stream_chat 的最终聚合结果。
pub struct SummarizeResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub model: String,
}

/// 流式增量块（经 channel 推给上层做累积 + 前端推送）。
pub enum StreamChunk {
    Delta(String),
    Thinking(String),
}

/// 流式选项（对齐 streamChat opts）。
pub struct StreamOpts {
    pub signal: Arc<AtomicBool>,
    pub max_tokens: Option<u64>,
    pub thinking: bool,
}

/// 解析 SSE 文本缓冲为事件帧（对齐 stream.js parseSSEFrames）。返回 (events, 尾部半帧)。
/// 帧以空行分隔；一帧内多行 data: 用 \n 连接；忽略注释(:)与心跳。
pub fn parse_sse_frames(buffer: &str) -> (Vec<(String, String)>, String) {
    let normalized = buffer.replace("\r\n", "\n");
    let mut blocks: Vec<&str> = normalized.split("\n\n").collect();
    let rest = blocks.pop().unwrap_or("").to_string();
    let mut events = Vec::new();
    for block in blocks {
        if block.trim().is_empty() {
            continue;
        }
        let mut event = String::new();
        let mut data_lines: Vec<String> = Vec::new();
        for line in block.split('\n') {
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(r) = line.strip_prefix("event:") {
                event = r.trim().to_string();
            } else if let Some(r) = line.strip_prefix("data:") {
                data_lines.push(r.strip_prefix(' ').unwrap_or(r).to_string());
            }
        }
        if data_lines.is_empty() {
            continue;
        }
        events.push((event, data_lines.join("\n")));
    }
    (events, rest)
}

enum ProviderKind {
    OpenAI,
    Anthropic,
}

/// 厂商无关的 provider（对齐 llm/index.js createProvider 返回值）。
pub struct Provider {
    kind: ProviderKind,
    client: reqwest::Client,
    base: String,
    api_key: String,
    pub model: String,
    temperature: f64,
    max_tokens: u64,
    timeout_seconds: u64,
    retries: u32,
}

/// 从配置构造 provider（对齐 llm/index.js createProvider）。
pub fn create_provider(cfg: &Value, api_key: &str) -> Result<Provider, LlmError> {
    let provider = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
    let sub = &cfg["ai"][provider];
    if sub.is_null() {
        return Err(LlmError::Other(format!("未配置 provider：{provider}")));
    }
    if api_key.is_empty() {
        return Err(LlmError::Other(format!("未设置 {provider} 的 API Key（请配置环境变量）")));
    }
    let kind = match provider {
        "openai" => ProviderKind::OpenAI,
        "anthropic" => ProviderKind::Anthropic,
        other => return Err(LlmError::Other(format!("未知 provider：{other}"))),
    };
    let raw_base = sub["baseUrl"].as_str().unwrap_or("").trim().to_string();
    let default_base = match kind {
        ProviderKind::OpenAI => "https://api.openai.com/v1",
        ProviderKind::Anthropic => "https://api.anthropic.com",
    };
    let base = if raw_base.is_empty() {
        default_base.to_string()
    } else {
        raw_base.trim_end_matches('/').to_string()
    };
    Ok(Provider {
        kind,
        client: reqwest::Client::new(),
        base,
        api_key: api_key.to_string(),
        model: sub["model"].as_str().unwrap_or("").to_string(),
        temperature: sub["temperature"].as_f64().unwrap_or(0.3),
        max_tokens: sub["maxTokens"].as_u64().unwrap_or(800),
        timeout_seconds: cfg["ai"]["timeoutSeconds"].as_u64().unwrap_or(60),
        retries: cfg["ai"]["retries"].as_u64().unwrap_or(3) as u32,
    })
}

impl Provider {
    /// 一次性总结（对齐 OpenAIProvider/AnthropicProvider.summarize）。
    pub async fn summarize(&self, system: &str, user: &str) -> Result<SummarizeResult, LlmError> {
        match self.kind {
            ProviderKind::OpenAI => self.summarize_openai(system, user).await,
            ProviderKind::Anthropic => self.summarize_anthropic(system, user).await,
        }
    }

    async fn summarize_openai(&self, system: &str, user: &str) -> Result<SummarizeResult, LlmError> {
        let url = format!("{}/responses", self.base);
        let headers = [("Authorization", format!("Bearer {}", self.api_key))];
        let body = json!({
            "model": self.model,
            "instructions": system,
            "input": user,
            "max_output_tokens": self.max_tokens,
            "temperature": self.temperature,
        });
        let data = request_with_retry(
            &self.client,
            &url,
            &headers,
            &body,
            self.timeout_seconds,
            self.retries,
        )
        .await?;
        let text = parse_openai(&data)?;
        Ok(SummarizeResult {
            text,
            input_tokens: data["usage"]["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: data["usage"]["output_tokens"].as_u64().unwrap_or(0),
            model: data["model"].as_str().unwrap_or(&self.model).to_string(),
        })
    }

    async fn summarize_anthropic(
        &self,
        system: &str,
        user: &str,
    ) -> Result<SummarizeResult, LlmError> {
        let url = format!("{}/v1/messages", self.base);
        let headers = [
            ("x-api-key", self.api_key.clone()),
            ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ];
        let body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
            "temperature": self.temperature,
        });
        let data = request_with_retry(
            &self.client,
            &url,
            &headers,
            &body,
            self.timeout_seconds,
            self.retries,
        )
        .await?;
        let mut parts = String::new();
        if let Some(arr) = data["content"].as_array() {
            for b in arr {
                if b["type"] == "text" {
                    parts.push_str(b["text"].as_str().unwrap_or(""));
                }
            }
        }
        let t = parts.trim();
        if t.is_empty() {
            return Err(LlmError::Other("Anthropic 响应未解析到文本".to_string()));
        }
        Ok(SummarizeResult {
            text: t.to_string(),
            input_tokens: data["usage"]["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: data["usage"]["output_tokens"].as_u64().unwrap_or(0),
            model: data["model"].as_str().unwrap_or(&self.model).to_string(),
        })
    }

    /// 流式多轮对话（对齐 {openai,anthropic}.js streamChat）。增量经 tx 推送，返回最终聚合结果。
    pub async fn stream_chat(
        &self,
        system: &str,
        messages: &[Value],
        opts: &StreamOpts,
        tx: tokio::sync::mpsc::UnboundedSender<StreamChunk>,
    ) -> Result<SummarizeResult, LlmError> {
        match self.kind {
            ProviderKind::OpenAI => self.stream_openai(system, messages, opts, &tx).await,
            ProviderKind::Anthropic => self.stream_anthropic(system, messages, opts, &tx).await,
        }
    }

    async fn stream_openai(
        &self,
        system: &str,
        messages: &[Value],
        opts: &StreamOpts,
        tx: &tokio::sync::mpsc::UnboundedSender<StreamChunk>,
    ) -> Result<SummarizeResult, LlmError> {
        let url = format!("{}/responses", self.base);
        let headers = [("Authorization", format!("Bearer {}", self.api_key))];
        let make_body = |with_reasoning: bool| {
            let mut b = json!({
                "model": self.model,
                "instructions": system,
                "input": messages,
                "max_output_tokens": opts.max_tokens.unwrap_or(self.max_tokens),
                "temperature": self.temperature,
            });
            if with_reasoning {
                b["reasoning"] = json!({ "summary": "auto" });
            }
            b
        };
        // thinking=true 先试 reasoning；非推理模型返回 400 → 降级为普通流式重试一次
        if opts.thinking {
            match self
                .run_openai_once(&url, &headers, make_body(true), &opts.signal, tx)
                .await
            {
                Err(LlmError::BadRequest(_)) => {
                    self.run_openai_once(&url, &headers, make_body(false), &opts.signal, tx)
                        .await
                }
                other => other,
            }
        } else {
            self.run_openai_once(&url, &headers, make_body(false), &opts.signal, tx)
                .await
        }
    }

    async fn run_openai_once(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Value,
        signal: &Arc<AtomicBool>,
        tx: &tokio::sync::mpsc::UnboundedSender<StreamChunk>,
    ) -> Result<SummarizeResult, LlmError> {
        let mut text = String::new();
        let mut input_tokens = 0u64;
        let mut output_tokens = 0u64;
        let mut model = self.model.clone();
        let handler = |event: &str, d: &Value| -> Result<(), LlmError> {
            let ty = if !event.is_empty() {
                event
            } else {
                d["type"].as_str().unwrap_or("")
            };
            match ty {
                "response.output_text.delta" => {
                    if let Some(piece) = d["delta"].as_str() {
                        if !piece.is_empty() {
                            text.push_str(piece);
                            let _ = tx.send(StreamChunk::Delta(piece.to_string()));
                        }
                    }
                }
                "response.reasoning_summary_text.delta" => {
                    if let Some(piece) = d["delta"].as_str() {
                        if !piece.is_empty() {
                            let _ = tx.send(StreamChunk::Thinking(piece.to_string()));
                        }
                    }
                }
                "response.completed" | "response.incomplete" => {
                    let u = &d["response"]["usage"];
                    if let Some(v) = u["input_tokens"].as_u64() {
                        input_tokens = v;
                    }
                    if let Some(v) = u["output_tokens"].as_u64() {
                        output_tokens = v;
                    }
                    if let Some(m) = d["response"]["model"].as_str() {
                        model = m.to_string();
                    }
                }
                "response.failed" | "error" => {
                    let msg = d["response"]["error"]["message"]
                        .as_str()
                        .or_else(|| d["message"].as_str())
                        .unwrap_or("OpenAI 流式错误");
                    return Err(LlmError::Other(msg.to_string()));
                }
                _ => {}
            }
            Ok(())
        };
        self.stream_request(url, headers, &body, signal, handler).await?;
        let t = text.trim();
        if t.is_empty() {
            return Err(LlmError::Other("OpenAI 流式未返回文本".to_string()));
        }
        Ok(SummarizeResult {
            text: t.to_string(),
            input_tokens,
            output_tokens,
            model,
        })
    }

    async fn stream_anthropic(
        &self,
        system: &str,
        messages: &[Value],
        opts: &StreamOpts,
        tx: &tokio::sync::mpsc::UnboundedSender<StreamChunk>,
    ) -> Result<SummarizeResult, LlmError> {
        let url = format!("{}/v1/messages", self.base);
        let headers = [
            ("x-api-key", self.api_key.clone()),
            ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ];
        let budget = 1500u64;
        let max_out = opts.max_tokens.unwrap_or(self.max_tokens);
        let mut body = json!({
            "model": self.model,
            "max_tokens": if opts.thinking { max_out.max(budget + 1024) } else { max_out },
            "system": system,
            "messages": messages,
            "temperature": if opts.thinking { 1.0 } else { self.temperature },
        });
        if opts.thinking {
            body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
        }
        let mut text = String::new();
        let mut input_tokens = 0u64;
        let mut output_tokens = 0u64;
        let mut model = self.model.clone();
        let handler = |event: &str, d: &Value| -> Result<(), LlmError> {
            let ty = if !event.is_empty() {
                event
            } else {
                d["type"].as_str().unwrap_or("")
            };
            match ty {
                "message_start" => {
                    if let Some(v) = d["message"]["usage"]["input_tokens"].as_u64() {
                        input_tokens = v;
                    }
                    if let Some(m) = d["message"]["model"].as_str() {
                        model = m.to_string();
                    }
                }
                "content_block_delta" => {
                    let delta = &d["delta"];
                    match delta["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            if let Some(piece) = delta["text"].as_str() {
                                if !piece.is_empty() {
                                    text.push_str(piece);
                                    let _ = tx.send(StreamChunk::Delta(piece.to_string()));
                                }
                            }
                        }
                        "thinking_delta" => {
                            if let Some(piece) = delta["thinking"].as_str() {
                                if !piece.is_empty() {
                                    let _ = tx.send(StreamChunk::Thinking(piece.to_string()));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    if let Some(v) = d["usage"]["output_tokens"].as_u64() {
                        output_tokens = v;
                    }
                }
                "error" => {
                    let msg = d["error"]["message"].as_str().unwrap_or("Anthropic 流式错误");
                    return Err(LlmError::Other(msg.to_string()));
                }
                _ => {}
            }
            Ok(())
        };
        self.stream_request(&url, &headers, &body, &opts.signal, handler)
            .await?;
        let t = text.trim();
        if t.is_empty() {
            return Err(LlmError::Other("Anthropic 流式未返回文本".to_string()));
        }
        Ok(SummarizeResult {
            text: t.to_string(),
            input_tokens,
            output_tokens,
            model,
        })
    }

    /// 流式 POST 传输：连接非 2xx 直接抛（不重试），逐块解析 SSE 帧交 handler。
    /// 每块重置空闲超时；signal 置位则中止（对齐 stream.js streamSSE）。
    async fn stream_request(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: &Value,
        signal: &Arc<AtomicBool>,
        mut handle_event: impl FnMut(&str, &Value) -> Result<(), LlmError>,
    ) -> Result<(), LlmError> {
        // 对齐 JS streamSSE：自动补 stream:true，否则 API 返回普通 JSON 而非 SSE 流
        let mut body = body.clone();
        body["stream"] = json!(true);
        let mut req = self.client.post(url).json(&body);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(if e.is_timeout() {
                    LlmError::Timeout
                } else {
                    LlmError::ServerError(format!("网络错误：{e}"))
                })
            }
        };
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(error_for_status(status, &text));
        }
        let mut buffer = String::new();
        loop {
            if signal.load(Ordering::Relaxed) {
                return Err(LlmError::Aborted("已取消".to_string()));
            }
            let chunk = match tokio::time::timeout(
                Duration::from_secs(self.timeout_seconds),
                resp.chunk(),
            )
            .await
            {
                Err(_) => return Err(LlmError::Timeout),
                Ok(Ok(Some(b))) => b,
                Ok(Ok(None)) => break,
                Ok(Err(e)) => return Err(LlmError::ServerError(format!("网络错误：{e}"))),
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            let (events, rest) = parse_sse_frames(&buffer);
            buffer = rest;
            for (event, data) in events {
                if let Ok(d) = serde_json::from_str::<Value>(&data) {
                    handle_event(&event, &d)?;
                }
            }
        }
        // flush 尾帧（某些服务端最后一帧不带空行结尾）
        let (events, _) = parse_sse_frames(&format!("{buffer}\n\n"));
        for (event, data) in events {
            if let Ok(d) = serde_json::from_str::<Value>(&data) {
                handle_event(&event, &d)?;
            }
        }
        Ok(())
    }
}

/// 解析 OpenAI Responses 响应文本（对齐 openai.js parseOpenAI）。
fn parse_openai(data: &Value) -> Result<String, LlmError> {
    if let Some(agg) = data["output_text"].as_str() {
        if !agg.trim().is_empty() {
            return Ok(agg.trim().to_string());
        }
    }
    let mut parts = String::new();
    if let Some(output) = data["output"].as_array() {
        for item in output {
            if item["type"] != "message" {
                continue; // 跳过 reasoning 等非消息块
            }
            if let Some(content) = item["content"].as_array() {
                for b in content {
                    if b["type"] == "output_text" {
                        parts.push_str(b["text"].as_str().unwrap_or(""));
                    }
                }
            }
        }
    }
    let t = parts.trim();
    if t.is_empty() {
        return Err(LlmError::Other("OpenAI 响应未解析到文本".to_string()));
    }
    Ok(t.to_string())
}

/// 测试 AI 连接（对齐 llm/index.js testProvider）。返回 AiTestResult 形状的 JSON，不抛异常。
pub async fn test_provider(cfg: &Value, api_key: &str) -> Value {
    let t0 = utils::now_ms();
    // 压低开销：timeout 15s、retries 0、maxTokens 16
    let mut test_cfg = cfg.clone();
    test_cfg["ai"]["timeoutSeconds"] = json!(15);
    test_cfg["ai"]["retries"] = json!(0);
    let provider_name = cfg["ai"]["provider"].as_str().unwrap_or("anthropic").to_string();
    test_cfg["ai"][&provider_name]["maxTokens"] = json!(16);

    let latency = |t0: u128| (utils::now_ms() - t0) as u64;
    match create_provider(&test_cfg, api_key) {
        Ok(p) => match p.summarize("You are a connection test.", "Reply with: OK").await {
            Ok(r) => {
                let ms = latency(t0);
                json!({
                    "ok": true,
                    "message": format!("连接成功 · {} · {}ms · 回复：{}", r.model, ms, snippet(&r.text, 40)),
                    "model": r.model,
                    "latencyMs": ms,
                })
            }
            Err(e) => json!({ "ok": false, "message": e.message(), "latencyMs": latency(t0) }),
        },
        Err(e) => json!({ "ok": false, "message": e.message(), "latencyMs": latency(t0) }),
    }
}
