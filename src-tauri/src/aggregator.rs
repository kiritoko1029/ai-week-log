//! 聚合：对齐 src/main/aggregator.js。
//! 把 commit 与笔记按 (日期, 项目) 分桶，并执行笔记融合分配：
//!  - 项目级笔记 → 对应项目桶（支持别名映射）
//!  - 通用笔记（project=null）→ 注入当天所有桶的 sharedNotes + 兜底【miscProject】独立段

use std::cmp::Ordering;
use std::collections::HashMap;

use chrono::NaiveDate;
use serde::Serialize;

use crate::git::Commit;
use crate::notes::Note;
use crate::utils;

/// 聚合桶（对齐 aggregator.js 的 bucket 结构）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    #[serde(skip)]
    pub day: NaiveDate,
    pub day_str: String,
    pub project: String,
    pub display_name: String,
    pub commits: Vec<Commit>,
    pub notes: Vec<Note>,
    pub shared_notes: Vec<Note>,
    pub is_notes_only: bool,
}

/// 仓库展示信息（聚合排序/别名用，取自 cfg.repos）。
pub struct RepoMeta {
    pub name: String,
    pub alias: String,
}

fn epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()
}

/// 确保 (dayStr, project) 桶存在并返回可变引用（对齐 aggregator.js ensureBucket）。
fn ensure_bucket<'a>(
    day_map: &'a mut HashMap<String, HashMap<String, Bucket>>,
    day_str: &str,
    project: &str,
    display: &str,
) -> &'a mut Bucket {
    let pm = day_map.entry(day_str.to_string()).or_default();
    pm.entry(project.to_string()).or_insert_with(|| Bucket {
        day: utils::parse_date(day_str).unwrap_or_else(|_| epoch()),
        day_str: day_str.to_string(),
        project: project.to_string(),
        display_name: display.to_string(),
        commits: Vec::new(),
        notes: Vec::new(),
        shared_notes: Vec::new(),
        is_notes_only: true,
    })
}

/// 聚合 commit + 笔记为桶数组（已按日期升序、项目顺序排序）。
pub fn aggregate(
    commits: Vec<Commit>,
    notes: Vec<Note>,
    misc_project: &str,
    repos: &[RepoMeta],
) -> Vec<Bucket> {
    let mut order_index: HashMap<String, usize> = HashMap::new();
    let mut alias_to_name: HashMap<String, String> = HashMap::new();
    let mut name_to_display: HashMap<String, String> = HashMap::new();
    for (i, r) in repos.iter().enumerate() {
        if !r.name.is_empty() {
            order_index.insert(r.name.clone(), i);
            name_to_display.insert(
                r.name.clone(),
                if r.alias.is_empty() {
                    r.name.clone()
                } else {
                    r.alias.clone()
                },
            );
        }
        if !r.alias.is_empty() {
            alias_to_name.insert(r.alias.clone(), r.name.clone());
        }
    }
    let display_of =
        |proj: &str| name_to_display.get(proj).cloned().unwrap_or_else(|| proj.to_string());
    let normalize_project =
        |p: &str| alias_to_name.get(p).cloned().unwrap_or_else(|| p.to_string());

    let mut day_map: HashMap<String, HashMap<String, Bucket>> = HashMap::new();

    // 1) commit 入桶
    for c in commits {
        let proj = if c.project.is_empty() {
            misc_project.to_string()
        } else {
            c.project.clone()
        };
        let disp = display_of(&proj);
        let b = ensure_bucket(&mut day_map, &c.local_date, &proj, &disp);
        b.commits.push(c);
        b.is_notes_only = false;
    }

    // 2) 笔记入桶 + 通用笔记融合
    for n in notes {
        match n.project.as_deref() {
            Some(p) if !p.is_empty() => {
                // 项目级笔记：归对应项目桶（支持别名映射）
                let np = normalize_project(p);
                let disp = display_of(&np);
                let b = ensure_bucket(&mut day_map, &n.date, &np, &disp);
                b.notes.push(n);
            }
            _ => {
                // 通用笔记：注入当天所有已存在桶的 sharedNotes
                if let Some(pm) = day_map.get_mut(&n.date) {
                    for b in pm.values_mut() {
                        b.shared_notes.push(n.clone());
                    }
                }
                // 同时作为【miscProject】独立段落兜底
                let disp = display_of(misc_project);
                let mb = ensure_bucket(&mut day_map, &n.date, misc_project, &disp);
                mb.notes.push(n);
            }
        }
    }

    // 3) 展平 + 排序（日期升序；同日内 miscProject 排末尾，其余按 repoOrder）
    let cmp_project = |a: &str, b: &str| -> Ordering {
        let a_misc = a == misc_project;
        let b_misc = b == misc_project;
        if a_misc && !b_misc {
            return Ordering::Greater;
        }
        if b_misc && !a_misc {
            return Ordering::Less;
        }
        let ia = order_index.get(a).copied().unwrap_or(9999);
        let ib = order_index.get(b).copied().unwrap_or(9999);
        if ia != ib {
            return ia.cmp(&ib);
        }
        a.cmp(b)
    };

    let mut day_entries: Vec<(String, HashMap<String, Bucket>)> = day_map.into_iter().collect();
    day_entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut buckets = Vec::new();
    for (_day, pm) in day_entries {
        let mut items: Vec<(String, Bucket)> = pm.into_iter().collect();
        items.sort_by(|a, b| cmp_project(&a.0, &b.0));
        for (_p, b) in items {
            buckets.push(b);
        }
    }
    buckets
}
