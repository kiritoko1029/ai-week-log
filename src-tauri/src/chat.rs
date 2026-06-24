//! AI 对话问答（忠实移植 src/main/chat.js）。
//!
//! 会话持久化（chats.json）+ RAG 检索 + SSE 流式编排 + 报告意图识别。
//! 增量经 `app.emit("chat:stream", …)` 推送（对齐 Electron webContents.send；前端 listen）。
//!
//! RAG：记忆检索（memory.*）为依赖注入；memory 批次尚未实现，故当前直接走
//! 「历史报告 + 笔记关键词粗筛」兜底（与 Electron refs<2 时的兜底路径一致）。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{config, history, llm, memory, notes, pipeline, utils};

const CHATS_FILE: &str = "chats.json";
const MAX_SNIPPET: usize = 600; // 注入单条记录的正文上限（字符）
const MAX_SESSIONS: usize = 100;

static RE_INTENT_JSON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\{.*\}").unwrap());
static RE_REPORT_KIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(日报|周报|月报)").unwrap());
static RE_REPORT_VERB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(生成|写|做|出|来|帮我|整理|总结|搞|弄|给我|来一?份|来个)").unwrap());

fn to_base36(mut n: u128) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = Vec::new();
    while n > 0 {
        v.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    v.reverse();
    String::from_utf8(v).unwrap()
}

/// 对齐 JS `prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)`。
fn new_id(prefix: &str) -> String {
    let mut buf = [0u8; 8];
    let _ = getrandom::getrandom(&mut buf);
    let rand4: String = to_base36(u64::from_le_bytes(buf) as u128).chars().take(4).collect();
    format!("{}_{}{}", prefix, to_base36(utils::now_ms()), rand4)
}

pub fn new_msg_id() -> String {
    new_id("msg")
}

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() > n {
        format!("{}…", t.chars().take(n).collect::<String>())
    } else {
        t.to_string()
    }
}

// ── 存储 ────────────────────────────────────────────────

fn base_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default()
}

fn read_chats(app: &AppHandle) -> Value {
    let p = base_dir(app).join(CHATS_FILE);
    if let Ok(text) = fs::read_to_string(&p) {
        if let Ok(d) = serde_json::from_str::<Value>(&text) {
            if d["sessions"].is_array() {
                return d;
            }
        }
    }
    json!({ "schemaVersion": 1, "sessions": [] })
}

fn write_chats(app: &AppHandle, data: &Value) -> Result<(), String> {
    let dir = base_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(dir.join(CHATS_FILE), text).map_err(|e| e.to_string())
}

/// 会话列表（轻量元数据，不含 messages 全文），按 updatedAt 倒序。
pub fn sessions(app: &AppHandle) -> Value {
    let data = read_chats(app);
    let mut list: Vec<Value> = data["sessions"].as_array().cloned().unwrap_or_default();
    list.sort_by(|a, b| {
        b["updatedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["updatedAt"].as_str().unwrap_or(""))
    });
    let meta: Vec<Value> = list
        .iter()
        .map(|s| {
            json!({
                "id": s["id"],
                "title": s["title"],
                "createdAt": s["createdAt"],
                "updatedAt": s["updatedAt"],
                "messageCount": s["messages"].as_array().map(|m| m.len()).unwrap_or(0),
            })
        })
        .collect();
    Value::Array(meta)
}

pub fn session_get(app: &AppHandle, id: &str) -> Value {
    let data = read_chats(app);
    data["sessions"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["id"].as_str() == Some(id)))
        .cloned()
        .unwrap_or(Value::Null)
}

pub fn session_create(app: &AppHandle, title: Option<String>) -> Value {
    let mut data = read_chats(app);
    let now = utils::now_iso();
    let t = title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "新对话".to_string());
    let session = json!({
        "id": new_id("c"),
        "title": t,
        "createdAt": now,
        "updatedAt": now,
        "messages": [],
    });
    if !data["sessions"].is_array() {
        data["sessions"] = json!([]);
    }
    if let Some(arr) = data["sessions"].as_array_mut() {
        arr.insert(0, session.clone());
        arr.truncate(MAX_SESSIONS);
    }
    let _ = write_chats(app, &data);
    session
}

pub fn session_rename(app: &AppHandle, id: &str, title: &str) -> Value {
    let mut data = read_chats(app);
    let now = utils::now_iso();
    let mut found: Option<Value> = None;
    if let Some(arr) = data["sessions"].as_array_mut() {
        if let Some(s) = arr.iter_mut().find(|x| x["id"].as_str() == Some(id)) {
            let next = title.trim();
            if !next.is_empty() {
                s["title"] = json!(next);
            }
            s["updatedAt"] = json!(now);
            found = Some(s["title"].clone());
        }
    }
    match found {
        Some(t) => {
            let _ = write_chats(app, &data);
            json!({ "ok": true, "title": t })
        }
        None => json!({ "ok": false }),
    }
}

pub fn session_delete(app: &AppHandle, id: &str) -> Value {
    let mut data = read_chats(app);
    let before = data["sessions"].as_array().map(|a| a.len()).unwrap_or(0);
    if let Some(arr) = data["sessions"].as_array_mut() {
        arr.retain(|s| s["id"].as_str() != Some(id));
    }
    let after = data["sessions"].as_array().map(|a| a.len()).unwrap_or(0);
    let _ = write_chats(app, &data);
    json!({ "ok": after < before })
}

/// 追加一条消息；首条 user 消息自动作会话标题。返回保存的消息（会话不存在则 None）。
/// 注意：对齐 chat.js appendMessage——仅持久化 refs/reasoning/usage，不含 report 字段。
fn append_message(app: &AppHandle, session_id: &str, msg: &Value) -> Option<Value> {
    let mut data = read_chats(app);
    let now = utils::now_iso();
    let mut saved_out: Option<Value> = None;
    if let Some(arr) = data["sessions"].as_array_mut() {
        if let Some(s) = arr.iter_mut().find(|x| x["id"].as_str() == Some(session_id)) {
            let id = msg["id"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| new_id("msg"));
            let mut saved = json!({
                "id": id,
                "role": msg["role"].clone(),
                "content": msg["content"].clone(),
                "createdAt": now.clone(),
            });
            if msg["refs"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                saved["refs"] = msg["refs"].clone();
            }
            if msg["reasoning"].as_str().map(|r| !r.is_empty()).unwrap_or(false) {
                saved["reasoning"] = msg["reasoning"].clone();
            }
            if msg.get("usage").map(|u| !u.is_null()).unwrap_or(false) {
                saved["usage"] = msg["usage"].clone();
            }
            if !s["messages"].is_array() {
                s["messages"] = json!([]);
            }
            if let Some(msgs) = s["messages"].as_array_mut() {
                msgs.push(saved.clone());
            }
            let title = s["title"].as_str().unwrap_or("").to_string();
            if (title.is_empty() || title == "新对话") && msg["role"].as_str() == Some("user") {
                let t = truncate(msg["content"].as_str().unwrap_or(""), 20);
                if !t.is_empty() {
                    s["title"] = json!(t);
                }
            }
            s["updatedAt"] = json!(now);
            saved_out = Some(saved);
        }
    }
    if saved_out.is_some() {
        let _ = write_chats(app, &data);
    }
    saved_out
}

// ── RAG 检索 ────────────────────────────────────────────

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// 从 query 提取检索词：英文/数字词 + 中文 2-gram（对齐 keyTerms）。
fn key_terms(query: &str) -> Vec<String> {
    let q = query.to_lowercase();
    let mut terms: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let push = |t: String, terms: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
        if seen.insert(t.clone()) {
            terms.push(t);
        }
    };
    for w in q.split(|c: char| !(c.is_ascii_alphanumeric() || is_cjk(c))) {
        if !w.is_empty() && w.chars().any(|c| c.is_ascii_alphanumeric()) && w.chars().count() >= 2 {
            push(w.to_string(), &mut terms, &mut seen);
        }
    }
    let zh: Vec<char> = q.chars().filter(|c| is_cjk(*c)).collect();
    for i in 0..zh.len().saturating_sub(1) {
        let gram: String = zh[i..i + 2].iter().collect();
        push(gram, &mut terms, &mut seen);
    }
    terms
}

fn count_hits(text: &str, terms: &[String]) -> usize {
    let t = text.to_lowercase();
    terms
        .iter()
        .filter(|term| !term.is_empty() && t.contains(term.as_str()))
        .count()
}

fn report_label(r: &Value) -> String {
    let ty = match r["type"].as_str().unwrap_or("") {
        "weekly" => "周报".to_string(),
        "daily" => "日报".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "报告".to_string(),
    };
    let a = r["rangeStart"].as_str().unwrap_or("");
    let b = r["rangeEnd"].as_str().unwrap_or("");
    let range = if !a.is_empty() && !b.is_empty() && a != b {
        format!("{}~{}", a, b)
    } else if !a.is_empty() {
        a.to_string()
    } else {
        b.to_string()
    };
    if range.is_empty() {
        ty
    } else {
        format!("{} {}", ty, range)
    }
}

/// 报告兜底：命中关键词的优先，否则取最近 limit 份（对齐 pickReports）。
fn pick_reports(history: &[Value], terms: &[String], limit: usize) -> Vec<Value> {
    let scored: Vec<(usize, &Value)> = history
        .iter()
        .map(|r| (count_hits(r["text"].as_str().unwrap_or(""), terms), r))
        .collect();
    let mut hit: Vec<(usize, &Value)> = scored.iter().filter(|(s, _)| *s > 0).cloned().collect();
    hit.sort_by(|a, b| b.0.cmp(&a.0));
    let chosen: Vec<&Value> = if !hit.is_empty() {
        hit.into_iter().map(|(_, r)| r).collect()
    } else {
        scored.iter().take(limit).map(|(_, r)| *r).collect()
    };
    chosen.into_iter().take(limit).cloned().collect()
}

/// 笔记兜底：近 90 天，命中关键词优先，否则取最近 limit 条（对齐 pickNotes）。
fn pick_notes(notes_dir: &str, cfg: &Value, terms: &[String], limit: usize) -> Vec<notes::Note> {
    if notes_dir.is_empty() {
        return vec![];
    }
    let to = utils::today();
    let from = to - chrono::Duration::days(90);
    let misc = cfg["notes"]["miscProject"].as_str().unwrap_or("日常工作");
    let all = notes::load_notes(notes_dir, &utils::iso_date(from), &utils::iso_date(to), misc)
        .unwrap_or_default();
    let scored: Vec<(usize, notes::Note)> = all
        .into_iter()
        .map(|n| {
            let hay = format!("{} {}", n.content, n.project.clone().unwrap_or_default());
            (count_hits(&hay, terms), n)
        })
        .collect();
    let has_hit = scored.iter().any(|(s, _)| *s > 0);
    if has_hit {
        let mut hit: Vec<(usize, notes::Note)> =
            scored.into_iter().filter(|(s, _)| *s > 0).collect();
        hit.sort_by(|a, b| b.0.cmp(&a.0));
        hit.into_iter().take(limit).map(|(_, n)| n).collect()
    } else {
        let len = scored.len();
        let start = len.saturating_sub(limit);
        scored.into_iter().skip(start).map(|(_, n)| n).collect()
    }
}

/// 检索与 query 相关的工作上下文。返回 (contextText, refs)。
async fn retrieve_context(
    app: &AppHandle,
    cfg: &Value,
    query: &str,
    history: &[Value],
    notes_dir: &str,
) -> (String, Vec<Value>) {
    let mut refs: Vec<Value> = vec![];
    let mut blocks: Vec<String> = vec![];
    let k = cfg["ai"]["chat"]["topK"]
        .as_u64()
        .or_else(|| cfg["memory"]["topK"].as_u64())
        .unwrap_or(6) as usize;

    // 主：记忆检索（语义/关键词；本地 ONNX 未集成时为关键词预筛）
    if cfg["memory"]["enabled"].as_bool().unwrap_or(false) {
        let hits = memory::search(app, query, k, cfg).await;
        if let Some(arr) = hits.as_array() {
            for h in arr {
                let body = h["full"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| h["digest"].as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if body.is_empty() {
                    continue;
                }
                let project = h["project"].as_str().unwrap_or("");
                let date = h["date"].as_str().unwrap_or("");
                let label = format!(
                    "{}{}",
                    if project.is_empty() { "记忆" } else { project },
                    if date.is_empty() { String::new() } else { format!(" · {}", date) }
                );
                refs.push(json!({
                    "kind": "memory",
                    "label": label,
                    "date": h["date"].clone(),
                    "project": h["project"].clone(),
                    "snippet": truncate(&body, 160),
                }));
                blocks.push(format!("【记忆 · {} {}】\n{}", project, date, truncate(&body, MAX_SNIPPET)));
            }
        }
    }

    // 兜底：记忆命中过少 → 报告 + 笔记关键词粗筛
    if refs.len() < 2 {
        let terms = key_terms(query);
        for r in pick_reports(history, &terms, 3) {
            let label = report_label(&r);
            let text = r["text"].as_str().unwrap_or("");
            refs.push(json!({
                "kind": "report",
                "label": label,
                "date": r["rangeStart"].clone(),
                "snippet": truncate(text, 160),
            }));
            blocks.push(format!("【报告 · {}】\n{}", label, truncate(text, MAX_SNIPPET)));
        }
        for n in pick_notes(notes_dir, cfg, &terms, 5) {
            let proj = n.project.clone().filter(|p| !p.is_empty());
            let label = format!(
                "笔记 · {}{}",
                n.date,
                proj.as_ref().map(|p| format!(" · {}", p)).unwrap_or_default()
            );
            let proj_val = proj.clone().map(Value::from).unwrap_or(Value::Null);
            refs.push(json!({
                "kind": "note",
                "label": label,
                "date": n.date,
                "project": proj_val,
                "snippet": truncate(&n.content, 160),
            }));
            blocks.push(format!("【{}】\n{}", label, truncate(&n.content, MAX_SNIPPET)));
        }
    }

    (blocks.join("\n\n"), refs)
}

const CHAT_SYSTEM_BASE: &str = r#"你是 WeekLog 的工作助手，基于用户本地的 Git 工作记录、周报/日报与笔记回答问题。
规则：
- 优先依据下方「已知工作记录」回答；这些是用户真实的历史工作内容。
- 若已知记录不足以回答，如实说明「记录中暂无相关信息」，不要编造项目、日期或成果。
- 回答用简体中文，简洁专业；涉及代码时用 Markdown 代码块。"#;

fn build_chat_system(context_text: &str) -> String {
    if context_text.trim().is_empty() {
        format!(
            "{}\n\n【已知工作记录】\n（未检索到相关记录。可提示用户先生成报告或在设置中重建 AI 记忆，问答会更准确。）",
            CHAT_SYSTEM_BASE
        )
    } else {
        format!("{}\n\n【已知工作记录】\n{}", CHAT_SYSTEM_BASE, context_text)
    }
}

const REFINE_SYSTEM_BASE: &str = r#"你是 WeekLog 的报告润色助手。下面「待润色报告」是用户已生成的周报/日报，用户会用一句话给出修改指令。
规则：
- 严格按用户指令修改「待润色报告」，输出修改后的【完整报告】，保持原有格式、结构与未涉及的内容不变。
- 只改用户要求改的地方，不要擅自增删或改写其他内容，不要编造项目、日期或成果。
- 直接输出修改后的报告全文，不要附加「好的」「已为你修改」之类的解释、前言或结语。
- 用简体中文。"#;

/// 润色态 system：编辑者框架 + 待润色报告（refine_report 已含【待润色报告（…）】标签）。
/// 检索到的工作记录作为参考附在末尾，避免与待改报告混淆。
fn build_refine_system(refine_report: &str, reference: &str) -> String {
    let mut s = format!("{}\n\n{}", REFINE_SYSTEM_BASE, refine_report);
    if !reference.trim().is_empty() {
        s.push_str("\n\n【参考工作记录】\n");
        s.push_str(reference);
    }
    s
}

/// 把会话历史转为 provider messages，截断到最近 turns 轮（对齐 buildMessages）。
fn build_messages(session: &Value, turns: usize) -> Vec<Value> {
    let all: Vec<&Value> = session["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|m| matches!(m["role"].as_str(), Some("user") | Some("assistant")))
                .collect()
        })
        .unwrap_or_default();
    let limit = (turns * 2).max(2);
    let start = all.len().saturating_sub(limit);
    all[start..]
        .iter()
        .map(|m| json!({ "role": m["role"].clone(), "content": m["content"].clone() }))
        .collect()
}

// ── chat:stream 事件推送 ────────────────────────────────

fn emit(app: &AppHandle, session_id: &str, msg_id: &str, ty: &str, extra: Value) {
    let mut payload = serde_json::Map::new();
    payload.insert("sessionId".to_string(), json!(session_id));
    payload.insert("msgId".to_string(), json!(msg_id));
    payload.insert("type".to_string(), json!(ty));
    if let Some(m) = extra.as_object() {
        for (k, v) in m {
            payload.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit("chat:stream", Value::Object(payload));
}

// ── 流式问答编排 ────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn ask_stream(
    app: &AppHandle,
    cfg: &Value,
    api_key: &str,
    signal: &Arc<AtomicBool>,
    session_id: &str,
    msg_id: &str,
    content: &str,
    context: Option<String>,
) {
    if append_message(app, session_id, &json!({ "role": "user", "content": content })).is_none() {
        emit(app, session_id, msg_id, "error", json!({ "message": "会话不存在" }));
        return;
    }

    let history = history::read_history(app);
    let notes_dir = config::notes_dir(app).unwrap_or_default();
    let (ctx_text, refs) = retrieve_context(app, cfg, content, &history, &notes_dir).await;
    emit(app, session_id, msg_id, "refs", json!({ "refs": refs.clone() }));

    // 润色态（context 为「送入对话润色」的报告文本）：用编辑者 system，要求输出修改后的
    // 完整报告；检索到的工作记录降级为参考附在后面。普通问答仍走 build_chat_system。
    let refine = context.as_deref().map(str::trim).filter(|c| !c.is_empty());
    let system = match refine {
        Some(report) => build_refine_system(report, &ctx_text),
        None => build_chat_system(&ctx_text),
    };

    let provider = match llm::create_provider(cfg, api_key) {
        Ok(p) => p,
        Err(e) => {
            emit(app, session_id, msg_id, "error", json!({ "message": e.message() }));
            return;
        }
    };

    let session = session_get(app, session_id);
    let turns = cfg["ai"]["chat"]["historyTurns"].as_u64().unwrap_or(12) as usize;
    let msgs = build_messages(&session, turns);
    let opts = llm::StreamOpts {
        signal: signal.clone(),
        max_tokens: cfg["ai"]["chat"]["maxTokens"].as_u64(),
        thinking: cfg["ai"]["chat"]["thinking"].as_bool().unwrap_or(false),
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<llm::StreamChunk>();
    let stream_fut = provider.stream_chat(&system, &msgs, &opts, tx);
    let drain = async {
        let mut acc = String::new();
        let mut reasoning = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                llm::StreamChunk::Delta(t) => {
                    emit(app, session_id, msg_id, "delta", json!({ "text": t }));
                    acc.push_str(&t);
                }
                llm::StreamChunk::Thinking(t) => {
                    emit(app, session_id, msg_id, "thinking", json!({ "text": t }));
                    reasoning.push_str(&t);
                }
            }
        }
        (acc, reasoning)
    };
    let (res, (acc, reasoning)) = futures::future::join(stream_fut, drain).await;

    match res {
        Ok(r) => {
            let usage = json!({
                "inputTokens": r.input_tokens,
                "outputTokens": r.output_tokens,
                "model": r.model,
            });
            let saved = append_message(
                app,
                session_id,
                &json!({
                    "role": "assistant",
                    "content": r.text,
                    "refs": refs.clone(),
                    "reasoning": if reasoning.is_empty() { Value::Null } else { json!(reasoning) },
                    "usage": usage.clone(),
                }),
            );
            emit(app, session_id, msg_id, "done", json!({ "message": saved, "usage": usage }));
        }
        Err(e) => {
            let aborted = matches!(e, llm::LlmError::Aborted(_));
            if !acc.trim().is_empty() || !reasoning.trim().is_empty() {
                let content = if aborted {
                    format!("{}\n\n_(已停止生成)_", acc)
                } else {
                    acc.clone()
                };
                append_message(
                    app,
                    session_id,
                    &json!({
                        "role": "assistant",
                        "content": content,
                        "refs": refs.clone(),
                        "reasoning": if reasoning.is_empty() { Value::Null } else { json!(reasoning) },
                    }),
                );
            }
            if aborted {
                emit(app, session_id, msg_id, "aborted", json!({}));
            } else {
                emit(app, session_id, msg_id, "error", json!({ "message": e.message() }));
            }
        }
    }
}

// ── 报告生成意图解析 ───────────────────────────────────

const INTENT_SYSTEM: &str = r#"你是 WeekLog 的意图解析器。判断用户消息是否要"生成一份日报或周报"，并解析参数。只输出 JSON，不要任何多余文字或解释。
输出格式：{"action":"generate"|"chat","reportType":"daily"|"weekly"|null,"rangeOpts":对象|null}
规则：
- action=generate 仅当用户明确要"生成/写/做一份"日报或周报；若只是提问、引用或讨论已有报告（如"上周周报里我说了啥"），则 action=chat。
- reportType：daily=日报，weekly=周报。
- rangeOpts 形态：
  - 今天日报 {"mode":"daily","date":"today"}；昨天 {"mode":"daily","date":"yesterday"}；指定日 {"mode":"daily","date":"YYYY-MM-DD"}
  - 本周周报 {}；上周 {"week":"last"}；指定范围 {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}
示例：
"帮我写本周周报" → {"action":"generate","reportType":"weekly","rangeOpts":{}}
"生成今天的日报" → {"action":"generate","reportType":"daily","rangeOpts":{"mode":"daily","date":"today"}}
"上周周报里我提到什么" → {"action":"chat","reportType":null,"rangeOpts":null}"#;

/// 纯正则预筛：是否疑似"生成日报/周报"请求（命中才值得调 LLM 细判）。
fn looks_like_report_request(text: &str) -> bool {
    RE_REPORT_KIND.is_match(text) && RE_REPORT_VERB.is_match(text)
}

/// 快捷钮语义时间 → rangeOpts（纯函数，对齐 whenToRangeOpts）。
fn when_to_range_opts(report_type: &str, when: &str) -> Value {
    if report_type == "daily" {
        if when == "yesterday" {
            json!({ "mode": "daily", "date": "yesterday" })
        } else {
            json!({ "mode": "daily", "date": "today" })
        }
    } else if when == "last_week" {
        json!({ "week": "last" })
    } else {
        json!({})
    }
}

/// 从 LLM 文本里抽第一个 JSON 对象（对齐 parseIntentJson）。
fn parse_intent_json(text: &str) -> Option<Value> {
    let m = RE_INTENT_JSON.find(text)?;
    serde_json::from_str(m.as_str()).ok()
}

/// LLM 结构化解析报告意图；任何异常/脏输出降级为 chat（返回 None）。
async fn detect_report_intent(cfg: &Value, api_key: &str, text: &str) -> Option<(String, Value)> {
    let provider = llm::create_provider(cfg, api_key).ok()?;
    let today = utils::iso_date(utils::today());
    let ws = if cfg["weekStart"].as_str() == Some("sunday") {
        "一周从周日开始"
    } else {
        "一周从周一开始"
    };
    let user = format!("今天是 {}，{}。\n用户消息：{}", today, ws, text);
    let res = provider.summarize(INTENT_SYSTEM, &user).await.ok()?;
    let parsed = parse_intent_json(&res.text)?;
    if parsed["action"].as_str() != Some("generate") {
        return None;
    }
    let report_type = match parsed["reportType"].as_str() {
        Some("daily") => "daily",
        Some("weekly") => "weekly",
        _ => return None,
    }
    .to_string();
    let range_opts = if parsed["rangeOpts"].is_object() {
        parsed["rangeOpts"].clone()
    } else {
        json!({})
    };
    Some((report_type, range_opts))
}

/// 报告生成编排：走真实 generate 流水线 → 存档历史 → 入会话 → 经 chat:stream 推进度/结果。
async fn run_chat_report(
    app: &AppHandle,
    cfg: &Value,
    api_key: &str,
    session_id: &str,
    msg_id: &str,
    report_type: &str,
    range_opts_val: Value,
) {
    let cn_label = if report_type == "weekly" { "周报" } else { "日报" };
    emit(app, session_id, msg_id, "report_progress", json!({ "stage": "采集中" }));

    let range_opts: utils::RangeOpts = serde_json::from_value(range_opts_val).unwrap_or_default();
    let notes_dir = match config::notes_dir(app) {
        Ok(d) => d,
        Err(e) => {
            emit(app, session_id, msg_id, "error", json!({ "message": e }));
            return;
        }
    };
    let options: pipeline::CollectOptions = serde_json::from_value(json!({
        "format": cfg["output"]["format"],
        "weekStart": cfg["weekStart"],
        "merge": cfg["filters"]["mergeCommits"],
        "_reportType": cn_label,
    }))
    .unwrap_or_default();

    emit(app, session_id, msg_id, "report_progress", json!({ "stage": "AI 融合生成中" }));
    // 复用真实生成流水线；传空 task_id（Tasks::update 对未知 id 安全 no-op，不创建可见任务）
    let report = pipeline::generate(
        app.clone(),
        cfg.clone(),
        api_key.to_string(),
        range_opts,
        notes_dir,
        options,
        String::new(),
    )
    .await;

    if let Some(err) = &report.error {
        emit(app, session_id, msg_id, "error", json!({ "message": err }));
        return;
    }
    let range_start = report.range_start.clone().unwrap_or_default();
    let range_end = report.range_end.clone().unwrap_or_default();
    let text = report.text.clone().unwrap_or_default();
    let meta = report.meta.clone().unwrap_or_else(|| json!({}));

    let saved_hist = history::save_entry(
        app,
        json!({
            "type": cn_label,
            "rangeStart": range_start,
            "rangeEnd": range_end,
            "text": text,
            "meta": meta,
        }),
    )
    .unwrap_or_else(|_| json!({}));
    let history_id = saved_hist["id"].clone();

    let msg = append_message(
        app,
        session_id,
        &json!({
            "role": "assistant",
            "content": text,
            "report": {
                "reportType": report_type,
                "rangeStart": range_start,
                "rangeEnd": range_end,
                "historyId": history_id,
                "meta": meta,
            },
        }),
    );
    emit(app, session_id, msg_id, "report_done", json!({ "message": msg }));
}

// ── 后台 worker（供 lib.rs 命令 spawn）─────────────────

#[allow(clippy::too_many_arguments)]
pub async fn handle_send(
    app: &AppHandle,
    cfg: Value,
    api_key: String,
    signal: Arc<AtomicBool>,
    session_id: String,
    msg_id: String,
    content: String,
    context: Option<String>,
) {
    // 报告意图：规则预筛 → LLM 细判 → 命中则走真实生成流水线。
    // 润色态（带 context）跳过：用户意图始终是修改当前报告，否则形如「帮我把周报整理简洁」
    // 会被误判为重新生成、丢掉润色上下文与具体指令。
    let is_refine = context.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false);
    if !is_refine && looks_like_report_request(&content) {
        emit(app, &session_id, &msg_id, "report_progress", json!({ "stage": "理解中" }));
        if let Some((report_type, range_opts)) = detect_report_intent(&cfg, &api_key, &content).await {
            append_message(app, &session_id, &json!({ "role": "user", "content": content }));
            run_chat_report(app, &cfg, &api_key, &session_id, &msg_id, &report_type, range_opts).await;
            return;
        }
    }
    // 普通问答（ask_stream 内部会落 user 消息）
    ask_stream(app, &cfg, &api_key, &signal, &session_id, &msg_id, &content, context).await;
}

pub async fn handle_generate(
    app: &AppHandle,
    cfg: Value,
    api_key: String,
    session_id: String,
    msg_id: String,
    report_type: String,
    when: String,
) {
    let cn_label = if report_type == "weekly" { "周报" } else { "日报" };
    let when_label = match when.as_str() {
        "yesterday" => "昨天",
        "last_week" => "上周",
        "this_week" => "本周",
        _ => "今天",
    };
    append_message(
        app,
        &session_id,
        &json!({ "role": "user", "content": format!("生成{}{}", when_label, cn_label) }),
    );
    let range_opts = when_to_range_opts(&report_type, &when);
    run_chat_report(app, &cfg, &api_key, &session_id, &msg_id, &report_type, range_opts).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_terms_extracts_english_and_cjk_bigrams() {
        let terms = key_terms("修复 login bug");
        assert!(terms.iter().any(|t| t == "login"));
        assert!(terms.iter().any(|t| t == "bug"));
        assert!(terms.iter().any(|t| t == "修复"));
    }

    #[test]
    fn looks_like_report_request_matches() {
        assert!(looks_like_report_request("帮我写本周周报"));
        assert!(looks_like_report_request("生成今天的日报"));
        assert!(!looks_like_report_request("上周周报里我提到什么")); // 无生成动词
        assert!(!looks_like_report_request("今天天气不错"));
    }

    #[test]
    fn when_to_range_opts_maps_correctly() {
        assert_eq!(when_to_range_opts("daily", "yesterday"), json!({"mode":"daily","date":"yesterday"}));
        assert_eq!(when_to_range_opts("daily", "today"), json!({"mode":"daily","date":"today"}));
        assert_eq!(when_to_range_opts("weekly", "last_week"), json!({"week":"last"}));
        assert_eq!(when_to_range_opts("weekly", "this_week"), json!({}));
    }

    #[test]
    fn parse_intent_json_extracts_object() {
        let v = parse_intent_json("好的\n{\"action\":\"generate\",\"reportType\":\"weekly\"}\n完成").unwrap();
        assert_eq!(v["action"], "generate");
        assert_eq!(v["reportType"], "weekly");
    }

    #[test]
    fn report_label_formats_range() {
        let r = json!({ "type": "weekly", "rangeStart": "2026-06-15", "rangeEnd": "2026-06-19" });
        assert_eq!(report_label(&r), "周报 2026-06-15~2026-06-19");
        let r2 = json!({ "type": "日报", "rangeStart": "2026-06-19", "rangeEnd": "2026-06-19" });
        assert_eq!(report_label(&r2), "日报 2026-06-19");
    }

    #[test]
    fn build_messages_truncates_to_turns() {
        let mut msgs = vec![];
        for i in 0..40 {
            msgs.push(json!({ "role": if i % 2 == 0 { "user" } else { "assistant" }, "content": format!("m{i}") }));
        }
        let session = json!({ "messages": msgs });
        let built = build_messages(&session, 12);
        assert_eq!(built.len(), 24); // 12 轮 * 2
    }
}
