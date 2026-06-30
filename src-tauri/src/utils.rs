//! 基础工具函数：日期解析/格式化、时间范围、token 估算。
//! 对齐 src/main/utils.js。本地时区语义，用 chrono 精确处理跨平台时区。

use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::Deserialize;

/// 当天本地日期（对齐 utils.js today() 的日历日部分）。
pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// 解析日期输入为本地日期。对齐 utils.js parseDateInput：
/// today / yesterday / YYYY-MM-DD。
pub fn parse_date(input: &str) -> Result<NaiveDate, String> {
    if input.is_empty() || input == "today" {
        return Ok(today());
    }
    if input == "yesterday" {
        let t = today();
        return Ok(t.pred_opt().unwrap_or(t));
    }
    NaiveDate::parse_from_str(input, "%Y-%m-%d").map_err(|_| format!("非法日期：{input}"))
}

/// 格式化为 YYYY-MM-DD（对齐 utils.js isoDate）。
pub fn iso_date(d: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// 无前导零日期，匹配周报格式：2026/6/15（对齐 utils.js formatDateNoZero）。
pub fn format_date_no_zero(d: NaiveDate) -> String {
    format!("{}/{}/{}", d.year(), d.month(), d.day())
}

/// 遍历 [from, to]（含）的每个日期字符串，对齐 utils.js iterateDates。
pub fn iterate_dates(from_str: &str, to_str: &str) -> Result<Vec<String>, String> {
    let mut from = parse_date(from_str)?;
    let to = parse_date(to_str)?;
    let mut out = Vec::new();
    while from <= to {
        out.push(iso_date(from));
        from = from.succ_opt().ok_or_else(|| "日期迭代溢出".to_string())?;
    }
    Ok(out)
}

/// 某日所在周的周起始日（对齐 utils.js weekStartOf）。
/// week_start: "monday" | "sunday"。
pub fn week_start_of(d: NaiveDate, week_start: &str) -> NaiveDate {
    // chrono num_days_from_sunday(): 0=周日..6=周六，与 JS getDay() 一致
    let dow = d.weekday().num_days_from_sunday() as i64;
    let offset = if week_start == "sunday" { dow } else { (dow + 6) % 7 };
    d - Duration::days(offset)
}

/// 某日所在周的 [起始, 结束]（结束为起始 + 6 天，闭区间）。
pub fn week_range(reference: NaiveDate, week_start: &str) -> (NaiveDate, NaiveDate) {
    let from = week_start_of(reference, week_start);
    (from, from + Duration::days(6))
}

/// 解析 ISO 周（如 2026-W23）为该周 [from, to]（对齐 utils.js isoWeekRange）。
pub fn iso_week_range(iso_week: &str, week_start: &str) -> Result<(NaiveDate, NaiveDate), String> {
    let (year, week) = parse_iso_week(iso_week).ok_or_else(|| format!("非法 ISO 周：{iso_week}"))?;
    // ISO 周：该年第一个周四所在周为 W01
    let jan4 = NaiveDate::from_ymd_opt(year, 1, 4).ok_or_else(|| format!("非法年份：{year}"))?;
    let w1mon = week_start_of(jan4, "monday");
    let mut from = w1mon + Duration::days((week - 1) * 7);
    let mut to = from + Duration::days(6);
    if week_start == "sunday" {
        from -= Duration::days(1);
        to -= Duration::days(1);
    }
    Ok((from, to))
}

fn parse_iso_week(s: &str) -> Option<(i32, i64)> {
    // 形如 2026-W23
    let bytes = s.as_bytes();
    if bytes.len() != 8 || bytes[4] != b'-' || bytes[5] != b'W' {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    let week: i64 = s.get(6..8)?.parse().ok()?;
    Some((year, week))
}

/// 时间范围选项（对齐渲染层 GenerateRangeOpts；额外兼容 days）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeOpts {
    pub mode: Option<String>,
    pub date: Option<String>,
    pub week: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub days: Option<i64>,
}

/// 解析时间范围为 [from, to]（闭区间），对齐 utils.js resolveRange。
pub fn resolve_range(opts: &RangeOpts, week_start: &str) -> Result<(NaiveDate, NaiveDate), String> {
    let mode = opts.mode.as_deref().unwrap_or("weekly");
    if mode == "daily" {
        let d = parse_date(opts.date.as_deref().unwrap_or("today"))?;
        return Ok((d, d));
    }
    if opts.from.is_some() || opts.to.is_some() {
        let to = parse_date(opts.to.as_deref().unwrap_or("today"))?;
        let from = match &opts.from {
            Some(f) => parse_date(f)?,
            None => week_start_of(to, week_start),
        };
        return Ok((from, to));
    }
    if let Some(days) = opts.days {
        if days != 0 {
            let to = today();
            let from = to - Duration::days(days - 1);
            return Ok((from, to));
        }
    }
    if opts.week.as_deref() == Some("last") {
        let reference = today() - Duration::days(7);
        return Ok(week_range(reference, week_start));
    }
    if let Some(w) = &opts.week {
        if parse_iso_week(w).is_some() {
            return iso_week_range(w, week_start);
        }
    }
    // 默认：本周（周起始日至今）
    let from = week_start_of(today(), week_start);
    Ok((from, today()))
}

/// 粗略 token 估算：中文 ≈ 1 token/字，其余 ≈ 1 token/4 字符（对齐 utils.js estimateTokens）。
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut cn = 0usize;
    let mut total = 0usize;
    for ch in text.chars() {
        total += 1;
        // /[一-鿿]/ == U+4E00..=U+9FFF（CJK 统一表意文字）
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            cn += 1;
        }
    }
    let other = total - cn;
    cn + other.div_ceil(4)
}

// ── id / 时间戳辅助（供 history / tasks / chat 等模块复用）──

/// 当前 Unix 毫秒时间戳。
pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// base36 编码（对齐 JS Number.toString(36)）。
pub fn base36(mut n: u128) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = Vec::new();
    while n > 0 {
        s.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

/// 伪随机 base36 后缀（id 仅需唯一性，用纳秒种子线性同余）。
pub fn rand_suffix(len: usize) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
        .wrapping_mul(2_654_435_761)
        .wrapping_add(1);
    let mut s = String::new();
    for _ in 0..len {
        s.push(DIGITS[(v % 36) as usize] as char);
        v = v.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    }
    s
}

/// 生成 id：prefix + base36(now) + 4 位随机（对齐 JS 'r_'/'pf_' + Date.now().toString(36) + random）。
pub fn gen_id(prefix: &str) -> String {
    format!("{prefix}{}{}", base36(now_ms()), rand_suffix(4))
}

/// UTC ISO 时间串（对齐 JS new Date().toISOString()）。
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// 密码学随机 32 字节 → 64 位十六进制串（对齐 crypto.randomBytes(32).toString('hex')）。
/// 用于 MCP Bearer token 等需要不可预测性的场景。
pub fn random_token() -> String {
    let mut buf = [0u8; 32];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}
