//! 编排层：对齐 src/main/pipeline.js。
//! collect（采集 + 笔记 + 聚合，dry-run）与 generate（完整生成：并发 AI 总结 + 失败降级 + 渲染）。

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;

use futures::stream::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::aggregator::{self, Bucket};
use crate::tasks::{Progress, Tasks};
use crate::{git, llm, notes, prefs, prompt, render, utils};

static CONV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(feat|fix|perf|refactor|docs|test|chore|style|build|ci)(\(.+?\))?:\s*").unwrap()
});

fn default_true() -> bool {
    true
}

/// cfg.repos 单项（取生成所需字段）。
#[derive(Debug, Deserialize, Default)]
struct RepoCfg {
    #[serde(default)]
    path: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    alias: String,
    #[serde(default)]
    author: String,
    #[serde(default = "default_true")]
    enabled: bool,
}

/// 采集/生成选项（对齐渲染层 GenerateOptions；repos/projects 为内部过滤）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectOptions {
    #[serde(default)]
    pub no_notes: bool,
    pub format: Option<String>,
    pub author: Option<Value>,
    pub merge: Option<String>,
    pub week_start: Option<String>,
    pub with_commits: Option<bool>,
    pub show_notes: Option<bool>,
    pub newline: Option<String>,
    #[serde(rename = "_reportType")]
    pub report_type: Option<String>,
    #[serde(default)]
    pub repos: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct RepoError {
    pub repo: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollectStats {
    pub commit_count: usize,
    pub note_count: usize,
    pub note_project_count: usize,
    pub note_misc_count: usize,
    pub bucket_count: usize,
    pub notes_only_count: usize,
    pub days: usize,
    pub est_tokens: usize,
    pub repo_errors: Vec<RepoError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectRange {
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

#[derive(Serialize)]
pub struct CollectResult {
    pub stats: CollectStats,
    pub range: CollectRange,
}

/// 生成报告结果（对齐渲染层 Report）。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_end: Option<String>,
    pub failed_units: Vec<String>,
}

/// collect 的完整产物（内部用；command collect 只取 stats+range）。
struct Collected {
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
    timezone: Option<String>,
    buckets: Vec<Bucket>,
    stats: CollectStats,
}

fn value_to_str_vec(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => vec![s.clone()],
        Value::Array(a) => a
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn cfg_str<'a>(cfg: &'a Value, path: &[&str], fallback: &'a str) -> &'a str {
    let mut node = cfg;
    for key in path {
        node = &node[key];
    }
    node.as_str().unwrap_or(fallback)
}

/// 采集 + 加载笔记 + 聚合（对齐 pipeline.js collect 的内部产物）。
fn collect_internal(
    cfg: &Value,
    range_opts: &utils::RangeOpts,
    notes_dir: &str,
    options: &CollectOptions,
) -> Result<Collected, String> {
    let week_start = options
        .week_start
        .clone()
        .unwrap_or_else(|| cfg_str(cfg, &["weekStart"], "monday").to_string());
    let (from_d, to_d) = utils::resolve_range(range_opts, &week_start)?;
    let from = utils::iso_date(from_d);
    let to = utils::iso_date(to_d);
    let misc_project = cfg_str(cfg, &["notes", "miscProject"], "日常工作").to_string();

    // 启用的仓库（默认启用，除非显式 enabled=false），再按 options.repos 过滤
    let all_repos: Vec<RepoCfg> = serde_json::from_value(cfg["repos"].clone()).unwrap_or_default();
    let repos: Vec<&RepoCfg> = all_repos
        .iter()
        .filter(|r| r.enabled)
        .filter(|r| {
            options.repos.is_empty()
                || options.repos.contains(&r.name)
                || options.repos.contains(&r.path)
        })
        .collect();

    // 过滤器：author（options 优先，回退 cfg.filters.author）、mergeCommits
    let mut author_filter = options
        .author
        .as_ref()
        .map(value_to_str_vec)
        .unwrap_or_default();
    if author_filter.is_empty() {
        if let Some(arr) = cfg["filters"]["author"].as_array() {
            author_filter = arr
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
        }
    }
    let merge_mode = options
        .merge
        .clone()
        .unwrap_or_else(|| cfg_str(cfg, &["filters", "mergeCommits"], "exclude").to_string());

    // 逐仓库采集（单仓库失败记录到 repoErrors，不影响整体）
    let mut all_commits = Vec::new();
    let mut repo_errors = Vec::new();
    for r in &repos {
        let target = git::RepoTarget {
            path: r.path.clone(),
            name: r.name.clone(),
            author: r.author.clone(),
        };
        match git::collect_repo(&target, &from, &to, &merge_mode, &author_filter) {
            Ok(mut cs) => all_commits.append(&mut cs),
            Err(e) => repo_errors.push(RepoError {
                repo: if !r.name.is_empty() {
                    r.name.clone()
                } else {
                    r.path.clone()
                },
                error: e,
            }),
        }
    }

    let notes_list = if options.no_notes {
        Vec::new()
    } else {
        notes::load_notes(notes_dir, &from, &to, &misc_project)?
    };

    let commit_count = all_commits.len();
    let note_count = notes_list.len();
    let note_project_count = notes_list
        .iter()
        .filter(|n| n.project.as_deref().map(|p| !p.is_empty()).unwrap_or(false))
        .count();
    let note_misc_count = note_count - note_project_count;

    let repo_metas: Vec<aggregator::RepoMeta> = repos
        .iter()
        .map(|r| aggregator::RepoMeta {
            name: r.name.clone(),
            alias: r.alias.clone(),
        })
        .collect();
    let mut buckets = aggregator::aggregate(all_commits, notes_list, &misc_project, &repo_metas);

    // 项目过滤（保留 miscProject 兜底段）
    if !options.projects.is_empty() {
        let mut allow: HashSet<String> = options.projects.iter().cloned().collect();
        allow.insert(misc_project.clone());
        buckets.retain(|b| allow.contains(&b.project));
    }

    let est_tokens: usize = buckets.iter().map(prompt::estimate_bucket_tokens).sum();
    let day_set: HashSet<&str> = buckets.iter().map(|b| b.day_str.as_str()).collect();
    let notes_only_count = buckets.iter().filter(|b| b.is_notes_only).count();
    let bucket_count = buckets.len();
    let days = day_set.len();

    Ok(Collected {
        from: from_d,
        to: to_d,
        timezone: cfg["timezone"].as_str().map(|s| s.to_string()),
        buckets,
        stats: CollectStats {
            commit_count,
            note_count,
            note_project_count,
            note_misc_count,
            bucket_count,
            notes_only_count,
            days,
            est_tokens,
            repo_errors,
        },
    })
}

/// 采集（dry-run，对齐 pipeline.js collect）。
pub fn collect(
    cfg: &Value,
    range_opts: &utils::RangeOpts,
    notes_dir: &str,
    options: &CollectOptions,
) -> Result<CollectResult, String> {
    let c = collect_internal(cfg, range_opts, notes_dir, options)?;
    Ok(CollectResult {
        range: CollectRange {
            from: utils::iso_date(c.from),
            to: utils::iso_date(c.to),
            timezone: c.timezone,
        },
        stats: c.stats,
    })
}

fn strip_conv_prefix(s: &str) -> String {
    CONV_RE.replace(s, "").trim().to_string()
}

/// AI 失败时的本地降级摘要（对齐 pipeline.js fallbackSummary）。
fn fallback_summary(bucket: &Bucket) -> String {
    let mut items: Vec<String> = Vec::new();
    for c in bucket.commits.iter().take(8) {
        let s = strip_conv_prefix(&c.subject);
        if !s.is_empty() {
            items.push(s);
        }
    }
    for n in &bucket.notes {
        if !n.content.is_empty() {
            items.push(n.content.clone());
        }
    }
    for n in &bucket.shared_notes {
        if !n.content.is_empty() {
            items.push(n.content.clone());
        }
    }
    let more = if bucket.commits.len() > 8 {
        format!("，以及其余 {} 项改动", bucket.commits.len() - 8)
    } else {
        String::new()
    };
    format!(
        "本日主要完成：{}{}。（注：AI 总结不可用，以上为提交与笔记摘要）",
        items.join("；"),
        more
    )
}

/// 构造渲染段落（对齐 pipeline.js makeParagraph）。
fn make_paragraph(bucket: &Bucket, text: String, degraded: bool) -> render::RenderParagraph {
    render::RenderParagraph {
        project: if bucket.display_name.is_empty() {
            bucket.project.clone()
        } else {
            bucket.display_name.clone()
        },
        text,
        degraded,
        commits: bucket.commits.clone(),
        notes: bucket.notes.clone(),
        shared_notes: bucket.shared_notes.clone(),
    }
}

/// 完整生成报告（采集 → 笔记 → 聚合 → 并发 AI 总结 → 渲染），对齐 pipeline.js generate。
/// 进度经 generate:progress 事件 + tasks.update（task_id）双推送。
pub async fn generate(
    app: AppHandle,
    cfg: Value,
    api_key: String,
    range_opts: utils::RangeOpts,
    notes_dir: String,
    options: CollectOptions,
    task_id: String,
) -> Report {
    let t0 = utils::now_ms();
    let collected = match collect_internal(&cfg, &range_opts, &notes_dir, &options) {
        Ok(c) => c,
        Err(e) => {
            return Report {
                error: Some(e),
                ..Default::default()
            }
        }
    };

    if collected.buckets.is_empty() {
        return Report {
            range_start: Some(utils::iso_date(collected.from)),
            range_end: Some(utils::iso_date(collected.to)),
            text: Some(
                "指定范围内无工作记录（无 commit 且无笔记）。请检查时间范围、作者过滤或笔记。"
                    .to_string(),
            ),
            meta: Some(json!({ "empty": true, "durationMs": (utils::now_ms() - t0) as u64 })),
            ..Default::default()
        };
    }

    let provider = match llm::create_provider(&cfg, &api_key) {
        Ok(p) => p,
        Err(e) => {
            return Report {
                error: Some(e.message()),
                ..Default::default()
            }
        }
    };

    let system_prompt = prompt::build_system_prompt(&prefs::enabled_rules(&app));
    let buckets = collected.buckets;
    let total = buckets.len();
    let user_prompts: Vec<String> = buckets.iter().map(prompt::build_user_prompt).collect();
    let limit = cfg["ai"]["concurrency"].as_u64().unwrap_or(3).max(1) as usize;
    let concurrency = limit.min(total).max(1);
    let done = AtomicUsize::new(0);

    // 并发总结：单桶失败降级为本地摘要，整份报告仍产出
    let mut outcomes: Vec<(usize, render::RenderParagraph, u64, u64, Option<String>)> =
        futures::stream::iter(0..total)
            .map(|i| {
                let provider = &provider;
                let system = system_prompt.as_str();
                let user = user_prompts[i].as_str();
                let b = &buckets[i];
                let app = app.clone();
                let task_id = task_id.as_str();
                let done = &done;
                async move {
                    let (para, it, ot, failed) = match provider.summarize(system, user).await {
                        Ok(r) => (make_paragraph(b, r.text, false), r.input_tokens, r.output_tokens, None),
                        Err(_) => (
                            make_paragraph(b, fallback_summary(b), true),
                            0,
                            0,
                            Some(format!("{} {}", b.day_str, b.project)),
                        ),
                    };
                    let d = done.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit(
                        "generate:progress",
                        json!({ "done": d, "total": total, "project": b.project, "dayStr": b.day_str }),
                    );
                    app.state::<Tasks>().update(
                        task_id,
                        Some(format!("AI 融合生成中… {d}/{total}（{}）", b.project)),
                        Some(Some(Progress {
                            done: d as f64,
                            total: total as f64,
                            label: b.project.clone(),
                        })),
                        None,
                    );
                    (i, para, it, ot, failed)
                }
            })
            .buffer_unordered(concurrency)
            .collect()
            .await;

    outcomes.sort_by_key(|o| o.0);
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut failed_units = Vec::new();
    let mut paragraphs: Vec<render::RenderParagraph> = Vec::with_capacity(total);
    for (_, para, it, ot, failed) in outcomes {
        input_tokens += it;
        output_tokens += ot;
        if let Some(f) = failed {
            failed_units.push(f);
        }
        paragraphs.push(para);
    }

    // 按天分组（buckets 已按日期升序排序，paragraphs 同序）
    let mut days: Vec<render::RenderDay> = Vec::new();
    for (b, para) in buckets.iter().zip(paragraphs.into_iter()) {
        if days.last().map(|d| d.day) != Some(b.day) {
            days.push(render::RenderDay {
                day: b.day,
                paragraphs: Vec::new(),
            });
        }
        days.last_mut().unwrap().paragraphs.push(para);
    }

    let format = options
        .format
        .clone()
        .or_else(|| cfg["output"]["format"].as_str().map(String::from))
        .unwrap_or_else(|| "text".to_string());
    let with_commits = options
        .with_commits
        .unwrap_or_else(|| cfg["output"]["withCommits"].as_bool().unwrap_or(false));
    let show_notes = options
        .show_notes
        .unwrap_or_else(|| cfg["output"]["showNotes"].as_bool().unwrap_or(false));
    let newline = options
        .newline
        .clone()
        .unwrap_or_else(|| cfg["output"]["newline"].as_str().unwrap_or("LF").to_string());

    let report = render::RenderReport {
        days,
        range_start: Some(collected.from),
        range_end: Some(collected.to),
        failed_units: failed_units.clone(),
    };
    let text = render::render(
        &report,
        &render::RenderOpts {
            format,
            newline,
            with_commits,
            show_notes,
        },
    );

    let repo_errors = serde_json::to_value(&collected.stats.repo_errors).unwrap_or_else(|_| json!([]));
    let meta = json!({
        "provider": cfg["ai"]["provider"].as_str().unwrap_or(""),
        "model": provider.model,
        "commitCount": collected.stats.commit_count,
        "noteCount": collected.stats.note_count,
        "bucketCount": total,
        "notesOnlyCount": collected.stats.notes_only_count,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "durationMs": (utils::now_ms() - t0) as u64,
        "repoErrors": repo_errors,
    });

    // AI 记忆 fire-and-forget（报告成功后异步建记忆，对齐 pipeline.js autoGenerate）
    if total > 0
        && cfg["memory"]["enabled"].as_bool().unwrap_or(false)
        && cfg["memory"]["autoGenerate"].as_bool().unwrap_or(false)
        && !api_key.is_empty()
    {
        let app2 = app.clone();
        let cfg2 = cfg.clone();
        let key2 = api_key.clone();
        let mem_report = json!({
            "text": text.clone(),
            "rangeStart": utils::iso_date(collected.from),
            "rangeEnd": utils::iso_date(collected.to),
        });
        tauri::async_runtime::spawn(async move {
            crate::memory::auto_generate(&app2, cfg2, key2, mem_report).await;
        });
    }

    Report {
        text: Some(text),
        range_start: Some(utils::iso_date(collected.from)),
        range_end: Some(utils::iso_date(collected.to)),
        meta: Some(meta),
        failed_units,
        error: None,
    }
}
