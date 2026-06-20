//! Git 日志采集：对齐 src/main/git.js。
//! 用 std::process::Command 直调 `git log`，按 0x1e(记录)/0x1f(字段) 分隔方案输出，
//! 编码可控、无第三方依赖。

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use chrono::{Local, NaiveDateTime, TimeZone, Utc};
use regex::Regex;
use serde::Serialize;

use crate::utils;

pub const FIELD_SEP: char = '\u{1f}';
pub const REC_SEP: char = '\u{1e}';

static NUMSTAT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+|-)\t(\d+|-)\t(.+)$").unwrap());
static RENAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.*)([{]?)([^{}]*)\s*=>\s*([^{}]*)([}]?)(.*)$").unwrap());
static EMPTY_REPO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)does not have any commits|no commits yet|unknown revision").unwrap()
});

/// 应跳过的目录名（不递归进入），对齐 git.js SCAN_SKIP_DIRS。
static SCAN_SKIP_DIRS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "node_modules",
        ".git",
        ".svn",
        "build",
        "dist",
        "target",
        ".next",
        "__pycache__",
    ]
    .into_iter()
    .collect()
});

/// 单个文件改动（对齐 git.js numstat 解析）。
#[derive(Serialize, Clone, Debug)]
pub struct FileChange {
    pub status: String, // A/M/D
    pub path: String,
    pub insertions: i64,
    pub deletions: i64,
}

/// 单条提交（对齐 git.js parseGitLog 输出，字段名 camelCase 与 JS 一致）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub local_date: String,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileChange>,
    pub insertions: i64,
    pub deletions: i64,
    pub files_changed: usize,
    pub repo: String,
    pub project: String,
    pub is_merge: bool,
}

/// 扫描得到的仓库候选（对齐渲染层 ScannedRepo）。
#[derive(Serialize, Clone, Debug)]
pub struct ScannedRepo {
    pub path: String,
    pub name: String,
    pub branch: String,
}

/// Windows 下隐藏 git 子进程控制台窗口（对齐 spawnSync windowsHide）。
#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

fn git() -> Command {
    let mut c = Command::new("git");
    hide_window(&mut c);
    c
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 检测系统 git 是否可用（对齐 git.js checkGit）。
pub fn check_git() -> bool {
    git()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 是否为有效 Git 仓库（对齐 git.js isGitRepo）。
pub fn is_git_repo(p: &str) -> bool {
    git()
        .args(["-C", p, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// 当前分支名（对齐 git.js currentBranch）。
pub fn current_branch(p: &str) -> String {
    git()
        .args(["-C", p, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// 执行 git log，返回原始 stdout（对齐 git.js runGitLog）。
/// merge_mode: exclude | include | only。
fn run_git_log(
    repo_path: &str,
    since: &str,
    until: &str,
    author: &str,
    merge_mode: &str,
) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "-C".into(),
        repo_path.into(),
        "-c".into(),
        "i18n.logOutputEncoding=UTF-8".into(),
        "log".into(),
    ];
    if !since.is_empty() {
        args.push(format!("--since={since} 00:00:00"));
    }
    if !until.is_empty() {
        args.push(format!("--until={until} 23:59:59"));
    }
    if !author.is_empty() {
        args.push(format!("--author={author}"));
    }
    if merge_mode == "exclude" {
        args.push("--no-merges".into());
    } else if merge_mode == "only" {
        args.push("--merges".into());
    }
    args.push("--date=format-local:%Y-%m-%d %H:%M:%S".into());
    // 末尾 %n 让 header 独占一行，numstat 行紧随其后，干净切分
    args.push(format!(
        "--pretty=format:{REC_SEP}%H{FIELD_SEP}%an{FIELD_SEP}%ae{FIELD_SEP}%ad{FIELD_SEP}%s{FIELD_SEP}%b{FIELD_SEP}%n"
    ));
    args.push("--numstat".into());

    let output = git()
        .args(&args)
        .output()
        .map_err(|e| format!("git log 执行失败：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        // 无提交 / 空仓库不算错误，返回空
        if EMPTY_REPO_RE.is_match(stderr) {
            return Ok(String::new());
        }
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        return Err(format!(
            "git log 失败：{}",
            if stderr.is_empty() {
                format!("exit {code}")
            } else {
                stderr.to_string()
            }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 解析 numstat 中的 rename/花括号路径：a/{b => c}.js → a/c（对齐 git.js normalizeNumstatPath）。
pub fn normalize_numstat_path(p: &str) -> String {
    if p.contains("=>") {
        if let Some(m) = RENAME_RE.captures(p) {
            let prefix = m.get(1).map_or("", |x| x.as_str());
            let new_name = m.get(4).map_or("", |x| x.as_str());
            return format!("{prefix}{new_name}").trim().to_string();
        }
    }
    p.to_string()
}

/// 把本地时间字符串（"YYYY-MM-DD HH:MM:SS"）转 ISO（UTC，对齐 JS Date.toISOString）。
fn local_to_iso(ad: &str) -> (String, String) {
    let src = if ad.is_empty() {
        "1970-01-01 00:00:00"
    } else {
        ad
    };
    let naive = NaiveDateTime::parse_from_str(src, "%Y-%m-%d %H:%M:%S")
        .unwrap_or_else(|_| NaiveDateTime::parse_from_str("1970-01-01 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap());
    let iso = Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| {
            dt.with_timezone(&Utc)
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        })
        .unwrap_or_default();
    let local_date = utils::iso_date(naive.date());
    (iso, local_date)
}

/// 解析 git log 原始输出为 Commit[]（对齐 git.js parseGitLog）。
pub fn parse_git_log(raw: &str, repo_path: &str, project_name: &str) -> Vec<Commit> {
    let mut commits = Vec::new();
    if raw.is_empty() {
        return commits;
    }
    for block in raw.split(REC_SEP) {
        let trimmed = block.trim_start_matches('\n');
        if trimmed.trim().is_empty() {
            continue;
        }
        let (head_line, rest) = match trimmed.find('\n') {
            Some(nl) => (&trimmed[..nl], &trimmed[nl + 1..]),
            None => (trimmed, ""),
        };
        let fields: Vec<&str> = head_line.split(FIELD_SEP).collect();
        let f = |i: usize| fields.get(i).copied().unwrap_or("");
        let hash = f(0);
        let an = f(1);
        let ae = f(2);
        let ad = f(3);
        let subject = f(4);
        let body = f(5);

        let mut files = Vec::new();
        let mut insertions = 0i64;
        let mut deletions = 0i64;
        for line in rest.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            if let Some(m) = NUMSTAT_RE.captures(line) {
                let ins = if &m[1] == "-" { 0 } else { m[1].parse().unwrap_or(0) };
                let del = if &m[2] == "-" { 0 } else { m[2].parse().unwrap_or(0) };
                insertions += ins;
                deletions += del;
                let status = if ins == 0 && del > 0 {
                    "D"
                } else if ins > 0 && del == 0 {
                    "A"
                } else {
                    "M"
                };
                files.push(FileChange {
                    status: status.to_string(),
                    path: normalize_numstat_path(&m[3]),
                    insertions: ins,
                    deletions: del,
                });
            }
        }

        let (date_iso, local_date) = local_to_iso(ad);
        let files_changed = files.len();
        commits.push(Commit {
            hash: hash.to_string(),
            short_hash: hash.chars().take(7).collect(),
            author_name: an.to_string(),
            author_email: ae.to_string(),
            date: date_iso,
            local_date,
            subject: subject.trim().to_string(),
            body: body.trim().to_string(),
            files,
            insertions,
            deletions,
            files_changed,
            repo: repo_path.to_string(),
            project: project_name.to_string(),
            is_merge: false,
        });
    }
    commits
}

/// 采集目标（来自 cfg.repos 的有效项）。
pub struct RepoTarget {
    pub path: String,
    pub name: String,
    pub author: String,
}

/// 采集单个仓库在区间内的 commit（对齐 git.js collectRepo）。
pub fn collect_repo(
    repo: &RepoTarget,
    from: &str,
    to: &str,
    merge_mode: &str,
    filter_authors: &[String],
) -> Result<Vec<Commit>, String> {
    let project = if !repo.name.is_empty() {
        repo.name.clone()
    } else {
        basename(&repo.path)
    };
    let author = if !repo.author.is_empty() {
        repo.author.clone()
    } else if !filter_authors.is_empty() {
        filter_authors.join("|")
    } else {
        String::new()
    };
    let raw = run_git_log(&repo.path, from, to, &author, merge_mode)?;
    Ok(parse_git_log(&raw, &repo.path, &project))
}

/// 扫描 root_dir 下所有 Git 仓库（最大深度 max_depth），对齐 git.js scanGitRepos。
/// 命中 .git 即视为一个仓库，不再向内部下钻；跳过黑名单/隐藏/软链目录。
pub fn scan_git_repos(root_dir: &str, max_depth: usize) -> Vec<ScannedRepo> {
    let mut results: Vec<ScannedRepo> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((PathBuf::from(root_dir), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if depth > max_depth {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // 无权限或非目录
        };
        for ent in entries.flatten() {
            let ft = match ent.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            // read_dir 的 file_type 为 lstat 语义：软链(指向目录)的 is_dir 为 false，被此处排除
            if !ft.is_dir() {
                continue;
            }
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SCAN_SKIP_DIRS.contains(name.as_str()) {
                continue;
            }
            let full = dir.join(&name);
            // 命中 .git → 这是一个仓库
            if full.join(".git").exists() {
                let fp = full.to_string_lossy().to_string();
                if seen.insert(fp.clone()) {
                    let branch = current_branch(&fp);
                    results.push(ScannedRepo {
                        path: fp,
                        name,
                        branch,
                    });
                }
                // 仓库内部不再下钻
                continue;
            }
            if depth + 1 <= max_depth {
                queue.push_back((full, depth + 1));
            }
        }
    }

    results.sort_by(|a, b| a.path.cmp(&b.path));
    results
}
