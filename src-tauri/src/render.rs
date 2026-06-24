//! 渲染：对齐 src/main/render.js。
//! 把报告渲染为 compact / text / md / json；并提供 convert_format() 在 compact/text/md
//! 三种格式间互转（不调 AI，纯字符串解析 + 重渲染，解析失败回退原文本保证不丢内容）。

use std::sync::LazyLock;

use chrono::NaiveDate;
use regex::Regex;
use serde::Serialize;

use crate::git::Commit;
use crate::notes::Note;
use crate::utils;

// ── 渲染数据结构（generate 构造含明细；convert 解析仅 project/text）──

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderParagraph {
    pub project: String,
    pub text: String,
    pub degraded: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub commits: Vec<Commit>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<Note>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shared_notes: Vec<Note>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDay {
    pub day: NaiveDate,
    pub paragraphs: Vec<RenderParagraph>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderReport {
    pub days: Vec<RenderDay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_start: Option<NaiveDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_end: Option<NaiveDate>,
    pub failed_units: Vec<String>,
}

/// 渲染选项（对齐 render.js opts）。
pub struct RenderOpts {
    pub format: String,
    pub newline: String,
    pub with_commits: bool,
    pub show_notes: bool,
}

impl Default for RenderOpts {
    fn default() -> Self {
        RenderOpts {
            format: "text".to_string(),
            newline: "LF".to_string(),
            with_commits: false,
            show_notes: false,
        }
    }
}

// ── 解析正则（对齐 render.js 的常量正则）──

static DATE_PARTS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})/(\d{1,2})/(\d{1,2})$").unwrap());
static DATE_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4}/\d{1,2}/\d{1,2})(?:\s+(.*))?$").unwrap());
static PARA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^【([^】]+)】：?(.*)$").unwrap());
static MD_PARA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-\s*\*\*【([^】]+)】\*\*：?(.*)$").unwrap());
static MD_DATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^##\s*(\d{4}/\d{1,2}/\d{1,2})").unwrap());
static MD_TITLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^#\s+工作周报\s*\((\d{4}/\d{1,2}/\d{1,2})\s*-\s*(\d{4}/\d{1,2}/\d{1,2})\)").unwrap()
});
static INLINE_PARA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"【([^】]+)】：?").unwrap());
static FAILED_TC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^⚠\s*以下单元 AI 失败已降级：").unwrap());
static FAILED_MD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^>\s*⚠\s*降级单元：").unwrap());

// ── 渲染 ──

fn apply_newline(newline: &str, s: String) -> String {
    if newline == "CRLF" {
        s.replace('\n', "\r\n")
    } else {
        s
    }
}

/// 把 day 的段落渲染成 `【项目】：摘要` 数组（对齐 paragraphLines）。
fn paragraph_lines(day: &RenderDay, opts: &RenderOpts) -> Vec<String> {
    let mut out = Vec::new();
    for p in &day.paragraphs {
        let mut line = format!("【{}】：{}", p.project, p.text);
        if opts.with_commits && !p.commits.is_empty() {
            let hashes: Vec<&str> = p.commits.iter().map(|c| c.short_hash.as_str()).collect();
            line.push_str(&format!("  (commits: {})", hashes.join(", ")));
        }
        if opts.show_notes {
            let mut notes: Vec<&str> = p.notes.iter().map(|n| n.content.as_str()).collect();
            notes.extend(p.shared_notes.iter().map(|n| n.content.as_str()));
            if !notes.is_empty() {
                line.push_str(&format!("\n    笔记：{}", notes.join("；")));
            }
        }
        out.push(line);
    }
    out
}

fn render_compact(report: &RenderReport, opts: &RenderOpts) -> String {
    let mut lines = Vec::new();
    for day in &report.days {
        let paras: Vec<String> = paragraph_lines(day, opts)
            .iter()
            .map(|l| l.replace('\n', " "))
            .collect();
        if !paras.is_empty() {
            lines.push(format!(
                "{} {}",
                utils::format_date_no_zero(day.day),
                paras.join("")
            ));
        } else {
            lines.push(utils::format_date_no_zero(day.day));
        }
    }
    if !report.failed_units.is_empty() {
        lines.push(format!(
            "⚠ 以下单元 AI 失败已降级：{}",
            report.failed_units.join("；")
        ));
    }
    apply_newline(&opts.newline, lines.join("\n"))
}

fn render_text(report: &RenderReport, opts: &RenderOpts) -> String {
    let mut lines = Vec::new();
    for (i, day) in report.days.iter().enumerate() {
        if i > 0 {
            lines.push(String::new()); // 日期块之间空一行
        }
        lines.push(utils::format_date_no_zero(day.day));
        for l in paragraph_lines(day, opts) {
            lines.push(l);
        }
    }
    if !report.failed_units.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "⚠ 以下单元 AI 失败已降级：{}",
            report.failed_units.join("；")
        ));
    }
    apply_newline(&opts.newline, lines.join("\n"))
}

fn render_markdown(report: &RenderReport, opts: &RenderOpts) -> String {
    let mut lines = Vec::new();
    // rangeStart/rangeEnd 可能缺失（如从 text/compact 互转而来），缺则用首尾日期兜底，避免 NaN
    let start = report
        .range_start
        .or_else(|| report.days.first().map(|d| d.day))
        .unwrap_or_else(utils::today);
    let end = report
        .range_end
        .or_else(|| report.days.last().map(|d| d.day))
        .unwrap_or(start);
    lines.push(format!(
        "# 工作周报 ({} - {})",
        utils::format_date_no_zero(start),
        utils::format_date_no_zero(end)
    ));
    lines.push(String::new());
    for day in &report.days {
        lines.push(format!("## {}", utils::format_date_no_zero(day.day)));
        for p in &day.paragraphs {
            let mut line = format!("- **【{}】**：{}", p.project, p.text);
            if opts.with_commits && !p.commits.is_empty() {
                let hashes: Vec<&str> = p.commits.iter().map(|c| c.short_hash.as_str()).collect();
                line.push_str(&format!("  (commits: {})", hashes.join(", ")));
            }
            lines.push(line);
        }
        lines.push(String::new());
    }
    if !report.failed_units.is_empty() {
        lines.push(format!("> ⚠ 降级单元：{}", report.failed_units.join("；")));
    }
    apply_newline(&opts.newline, lines.join("\n"))
}

fn render_json(report: &RenderReport) -> String {
    serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".to_string())
}

/// 渲染报告为指定格式（对齐 render.js render）。
pub fn render(report: &RenderReport, opts: &RenderOpts) -> String {
    match opts.format.as_str() {
        "md" => render_markdown(report, opts),
        "compact" => render_compact(report, opts),
        "json" => render_json(report),
        _ => render_text(report, opts),
    }
}

// ── 解析（用于格式互转）──

fn date_label_to_date(label: &str) -> Option<NaiveDate> {
    let caps = DATE_PARTS_RE.captures(label.trim())?;
    let y: i32 = caps[1].parse().ok()?;
    let m: u32 = caps[2].parse().ok()?;
    let d: u32 = caps[3].parse().ok()?;
    NaiveDate::from_ymd_opt(y, m, d)
}

fn simple_para(project: &str, text: &str) -> RenderParagraph {
    RenderParagraph {
        project: project.to_string(),
        text: text.trim().to_string(),
        ..Default::default()
    }
}

/// 从一行中按 `【...】：` 切出多个段落（compact 用，对齐 splitParagraphsFromInline）。
fn split_paragraphs_from_inline(line: &str) -> Vec<RenderParagraph> {
    let mut result = Vec::new();
    let matches: Vec<(usize, usize, String)> = INLINE_PARA_RE
        .captures_iter(line)
        .map(|c| {
            let whole = c.get(0).unwrap();
            (whole.start(), whole.end(), c[1].to_string())
        })
        .collect();
    if matches.is_empty() {
        return result;
    }
    for i in 0..matches.len() {
        let start = matches[i].1;
        let end = if i + 1 < matches.len() {
            matches[i + 1].0
        } else {
            line.len()
        };
        result.push(simple_para(&matches[i].2, &line[start..end]));
    }
    result
}

fn extract_failed(s: &str, re: &Regex) -> Vec<String> {
    re.replace(s, "")
        .split('；')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

enum Parsed {
    Raw(String),
    Report {
        days: Vec<RenderDay>,
        range_start: Option<NaiveDate>,
        range_end: Option<NaiveDate>,
        failed_units: Vec<String>,
    },
}

/// 解析渲染后的文本为结构（对齐 render.js parseRenderedText）。无法解析返回 Raw。
fn parse_rendered_text(text: &str, from_format: &str) -> Parsed {
    let raw = text.to_string();
    if raw.trim().is_empty() {
        return Parsed::Raw(raw);
    }
    // 统一换行为 \n
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let mut failed_units: Vec<String> = Vec::new();
    let mut days: Vec<RenderDay> = Vec::new();
    let mut range_start: Option<NaiveDate> = None;
    let mut range_end: Option<NaiveDate> = None;

    if from_format == "md" {
        let mut cur: Option<RenderDay> = None;
        for line in &lines {
            if let Some(tm) = MD_TITLE_RE.captures(line) {
                range_start = date_label_to_date(&tm[1]);
                range_end = date_label_to_date(&tm[2]);
                continue;
            }
            if let Some(dm) = MD_DATE_RE.captures(line) {
                if let Some(d) = cur.take() {
                    days.push(d);
                }
                if let Some(day) = date_label_to_date(&dm[1]) {
                    cur = Some(RenderDay {
                        day,
                        paragraphs: Vec::new(),
                    });
                }
                continue;
            }
            let Some(c) = cur.as_mut() else { continue };
            let trimmed = line.trim();
            if let Some(pm) = MD_PARA_RE.captures(trimmed) {
                c.paragraphs.push(simple_para(&pm[1], &pm[2]));
            } else if FAILED_MD_RE.is_match(trimmed) {
                failed_units = extract_failed(trimmed, &FAILED_MD_RE);
            }
        }
        if let Some(d) = cur.take() {
            days.push(d);
        }
    } else if from_format == "compact" {
        for line in &lines {
            let s = line.trim();
            if s.is_empty() {
                continue;
            }
            if FAILED_TC_RE.is_match(s) {
                failed_units = extract_failed(s, &FAILED_TC_RE);
                continue;
            }
            if let Some(pm) = DATE_PREFIX_RE.captures(s) {
                if let Some(day) = date_label_to_date(&pm[1]) {
                    let inline = pm.get(2).map_or("", |m| m.as_str());
                    days.push(RenderDay {
                        day,
                        paragraphs: split_paragraphs_from_inline(inline),
                    });
                }
            }
        }
    } else {
        // text：按空行切日期块；首行日期；【项目】：为段落
        let mut cur: Option<RenderDay> = None;
        for line in &lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                if let Some(d) = cur.take() {
                    days.push(d);
                }
                continue;
            }
            if let Some(day) = date_label_to_date(trimmed) {
                if let Some(d) = cur.take() {
                    days.push(d);
                }
                cur = Some(RenderDay {
                    day,
                    paragraphs: Vec::new(),
                });
                continue;
            }
            if FAILED_TC_RE.is_match(trimmed) {
                failed_units = extract_failed(trimmed, &FAILED_TC_RE);
                continue;
            }
            if let Some(pm) = PARA_RE.captures(line) {
                if let Some(c) = cur.as_mut() {
                    c.paragraphs.push(simple_para(&pm[1], &pm[2]));
                }
            }
        }
        if let Some(d) = cur.take() {
            days.push(d);
        }
    }

    if days.is_empty() {
        return Parsed::Raw(raw);
    }
    Parsed::Report {
        days,
        range_start,
        range_end,
        failed_units,
    }
}

/// 在 compact / text / md 三种格式间互转（对齐 render.js convertFormat）。
/// 解析失败回退原文本。
pub fn convert_format(text: &str, from: &str, to: &str, newline: &str) -> String {
    let src_format = if from.is_empty() { "text" } else { from };
    let target = if to.is_empty() { "text" } else { to };
    if src_format == target {
        return text.to_string();
    }
    // json 不参与互转，原样返回
    if target == "json" || src_format == "json" {
        return text.to_string();
    }
    match parse_rendered_text(text, src_format) {
        Parsed::Raw(r) => r,
        Parsed::Report {
            days,
            range_start,
            range_end,
            failed_units,
        } => {
            let report = RenderReport {
                days,
                range_start,
                range_end,
                failed_units,
            };
            render(
                &report,
                &RenderOpts {
                    format: target.to_string(),
                    newline: newline.to_string(),
                    with_commits: false,
                    show_notes: false,
                },
            )
        }
    }
}
