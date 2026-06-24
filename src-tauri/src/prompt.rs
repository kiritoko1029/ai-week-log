//! Prompt 工程 + token 估算：对齐 src/main/llm/index.js 的纯函数部分。
//! provider 调用（OpenAI/Anthropic 网络请求）属于后续 LLM 阶段，本模块只负责
//! 把桶渲染为 system/user prompt，并估算 token。

use std::sync::LazyLock;

use regex::Regex;

use crate::aggregator::Bucket;
use crate::utils;

static MULTI_NL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n+").unwrap());

/// 报告生成基础系统提示词（对齐 llm/index.js SYSTEM_PROMPT_BASE）。
pub const SYSTEM_PROMPT_BASE: &str = "你是一名资深研发周报/日报助手，擅长把零散的 Git 提交记录与人工笔记提炼为客观、专业的工作小结。

写作要求：
1. 使用简体中文，书面、客观陈述，聚焦\"做了什么、解决了什么、带来什么价值\"。
2. 仅总结指定项目在指定日期当天的工作，控制在 3 到 5 句话，凝练成一段连续文字，不要分点、不要换行。
3. 输入包含两类信息源：【代码提交】与【人工笔记】，二者均为真实工作，请统一归纳，不得因来源不同而割裂或忽略笔记中的非代码工作（如会议、沟通、设计、调研）。
4. 进行归纳与抽象，不要逐条复述 commit 原文，不要罗列提交哈希、分支名、文件路径清单。
5. 只依据提供的信息进行总结，不得杜撰未提及的功能、数据或结论。
6. 直接输出这段总结文字本身，不要输出项目名、不要输出\"【】\"前缀、不要加日期、不要加任何标题或解释。
7. 语气陈述过去完成的工作（如\"完成了\"\"优化了\"\"修复了\"\"参加了\"\"确认了\"），避免营销化、夸张或空话套话。";

/// 构造报告生成系统提示词；若有写作偏好则追加【用户写作偏好】段（对齐 buildSystemPrompt）。
pub fn build_system_prompt(prefs: &[String]) -> String {
    let rules: Vec<String> = prefs
        .iter()
        .filter(|r| !r.trim().is_empty())
        .map(|r| format!("- {}", r.trim()))
        .collect();
    if rules.is_empty() {
        return SYSTEM_PROMPT_BASE.to_string();
    }
    format!(
        "{SYSTEM_PROMPT_BASE}\n\n8. 【用户写作偏好（请严格遵守）】用户明确要求的写作调整，请在本次总结中严格执行：\n{}",
        rules.join("\n")
    )
}

/// 把 commit 列表渲染为 prompt 中的【代码提交】段（对齐 buildCommitsBlock）。
pub fn build_commits_block(bucket: &Bucket) -> String {
    let mut lines = Vec::new();
    for (i, c) in bucket.commits.iter().enumerate() {
        let subj = c.subject.trim();
        let body = MULTI_NL_RE.replace_all(c.body.trim(), " ");
        let mut line = format!("{}. {}", i + 1, subj);
        if !body.is_empty() {
            line.push_str(&format!("（说明：{body}）"));
        }
        let files: Vec<&str> = c.files.iter().take(8).map(|f| f.path.as_str()).collect();
        if !files.is_empty() {
            let more = if c.files.len() > 8 {
                format!(" 等{}个文件", c.files.len())
            } else {
                String::new()
            };
            line.push_str(&format!(
                "\n   改动文件：{}{}；变更量：+{}/-{}",
                files.join("、"),
                more,
                c.insertions,
                c.deletions
            ));
        }
        lines.push(line);
    }
    lines.join("\n")
}

/// 组装 user prompt：注入【代码提交】与【人工笔记】（对齐 buildUserPrompt）。
pub fn build_user_prompt(bucket: &Bucket) -> String {
    let date_str = utils::format_date_no_zero(bucket.day);
    let display = if bucket.display_name.is_empty() {
        &bucket.project
    } else {
        &bucket.display_name
    };
    let mut parts: Vec<String> = vec![
        "请总结以下项目在指定日期的开发工作。".to_string(),
        String::new(),
        format!("项目名称：{display}"),
        format!("日期：{date_str}"),
        String::new(),
    ];

    parts.push("【代码提交】".to_string());
    if bucket.commits.is_empty() {
        parts.push("（本日该项目无代码提交记录）".to_string());
    } else {
        parts.push(build_commits_block(bucket));
    }

    parts.push(String::new());
    parts.push("【人工笔记】".to_string());
    let proj_notes = &bucket.notes;
    let shared_notes = &bucket.shared_notes;
    if !proj_notes.is_empty() {
        parts.push("项目相关笔记：".to_string());
        for (i, n) in proj_notes.iter().enumerate() {
            parts.push(format!("{}. {}", i + 1, n.content));
        }
    }
    if !shared_notes.is_empty() {
        parts.push("当日通用补充（非特定项目的工作，如会议、沟通、调研）：".to_string());
        for (i, n) in shared_notes.iter().enumerate() {
            parts.push(format!("{}. {}", i + 1, n.content));
        }
    }
    if proj_notes.is_empty() && shared_notes.is_empty() {
        parts.push("（无人工笔记）".to_string());
    }

    parts.push(String::new());
    parts.push("请按系统指令，用 3 到 5 句话输出这一段中文工作总结。".to_string());
    parts.join("\n")
}

/// 估算一个桶输入的 token（commit + 笔记合计，对齐 estimateBucketTokens）。
pub fn estimate_bucket_tokens(bucket: &Bucket) -> usize {
    utils::estimate_tokens(SYSTEM_PROMPT_BASE) + utils::estimate_tokens(&build_user_prompt(bucket))
}
