//! AI 记忆系统（忠实移植 src/main/memory.js）。
//!
//! - 存储：memory/index.json（轻量 id/date/project/keywords/digest/embedding）+ memory/entries/{id}.md（全文）
//! - embedding：API（OpenAI，reqwest）+ 本地 ONNX；本地模型下载由用户手动触发，
//!   自动检索/向量化只复用已落盘模型，缺失时降级为关键词预筛。
//! - 检索：关键词预筛 + 语义余弦重排（有向量才重排）；仅 topK 加载全文。
//! - 生成：报告完成后由 pipeline 触发 build_memory_entry → save_entry → 入队 embedding。

use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use futures::StreamExt;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokenizers::Tokenizer;

use crate::{llm, tasks, utils};

const MEMORY_DIR: &str = "memory";
const ENTRIES_DIR: &str = "entries";
const INDEX_FILE: &str = "index.json";

static RE_PROJECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"项目[：:]\s*(\S+)").unwrap());
static RE_FENCE_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^```(?:json)?\s*").unwrap());
static RE_FENCE_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*```$").unwrap());
static RE_EN_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z][a-z0-9_-]{1,30}").unwrap());
static RE_CJK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\u{4e00}-\u{9fff}]+").unwrap());

// ── 路径 ──

fn base_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default()
}
fn mem_dir(app: &AppHandle) -> PathBuf {
    base_dir(app).join(MEMORY_DIR)
}
fn entries_dir(app: &AppHandle) -> PathBuf {
    mem_dir(app).join(ENTRIES_DIR)
}
fn index_path(app: &AppHandle) -> PathBuf {
    mem_dir(app).join(INDEX_FILE)
}
fn entry_path(app: &AppHandle, id: &str) -> PathBuf {
    entries_dir(app).join(format!("{id}.md"))
}

// ── 本地模型缓存目录 ──
//
// 模型体积大（multilingual-e5-small fp32 ~470MB），存于 base_dir/models，避免随更新丢失。
// 同时复用 Electron 版（应用名 weeklog）已下载的模型，避免重复下载。

fn model_cache_dir(app: &AppHandle) -> PathBuf {
    base_dir(app).join("models")
}

/// Electron 版（应用名 `weeklog`）的 models 目录，按平台拼装。复用其已下载的模型。
fn legacy_model_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(
                PathBuf::from(home)
                    .join("Library/Application Support/weeklog/models"),
            );
        }
    } else if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("weeklog").join("models"));
        }
    } else {
        // Linux：优先 XDG_CONFIG_HOME，否则 ~/.config
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            dirs.push(PathBuf::from(xdg).join("weeklog").join("models"));
        } else if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".config/weeklog/models"));
        }
    }
    dirs
}

/// 校验某个 `models/{model}` 目录是否含完整模型文件（config + tokenizer + onnx）。
fn is_valid_model_dir(dir: &PathBuf) -> bool {
    let files: Vec<String> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect(),
        Err(_) => return false,
    };
    if !files.iter().any(|f| f == "config.json") || !files.iter().any(|f| f == "tokenizer.json") {
        return false;
    }
    let onnx_dir = if files.iter().any(|f| f == "onnx") {
        dir.join("onnx")
    } else {
        dir.clone()
    };
    fs::read_dir(&onnx_dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n == "model.onnx" || n == "model_quantized.onnx"
            })
        })
        .unwrap_or(false)
}

/// 定位一个可用的 `{model}` 目录：先 Tauri 缓存目录，再回退 Electron 旧目录。
fn find_model_dir(app: &AppHandle, model: &str) -> Option<PathBuf> {
    let primary = model_cache_dir(app).join(model);
    if is_valid_model_dir(&primary) {
        return Some(primary);
    }
    for base in legacy_model_dirs() {
        let d = base.join(model);
        if is_valid_model_dir(&d) {
            return Some(d);
        }
    }
    None
}

/// 返回模型目录下的 onnx 文件实际路径（onnx/ 子目录优先）。
fn onnx_path_in(dir: &PathBuf) -> Option<PathBuf> {
    for sub in [dir.join("onnx"), dir.clone()] {
        for name in ["model.onnx", "model_quantized.onnx"] {
            let p = sub.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

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

fn new_id() -> String {
    let mut buf = [0u8; 8];
    let _ = getrandom::getrandom(&mut buf);
    let rand4: String = to_base36(u64::from_le_bytes(buf) as u128).chars().take(4).collect();
    format!("m_{}{}", to_base36(utils::now_ms()), rand4)
}

// ── index.json 读写 ──

fn read_index(app: &AppHandle) -> Vec<Value> {
    if let Ok(text) = fs::read_to_string(index_path(app)) {
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&text) {
            return arr;
        }
    }
    Vec::new()
}

fn write_index(app: &AppHandle, list: &[Value]) -> Result<(), String> {
    fs::create_dir_all(mem_dir(app)).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&Value::Array(list.to_vec())).map_err(|e| e.to_string())?;
    fs::write(index_path(app), text).map_err(|e| e.to_string())
}

pub fn list_index(app: &AppHandle) -> Value {
    Value::Array(read_index(app))
}

// ── 简易分词（关键词预筛）──

fn tokenize(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let mut tokens: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let add = |t: String, tokens: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
        if seen.insert(t.clone()) {
            tokens.push(t);
        }
    };
    let lower = text.to_lowercase();
    for m in RE_EN_WORD.find_iter(&lower) {
        let w = m.as_str();
        if w.chars().count() >= 2 {
            add(w.to_string(), &mut tokens, &mut seen);
        }
    }
    for seg in RE_CJK.find_iter(text) {
        let chars: Vec<char> = seg.as_str().chars().collect();
        if chars.len() == 1 {
            add(chars[0].to_string(), &mut tokens, &mut seen);
        } else {
            for i in 0..chars.len().saturating_sub(1) {
                add(chars[i..i + 2].iter().collect(), &mut tokens, &mut seen);
            }
        }
    }
    tokens
}

// ── Embedding（API + 本地 ONNX）──

/// 对单条文本生成 embedding 向量。
/// - api：调用 OpenAI embeddings。
/// - local：只加载已落盘 onnx → 推理；缺模型时返回 None，不自动下载。
async fn embed(app: &AppHandle, cfg: &Value, api_key: &str, text: &str) -> Option<Vec<f64>> {
    if text.trim().is_empty() {
        return None;
    }
    let source = cfg["memory"]["embeddingSource"].as_str().unwrap_or("local");
    let model = cfg["memory"]["embeddingModel"]
        .as_str()
        .unwrap_or("Xenova/multilingual-e5-small")
        .to_string();
    if source == "api" {
        return embed_via_api(cfg, api_key, &model, text).await.unwrap_or(None);
    }
    // 本地 ONNX：缺模型时直接降级，不触发网络下载。
    let dir = find_model_dir(app, &model)?;
    // multilingual-e5 约定：query/passage 前缀（与 JS 一致，存储/查询都用 query:）
    let input = format!("query: {}", text);
    let model_key = model;
    // ort 推理是同步 CPU 任务，放 spawn_blocking 避免阻塞 tokio 运行时
    tauri::async_runtime::spawn_blocking(move || run_inference(&dir, &model_key, &input))
        .await
        .ok()
        .flatten()
}

/// 调用 OpenAI embedding API（复用 openai 配置）。
async fn embed_via_api(
    cfg: &Value,
    api_key: &str,
    model: &str,
    text: &str,
) -> Result<Option<Vec<f64>>, String> {
    let sub = &cfg["ai"]["openai"];
    if sub.is_null() {
        return Err("未配置 OpenAI（API embedding 需要 openai 配置）".to_string());
    }
    if api_key.is_empty() {
        return Err("API embedding 需要 apiKey".to_string());
    }
    let raw_base = sub["baseUrl"].as_str().unwrap_or("").trim_end_matches('/');
    let base = if raw_base.is_empty() {
        "https://api.openai.com/v1"
    } else {
        raw_base
    };
    let url = format!("{}/embeddings", base);
    let body = json!({ "model": model.replace("Xenova/", ""), "input": text });
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let t = resp.text().await.unwrap_or_default();
        let snippet: String = t.chars().take(200).collect();
        return Err(format!("embedding API {}", snippet));
    }
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data["data"][0]["embedding"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_f64()).collect()))
}

// ── 本地模型：下载源解析（对齐 memory.js resolveSource/applySource）──

// 进程级缓存：auto 探测结果只算一次
static RESOLVED_SOURCE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 轻量连通性探测：HEAD 请求，3s 超时；网络层失败即不可达。
async fn probe_reachable(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.head(url).send().await {
        // 2xx/3xx/4xx 都算"能连上"，只有网络层失败才回退
        Ok(r) => r.status().as_u16() < 500,
        Err(_) => false,
    }
}

/// auto → 探测魔搭；modelscope/huggingface 原样返回。结果进程级缓存。
async fn resolve_source(source: &str) -> String {
    if source != "auto" {
        return source.to_string();
    }
    if let Some(s) = RESOLVED_SOURCE.lock().ok().and_then(|g| g.clone()) {
        return s;
    }
    let ok = probe_reachable("https://modelscope.cn").await;
    let resolved = if ok { "modelscope" } else { "huggingface" }.to_string();
    if let Ok(mut g) = RESOLVED_SOURCE.lock() {
        *g = Some(resolved.clone());
    }
    resolved
}

/// 拼装某个文件的下载 URL（ModelScope 路径结构与 HF 不同）。
fn file_url(source: &str, model: &str, file: &str) -> String {
    if source == "modelscope" {
        format!("https://modelscope.cn/api/v1/models/{}/resolve/main/{}", model, file)
    } else {
        format!("https://huggingface.co/{}/resolve/main/{}", model, file)
    }
}

/// 流式下载单个文件到 dest，按 content-length 折算百分比上报到任务。
async fn download_file(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    dest: &PathBuf,
    label: &str,
) -> Result<(), String> {
    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_pct: i64 = -1;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if total > 0 {
            let pct = (downloaded * 100 / total) as i64;
            if pct != last_pct {
                last_pct = pct;
                app.state::<tasks::Tasks>().update(
                    task_id,
                    None,
                    Some(Some(tasks::Progress {
                        done: pct as f64,
                        total: 100.0,
                        label: format!("{}（{}%）", label, pct),
                    })),
                    None,
                );
            }
        }
    }
    Ok(())
}

/// 手动下载本地模型：先复用已有目录，缺失则下载到 Tauri 缓存目录。返回模型目录。
async fn download_model(app: &AppHandle, model: &str, source: &str) -> Option<PathBuf> {
    if let Some(dir) = find_model_dir(app, model) {
        return Some(dir);
    }
    let dest = model_cache_dir(app).join(model);
    let resolved = resolve_source(source).await;
    let src_label = if resolved == "modelscope" { "魔搭社区" } else { "HuggingFace" };
    let task_id = app.state::<tasks::Tasks>().create(
        "model_dl",
        "下载 Embedding 模型",
        &format!("正在从 {} 下载 {}", src_label, model),
        Some(tasks::Progress {
            done: 0.0,
            total: 100.0,
            label: "准备中".to_string(),
        }),
    );
    // tokenizer.json + config.json 用于分词/校验；onnx/model.onnx 是权重（fp32，与现存向量同源）
    let files = ["config.json", "tokenizer.json", "onnx/model.onnx"];
    for f in files {
        let url = file_url(&resolved, model, f);
        if let Err(e) = download_file(app, &task_id, &url, &dest.join(f), f).await {
            app.state::<tasks::Tasks>()
                .error(&task_id, &format!("下载 {} 失败：{}", f, e));
            return None;
        }
    }
    app.state::<tasks::Tasks>()
        .done(&task_id, json!({ "model": model }));
    Some(dest)
}

pub async fn download_local_model(app: &AppHandle, cfg: &Value) -> Value {
    let model = cfg["memory"]["embeddingModel"]
        .as_str()
        .unwrap_or("Xenova/multilingual-e5-small");
    let source = cfg["memory"]["modelSource"].as_str().unwrap_or("auto");
    match download_model(app, model, source).await {
        Some(dir) => {
            let bytes = dir_size(&dir);
            json!({
                "ok": true,
                "model": model,
                "cacheDir": model_cache_dir(app).to_string_lossy().to_string(),
                "modelDir": dir.to_string_lossy().to_string(),
                "sizeMB": ((bytes as f64 / 1024.0 / 1024.0) * 10.0).round() / 10.0,
            })
        }
        None => json!({ "ok": false, "error": "模型下载失败" }),
    }
}

pub fn open_model_folder(app: &AppHandle, cfg: &Value) -> Value {
    let model = cfg["memory"]["embeddingModel"]
        .as_str()
        .unwrap_or("Xenova/multilingual-e5-small");
    let target = find_model_dir(app, model).unwrap_or_else(|| model_cache_dir(app));
    let _ = fs::create_dir_all(&target);
    let ok = open_path(&target).is_ok();
    json!({ "ok": ok, "path": target.to_string_lossy().to_string() })
}

pub fn clear_local_model(app: &AppHandle, cfg: &Value) -> Value {
    let model = cfg["memory"]["embeddingModel"]
        .as_str()
        .unwrap_or("Xenova/multilingual-e5-small");
    let target = find_model_dir(app, model).unwrap_or_else(|| model_cache_dir(app).join(model));
    let _ = fs::remove_dir_all(&target);
    if let Ok(mut guard) = LOCAL_MODEL.lock() {
        if guard.as_ref().map(|(m, _, _)| m == model).unwrap_or(false) {
            *guard = None;
        }
    }
    json!({ "ok": true, "model": model, "path": target.to_string_lossy().to_string() })
}

fn open_path(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// ── 本地模型：ONNX 推理（同步，进程级缓存 session+tokenizer）──

#[allow(clippy::type_complexity)]
static LOCAL_MODEL: LazyLock<Mutex<Option<(String, Session, Tokenizer)>>> =
    LazyLock::new(|| Mutex::new(None));

/// 同步推理：加载（缓存）onnx+tokenizer → 编码 → 推理 → mean-pool(mask) → L2 归一化。
/// 返回与 transformers.js `{pooling:'mean', normalize:true}` 一致的 384 维向量。
fn run_inference(dir: &PathBuf, model_key: &str, input: &str) -> Option<Vec<f64>> {
    let mut guard = LOCAL_MODEL.lock().ok()?;
    let need_load = guard
        .as_ref()
        .map(|(m, _, _)| m != model_key)
        .unwrap_or(true);
    if need_load {
        let onnx = onnx_path_in(dir)?;
        let session = Session::builder()
            .ok()?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .ok()?
            .with_intra_threads(4)
            .ok()?
            .commit_from_file(&onnx)
            .ok()?;
        let mut tok = Tokenizer::from_file(dir.join("tokenizer.json")).ok()?;
        let _ = tok.with_truncation(Some(tokenizers::TruncationParams {
            max_length: 512,
            ..Default::default()
        }));
        *guard = Some((model_key.to_string(), session, tok));
    }
    let (_, session, tok) = guard.as_mut()?;

    let enc = tok.encode(input, true).ok()?;
    let ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
    let mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
    let seq = ids.len();
    if seq == 0 {
        return None;
    }
    let shape = vec![1_i64, seq as i64];
    let needs_tt = session.inputs.iter().any(|i| i.name == "token_type_ids");
    let ids_t = Tensor::from_array((shape.clone(), ids)).ok()?;
    let mask_t = Tensor::from_array((shape.clone(), mask.clone())).ok()?;

    let outputs = if needs_tt {
        let tt_t = Tensor::from_array((shape.clone(), vec![0_i64; seq])).ok()?;
        session
            .run(ort::inputs![
                "input_ids" => ids_t,
                "attention_mask" => mask_t,
                "token_type_ids" => tt_t,
            ])
            .ok()?
    } else {
        session
            .run(ort::inputs![
                "input_ids" => ids_t,
                "attention_mask" => mask_t,
            ])
            .ok()?
    };

    // 取 last_hidden_state（否则第一个输出），形状 [1, seq, hidden]
    let mut out_val = None;
    for (name, val) in outputs.iter() {
        if name == "last_hidden_state" {
            out_val = Some(val);
            break;
        }
        if out_val.is_none() {
            out_val = Some(val);
        }
    }
    let out_dyn = out_val?;
    let (out_shape, data) = out_dyn.try_extract_tensor::<f32>().ok()?;
    let hidden = *out_shape.last()? as usize;
    if hidden == 0 || data.len() < seq * hidden {
        return None;
    }

    // mean pooling（attention-mask 加权）
    let mut pooled = vec![0f32; hidden];
    let mut denom = 0f32;
    for t in 0..seq {
        let m = mask[t] as f32;
        if m == 0.0 {
            continue;
        }
        denom += m;
        let base = t * hidden;
        for h in 0..hidden {
            pooled[h] += data[base + h] * m;
        }
    }
    if denom == 0.0 {
        return None;
    }
    for v in pooled.iter_mut() {
        *v /= denom;
    }
    // L2 normalize
    let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in pooled.iter_mut() {
            *v /= norm;
        }
    }
    Some(pooled.into_iter().map(|x| x as f64).collect())
}

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn embedding_vec(item: &Value) -> Option<Vec<f64>> {
    item["embedding"]
        .as_array()
        .filter(|a| !a.is_empty())
        .map(|a| a.iter().filter_map(|v| v.as_f64()).collect())
}

// ── 模型/向量化状态 ──

fn dir_size(dir: &PathBuf) -> u64 {
    let mut bytes = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(md) = fs::metadata(&p) {
                if md.is_dir() {
                    bytes += dir_size(&p);
                } else {
                    bytes += md.len();
                }
            }
        }
    }
    bytes
}

/// 检测本地模型文件是否就绪（onnx + config.json + tokenizer.json）。返回 (ready, sizeMB)。
/// 探测 Tauri 缓存目录与 Electron 旧目录，任一命中即就绪。
fn probe_local_model(app: &AppHandle, model: &str) -> (bool, f64) {
    match find_model_dir(app, model) {
        Some(dir) => {
            let bytes = dir_size(&dir);
            (true, ((bytes as f64 / 1024.0 / 1024.0) * 10.0).round() / 10.0)
        }
        None => (false, 0.0),
    }
}

/// 聚合记忆系统整体状态（对齐 getStatus）。
pub fn get_status(app: &AppHandle, cfg: &Value) -> Value {
    let source = cfg["memory"]["embeddingSource"].as_str().unwrap_or("local");
    let model = cfg["memory"]["embeddingModel"]
        .as_str()
        .unwrap_or("Xenova/multilingual-e5-small");
    let model_source = cfg["memory"]["modelSource"].as_str().unwrap_or("auto");
    let list = read_index(app);
    let total = list.len();
    let embedded = list
        .iter()
        .filter(|x| {
            x["embeddingReady"].as_bool().unwrap_or(false)
                && x["embedding"].as_array().map(|a| !a.is_empty()).unwrap_or(false)
        })
        .count();
    let dim = list
        .iter()
        .find_map(|x| x["embedding"].as_array().filter(|a| !a.is_empty()).map(|a| a.len()))
        .unwrap_or(0);
    let (model_ready, model_size_mb) = if source == "local" {
        probe_local_model(app, model)
    } else {
        (false, 0.0)
    };
    json!({
        "source": source,
        "model": model,
        "modelSource": model_source,
        "modelReady": model_ready,
        "modelSizeMB": model_size_mb,
        "total": total,
        "embedded": embedded,
        "dim": dim,
    })
}

// ── Embedding 异步队列（顺序后台 worker，对齐 startWorker）──

struct QueueState {
    ids: VecDeque<String>,
    running: bool,
    ctx: Option<(Value, String)>, // (cfg, api_key)
}

static QUEUE: LazyLock<Mutex<QueueState>> = LazyLock::new(|| {
    Mutex::new(QueueState {
        ids: VecDeque::new(),
        running: false,
        ctx: None,
    })
});

pub fn enqueue(app: &AppHandle, cfg: Value, api_key: String, id: String) {
    let start = {
        let mut q = QUEUE.lock().unwrap();
        q.ids.push_back(id);
        q.ctx = Some((cfg, api_key));
        if q.running {
            false
        } else {
            q.running = true;
            true
        }
    };
    if start {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { run_worker(app).await });
    }
}

pub fn queue_status() -> Value {
    let q = QUEUE.lock().unwrap();
    let n = q.ids.len();
    json!({ "pending": n, "total": n, "running": q.running })
}

async fn run_worker(app: AppHandle) {
    loop {
        let next = {
            let mut q = QUEUE.lock().unwrap();
            match q.ids.pop_front() {
                Some(id) => q.ctx.clone().map(|(c, k)| (id, c, k)),
                None => {
                    q.running = false;
                    None
                }
            }
        };
        match next {
            Some((id, cfg, key)) => {
                let _ = process_embedding(&app, &cfg, &key, &id).await;
            }
            None => break,
        }
    }
}

async fn process_embedding(app: &AppHandle, cfg: &Value, api_key: &str, id: &str) {
    let list = read_index(app);
    let item = match list.iter().find(|x| x["id"].as_str() == Some(id)) {
        Some(i) => i.clone(),
        None => return,
    };
    if item["embedding"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        return; // 已有
    }
    let mut parts = vec![
        item["project"].as_str().unwrap_or("").to_string(),
        item["digest"].as_str().unwrap_or("").to_string(),
    ];
    if let Some(kw) = item["keywords"].as_array() {
        for k in kw {
            parts.push(k.as_str().unwrap_or("").to_string());
        }
    }
    let text = parts.join(" ");
    if let Some(vec) = embed(app, cfg, api_key, &text).await {
        if !vec.is_empty() {
            let mut list = read_index(app);
            if let Some(it) = list.iter_mut().find(|x| x["id"].as_str() == Some(id)) {
                it["embedding"] = json!(vec);
                it["embeddingReady"] = json!(true);
            }
            let _ = write_index(app, &list);
        }
    }
}

// ── LLM 压缩：从报告生成结构化记忆 ──

const MEMORY_SYSTEM_PROMPT: &str = r#"你是一个工作记忆整理助手。用户会提供一份日报/周报及相关的代码提交信息。
请把这份内容压缩成一条结构化的长期记忆，便于将来在用户写简短笔记时推断项目与工作内容。

你必须严格输出 JSON（不要 markdown 代码块、不要额外解释），格式：
{"project":"项目名","date":"YYYY-MM-DD 或日期范围","keywords":["关键概念词"],"digest":"一句话摘要（≤40字）","full":"完整记忆（2-4句，描述做了什么、用了什么技术/功能、产出）"}

keywords 要包含：项目名、功能名、技术栈、业务概念（中英文均可），便于检索匹配。
digest 要高度概括，full 要保留具体细节（如功能名、模块名）。"#;

fn format_date(d: &str) -> String {
    if d.is_empty() {
        return String::new();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(d) {
        return utils::iso_date(dt.with_timezone(&chrono::Local).date_naive());
    }
    if let Ok(nd) = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") {
        return utils::iso_date(nd);
    }
    d.to_string()
}

fn build_memory_user_prompt(report: &Value) -> String {
    let mut parts: Vec<String> = vec!["请把以下报告整理成一条长期记忆：".to_string(), String::new()];
    parts.push("【报告时间范围】".to_string());
    let rs = report["rangeStart"].as_str().map(format_date).unwrap_or_default();
    let re = report["rangeEnd"].as_str().map(format_date).unwrap_or_default();
    parts.push(format!("{} ~ {}", rs, re));
    parts.push(String::new());
    parts.push("【报告正文】".to_string());
    parts.push(report["text"].as_str().unwrap_or("").to_string());
    parts.push(String::new());
    if let Some(days) = report["days"].as_array() {
        if !days.is_empty() {
            parts.push("【分天明细】".to_string());
            for d in days {
                if let Some(paras) = d["paragraphs"].as_array() {
                    if !paras.is_empty() {
                        parts.push(format!("{}:", d["dayStr"].as_str().unwrap_or("")));
                        for p in paras {
                            let t = if p.is_string() {
                                p.as_str().unwrap_or("")
                            } else {
                                p["text"].as_str().unwrap_or("")
                            };
                            parts.push(format!("  {}", t));
                        }
                    }
                }
            }
        }
    }
    parts.push(String::new());
    parts.push("请输出 JSON。".to_string());
    parts.join("\n")
}

/// 从 LLM 返回里解析 JSON（容错：去 markdown 包裹 + 截取首尾花括号）。
fn parse_memory_json(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    let mut s = text.trim().to_string();
    s = RE_FENCE_START.replace(&s, "").to_string();
    s = RE_FENCE_END.replace(&s, "").to_string();
    if let (Some(i), Some(j)) = (s.find('{'), s.rfind('}')) {
        if j > i {
            s = s[i..=j].to_string();
        }
    }
    serde_json::from_str(&s).ok()
}

fn keyword_string(k: &Value) -> String {
    if let Some(s) = k.as_str() {
        s.to_string()
    } else {
        k.to_string()
    }
}

/// 从报告构建一条记忆 entry（不落盘）。无正文返回 None；LLM 调用失败返回 None；脏 JSON 走兜底。
async fn build_memory_entry(report: &Value, cfg: &Value, api_key: &str) -> Option<Value> {
    let has_text = report["text"].as_str().map(|t| !t.is_empty()).unwrap_or(false);
    let has_days = report["days"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !has_text && !has_days {
        return None;
    }
    let provider = match llm::create_provider(cfg, api_key) {
        Ok(p) => p,
        Err(_) => return None,
    };
    let user = build_memory_user_prompt(report);
    let res = match provider.summarize(MEMORY_SYSTEM_PROMPT, &user).await {
        Ok(r) => r,
        Err(_) => return None,
    };
    let parsed = parse_memory_json(&res.text);
    let valid = parsed
        .as_ref()
        .map(|p| p["project"].as_str().map(|s| !s.is_empty()).unwrap_or(false))
        .unwrap_or(false);
    if !valid {
        return Some(fallback_entry(report));
    }
    let p = parsed.unwrap();
    let keywords: Vec<Value> = p["keywords"]
        .as_array()
        .map(|a| a.iter().take(20).map(|k| json!(keyword_string(k))).collect())
        .unwrap_or_default();
    let date = p["date"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| report["rangeStart"].as_str().map(format_date).unwrap_or_default());
    let full = p["full"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| p["digest"].as_str())
        .unwrap_or("");
    let now = utils::now_iso();
    Some(json!({
        "id": new_id(),
        "date": date,
        "project": p["project"].as_str().unwrap_or(""),
        "keywords": keywords,
        "digest": p["digest"].as_str().unwrap_or(""),
        "full": full,
        "embedding": Value::Null,
        "embeddingReady": false,
        "model": res.model,
        "createdAt": now,
        "updatedAt": now,
    }))
}

fn fallback_entry(report: &Value) -> Value {
    let first = &report["days"][0]["paragraphs"][0];
    let first_text = if first.is_string() {
        first.as_str().unwrap_or("").to_string()
    } else {
        first["text"].as_str().unwrap_or("").to_string()
    };
    let project = RE_PROJECT
        .captures(&first_text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();
    let date = report["rangeStart"].as_str().map(format_date).unwrap_or_default();
    let now = utils::now_iso();
    json!({
        "id": new_id(),
        "date": date,
        "project": if project.is_empty() { "未分类".to_string() } else { project },
        "keywords": tokenize(&first_text).into_iter().take(10).collect::<Vec<_>>(),
        "digest": first_text.chars().take(40).collect::<String>(),
        "full": first_text,
        "embedding": Value::Null,
        "embeddingReady": false,
        "createdAt": now,
        "updatedAt": now,
    })
}

/// 保存 entry：写 entries/{id}.md + 更新 index.json（不含 embedding 写入 md）。
fn save_entry(app: &AppHandle, entry: &Value) -> Option<Value> {
    let id = entry["id"].as_str().filter(|s| !s.is_empty())?;
    fs::create_dir_all(entries_dir(app)).ok()?;
    let keywords_str = entry["keywords"]
        .as_array()
        .map(|a| a.iter().filter_map(|k| k.as_str()).collect::<Vec<_>>().join("、"))
        .unwrap_or_default();
    let full_content = [
        format!("# {}", entry["project"].as_str().filter(|s| !s.is_empty()).unwrap_or("未分类")),
        String::new(),
        format!("- 日期：{}", entry["date"].as_str().unwrap_or("")),
        format!("- 摘要：{}", entry["digest"].as_str().unwrap_or("")),
        format!("- 关键词：{}", keywords_str),
        String::new(),
        entry["full"].as_str().unwrap_or("").to_string(),
        String::new(),
    ]
    .join("\n");
    let _ = fs::write(entry_path(app, id), full_content);

    let now = utils::now_iso();
    let idx_item = json!({
        "id": id,
        "date": entry["date"].clone(),
        "project": entry["project"].clone(),
        "keywords": entry["keywords"].as_array().cloned().map(Value::Array).unwrap_or_else(|| json!([])),
        "digest": entry["digest"].as_str().unwrap_or(""),
        "embedding": if entry["embedding"].is_null() { Value::Null } else { entry["embedding"].clone() },
        "embeddingReady": entry["embeddingReady"].as_bool().unwrap_or(false),
        "updatedAt": entry["updatedAt"].as_str().unwrap_or(&now),
        "createdAt": entry["createdAt"].as_str().unwrap_or(&now),
    });
    let mut list = read_index(app);
    if let Some(pos) = list.iter().position(|x| x["id"].as_str() == Some(id)) {
        list[pos] = idx_item.clone();
    } else {
        list.insert(0, idx_item.clone());
    }
    list.truncate(1000);
    let _ = write_index(app, &list);
    Some(idx_item)
}

pub fn delete_entry(app: &AppHandle, id: &str) -> Value {
    let list = read_index(app);
    let next: Vec<Value> = list.into_iter().filter(|x| x["id"].as_str() != Some(id)).collect();
    let _ = write_index(app, &next);
    let _ = fs::remove_file(entry_path(app, id));
    json!({ "ok": true })
}

// ── 混合检索：关键词预筛 + 语义重排 ──

pub async fn search(app: &AppHandle, query: &str, top_k: usize, cfg: &Value) -> Value {
    if query.trim().is_empty() {
        return json!([]);
    }
    let list = read_index(app);
    if list.is_empty() {
        return json!([]);
    }
    let q_tokens: std::collections::HashSet<String> = tokenize(query).into_iter().collect();

    // 1) 关键词预筛
    let mut scored: Vec<(usize, &Value)> = list
        .iter()
        .map(|item| {
            let mut item_tokens: std::collections::HashSet<String> = std::collections::HashSet::new();
            if let Some(kw) = item["keywords"].as_array() {
                for k in kw {
                    if let Some(s) = k.as_str() {
                        item_tokens.insert(s.to_string());
                    }
                }
            }
            for t in tokenize(item["project"].as_str().unwrap_or("")) {
                item_tokens.insert(t);
            }
            for t in tokenize(item["digest"].as_str().unwrap_or("")) {
                item_tokens.insert(t);
            }
            let hits = q_tokens.iter().filter(|t| item_tokens.contains(*t)).count();
            (hits, item)
        })
        .collect();

    let mut candidates: Vec<(usize, &Value)> =
        scored.iter().filter(|(h, _)| *h > 0).cloned().collect();
    if candidates.is_empty() {
        candidates = std::mem::take(&mut scored);
    }

    // 2) 语义重排（有向量才重排；本地模型缺失/下载失败时 q_vec=None → 关键词得分）
    let q_vec = embed(app, cfg, "", query).await;

    candidates.sort_by(|a, b| {
        let av = embedding_vec(a.1);
        let bv = embedding_vec(b.1);
        if let (Some(qv), Some(va), Some(vb)) = (&q_vec, &av, &bv) {
            return cosine(qv, vb)
                .partial_cmp(&cosine(qv, va))
                .unwrap_or(std::cmp::Ordering::Equal);
        }
        if q_vec.is_some() && av.is_some() && bv.is_none() {
            return std::cmp::Ordering::Less;
        }
        if q_vec.is_some() && av.is_none() && bv.is_some() {
            return std::cmp::Ordering::Greater;
        }
        b.0.cmp(&a.0)
    });

    let top = candidates.into_iter().take(if top_k == 0 { 5 } else { top_k });

    // 3) 仅对 topK 加载全文
    let hits: Vec<Value> = top
        .map(|(hits, item)| {
            let mut full = item["digest"].as_str().unwrap_or("").to_string();
            if let Ok(raw) = fs::read_to_string(entry_path(app, item["id"].as_str().unwrap_or(""))) {
                let body: String = raw
                    .split('\n')
                    .filter(|l| !l.starts_with('#') && !l.starts_with("- "))
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string();
                if !body.is_empty() {
                    full = body;
                }
            }
            let score = match (&q_vec, embedding_vec(item)) {
                (Some(qv), Some(iv)) => cosine(qv, &iv),
                _ => hits as f64,
            };
            json!({
                "id": item["id"],
                "date": item["date"],
                "project": item["project"],
                "digest": item["digest"],
                "keywords": item["keywords"].as_array().cloned().map(Value::Array).unwrap_or_else(|| json!([])),
                "full": full,
                "score": score,
            })
        })
        .collect();
    Value::Array(hits)
}

// ── 用记忆辅助推断项目 ──

const INFER_SYSTEM_PROMPT: &str = r#"你是一个项目推断助手。用户正在写一段简短、可能信息不全的工作笔记。
我会提供一些历史记忆条目（项目、摘要、关键词）。请根据用户笔记内容，判断它最可能属于哪个项目、以及在做什么工作。

你必须严格输出 JSON（不要 markdown 代码块）：
{"project":"推断的项目名（若无法判断则空字符串）","confidence":0到1的数字,"reason":"推断理由（≤30字）","suggestedSummary":"基于记忆补全的一句话工作描述"}

如果没有任何记忆能匹配，project 返回空字符串、confidence 返回 0。"#;

pub async fn infer_project(app: &AppHandle, cfg: &Value, api_key: &str, note_text: &str) -> Value {
    if note_text.trim().chars().count() < 3 {
        return json!({ "project": "", "confidence": 0 });
    }
    let top_k = cfg["memory"]["topK"].as_u64().unwrap_or(5) as usize;
    let hits_val = search(app, note_text, top_k, cfg).await;
    let hits = hits_val.as_array().cloned().unwrap_or_default();
    if hits.is_empty() {
        return json!({ "project": "", "confidence": 0, "reason": "无匹配记忆" });
    }

    let provider = match llm::create_provider(cfg, api_key) {
        Ok(p) => p,
        Err(_) => {
            return json!({
                "project": hits[0]["project"],
                "confidence": hits[0]["score"],
                "reason": "LLM 失败，取最相似记忆",
                "matches": hits,
            })
        }
    };
    let memory_block = hits
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let kw = h["keywords"]
                .as_array()
                .map(|a| a.iter().filter_map(|k| k.as_str()).collect::<Vec<_>>().join("、"))
                .unwrap_or_default();
            format!(
                "{}. 项目【{}】（{}）：{}\n   关键词：{}\n   详情：{}",
                i + 1,
                h["project"].as_str().unwrap_or(""),
                h["date"].as_str().unwrap_or(""),
                h["digest"].as_str().unwrap_or(""),
                kw,
                h["full"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "用户当前笔记：\n{}\n\n相关历史记忆：\n{}\n\n请输出 JSON。",
        note_text, memory_block
    );

    let matches: Vec<Value> = hits
        .iter()
        .map(|h| json!({ "project": h["project"], "date": h["date"], "digest": h["digest"], "score": h["score"] }))
        .collect();

    let res = match provider.summarize(INFER_SYSTEM_PROMPT, &user).await {
        Ok(r) => r,
        Err(_) => {
            return json!({
                "project": hits[0]["project"],
                "confidence": hits[0]["score"],
                "reason": "LLM 失败，取最相似记忆",
                "matches": matches,
            })
        }
    };
    let parsed = match parse_memory_json(&res.text) {
        Some(p) => p,
        None => {
            return json!({
                "project": hits[0]["project"],
                "confidence": hits[0]["score"],
                "reason": "LLM 返回不可解析",
                "matches": matches,
            })
        }
    };
    json!({
        "project": parsed["project"].as_str().unwrap_or(""),
        "confidence": parsed["confidence"].as_f64().unwrap_or(0.0),
        "reason": parsed["reason"].as_str().unwrap_or(""),
        "suggestedSummary": parsed["suggestedSummary"].as_str().unwrap_or(""),
        "matches": matches,
    })
}

// ── 全量重建 + 报告后自动建记忆 ──

pub async fn rebuild(app: &AppHandle, cfg: Value, api_key: String, task_id: String) -> Value {
    let history = crate::history::read_history(app);
    let total = history.len();
    // 清空旧索引与条目
    let _ = write_index(app, &[]);
    if let Ok(rd) = fs::read_dir(entries_dir(app)) {
        for e in rd.flatten() {
            let _ = fs::remove_file(e.path());
        }
    }
    let mut generated = 0;
    let mut failed = 0;
    for (i, h) in history.iter().enumerate() {
        let report = json!({
            "text": h["text"].as_str().unwrap_or(""),
            "rangeStart": h["rangeStart"],
            "rangeEnd": h["rangeEnd"],
            "days": h["days"],
        });
        match build_memory_entry(&report, &cfg, &api_key).await {
            Some(entry) => {
                save_entry(app, &entry);
                enqueue(
                    app,
                    cfg.clone(),
                    api_key.clone(),
                    entry["id"].as_str().unwrap_or("").to_string(),
                );
                generated += 1;
            }
            None => failed += 1,
        }
        app.state::<tasks::Tasks>().update(
            &task_id,
            Some(format!("{}/{}", i + 1, total)),
            Some(Some(tasks::Progress {
                done: (i + 1) as f64,
                total: total as f64,
                label: format!("{}/{}", i + 1, total),
            })),
            None,
        );
    }
    json!({ "generated": generated, "failed": failed })
}

/// 报告生成后 fire-and-forget 建一条记忆（对齐 pipeline.js autoGenerate）。
pub async fn auto_generate(app: &AppHandle, cfg: Value, api_key: String, report: Value) {
    if let Some(entry) = build_memory_entry(&report, &cfg, &api_key).await {
        if let Some(saved) = save_entry(app, &entry) {
            enqueue(
                app,
                cfg,
                api_key,
                saved["id"].as_str().unwrap_or("").to_string(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_english_and_cjk() {
        let t = tokenize("修复 Login 模块");
        assert!(t.iter().any(|x| x == "login"));
        assert!(t.iter().any(|x| x == "修复"));
        assert!(t.iter().any(|x| x == "模块"));
    }

    #[test]
    fn cosine_basic() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-9);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0); // 维度不等
    }

    #[test]
    fn parse_memory_json_strips_fence() {
        let v = parse_memory_json("```json\n{\"project\":\"WeekLog\",\"digest\":\"x\"}\n```").unwrap();
        assert_eq!(v["project"], "WeekLog");
    }

    #[test]
    fn format_date_normalizes() {
        assert_eq!(format_date("2026-06-19"), "2026-06-19");
        assert_eq!(format_date(""), "");
    }

    #[test]
    fn fallback_entry_extracts_project() {
        let report = json!({
            "rangeStart": "2026-06-19",
            "days": [{ "paragraphs": ["项目：WeekLog 完成了迁移工作"] }],
        });
        let e = fallback_entry(&report);
        assert_eq!(e["project"], "WeekLog");
        assert_eq!(e["date"], "2026-06-19");
    }
}
