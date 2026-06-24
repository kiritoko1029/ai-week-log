//! 笔记模块：对齐 src/main/notes.js。
//! 按天 Markdown 文件存储（notes/YYYY-MM-DD.md），用 `## 项目名` 二级标题分段；
//! miscProject 段或无标题内容视为"通用笔记"（project=null）。

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{llm, utils};

/// 笔记条目（对齐渲染层 Note 类型）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Note {
    pub date: String,
    pub project: Option<String>,
    pub content: String,
    #[serde(default)]
    pub source: String,
}

fn note_file_path(notes_dir: &str, date_str: &str) -> PathBuf {
    PathBuf::from(notes_dir).join(format!("{date_str}.md"))
}

/// 解析单篇笔记文本为 Note[]（对齐 notes.js parseNoteText）。
/// miscProject 段或顶部无标题内容 → project=null。
fn parse_note_text(text: &str, date_str: &str, misc_project: &str, source: &str) -> Vec<Note> {
    let mut notes = Vec::new();
    if text.trim().is_empty() {
        return notes;
    }
    let mut current_heading: String = misc_project.to_string();
    let mut buffer: Vec<&str> = Vec::new();

    let flush = |buffer: &mut Vec<&str>, current_heading: &str| -> Option<Note> {
        let content = buffer.join("\n");
        buffer.clear();
        let content = content.trim();
        if content.is_empty() {
            return None;
        }
        let is_misc = current_heading == misc_project;
        Some(Note {
            date: date_str.to_string(),
            project: if is_misc { None } else { Some(current_heading.trim().to_string()) },
            content: content.to_string(),
            source: source.to_string(),
        })
    };

    for line in text.lines() {
        if let Some(h) = parse_heading(line) {
            if let Some(n) = flush(&mut buffer, &current_heading) {
                notes.push(n);
            }
            current_heading = h;
        } else {
            buffer.push(line);
        }
    }
    if let Some(n) = flush(&mut buffer, &current_heading) {
        notes.push(n);
    }
    notes
}

/// 解析 `## 标题` 行，返回 trim 后的标题。
fn parse_heading(line: &str) -> Option<String> {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix("## ") {
        let h = rest.trim();
        if !h.is_empty() {
            return Some(h.to_string());
        }
    }
    None
}

/// 读取区间内所有笔记（对齐 notes.js loadNotes）。
pub fn load_notes(notes_dir: &str, from: &str, to: &str, misc_project: &str) -> Result<Vec<Note>, String> {
    let mut out = Vec::new();
    if !PathBuf::from(notes_dir).exists() {
        return Ok(out);
    }
    let dates = utils::iterate_dates(from, to)?;
    for date_str in dates {
        let file = note_file_path(notes_dir, &date_str);
        if let Ok(text) = fs::read_to_string(&file) {
            let mut ns = parse_note_text(&text, &date_str, misc_project, &format!("notes/{date_str}.md"));
            out.append(&mut ns);
        }
    }
    Ok(out)
}

/// 读取某天笔记原文（对齐 notes.js getNoteText）。
pub fn get_note_text(notes_dir: &str, date_str: &str) -> String {
    let file = note_file_path(notes_dir, date_str);
    fs::read_to_string(&file).unwrap_or_default()
}

/// 保存某天笔记原文（对齐 notes.js saveNoteText）。
pub fn save_note_text(notes_dir: &str, date_str: &str, text: &str) -> Result<(), String> {
    fs::create_dir_all(notes_dir).map_err(|e| e.to_string())?;
    let file = note_file_path(notes_dir, date_str);
    fs::write(&file, text).map_err(|e| e.to_string())
}

/// 向某天笔记追加一条（对齐 notes.js appendNote）。
/// project 为空或等于 miscProject → 写入 miscProject 段；否则写入对应项目段。
pub fn append_note(
    notes_dir: &str,
    date_str: &str,
    project: &str,
    content: &str,
    misc_project: &str,
) -> Result<String, String> {
    fs::create_dir_all(notes_dir).map_err(|e| e.to_string())?;
    let file = note_file_path(notes_dir, date_str);
    let line = content.trim();
    if line.is_empty() {
        return Ok(file.to_string_lossy().to_string());
    }
    let heading = if project.is_empty() || project == misc_project {
        misc_project
    } else {
        project
    };
    let existing = fs::read_to_string(&file).unwrap_or_default();
    let text = append_segment(&existing, heading, line);
    fs::write(&file, text).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

/// 在文本中指定 heading 段追加一行；段不存在则新建（对齐 notes.js appendSegment）。
fn append_segment(text: &str, heading: &str, line: &str) -> String {
    let lines: Vec<&str> = text.split('\n').flat_map(|l| {
        // 兼容 \r\n：按 \n 切分后去掉残留 \r
        if let Some(stripped) = l.strip_suffix('\r') {
            vec![stripped]
        } else {
            vec![l]
        }
    }).collect();

    // 找到该 heading 段的起始
    if let Some(head_idx) = lines.iter().position(|l| {
        parse_heading(l).map(|h| h == heading).unwrap_or(false)
    }) {
        // 找下一段 `## ` 的位置
        let mut insert_at = head_idx + 1;
        while insert_at < lines.len() && parse_heading(lines[insert_at]).is_none() {
            insert_at += 1;
        }
        // 跳过段尾空行
        let mut p = insert_at;
        while p > head_idx + 1 && lines[p - 1].trim().is_empty() {
            p -= 1;
        }
        let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        out.insert(p, line.to_string());
        return out.join("\n");
    }

    // 段不存在：追加到文件末尾
    let mut result = text.to_string();
    if !result.is_empty() && !result.ends_with('\n') {
        result.push('\n');
    }
    result.push_str(&format!("\n## {heading}\n{line}\n"));
    result
}

static NL3_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

// ── 精简替换（对齐 notes.js replaceNotes / removeNoteLines）──

struct Section {
    heading: String,
    notes: Vec<String>,
}

fn flush_note(buffer: &mut Vec<String>, cur_section: &mut Option<Section>, cur_heading: &str) {
    let c = buffer.join("\n");
    buffer.clear();
    let c = c.trim();
    if c.is_empty() {
        return;
    }
    cur_section
        .get_or_insert_with(|| Section {
            heading: cur_heading.to_string(),
            notes: Vec::new(),
        })
        .notes
        .push(c.to_string());
}

/// 从笔记文本移除匹配的笔记（按 project + 完整 content 匹配，content 可跨多行），
/// 对齐 notes.js removeNoteLines：命中则丢弃整条，其余按原段落顺序重组。
fn remove_note_lines(text: &str, items: &[&Note], misc_project: &str) -> String {
    let mut to_remove: HashSet<String> = HashSet::new();
    for it in items {
        let heading = match it.project.as_deref() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => misc_project.to_string(),
        };
        to_remove.insert(format!("{}\u{0}{}", heading, it.content.trim()));
    }
    if to_remove.is_empty() {
        return text.to_string();
    }

    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut sections: Vec<Section> = Vec::new();
    let mut cur_heading = misc_project.to_string();
    let mut cur_section: Option<Section> = None;
    let mut buffer: Vec<String> = Vec::new();

    for line in normalized.split('\n') {
        if let Some(h) = parse_heading(line) {
            flush_note(&mut buffer, &mut cur_section, &cur_heading);
            if let Some(sec) = cur_section.take() {
                if !sec.notes.is_empty() {
                    sections.push(sec);
                }
            }
            cur_heading = h;
            cur_section = Some(Section {
                heading: cur_heading.clone(),
                notes: Vec::new(),
            });
        } else if line.trim().is_empty() {
            flush_note(&mut buffer, &mut cur_section, &cur_heading);
        } else {
            buffer.push(line.to_string());
        }
    }
    flush_note(&mut buffer, &mut cur_section, &cur_heading);
    if let Some(sec) = cur_section.take() {
        if !sec.notes.is_empty() {
            sections.push(sec);
        }
    }

    // 按原顺序重建：miscProject 段无标题；其余段保留 `## 标题`
    let mut out: Vec<String> = Vec::new();
    for sec in &sections {
        let kept: Vec<&String> = sec
            .notes
            .iter()
            .filter(|c| !to_remove.contains(&format!("{}\u{0}{}", sec.heading, c)))
            .collect();
        if kept.is_empty() {
            continue;
        }
        if sec.heading != misc_project {
            out.push(format!("## {}", sec.heading));
        }
        for c in kept {
            out.push(c.clone());
        }
        out.push(String::new()); // 段间空行
    }
    let joined = out.join("\n");
    let collapsed = NL3_RE.replace_all(&joined, "\n\n");
    format!("{}\n", collapsed.trim())
}

/// 精简替换：移除选中的若干条笔记，再追加一条精简后的笔记（对齐 notes.js replaceNotes）。
pub fn replace_notes(
    notes_dir: &str,
    remove_items: &[Note],
    date_str: &str,
    project: &str,
    content: &str,
    misc_project: &str,
) -> Result<Vec<String>, String> {
    fs::create_dir_all(notes_dir).map_err(|e| e.to_string())?;
    let line = content.trim();
    // 按日期分组待移除项，逐文件处理
    let mut by_date: BTreeMap<String, Vec<&Note>> = BTreeMap::new();
    for it in remove_items {
        if it.date.is_empty() {
            continue;
        }
        by_date.entry(it.date.clone()).or_default().push(it);
    }
    let mut files = Vec::new();
    for (d, items) in &by_date {
        let file = note_file_path(notes_dir, d);
        let text = fs::read_to_string(&file).unwrap_or_default();
        let new_text = remove_note_lines(&text, items, misc_project);
        fs::write(&file, new_text).map_err(|e| e.to_string())?;
        files.push(file.to_string_lossy().to_string());
    }
    // 追加精简后的笔记到目标日期
    if !line.is_empty() {
        let added = append_note(notes_dir, date_str, project, line, misc_project)?;
        if !files.contains(&added) {
            files.push(added);
        }
    }
    Ok(files)
}

// ── AI 精简：多条笔记 → 一条精简小记（对齐 notes.js summarizeNotes）──

const NOTE_SUMMARY_SYSTEM: &str = "你是一名研发工作小记整理助手。
请把多条人工工作笔记合并精简成一条适合写入日报/周报素材的中文小记。
要求：客观、简洁、书面化；合并同类事项、剔除冗余；保留真实完成事项和价值；不要编造未提供的信息。
直接输出精简后的小记内容本身，不要标题、不要解释、不要项目名前缀、不要分点。";

fn build_note_summary_prompt(notes: &[&Note]) -> String {
    let mut lines = vec!["请精简整理以下工作笔记：".to_string(), String::new()];
    for (i, note) in notes.iter().enumerate() {
        let mut meta = Vec::new();
        if let Some(p) = note.project.as_deref() {
            if !p.is_empty() {
                meta.push(format!("项目：{p}"));
            }
        }
        if !note.date.is_empty() {
            meta.push(format!("日期：{}", note.date));
        }
        lines.push(format!("{}. {}", i + 1, note.content));
        if !meta.is_empty() {
            lines.push(format!("   {}", meta.join("；")));
        }
    }
    lines.push(String::new());
    lines.push("请输出一条精简后可直接写入工作小记的中文内容。".to_string());
    lines.join("\n")
}

/// AI 精简笔记（多条 → 一条），对齐 notes.js summarizeNotes。返回 {text,model,…} 或 {error}。
pub async fn summarize_notes(notes: &[Note], provider: &llm::Provider) -> Value {
    let items: Vec<&Note> = notes
        .iter()
        .filter(|n| !n.content.trim().is_empty())
        .collect();
    if items.is_empty() {
        return json!({ "text": "", "model": "" });
    }
    match provider
        .summarize(NOTE_SUMMARY_SYSTEM, &build_note_summary_prompt(&items))
        .await
    {
        Ok(r) => json!({
            "text": r.text.trim(),
            "model": r.model,
            "inputTokens": r.input_tokens,
            "outputTokens": r.output_tokens,
        }),
        Err(e) => json!({ "error": e.message() }),
    }
}
