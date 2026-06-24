//! 后台任务系统：对齐 src/main/tasks.js。
//! 在主进程维护任务注册表（跨页面持久），生命周期 running → done|error|cancelled，
//! 经 `task:update` 事件增量推送到渲染层。用 Tauri State 持有，AppHandle 负责 emit。

use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::utils;

const MAX_TASKS: usize = 50;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: f64,
    pub total: f64,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String, // running | done | error | cancelled
    pub progress: Option<Progress>,
    pub detail: String,
    pub error: Option<String>,
    pub result: Value,
    pub created_at: u128,
    pub updated_at: u128,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePayload<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<&'a Task>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
}

#[derive(Default)]
struct Inner {
    tasks: Vec<Task>,
    seq: u64,
    app: Option<AppHandle>,
}

/// 任务注册表（作为 Tauri managed state）。
#[derive(Default)]
pub struct Tasks {
    inner: Mutex<Inner>,
}

fn emit_update(app: &AppHandle, task: &Task) {
    let _ = app.emit(
        "task:update",
        UpdatePayload {
            kind: "update",
            task: Some(task),
            id: None,
        },
    );
}

impl Tasks {
    pub fn new() -> Self {
        Tasks::default()
    }

    /// 注入 AppHandle（在 setup 中调用，使后续任务变更可推送到前端）。
    pub fn set_app(&self, app: AppHandle) {
        self.inner.lock().unwrap().app = Some(app);
    }

    /// 创建任务，返回 id（对齐 tasks.js create）。
    pub fn create(&self, kind: &str, title: &str, detail: &str, progress: Option<Progress>) -> String {
        let (snapshot, app) = {
            let mut g = self.inner.lock().unwrap();
            g.seq += 1;
            let id = format!("task_{}_{}", utils::base36(utils::now_ms()), g.seq);
            let now = utils::now_ms();
            let task = Task {
                id: id.clone(),
                kind: kind.to_string(),
                title: title.to_string(),
                status: "running".to_string(),
                progress,
                detail: detail.to_string(),
                error: None,
                result: Value::Null,
                created_at: now,
                updated_at: now,
            };
            g.tasks.push(task.clone());
            // 限制最近 MAX_TASKS 条（删最老）
            if g.tasks.len() > MAX_TASKS {
                g.tasks.remove(0);
            }
            (task, g.app.clone())
        };
        if let Some(app) = app {
            emit_update(&app, &snapshot);
        }
        snapshot.id
    }

    fn mutate<F: FnOnce(&mut Task)>(&self, id: &str, f: F) {
        let (snapshot, app) = {
            let mut g = self.inner.lock().unwrap();
            let Some(task) = g.tasks.iter_mut().find(|t| t.id == id) else {
                return;
            };
            f(task);
            task.updated_at = utils::now_ms();
            (task.clone(), g.app.clone())
        };
        if let Some(app) = app {
            emit_update(&app, &snapshot);
        }
    }

    /// 更新进度/详情/标题（对齐 tasks.js update）。
    pub fn update(
        &self,
        id: &str,
        detail: Option<String>,
        progress: Option<Option<Progress>>,
        title: Option<String>,
    ) {
        self.mutate(id, |task| {
            if let Some(p) = progress {
                task.progress = p;
            }
            if let Some(d) = detail {
                task.detail = d;
            }
            if let Some(t) = title {
                task.title = t;
            }
        });
    }

    /// 标记完成（对齐 tasks.js done）。
    pub fn done(&self, id: &str, result: Value) {
        self.mutate(id, |task| {
            task.status = "done".to_string();
            task.result = result;
        });
    }

    /// 标记失败（对齐 tasks.js error）。
    pub fn error(&self, id: &str, error_msg: &str) {
        self.mutate(id, |task| {
            task.status = "error".to_string();
            task.error = Some(if error_msg.is_empty() {
                "未知错误".to_string()
            } else {
                error_msg.to_string()
            });
        });
    }

    /// 删除一条任务（对齐 tasks.js remove）。
    pub fn remove(&self, id: &str) {
        let app = {
            let mut g = self.inner.lock().unwrap();
            g.tasks.retain(|t| t.id != id);
            g.app.clone()
        };
        if let Some(app) = app {
            let _ = app.emit(
                "task:update",
                UpdatePayload {
                    kind: "remove",
                    task: None,
                    id: Some(id),
                },
            );
        }
    }

    /// 清除已完成/失败的任务（对齐 tasks.js clearFinished）。
    pub fn clear_finished(&self) {
        let app = {
            let mut g = self.inner.lock().unwrap();
            g.tasks.retain(|t| t.status == "running");
            g.app.clone()
        };
        if let Some(app) = app {
            let _ = app.emit(
                "task:update",
                UpdatePayload {
                    kind: "clear",
                    task: None,
                    id: None,
                },
            );
        }
    }

    /// 全部任务快照（按创建时间倒序，对齐 tasks.js list）。
    pub fn list(&self) -> Vec<Task> {
        let g = self.inner.lock().unwrap();
        let mut out = g.tasks.clone();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    /// 是否有运行中的任务（对齐 tasks.js hasRunning）。
    pub fn has_running(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .tasks
            .iter()
            .any(|t| t.status == "running")
    }
}
