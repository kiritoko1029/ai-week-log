---
name: weeklog-ai-note
description: Save a work note to WeekLog at the end of a substantive coding session. Use this when a development conversation that produced real code or file changes (a feature, bug fix, refactor, config change, investigation with a concrete outcome) is essentially complete, so the work gets recorded into the user's daily/weekly report material. Do NOT use for pure Q&A, explanations, brainstorming, or chit-chat with no actual changes.
---

# WeekLog AI 小记

把"刚刚这段开发对话实际完成的工作"作为一条小记发回 WeekLog 桌面应用，供用户汇总成日报/周报。WeekLog 会用它自己配置的「小记总结模型」把对话总结成一条中文小记，并放入"待处理池"等待用户在界面里确认后再写入笔记。**你不需要自己写总结**——只需把对话发回去即可。

## 何时触发（重要）

在一次**有实质产出**的开发对话临近结束、用户的请求基本完成时触发，典型信号：

- 本次对话产生了真实的代码/文件改动（新功能、修复 bug、重构、配置或脚本变更）。
- 完成了一项有明确结论的排查、实现或交付。

**不要触发**的情况：纯问答 / 概念解释 / 头脑风暴 / 闲聊，或没有任何实际改动。判断不确定时，宁可不触发——WeekLog 端也会对"无实质内容"的对话二次过滤。

同一段对话**只在收尾时提交一次**，不要每轮都提交。

## 如何调用

在**当前项目工作目录**下运行随本 skill 安装的脚本（与本 `SKILL.md` 同目录）：

```bash
node "<本 skill 目录>/record-note.mjs"
```

脚本是零依赖的纯 Node 脚本，会自动：

1. 定位本次会话的 transcript（按各 agent 的会话目录探测最近一次、并优先匹配当前 cwd 的会话）。
2. 抽取其中的**用户提问 + AI 回复纯文本**（自动剔除思考过程、工具调用、系统提示等噪声）。
3. 采集当前 git 分支与改动文件清单。
4. 通过 MCP 调用 WeekLog 的 `submit_conversation` 工具，把对话发回 WeekLog。

可选参数：

- `--transcript <路径>`：如果你确切知道本次会话 transcript 的 JSONL 路径，传入可跳过自动探测（更准确）。
- `--cwd <路径>`：覆盖项目目录（默认用脚本运行时的 cwd）。
- `--source <codex|claude|zcode>`：覆盖来源标识（一般无需，安装时已写入）。
- `--dry-run`：只打印将要发送的内容、不真正提交（便于自检）。

运行成功后脚本会打印 `[weeklog] 已提交小记：…`。失败时脚本以退出码 0 静默结束，不影响你的正常工作，无需重试。

## 备注

- 端点与鉴权 token 已在安装时写入同目录的 `weeklog.json`，脚本会自动读取，你无需关心。
- 真正写入用户笔记需要用户在 WeekLog 界面确认，因此这一步是安全的、可回滚的。
