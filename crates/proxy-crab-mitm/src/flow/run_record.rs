//! Run record snapshot volume control (plan Task 21 Step 2/3/4; plan W5).
//!
//! Port of the archived ReqFlow `engine/run-record.ts` (@ `485fa00`) pure
//! functions — the single volume gate before run records hit `runs.db`:
//!
//! 1. [`cap_snapshot`] collapses any snapshot value (node input / output /
//!    loop iteration item / output) to a UTF-8 byte budget. Strings are cut on
//!    a char boundary with a self-describing tail; objects / arrays become a
//!    [`TruncatedSnapshot`]-shaped wrapper `{ __truncated, preview,
//!    originalBytes }` (read-side contract: [`is_truncated_snapshot`]).
//! 2. [`cap_node_runs_for_record`] applies the whole-record budget: when the
//!    capped node-run map still exceeds [`RUN_RECORD_MAX_BYTES`], the
//!    per-snapshot limit degrades from [`DEGRADED_SNAPSHOT_BYTES`] by halving
//!    down to [`MIN_DEGRADED_SNAPSHOT_BYTES`] (honest pass-through below that
//!    — extreme node counts are not looped on forever).
//!
//! Byte accounting is always UTF-8 byte length (Rust `str::len`), so
//! multi-byte characters are never under-counted. Capping is idempotent:
//! re-capping an already capped value with the same limit returns it as-is;
//! under a tighter limit the preview / text keeps shrinking while
//! `originalBytes` always keeps the very first pre-truncation byte count.
//!
//! Divergence from upstream: the upstream operates on arbitrary JS values and
//! degrades unserializable ones to placeholder text; `serde_json::Value` is
//! always serializable, so that branch cannot trigger here. The truncation
//! marker text is rebranded to ProxyCrab (structure unchanged).

use serde_json::{Map, Value as JsonValue};

/// 单快照（每节点 input / output，循环逐轮 item / output 同档）字节上限：256KB。
pub const SNAPSHOT_MAX_BYTES: usize = 256 * 1024;

/// 整条运行记录（节点快照全量）序列化字节上限：2MB。
pub const RUN_RECORD_MAX_BYTES: usize = 2 * 1024 * 1024;

/// 整体超限后的首个降级档位（单快照字节上限），其后逐级对半收紧。
pub const DEGRADED_SNAPSHOT_BYTES: usize = 64 * 1024;

/// 降级档位下限：再收紧失去可读价值，达到后如实放行（极端节点规模）。
pub const MIN_DEGRADED_SNAPSHOT_BYTES: usize = 128;

/// 截断标记：被截断的字符串尾部与截断包装 preview 尾部都携带，读侧识别依据。
pub const TRUNCATION_MARKER: &str = "…[ProxyCrab 快照已截断]";

/* ------------------------------------------------------------------ *
 * 截断包装结构（读侧识别契约）
 * ------------------------------------------------------------------ */

/// 截断快照包装的读侧视图：`preview` 为原值序列化文本的前段（可能因整体降级
/// 被再次截断），`original_bytes` 为最初未截断原值序列化后的 UTF-8 字节数。
pub struct TruncatedView<'a> {
    pub preview: &'a str,
    pub original_bytes: u64,
}

/// 判断值是否为截断快照包装（读侧识别入口；三字段类型齐全才认定，避免误伤
/// 恰好含同名字段的普通对象）。
pub fn is_truncated_snapshot(value: &JsonValue) -> Option<TruncatedView<'_>> {
    let object = value.as_object()?;
    if object.get("__truncated").and_then(JsonValue::as_bool) != Some(true) {
        return None;
    }
    let preview = object.get("preview").and_then(JsonValue::as_str)?;
    let original_bytes = object.get("originalBytes").and_then(JsonValue::as_u64)?;
    Some(TruncatedView {
        preview,
        original_bytes,
    })
}

/* ------------------------------------------------------------------ *
 * 字节计量与截断工具
 * ------------------------------------------------------------------ */

/// JSON 序列化字节数（serde_json::Value 恒可序列化，无失败分支）。
fn serialized_len(value: &JsonValue) -> usize {
    value.to_string().len()
}

/// 把字符串按 UTF-8 字节数截断到 budget 内（多字节字符不切半，切点回退到
/// 字符边界，避免产生非法 UTF-8 序列）。
fn cut_to_utf8_bytes(text: &str, budget: usize) -> &str {
    if budget == 0 || text.is_empty() {
        return "";
    }
    let bytes = text.as_bytes();
    if bytes.len() <= budget {
        return text;
    }
    let mut end = budget;
    // 回退跳过 UTF-8 连续字节（0b10xxxxxx），停在多字节字符的起始字节上
    while end > 0 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    &text[..end]
}

/// 从已截断字符串尾部反解「去掉尾部后的前段与最初原始字节数」；非截断串
/// 返回 None。尾部形态：`{MARKER}（{label}，原 N 字节）` 或 `{MARKER}（原 N 字节）`。
fn parse_truncated_string(value: &str) -> Option<(&str, u64)> {
    let rest = value.strip_suffix('）')?;
    let idx = rest.find(TRUNCATION_MARKER)?;
    let after = &rest[idx + TRUNCATION_MARKER.len()..];
    let inner = after.strip_prefix('（')?;
    // 去掉「 字节」后余下「{label}，原 N」或「原 N」
    let digits = inner.strip_suffix("字节")?.trim_end();
    let digits = match digits.rsplit_once("，原 ") {
        Some((_label, digits)) => digits,
        None => digits.strip_prefix("原 ")?,
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let original_bytes = digits.parse::<u64>().ok()?;
    Some((&rest[..idx], original_bytes))
}

/// 截断字符串的尾部文案（携带原始字节数与字段 label，自说明）。
fn string_truncation_tail(original_bytes: u64, label: &str) -> String {
    if label.is_empty() {
        format!("{TRUNCATION_MARKER}（原 {original_bytes} 字节）")
    } else {
        format!("{TRUNCATION_MARKER}（{label}，原 {original_bytes} 字节）")
    }
}

/// 截断包装 preview 的尾部文案。
fn preview_truncation_tail(label: &str) -> String {
    if label.is_empty() {
        TRUNCATION_MARKER.to_owned()
    } else {
        format!("{TRUNCATION_MARKER}（{label}）")
    }
}

/// 构建截断包装：把 serialized 文本截到预算内并包进 TruncatedSnapshot。
///
/// preview 字段落库序列化时其内部引号会被 JSON 转义而膨胀，因此预算按实际
/// 序列化结果迭代收敛（通常 1~2 轮），保证包装整体序列化 ≤ max_bytes；
/// max_bytes 小于包装结构自身开销的病理配置下以结构完整优先（允许略超）。
fn build_truncated_wrapper(
    serialized: &str,
    original_bytes: u64,
    label: &str,
    max_bytes: usize,
) -> JsonValue {
    let tail = preview_truncation_tail(label);
    let skeleton = serialized_len(&JsonValue::Object(
        [
            ("__truncated".to_owned(), JsonValue::Bool(true)),
            ("preview".to_owned(), JsonValue::String(String::new())),
            ("originalBytes".to_owned(), JsonValue::from(original_bytes)),
        ]
        .into_iter()
        .collect(),
    ));
    let mut budget = max_bytes.saturating_sub(skeleton + tail.len() + 8);
    loop {
        let wrapper = JsonValue::Object(
            [
                ("__truncated".to_owned(), JsonValue::Bool(true)),
                (
                    "preview".to_owned(),
                    JsonValue::String(cut_to_utf8_bytes(serialized, budget).to_owned() + &tail),
                ),
                ("originalBytes".to_owned(), JsonValue::from(original_bytes)),
            ]
            .into_iter()
            .collect(),
        );
        let actual = serialized_len(&wrapper);
        if actual <= max_bytes || budget == 0 {
            return wrapper;
        }
        budget = budget.saturating_sub((actual - max_bytes).div_ceil(2).max(1));
    }
}

/* ------------------------------------------------------------------ *
 * cap_snapshot：单快照体积控制
 * ------------------------------------------------------------------ */

/// [`cap_snapshot`] 结果：`value` 为处理后（可能截断）的值。
pub struct SnapshotCapResult {
    /// 未超限时为原值（克隆）；超限时为截断字符串或 TruncatedSnapshot 包装
    pub value: JsonValue,
    /// 本次调用是否发生了截断
    pub capped: bool,
    /// 截断发生时：原值序列化后的 UTF-8 字节数
    pub original_bytes: Option<u64>,
}

/// 把单个快照值按 UTF-8 序列化字节数收敛到 max_bytes 内（纯函数）。
///
/// - 未超限：原样透传（capped = false）；
/// - 字符串超限：直接截断文本，尾部追加 [`TRUNCATION_MARKER`] + label + 原始字节数；
/// - 对象 / 数组超限：序列化后截断为 preview，包 TruncatedSnapshot 包装；
///   其余标量超限（病理上限配置）统一按包装兜底，保证结果有界；
/// - 幂等：对已截断的值以同上限重入原样返回；上限收紧时继续收缩
///   （字符串与包装都保留最初原始字节数）。
pub fn cap_snapshot(value: &JsonValue, max_bytes: usize, label: &str) -> SnapshotCapResult {
    let limit = max_bytes;

    // 已是截断包装（如整体降级重入）：保留真实 original_bytes，仅收缩 preview
    if let Some(view) = is_truncated_snapshot(value) {
        let current = serialized_len(value);
        if current <= limit {
            return SnapshotCapResult {
                value: value.clone(),
                capped: false,
                original_bytes: None,
            };
        }
        let wrapper = build_truncated_wrapper(view.preview, view.original_bytes, label, limit);
        return SnapshotCapResult {
            value: wrapper,
            capped: true,
            original_bytes: Some(view.original_bytes),
        };
    }

    if let JsonValue::String(text) = value {
        return cap_string(text, limit, label);
    }

    let serialized = value.to_string();
    let bytes = serialized.len();
    if bytes <= limit {
        return SnapshotCapResult {
            value: value.clone(),
            capped: false,
            original_bytes: None,
        };
    }

    SnapshotCapResult {
        value: build_truncated_wrapper(&serialized, bytes as u64, label, limit),
        capped: true,
        original_bytes: Some(bytes as u64),
    }
}

/// 字符串快照的截断（[`cap_snapshot`] 的字符串分支）。
/// 结果整体字节数（含尾部标记）≤ max_bytes；尾部放不下时退化为裸标记 / 空串。
fn cap_string(value: &str, max_bytes: usize, label: &str) -> SnapshotCapResult {
    let bytes = value.len();
    if bytes <= max_bytes {
        return SnapshotCapResult {
            value: JsonValue::String(value.to_owned()),
            capped: false,
            original_bytes: None,
        };
    }

    // 已截断串重入（如整体降级）：保留最初的原始字节数，只继续收缩前段
    let previous = parse_truncated_string(value);
    let original_bytes = previous.map_or(bytes as u64, |(_, original)| original);
    let mut tail = string_truncation_tail(original_bytes, label);
    if tail.len() > max_bytes {
        tail = if TRUNCATION_MARKER.len() <= max_bytes {
            TRUNCATION_MARKER.to_owned()
        } else {
            String::new()
        };
    }
    let head_source = previous.map_or(value, |(head, _)| head);
    let head = cut_to_utf8_bytes(head_source, max_bytes.saturating_sub(tail.len()));
    SnapshotCapResult {
        value: JsonValue::String(format!("{head}{tail}")),
        capped: true,
        original_bytes: Some(original_bytes),
    }
}

/* ------------------------------------------------------------------ *
 * 节点快照表与逐迭代明细的档位收敛
 * ------------------------------------------------------------------ */

/// 把单快照上限应用到逐迭代明细（上游 capIterationsSummary）：每轮的
/// item / output 分别过 [`cap_snapshot`]（label 带 `iteration[下标]` 便于读侧
/// 定位截断段）。进度字段与轮次元数据原样保留。
///
/// 形态契约（与载荷 NodeRun.iterations 对齐）：`{ records: [ { index, item,
/// output, ... } ], ... }`；records 非数组或缺键时原样返回（不猜形状）。
pub fn cap_iterations_summary(
    iterations: &JsonValue,
    max_bytes: usize,
    node_id: &str,
) -> JsonValue {
    let Some(records) = iterations.get("records").and_then(JsonValue::as_array) else {
        return iterations.clone();
    };
    let capped: Vec<JsonValue> = records
        .iter()
        .enumerate()
        .map(|(position, record)| {
            let Some(record_object) = record.as_object() else {
                return record.clone();
            };
            let index = record
                .get("index")
                .and_then(JsonValue::as_u64)
                .unwrap_or(position as u64);
            let mut updated = record_object.clone();
            if let Some(item) = record_object.get("item") {
                updated.insert(
                    "item".to_owned(),
                    cap_snapshot(
                        item,
                        max_bytes,
                        &format!("{node_id}.iteration[{index}].item"),
                    )
                    .value,
                );
            }
            if let Some(output) = record_object.get("output") {
                updated.insert(
                    "output".to_owned(),
                    cap_snapshot(
                        output,
                        max_bytes,
                        &format!("{node_id}.iteration[{index}].output"),
                    )
                    .value,
                );
            }
            JsonValue::Object(updated)
        })
        .collect();
    let mut updated = iterations.clone();
    if let Some(object) = updated.as_object_mut() {
        object.insert("records".to_owned(), JsonValue::Array(capped));
    }
    updated
}

/// 把单快照上限应用到单个节点运行对象（input / output / iterations 三键，
/// 其余字段原样保留）。`node_run` 为节点快照 JSON 对象（FlowNodeRunRecord
/// 序列化形态）。
pub fn cap_node_run_object(node_run: &JsonValue, max_bytes: usize, node_id: &str) -> JsonValue {
    let Some(object) = node_run.as_object() else {
        return node_run.clone();
    };
    let mut updated = object.clone();
    if let Some(input) = object.get("input").filter(|value| !value.is_null()) {
        updated.insert(
            "input".to_owned(),
            cap_snapshot(input, max_bytes, &format!("{node_id}.input")).value,
        );
    }
    if let Some(output) = object.get("output").filter(|value| !value.is_null()) {
        updated.insert(
            "output".to_owned(),
            cap_snapshot(output, max_bytes, &format!("{node_id}.output")).value,
        );
    }
    if let Some(iterations) = object.get("iterations").filter(|value| !value.is_null()) {
        updated.insert(
            "iterations".to_owned(),
            cap_iterations_summary(iterations, max_bytes, node_id),
        );
    }
    JsonValue::Object(updated)
}

/// 把单快照上限应用到整张节点快照表（nodeId → 节点运行对象）。
pub fn cap_node_runs(
    node_runs: &Map<String, JsonValue>,
    max_bytes: usize,
) -> Map<String, JsonValue> {
    node_runs
        .iter()
        .map(|(node_id, node_run)| {
            (
                node_id.clone(),
                cap_node_run_object(node_run, max_bytes, node_id),
            )
        })
        .collect()
}

/// 整条记录体积闸（上游 buildRunRecord 的降级链）：节点快照表先按
/// `snapshot_max_bytes`（缺省 [`SNAPSHOT_MAX_BYTES`]）收敛，序列化仍超
/// `record_max_bytes`（缺省 [`RUN_RECORD_MAX_BYTES`]）则从 `degraded_start`
/// （缺省 [`DEGRADED_SNAPSHOT_BYTES`]）起逐级对半收紧并**每次都从原始值重算**，
/// 直至合规或达到 [`MIN_DEGRADED_SNAPSHOT_BYTES`] 下限后如实放行。
///
/// 上游在记录级同时组装 run 级字段；本移植只对节点快照表（记录体积的主体）
/// 负责，run 行开销（id / 时间戳 / 错误文案等）由接线方（run_store）把
/// `record_max_bytes` 预留后传入。
pub fn cap_node_runs_for_record(
    node_runs: &Map<String, JsonValue>,
    snapshot_max_bytes: usize,
    record_max_bytes: usize,
    degraded_start: usize,
) -> Map<String, JsonValue> {
    let capped = cap_node_runs(node_runs, snapshot_max_bytes);
    if serialized_len(&JsonValue::Object(capped.clone())) <= record_max_bytes {
        return capped;
    }

    // 整体超限：从降级档位起逐级对半收紧单快照上限，直至合规（或到下限放行）
    let mut limit = degraded_start.max(MIN_DEGRADED_SNAPSHOT_BYTES);
    loop {
        let capped = cap_node_runs(node_runs, limit);
        let within = serialized_len(&JsonValue::Object(capped.clone())) <= record_max_bytes;
        if within || limit <= MIN_DEGRADED_SNAPSHOT_BYTES {
            return capped;
        }
        limit = (limit / 2).max(MIN_DEGRADED_SNAPSHOT_BYTES);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 构造一个序列化后约 target 字节的 JSON 对象（用重复键填充）。
    fn padded_object(target_bytes: usize) -> JsonValue {
        let mut map = Map::new();
        map.insert(
            "pad".to_owned(),
            JsonValue::String("x".repeat(target_bytes)),
        );
        JsonValue::Object(map)
    }

    #[test]
    fn passthrough_under_limit_keeps_value_and_reports_not_capped() {
        let value = json!({ "status": 200, "body": "中文字符串" });
        let result = cap_snapshot(&value, SNAPSHOT_MAX_BYTES, "n1.output");
        assert!(!result.capped);
        assert_eq!(result.value, value);
        assert_eq!(result.original_bytes, None);
    }

    #[test]
    fn object_over_limit_becomes_self_describing_wrapper() {
        let value = padded_object(SNAPSHOT_MAX_BYTES + 1024);
        let result = cap_snapshot(&value, SNAPSHOT_MAX_BYTES, "n1.output");
        assert!(result.capped);
        let original_bytes = result.original_bytes.expect("original bytes reported");
        assert_eq!(original_bytes as usize, value.to_string().len());
        let view = is_truncated_snapshot(&result.value).expect("wrapper shape");
        assert_eq!(view.original_bytes, original_bytes);
        assert!(view.preview.starts_with("{\"pad\":\"xxx"));
        assert!(
            view.preview
                .ends_with("…[ProxyCrab 快照已截断]（n1.output）")
        );
        // 包装整体序列化不超上限（结构完整优先的病理配置除外）
        assert!(result.value.to_string().len() <= SNAPSHOT_MAX_BYTES);
    }

    #[test]
    fn recapping_same_limit_is_idempotent() {
        let value = padded_object(SNAPSHOT_MAX_BYTES + 1024);
        let first = cap_snapshot(&value, SNAPSHOT_MAX_BYTES, "n1.output");
        let second = cap_snapshot(&first.value, SNAPSHOT_MAX_BYTES, "n1.output");
        assert!(!second.capped);
        assert_eq!(second.value, first.value);
    }

    #[test]
    fn shrinking_wrapper_keeps_first_original_bytes() {
        let value = padded_object(SNAPSHOT_MAX_BYTES + 1024);
        let first = cap_snapshot(&value, SNAPSHOT_MAX_BYTES, "n1.output");
        let shrunk = cap_snapshot(&first.value, DEGRADED_SNAPSHOT_BYTES, "n1.output");
        assert!(shrunk.capped);
        let view = is_truncated_snapshot(&shrunk.value).expect("wrapper shape");
        assert_eq!(view.original_bytes as usize, value.to_string().len());
        assert!(view.preview.len() < first.value.to_string().len());
        assert!(shrunk.value.to_string().len() <= DEGRADED_SNAPSHOT_BYTES);
    }

    #[test]
    fn string_truncation_reports_utf8_bytes_and_stays_on_char_boundary() {
        let text = "中".repeat(SNAPSHOT_MAX_BYTES / 3 + 100);
        let result = cap_snapshot(
            &JsonValue::String(text.clone()),
            SNAPSHOT_MAX_BYTES,
            "n1.output",
        );
        assert!(result.capped);
        let JsonValue::String(truncated) = &result.value else {
            panic!("string expected");
        };
        assert_eq!(result.original_bytes, Some(text.len() as u64));
        // 字节数不超上限，尾部自说明，且最后是完整字符（String 本身保证 UTF-8 合法）
        assert!(truncated.len() <= SNAPSHOT_MAX_BYTES);
        assert!(truncated.starts_with("中中中"));
        assert!(truncated.ends_with(&format!(
            "…[ProxyCrab 快照已截断]（n1.output，原 {} 字节）",
            text.len()
        )));
    }

    #[test]
    fn string_truncation_reentry_keeps_first_original_bytes() {
        let text = "x".repeat(SNAPSHOT_MAX_BYTES + 500);
        let first = cap_snapshot(&JsonValue::String(text), SNAPSHOT_MAX_BYTES, "n1.output");
        let shrunk = cap_snapshot(&first.value, 64 * 1024, "n1.output");
        assert!(shrunk.capped);
        assert_eq!(shrunk.original_bytes, first.original_bytes);
        let JsonValue::String(truncated) = &shrunk.value else {
            panic!("string expected");
        };
        assert!(truncated.len() <= 64 * 1024);
    }

    #[test]
    fn pathological_tail_fallback_degrades_to_bare_marker_then_head_only() {
        // 尾部放不下：退化为裸标记（head 预算 = 40 - 裸标记 30 字节 = 10）
        let text = "x".repeat(100);
        let result = cap_snapshot(&JsonValue::String(text), 40, "averylonglabelname");
        assert!(result.capped);
        assert_eq!(result.original_bytes, Some(100));
        let JsonValue::String(truncated) = &result.value else {
            panic!("string expected");
        };
        assert_eq!(truncated.len(), 40);
        assert_eq!(
            truncated.as_str(),
            format!("{}{}", "x".repeat(10), TRUNCATION_MARKER)
        );

        // 连裸标记都放不下：退化为空尾部，仅剩 head（head 预算 = 全部 max）
        let result = cap_snapshot(&JsonValue::String("x".repeat(100)), 10, "l");
        assert_eq!(result.value, JsonValue::String("x".repeat(10)));
        assert_eq!(result.original_bytes, Some(100));
    }

    #[test]
    fn truncated_string_parser_recovers_head_and_original_bytes() {
        // 50 字节预算恰好只装得下尾部（无 label 尾部 = 标记 30 +「（原 300 字节）」20）
        let text = "abc".repeat(100);
        let capped = cap_snapshot(&JsonValue::String(text), 50, "");
        let JsonValue::String(truncated) = &capped.value else {
            panic!("string expected");
        };
        assert_eq!(truncated, "…[ProxyCrab 快照已截断]（原 300 字节）");
        let (head, original_bytes) = parse_truncated_string(truncated).expect("tail parses");
        assert_eq!(head, "");
        assert_eq!(original_bytes, 300);

        // 无标记串与普通含「原 N 字节」文案的串不误判
        assert_eq!(parse_truncated_string("plain text"), None);
        assert_eq!(parse_truncated_string("原 123 字节"), None);
    }

    #[test]
    fn is_truncated_snapshot_requires_all_three_fields() {
        assert!(is_truncated_snapshot(&json!({ "__truncated": true })).is_none());
        assert!(is_truncated_snapshot(&json!({ "__truncated": true, "preview": "p" })).is_none());
        assert!(
            is_truncated_snapshot(
                &json!({ "__truncated": true, "preview": 1, "originalBytes": 2 })
            )
            .is_none()
        );
        assert!(
            is_truncated_snapshot(
                &json!({ "__truncated": false, "preview": "p", "originalBytes": 2 })
            )
            .is_none()
        );
        let ok = json!({ "__truncated": true, "preview": "p", "originalBytes": 2 });
        assert!(is_truncated_snapshot(&ok).is_some());
    }

    #[test]
    fn node_run_object_caps_input_output_and_iteration_details() {
        let node_run = json!({
            "status": "success",
            "input": padded_object(SNAPSHOT_MAX_BYTES + 10),
            "output": { "ok": true },
            "iterations": {
                "total": 2,
                "done": 2,
                "records": [
                    { "index": 0, "item": padded_object(SNAPSHOT_MAX_BYTES + 10), "output": "a" },
                    { "index": 1, "item": "b", "output": "c" }
                ]
            }
        });
        let capped = cap_node_run_object(&node_run, SNAPSHOT_MAX_BYTES, "loop1");
        assert!(is_truncated_snapshot(&capped["input"]).is_some());
        assert_eq!(capped["output"], json!({ "ok": true }));
        assert_eq!(capped["status"], "success");
        let records = capped["iterations"]["records"].as_array().unwrap();
        assert!(is_truncated_snapshot(&records[0]["item"]).is_some());
        assert_eq!(records[0]["output"], "a");
        assert_eq!(records[1]["item"], "b");
        // 进度字段与轮次元数据原样保留
        assert_eq!(capped["iterations"]["total"], 2);
        assert_eq!(records[0]["index"], 0);
    }

    #[test]
    fn whole_record_degrades_by_halving_until_within_budget() {
        // 20 节点 × 300KB ≈ 6MB：256KB 档超 2MB；64KB 档 ≈ 1.3MB 合规
        let node_runs: Map<String, JsonValue> = (0..20)
            .map(|i| {
                (
                    format!("n{i}"),
                    json!({ "status": "success", "output": padded_object(300 * 1024) }),
                )
            })
            .collect();
        let capped = cap_node_runs_for_record(
            &node_runs,
            SNAPSHOT_MAX_BYTES,
            RUN_RECORD_MAX_BYTES,
            DEGRADED_SNAPSHOT_BYTES,
        );
        let total = serialized_len(&JsonValue::Object(capped.clone()));
        assert!(total <= RUN_RECORD_MAX_BYTES);
        // 降级档位生效（64KB < 256KB），原始字节数保留
        let first = is_truncated_snapshot(&capped["n0"]["output"]).expect("capped");
        assert_eq!(first.original_bytes as usize, 300 * 1024 + 10);
    }

    #[test]
    fn whole_record_honestly_passes_through_at_floor() {
        // 20000 节点 × 1KB ≈ 20MB：即便 128B 下限也压不进 2MB，如实放行
        let node_runs: Map<String, JsonValue> = (0..20_000)
            .map(|i| {
                (
                    format!("n{i}"),
                    json!({ "status": "success", "output": padded_object(1024) }),
                )
            })
            .collect();
        let capped = cap_node_runs_for_record(
            &node_runs,
            SNAPSHOT_MAX_BYTES,
            RUN_RECORD_MAX_BYTES,
            DEGRADED_SNAPSHOT_BYTES,
        );
        let first = is_truncated_snapshot(&capped["n0"]["output"]).expect("capped");
        assert!(first.preview.len() <= MIN_DEGRADED_SNAPSHOT_BYTES);
    }
}
