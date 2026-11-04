//! 工作流导入 / 导出的纯数据层（ReqFlow 复刻计划 Task 23 薄片 A）。
//!
//! 对齐归档 ReqFlow（`_archive/reqflow` main@485fa00）的
//! `src/storage/workflow-transfer.ts`（M7-T5 三段式 + M9-T5 导入安全 +
//! M15-T2 refId 重映射）：导出信封的字段命名与版本号形态逐字段对齐上游
//! （`format` / `version` / `exportedAt` / `workflows`，`format` 标识同为
//! `"reqflow-workflow"`、版本同为 1）；导入侧同为「文件级识别 → 逐流程形状
//! 校验 → id/refId 重映射 → 脚本逐条确认 → 重名消解」的纯函数链。
//!
//! 与上游的差异（存储介质不同，其余尽力对齐）：
//! - ReqFlow 导出仅含流程；宿主工作流引用请求库条目与环境变量集，导出信封
//!   扩展 `requests` / `envSets` 两个字段随流程带出（导入侧暂只消费
//!   `workflows`，请求库 / 环境集的入库裁决在接入层薄片处理）；
//! - 环境变量集的 secret 剔除复用 [`super::env_sets::strip_secrets_for_export`]
//!   （整张 secret 表不落导出文件）；流程 secret 变量对齐上游
//!   `stripSecretVariablesForExport`（只保留变量名，值置空串）；
//! - 传入导出的环境变量集范围（全部 / 仅激活集）由调用方决定，本层只负责
//!   剔除 secret；
//! - 导入校验为强类型边界：节点 / 连线经 serde 反序列化，畸形 config（如
//!   非法 `failPolicy`）记入 issues 阻断该流程，上游 JS 形态会静默透传；
//! - 变量表在「值必须为字符串」之外追加宿主存储约定的「键非空」校验
//!   （[`super::env_sets::validate_variables_table`] 同口径）。
//!
//! 本模块不依赖 [`super::store::FlowStore`]：导入的入库通道（流程 id /
//! projectId / 时间戳生成、重名落库）在接入层完成，这里只产出
//! [`WorkflowImportItem`] 投影。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    env_sets::strip_secrets_for_export,
    model::{
        NodeConfig, Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeType, remap_node_config_refs,
    },
    request_library::RequestLibraryEntry,
    store::EnvVariableSet,
};

/* ------------------------------------------------------------------ *
 * 导出（对齐归档 buildWorkflowExportFile / stripSecretVariablesForExport）
 * ------------------------------------------------------------------ */

/// 导出文件格式标识（自描述标记，导入时据此识别文件种类；对齐上游）。
pub const WORKFLOW_EXPORT_FORMAT: &str = "reqflow-workflow";

/// 当前导出 / 支持导入的最高文件版本（对齐上游）。
pub const WORKFLOW_EXPORT_VERSION: u32 = 1;

/// 导出文件顶层信封。字段命名与版本号形态对齐归档 `WorkflowExportFile`；
/// `requests` / `envSets` 为宿主扩展（ReqFlow 无对应物，见模块头差异说明）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExportFile {
    pub format: String,
    pub version: u32,
    /// 导出时间（Unix 毫秒）。
    pub exported_at: u64,
    /// 导出的流程清单（单流程导出即一个元素；secret 变量值已置空）。
    pub workflows: Vec<Workflow>,
    /// 随流程带出的请求库条目（仅流程引用到的；原样带出）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requests: Vec<RequestLibraryEntry>,
    /// 随流程带出的环境变量集（secret 表已整体剔除）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_sets: Vec<EnvVariableSet>,
}

/// 剔除流程中 secret 变量的值（纯函数）：secret 变量**只保留变量名**（导出
/// 文件可见「存在哪些 secret」），值一律置空串——导出 JSON 不含任何 secret
/// 明文；导入方拿到空值占位，由使用者回填。对齐上游
/// `stripSecretVariablesForExport`（注意与环境变量集的「整表剔除」口径不同，
/// 两者各自沿用上游 / 既有导出约定）。
pub fn strip_workflow_secrets_for_export(workflow: &Workflow) -> Workflow {
    let mut stripped = workflow.clone();
    for value in stripped.secret_variables.values_mut() {
        value.clear();
    }
    stripped
}

/// 收集流程引用到的请求库条目 id 集合（`config.requestId` 非空引用），
/// 供导出侧从请求库带出对应条目（纯函数）。
pub fn collect_referenced_request_ids(workflows: &[Workflow]) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for workflow in workflows {
        for node in &workflow.nodes {
            if let Some(request_id) = node.config.request_id.as_deref().filter(|id| !id.is_empty())
            {
                ids.insert(request_id.to_owned());
            }
        }
    }
    ids
}

/// 从请求库中取流程引用到的条目（保持请求库的既有排序；纯函数）。
pub fn collect_referenced_requests(
    workflows: &[Workflow],
    library: &[RequestLibraryEntry],
) -> Vec<RequestLibraryEntry> {
    let referenced = collect_referenced_request_ids(workflows);
    library
        .iter()
        .filter(|entry| referenced.contains(&entry.id))
        .cloned()
        .collect()
}

/// 构造导出文件对象（纯函数）：流程剔除 secret 变量值，环境变量集剔除整张
/// secret 表，请求库条目原样带出；调用方经 JSON 序列化落盘。
pub fn build_workflow_export_file(
    workflows: &[Workflow],
    requests: &[RequestLibraryEntry],
    env_sets: &[EnvVariableSet],
    exported_at: u64,
) -> WorkflowExportFile {
    WorkflowExportFile {
        format: WORKFLOW_EXPORT_FORMAT.to_owned(),
        version: WORKFLOW_EXPORT_VERSION,
        exported_at,
        workflows: workflows
            .iter()
            .map(strip_workflow_secrets_for_export)
            .collect(),
        requests: requests.to_vec(),
        env_sets: env_sets.iter().map(strip_secrets_for_export).collect(),
    }
}

/* ------------------------------------------------------------------ *
 * 导入·解析与形状校验（对齐归档 parseWorkflowImport）
 * ------------------------------------------------------------------ */

/// 名称缺失 / 空白时的流程名占位（对齐上游「未命名流程」；同时记一条 issue）。
pub const UNNAMED_WORKFLOW_NAME: &str = "未命名流程";

/// 节点类型字面量清单文案（与 [`WorkflowNodeType`] 的 serde camelCase 字面量
/// 一致，供 issue 文案复用；新增节点类型时同步）。
const NODE_TYPE_LABELS: &str =
    "start / httpReplay / condition / loop / delay / setVariable / assert / transform / stickyNote";

/// 单个解析出的待导入流程：校验问题见 `issues`（非空时 `data` 为 `None`）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedWorkflowImport {
    /// 流程名（原文；缺失时以 [`UNNAMED_WORKFLOW_NAME`] 占位并记 issue）。
    pub name: String,
    /// 流程描述（非字符串时按空串处理）。
    pub description: String,
    /// 节点数（结构可读时给出，供预览展示）。
    pub node_count: usize,
    /// 连线数（结构可读时给出，供预览展示）。
    pub edge_count: usize,
    /// 校验问题清单（可读文案；空 = 可导入）。
    pub issues: Vec<String>,
    /// 校验通过时的领域数据——id 尚未重映射，入库前必须经
    /// [`remap_imported_workflow`] 重生成；`issues` 非空时为 `None`。
    pub data: Option<WorkflowImportData>,
}

/// 校验通过的导入流程领域数据（形状与 [`Workflow`] 的编排字段对齐；流程 id /
/// projectId / 时间戳由入库通道生成，不在此投影内）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkflowImportData {
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub variables: BTreeMap<String, String>,
    pub secret_variables: BTreeMap<String, String>,
}

/// [`parse_workflow_import`] 的结果：文件级失败（可读错误）或逐流程解析清单。
pub type WorkflowImportParseResult = Result<Vec<ParsedWorkflowImport>, String>;

/// 从节点原始值尽力提取 id（供连线引用检查的节点 id 集合构建）。
fn node_raw_id(node: &Value) -> Option<&str> {
    node.as_object()
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// 校验单个导入节点的最小形状（id / type 枚举 / position 数字坐标 / config
/// 对象），返回 `None` 表示合法，否则返回带节点下标定位的可读问题。
fn inspect_imported_node_shape(value: &Value, index: usize) -> Option<String> {
    let label = || format!("节点 #{}", index + 1);
    if !value.is_object() {
        return Some(format!("{} 必须是对象", label()));
    }
    let object = value.as_object().expect("checked above");
    if object
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(|id| id.is_empty())
    {
        return Some(format!("{} 缺少有效 id", label()));
    }
    let type_ok = object
        .get("type")
        .is_some_and(|value| serde_json::from_value::<WorkflowNodeType>(value.clone()).is_ok());
    if !type_ok {
        return Some(format!("{} 的 type 必须是 {NODE_TYPE_LABELS} 之一", label()));
    }
    let position_ok = object.get("position").and_then(Value::as_object).is_some_and(
        |position| {
            position.get("x").is_some_and(Value::is_number)
                && position.get("y").is_some_and(Value::is_number)
        },
    );
    if !position_ok {
        return Some(format!("{} 的 position 必须是含数字 x / y 的对象", label()));
    }
    if !object.get("config").is_some_and(Value::is_object) {
        return Some(format!("{} 的 config 必须是对象", label()));
    }
    None
}

/// 校验单个导入连线的形状与引用完整（source / target 必须指向本流程节点集合，
/// 且不得触及 stickyNote 便签节点——便签是纯注释卡、不可连线，对齐上游
/// M13-T5 口径）。返回 `None` 表示合法，否则返回带连线下标定位的可读问题。
fn inspect_imported_edge_shape(
    value: &Value,
    index: usize,
    node_ids: &BTreeSet<String>,
    sticky_node_ids: &BTreeSet<String>,
) -> Option<String> {
    let label = || format!("连线 #{}", index + 1);
    if !value.is_object() {
        return Some(format!("{} 必须是对象", label()));
    }
    let object = value.as_object().expect("checked above");
    let non_empty = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    if !non_empty("id") {
        return Some(format!("{} 缺少有效 id", label()));
    }
    if !non_empty("source") || !non_empty("target") {
        return Some(format!("{} 缺少有效的 source / target", label()));
    }
    let source = object.get("source").and_then(Value::as_str).unwrap_or_default();
    let target = object.get("target").and_then(Value::as_str).unwrap_or_default();
    if !node_ids.contains(source) || !node_ids.contains(target) {
        return Some(format!("{} 引用了不存在的节点", label()));
    }
    if sticky_node_ids.contains(source) || sticky_node_ids.contains(target) {
        return Some(format!("{} 连接了便签节点：便签不参与连线", label()));
    }
    None
}

/// 连线导入前的归一化：`sourceHandle` 仅保留 `'true'` / `'false'` 两个合法
/// 手柄（非法 / 缺省不落字段，对齐上游 M16-T1 的导入保留语义）。
fn normalize_edge_for_import(edge: &Value) -> Value {
    let mut edge = edge.clone();
    let handle_ok = edge
        .get("sourceHandle")
        .and_then(Value::as_str)
        .is_some_and(|handle| handle == "true" || handle == "false");
    if !handle_ok
        && let Some(object) = edge.as_object_mut()
    {
        object.remove("sourceHandle");
    }
    edge
}

/// 校验导入变量表的形状：普通对象、值全部为字符串（对齐上游
/// `validateVariablesTable` 的文案），追加宿主存储约定的键非空校验。
/// 命中首个问题时记入 issues 并放弃整表（上游同语义：首个错误即返回）。
fn inspect_imported_variables(
    value: Option<&Value>,
    label: &str,
    issues: &mut Vec<String>,
) -> BTreeMap<String, String> {
    let Some(value) = value else {
        return BTreeMap::new();
    };
    let Some(object) = value.as_object() else {
        issues.push(format!("{label}必须是对象"));
        return BTreeMap::new();
    };
    let mut table = BTreeMap::new();
    for (key, item) in object {
        let Some(text) = item.as_str() else {
            issues.push(format!("{label}中变量 \"{key}\" 的值必须是字符串"));
            return BTreeMap::new();
        };
        if key.trim().is_empty() {
            issues.push(format!("{label}中变量键不能为空"));
            return BTreeMap::new();
        }
        table.insert(key.clone(), text.to_owned());
    }
    table
}

/// 校验单个导入流程，产出 issues 清单（空 = 可导入）。校验项：名称、
/// nodes / edges 数组、节点与连线逐项形状、连线引用完整、节点 id 不重复、
/// variables / secretVariables 形状；形状通过后再经 serde 反序列化为强类型
/// 领域数据（类型化边界的畸形 config 记 issue 阻断，见模块头差异说明）。
fn inspect_imported_workflow(value: &Value) -> ParsedWorkflowImport {
    let mut issues = Vec::new();
    let Some(object) = value.as_object() else {
        return ParsedWorkflowImport {
            name: UNNAMED_WORKFLOW_NAME.to_owned(),
            issues: vec!["流程记录必须是对象".to_owned()],
            ..ParsedWorkflowImport::default()
        };
    };

    let raw_name = object.get("name").and_then(Value::as_str);
    let name = match raw_name {
        Some(name) if !name.trim().is_empty() => name.to_owned(),
        _ => {
            issues.push("流程名称缺失或为空".to_owned());
            UNNAMED_WORKFLOW_NAME.to_owned()
        }
    };
    let description = object
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let raw_nodes = object.get("nodes").and_then(Value::as_array);
    let raw_edges = object.get("edges").and_then(Value::as_array);
    if raw_nodes.is_none() {
        issues.push("nodes 必须是数组".to_owned());
    }
    if raw_edges.is_none() {
        issues.push("edges 必须是数组".to_owned());
    }

    // 节点 id 集合 / 便签 id 集合：从原始值尽力提取（与上游一致，供连线引用
    // 检查在节点形状校验之外独立建立）。
    let node_ids: BTreeSet<String> = raw_nodes
        .into_iter()
        .flatten()
        .filter_map(node_raw_id)
        .map(str::to_owned)
        .collect();
    let sticky_node_ids: BTreeSet<String> = raw_nodes
        .into_iter()
        .flatten()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("stickyNote"))
        .filter_map(node_raw_id)
        .map(str::to_owned)
        .collect();

    let mut nodes = Vec::new();
    let mut seen_node_ids = BTreeSet::new();
    for (index, node) in raw_nodes.into_iter().flatten().enumerate() {
        if let Some(issue) = inspect_imported_node_shape(node, index) {
            issues.push(issue);
            continue;
        }
        let id = node_raw_id(node).expect("shape check guarantees an id");
        if !seen_node_ids.insert(id.to_owned()) {
            issues.push(format!("节点 id 重复：{id}"));
            continue;
        }
        match serde_json::from_value::<WorkflowNode>(node.clone()) {
            Ok(node) => nodes.push(node),
            Err(error) => issues.push(format!("节点 #{} 形状非法：{error}", index + 1)),
        }
    }

    let mut edges = Vec::new();
    for (index, edge) in raw_edges.into_iter().flatten().enumerate() {
        if let Some(issue) =
            inspect_imported_edge_shape(edge, index, &node_ids, &sticky_node_ids)
        {
            issues.push(issue);
            continue;
        }
        match serde_json::from_value::<WorkflowEdge>(normalize_edge_for_import(edge)) {
            Ok(edge) => edges.push(edge),
            Err(error) => issues.push(format!("连线 #{} 形状非法：{error}", index + 1)),
        }
    }

    let variables =
        inspect_imported_variables(object.get("variables"), "variables", &mut issues);
    // secret 变量表与 variables 同形校验、同通道透传（导入文件通常只含空值
    // 占位——导出侧已剔除值）。
    let secret_variables = inspect_imported_variables(
        object.get("secretVariables"),
        "secretVariables",
        &mut issues,
    );

    let data = if issues.is_empty() {
        Some(WorkflowImportData {
            nodes,
            edges,
            variables,
            secret_variables,
        })
    } else {
        None
    };
    ParsedWorkflowImport {
        name,
        description,
        node_count: raw_nodes.map_or(0, |items| items.len()),
        edge_count: raw_edges.map_or(0, |items| items.len()),
        issues,
        data,
    }
}

/// 解析导入文件文本（纯函数，任何输入都不 panic）。
///
/// 文件级校验失败（非 JSON / 顶层不是对象 / `format` 标识不符 / `version`
/// 缺失或非法 / 高于当前支持版本 / 无流程数据）返回可读错误；否则逐流程
/// 解析为 [`ParsedWorkflowImport`]（各自的 `issues` 标明可否导入）。对齐上游
/// `parseWorkflowImport` 的文件级口径。
pub fn parse_workflow_import(text: &str) -> WorkflowImportParseResult {
    let value: Value = serde_json::from_str(text).map_err(|_| "文件不是合法的 JSON".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "导出文件结构不符：顶层必须是对象".to_owned())?;
    if object.get("format").and_then(Value::as_str) != Some(WORKFLOW_EXPORT_FORMAT) {
        return Err(format!(
            "不是 ReqFlow 流程导出文件（format 标识缺失或不符，期望 \"{WORKFLOW_EXPORT_FORMAT}\"）"
        ));
    }
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "导出文件缺少有效的 version 版本号".to_owned())?;
    if version > u64::from(WORKFLOW_EXPORT_VERSION) {
        return Err(format!(
            "导出文件版本 v{version} 高于当前支持的最高版本 v{WORKFLOW_EXPORT_VERSION}，请升级程序后再导入"
        ));
    }
    let raw_workflows = object
        .get("workflows")
        .and_then(Value::as_array)
        .filter(|workflows| !workflows.is_empty())
        .ok_or_else(|| "导出文件中没有流程数据".to_owned())?;
    Ok(raw_workflows.iter().map(inspect_imported_workflow).collect())
}

/* ------------------------------------------------------------------ *
 * 导入·id / refId 重映射与冲突裁决（对齐归档 remapImportedWorkflow /
 * dedupeWorkflowName）
 * ------------------------------------------------------------------ */

/// 待入库的导入流程投影（id 已重映射、名称未去重）：编排字段与 [`Workflow`]
/// 对齐，流程 id / projectId / 时间戳由入库通道生成与维护（下一薄片接线）。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowImportItem {
    pub name: String,
    pub description: String,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub variables: BTreeMap<String, String>,
    pub secret_variables: BTreeMap<String, String>,
}

/// 改写 config 中「裸节点 id」字段（对齐上游 `remapConfigBareNodeIds`）：
/// 非模板形态的内部 id 引用——condition 分支（`trueTargets` / `falseTargets`）
/// 与 setVariable 赋值项来源节点（`assignments[].node`）。节点 id 重映射时
/// 同步改写；字段缺失或值不在映射表时原样保留。
fn remap_bare_node_ids(
    config: &NodeConfig,
    node_id_by_old: &BTreeMap<String, String>,
) -> NodeConfig {
    let mut config = config.clone();
    for targets in [config.true_targets.as_mut(), config.false_targets.as_mut()]
        .into_iter()
        .flatten()
    {
        for id in targets.iter_mut() {
            if let Some(new_id) = node_id_by_old.get(id) {
                *id = new_id.clone();
            }
        }
    }
    if let Some(assignments) = config.assignments.as_mut() {
        for assignment in assignments.iter_mut() {
            if let Some(node) = assignment.node.as_mut()
                && let Some(new_id) = node_id_by_old.get(node)
            {
                *node = new_id.clone();
            }
        }
    }
    config
}

/// 对校验通过的导入流程做 id / refId 重映射（纯函数）。重映射范围：
/// - 节点 id：全部重生成（`new_id` 注入，画布与仓库同源）；
/// - 节点 refId：**全部重生成**并对本流程查重（导入物是独立流程副本，不沿用
///   来源文件中的短码——这也是 refId 冲突的裁决方式：新短码经 `new_ref_id`
///   注入并在流程内查重，绝不与既有流程冲突）；模板引用与裸 id 字段同步改写；
/// - 连线 id：全部重生成；source / target 重映射到新节点 id；条件分支出边
///   手柄随导入保留（`'true'` / `'false'`，解析侧已归一化）；
/// - config：先改写裸 id 字段，再整体改写模板引用（复用
///   [`super::model::remap_node_config_refs`]，模板改写表 = 旧节点 id → 新 id
///   ∪ 旧 refId → 新 refId，两个 token 命名空间不相交）；
/// - variables / secretVariables：浅拷贝透传；名称 / 描述原样保留（重名后缀
///   由 [`dedupe_workflow_name`] 在入库前追加）。
///
/// 与上游的刻意差异：节点展示名（`label`）随导入保留，上游 JS 重映射会静默
/// 丢弃——宿主视为用户数据不丢弃。
///
/// `parsed.data` 为 `None`（校验未通过却调用）返回错误，属调用方编程错误。
pub fn remap_imported_workflow(
    parsed: &ParsedWorkflowImport,
    new_id: &mut dyn FnMut() -> String,
    new_ref_id: &mut dyn FnMut(&BTreeSet<String>) -> String,
) -> Result<WorkflowImportItem, String> {
    let Some(data) = parsed.data.as_ref() else {
        return Err("导入重映射失败：流程校验未通过，不能重映射".to_owned());
    };
    // 旧节点 id → 新节点 id / 旧 refId → 新 refId / 旧节点 id → 新 refId。
    let mut node_id_by_old = BTreeMap::new();
    let mut ref_id_by_old_ref = BTreeMap::new();
    let mut ref_id_by_old_id = BTreeMap::new();
    let mut taken_ref_ids = BTreeSet::new();
    for node in &data.nodes {
        let new_node_id = new_id();
        node_id_by_old.insert(node.id.clone(), new_node_id);
        let new_ref_id = new_ref_id(&taken_ref_ids);
        taken_ref_ids.insert(new_ref_id.clone());
        ref_id_by_old_id.insert(node.id.clone(), new_ref_id.clone());
        if let Some(old_ref_id) = node.ref_id.as_deref().filter(|value| !value.is_empty()) {
            ref_id_by_old_ref.insert(old_ref_id.to_owned(), new_ref_id);
        }
    }
    let mut template_map = node_id_by_old.clone();
    template_map.extend(ref_id_by_old_ref);

    let nodes = data
        .nodes
        .iter()
        .map(|node| WorkflowNode {
            id: node_id_by_old[&node.id].clone(),
            node_type: node.node_type,
            position: node.position,
            label: node.label.clone(),
            ref_id: Some(ref_id_by_old_id[&node.id].clone()),
            config: remap_node_config_refs(
                &remap_bare_node_ids(&node.config, &node_id_by_old),
                &template_map,
            ),
        })
        .collect();
    let edges = data
        .edges
        .iter()
        .map(|edge| WorkflowEdge {
            id: new_id(),
            source: node_id_by_old
                .get(&edge.source)
                .cloned()
                .unwrap_or_else(|| edge.source.clone()),
            target: node_id_by_old
                .get(&edge.target)
                .cloned()
                .unwrap_or_else(|| edge.target.clone()),
            source_handle: edge.source_handle,
        })
        .collect();
    Ok(WorkflowImportItem {
        name: parsed.name.clone(),
        description: parsed.description.clone(),
        nodes,
        edges,
        variables: data.variables.clone(),
        secret_variables: data.secret_variables.clone(),
    })
}

/// 导入重名消解（纯函数，对齐上游）：`name` 未被占用时原样返回；被占用时
/// 依次尝试「<原名> (导入 2)」「<原名> (导入 3)」…直到找到未占用的名称。
/// 与同批次先前导入的名称也应传入 `taken_names`（调用方逐个追加）。
pub fn dedupe_workflow_name(name: &str, taken_names: &BTreeSet<String>) -> String {
    if !taken_names.contains(name) {
        return name.to_owned();
    }
    for suffix in 2_u64.. {
        let candidate = format!("{name} (导入 {suffix})");
        if !taken_names.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("suffix loop always returns")
}

/* ------------------------------------------------------------------ *
 * 导入脚本审查（对齐归档 M9-T5 / M19 confirmScripts 安全口径）
 * ------------------------------------------------------------------ */

/// 可执行脚本种类：preProcess（httpReplay 前置）/ postProcess（后置）/
/// expression（condition 条件表达式）。三者都会在携带用户 cookie 与跨域
/// 权限的环境里执行，导入时必须逐条审查确认后才原样入库。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportedScriptKind {
    PreProcess,
    PostProcess,
    Expression,
}

impl ImportedScriptKind {
    /// 脚本种类字面量（与上游 `ImportedScriptKind` 一致，也是唯一键的组成段）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreProcess => "preProcess",
            Self::PostProcess => "postProcess",
            Self::Expression => "expression",
        }
    }
}

/// 单节点内的脚本收集顺序：pre → post → expression（清单稳定可复现）。
const SCRIPT_KINDS: [ImportedScriptKind; 3] = [
    ImportedScriptKind::PreProcess,
    ImportedScriptKind::PostProcess,
    ImportedScriptKind::Expression,
];

/// 导入文件中的一条可执行脚本（审查清单的最小单元）。
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedScriptRef {
    /// 所属流程在传入清单中的下标（与 confirm/clear 的 workflowIndex 同口径）。
    pub workflow_index: usize,
    /// 所属节点在 nodes 数组中的下标（展示定位用）。
    pub node_index: usize,
    /// 所属节点 id（导入文件原文，重映射前的旧 id）。
    pub node_id: String,
    /// 所属节点类型（展示节点种类标签用）。
    pub node_type: WorkflowNodeType,
    /// 脚本种类（见 [`ImportedScriptKind`]）。
    pub kind: ImportedScriptKind,
    /// 脚本原文（审查展示用）。
    pub source: String,
}

/// 读取一个脚本种类的字段值（`None` = 未配置）。
fn config_script(config: &NodeConfig, kind: ImportedScriptKind) -> Option<&str> {
    match kind {
        ImportedScriptKind::PreProcess => config.pre_process.as_deref(),
        ImportedScriptKind::PostProcess => config.post_process.as_deref(),
        ImportedScriptKind::Expression => config.expression.as_deref(),
    }
}

/// 构造脚本审查项的唯一键（确认集合的 key 口径，对齐上游
/// `importedScriptKey`）：流程下标 + 节点下标 + 脚本种类。下标口径对损坏
/// 输入比节点 id 更稳健。
pub fn imported_script_key(
    workflow_index: usize,
    node_index: usize,
    kind: ImportedScriptKind,
) -> String {
    format!("{workflow_index}:{node_index}:{}", kind.as_str())
}

/// 收集导入清单中全部可执行脚本（纯函数，导入弹窗「脚本审查」步骤的数据源）。
/// 只收集校验通过（`data` 非空）的流程；顺序：流程下标 → 节点下标 →
/// pre / post / expression 固定顺序。
pub fn collect_imported_scripts(workflows: &[ParsedWorkflowImport]) -> Vec<ImportedScriptRef> {
    let mut scripts = Vec::new();
    for (workflow_index, workflow) in workflows.iter().enumerate() {
        let Some(data) = workflow.data.as_ref() else {
            continue;
        };
        for (node_index, node) in data.nodes.iter().enumerate() {
            for kind in SCRIPT_KINDS {
                if let Some(source) = config_script(&node.config, kind)
                    .filter(|source| !source.is_empty())
                {
                    scripts.push(ImportedScriptRef {
                        workflow_index,
                        node_index,
                        node_id: node.id.clone(),
                        node_type: node.node_type,
                        kind,
                        source: source.to_owned(),
                    });
                }
            }
        }
    }
    scripts
}

/// 把未确认（默认拒绝）的导入脚本置空（纯函数，入库前的最后一步）。
///
/// 语义（对齐上游 M9-T5 / M19 confirmScripts）：**拒绝不入库的是脚本本身，
/// 不是流程**——未被逐条确认的脚本在入库副本中整字段移除（节点保留、脚本
/// 不执行），已确认的脚本原样保留；导入不因存在未确认脚本而中止。
pub fn clear_unconfirmed_scripts(
    parsed: &mut ParsedWorkflowImport,
    workflow_index: usize,
    unconfirmed_keys: &BTreeSet<String>,
) {
    let Some(data) = parsed.data.as_mut() else {
        return;
    };
    if unconfirmed_keys.is_empty() {
        return;
    }
    for (node_index, node) in data.nodes.iter_mut().enumerate() {
        for kind in SCRIPT_KINDS {
            let unconfirmed = unconfirmed_keys.contains(&imported_script_key(
                workflow_index,
                node_index,
                kind,
            ));
            if unconfirmed
                && config_script(&node.config, kind).is_some_and(|source| !source.is_empty())
            {
                match kind {
                    ImportedScriptKind::PreProcess => node.config.pre_process = None,
                    ImportedScriptKind::PostProcess => node.config.post_process = None,
                    ImportedScriptKind::Expression => node.config.expression = None,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::model::{
        ConditionBranchHandle, Position, RequestOverride, VariableAssignment,
        VariableAssignmentSource, WORKFLOW_SCHEMA_VERSION,
    };
    use crate::flow::request_library::{HarEntry, HarSnapshot, RequestSource};
    use serde_json::json;

    fn node(id: &str, node_type: WorkflowNodeType, config: NodeConfig) -> WorkflowNode {
        WorkflowNode {
            id: id.to_owned(),
            node_type,
            position: Position { x: 1.5, y: -2.5 },
            config,
            label: None,
            ref_id: None,
        }
    }

    fn sample_workflow() -> Workflow {
        let mut start = node("s1", WorkflowNodeType::Start, NodeConfig::default());
        start.ref_id = Some("aaaaa".to_owned());
        let mut replay = node(
            "n1",
            WorkflowNodeType::HttpReplay,
            NodeConfig {
                request_id: Some("req-1".to_owned()),
                pre_process: Some("return input".to_owned()),
                post_process: Some("return response".to_owned()),
                override_: Some(RequestOverride {
                    url: Some("http://api.test/{{ node.n2.path }}?r={{ node.bbbbb.id }}".to_owned()),
                    ..RequestOverride::default()
                }),
                ..NodeConfig::default()
            },
        );
        replay.ref_id = Some("bbbbb".to_owned());
        let condition = node(
            "n2",
            WorkflowNodeType::Condition,
            NodeConfig {
                expression: Some("input.ok === true".to_owned()),
                true_targets: Some(vec!["n1".to_owned()]),
                false_targets: Some(vec!["s1".to_owned()]),
                ..NodeConfig::default()
            },
        );
        let mut setter = node(
            "n3",
            WorkflowNodeType::SetVariable,
            NodeConfig {
                assignments: Some(vec![VariableAssignment {
                    name: "token".to_owned(),
                    from: VariableAssignmentSource::Node,
                    path: Some("body.token".to_owned()),
                    node: Some("n1".to_owned()),
                    value: None,
                }]),
                ..NodeConfig::default()
            },
        );
        setter.ref_id = Some("ccccc".to_owned());
        Workflow {
            id: "wf-1".to_owned(),
            project_id: "proj-1".to_owned(),
            name: "结算链路".to_owned(),
            description: "导入导出往返样例".to_owned(),
            nodes: vec![start, replay, condition, setter],
            edges: vec![
                WorkflowEdge {
                    id: "e1".to_owned(),
                    source: "s1".to_owned(),
                    target: "n1".to_owned(),
                    source_handle: None,
                },
                WorkflowEdge {
                    id: "e2".to_owned(),
                    source: "n2".to_owned(),
                    target: "n1".to_owned(),
                    source_handle: Some(ConditionBranchHandle::True),
                },
            ],
            variables: BTreeMap::from([("env".to_owned(), "dev".to_owned())]),
            secret_variables: BTreeMap::from([("token".to_owned(), "pk-live-9999".to_owned())]),
            schema_version: WORKFLOW_SCHEMA_VERSION,
            created_at: 100,
            updated_at: 100,
        }
    }

    fn sample_request(id: &str) -> RequestLibraryEntry {
        RequestLibraryEntry {
            id: id.to_owned(),
            name: format!("GET {id}"),
            tags: vec![],
            source: RequestSource::Capture,
            origin: String::new(),
            har: HarSnapshot::single(HarEntry::new("GET", "http://api.test/a")),
            body_ref: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn sample_env_set() -> EnvVariableSet {
        EnvVariableSet {
            id: "env-dev".to_owned(),
            name: "dev".to_owned(),
            values: BTreeMap::from([("baseUrl".to_owned(), "http://localhost".to_owned())]),
            secret_values: BTreeMap::from([("password".to_owned(), "hunter2".to_owned())]),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn export_envelope_strips_every_secret_value() {
        let workflow = sample_workflow();
        let file = build_workflow_export_file(
            &[workflow],
            &[sample_request("req-1")],
            &[sample_env_set()],
            12345,
        );
        assert_eq!(file.format, WORKFLOW_EXPORT_FORMAT);
        assert_eq!(file.version, WORKFLOW_EXPORT_VERSION);
        assert_eq!(file.exported_at, 12345);
        assert_eq!(file.requests.len(), 1);
        // 流程 secret 变量：名留值空；环境变量集：secret 表整表剔除。
        assert_eq!(
            file.workflows[0].secret_variables,
            BTreeMap::from([("token".to_owned(), String::new())])
        );
        assert!(file.env_sets[0].secret_values.is_empty());
        assert_eq!(
            file.env_sets[0].values.get("baseUrl").map(String::as_str),
            Some("http://localhost")
        );
        // 序列化文本不含任何 secret 明文（普通变量名与值不受影响）；环境变量集
        // 的 secret 表序列化为空对象（键保留、表为空——字段非 Option，不落值即
        // 达到剔除口径）。
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains("pk-live-9999"));
        assert!(!text.contains("hunter2"));
        assert!(text.contains("http://localhost"));
        assert!(text.contains("\"secretValues\":{}"));
    }

    #[test]
    fn strip_workflow_secrets_keeps_names_and_never_touches_input() {
        let workflow = sample_workflow();
        let stripped = strip_workflow_secrets_for_export(&workflow);
        assert_eq!(
            stripped.secret_variables,
            BTreeMap::from([("token".to_owned(), String::new())])
        );
        assert_eq!(stripped.variables, workflow.variables);
        assert_eq!(stripped.nodes, workflow.nodes);
        // 入参不被改动。
        assert_eq!(
            workflow.secret_variables.get("token").map(String::as_str),
            Some("pk-live-9999")
        );
    }

    #[test]
    fn referenced_requests_follow_library_order() {
        // 样例流程只引用 req-1；库中其它条目（含前缀雷同 id）不带入，且保持库序。
        let workflow = sample_workflow();
        let library = vec![
            sample_request("req-9"),
            sample_request("req-1x"),
            sample_request("req-1"),
            sample_request("req-2"),
        ];
        let collected = collect_referenced_requests(&[workflow], &library);
        assert_eq!(
            collected
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["req-1"]
        );
    }

    #[test]
    fn export_import_remap_round_trips_definition() {
        let workflow = sample_workflow();
        let file = build_workflow_export_file(std::slice::from_ref(&workflow), &[], &[], 1);
        let text = serde_json::to_string(&file).unwrap();
        let parsed = parse_workflow_import(&text).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].issues.is_empty(), "{:?}", parsed[0].issues);
        assert_eq!(parsed[0].node_count, 4);
        assert_eq!(parsed[0].edge_count, 2);
        // 解析产物保持导入文件原文的旧 id（重映射前）。
        let data = parsed[0].data.as_ref().unwrap();
        assert_eq!(data.nodes[1].id, "n1");
        assert_eq!(data.edges[1].source_handle, Some(ConditionBranchHandle::True));

        let mut id_counter = 0_usize;
        let mut new_id = || {
            id_counter += 1;
            format!("new-{id_counter}")
        };
        let ref_ids = ["raaao", "rbbbo", "rccco", "rdddo"];
        let mut ref_counter = 0_usize;
        let mut new_ref_id = |_taken: &BTreeSet<String>| {
            let next = ref_ids[ref_counter];
            ref_counter += 1;
            next.to_owned()
        };
        let item = remap_imported_workflow(&parsed[0], &mut new_id, &mut new_ref_id).unwrap();

        // 名称 / 描述 / 变量透传；secret 变量保持导出剔空形态。
        assert_eq!(item.name, "结算链路");
        assert_eq!(item.description, "导入导出往返样例");
        assert_eq!(
            item.variables,
            BTreeMap::from([("env".to_owned(), "dev".to_owned())])
        );
        assert_eq!(
            item.secret_variables,
            BTreeMap::from([("token".to_owned(), String::new())])
        );
        // 节点 id / refId 全部重生成（不沿用来源短码），类型与位置保留。
        let ids: Vec<&str> = item.nodes.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(ids, vec!["new-1", "new-2", "new-3", "new-4"]);
        for (node, ref_id) in item.nodes.iter().zip(ref_ids) {
            assert_eq!(node.ref_id.as_deref(), Some(ref_id));
            assert!(crate::flow::model::is_valid_ref_id(ref_id));
            assert_ne!(ref_id, "bbbbb");
        }
        assert_eq!(item.nodes[1].position, Position { x: 1.5, y: -2.5 });
        // 模板引用：旧节点 id → 新节点 id、旧 refId → 新 refId。
        assert_eq!(
            item.nodes[1].config.override_.as_ref().unwrap().url.as_deref(),
            Some("http://api.test/{{ node.new-3.path }}?r={{ node.rbbbo.id }}")
        );
        assert_eq!(
            item.nodes[1].config.pre_process.as_deref(),
            Some("return input")
        );
        // 裸 id 字段（trueTargets / falseTargets / assignments[].node）同步改写。
        assert_eq!(
            item.nodes[2].config.true_targets,
            Some(vec!["new-2".to_owned()])
        );
        assert_eq!(
            item.nodes[2].config.false_targets,
            Some(vec!["new-1".to_owned()])
        );
        assert_eq!(
            item.nodes[3].config.assignments.as_ref().unwrap()[0].node,
            Some("new-2".to_owned())
        );
        // 连线 id 重生成、端点重映射、条件手柄保留。
        assert_eq!(item.edges[0].id, "new-5");
        assert_eq!(item.edges[0].source, "new-1");
        assert_eq!(item.edges[0].target, "new-2");
        assert_eq!(item.edges[1].source, "new-3");
        assert_eq!(item.edges[1].source_handle, Some(ConditionBranchHandle::True));
    }

    #[test]
    fn parse_rejects_malformed_files() {
        assert_eq!(
            parse_workflow_import("not json").unwrap_err(),
            "文件不是合法的 JSON"
        );
        assert_eq!(
            parse_workflow_import("[1]").unwrap_err(),
            "导出文件结构不符：顶层必须是对象"
        );
        assert_eq!(
            parse_workflow_import("{\"version\":1,\"workflows\":[{}]}").unwrap_err(),
            format!("不是 ReqFlow 流程导出文件（format 标识缺失或不符，期望 \"{WORKFLOW_EXPORT_FORMAT}\"）")
        );
        assert_eq!(
            parse_workflow_import("{\"format\":\"reqflow-workflow\",\"workflows\":[{}]}")
                .unwrap_err(),
            "导出文件缺少有效的 version 版本号"
        );
        assert_eq!(
            parse_workflow_import("{\"format\":\"reqflow-workflow\",\"version\":2,\"workflows\":[{}]}")
                .unwrap_err(),
            "导出文件版本 v2 高于当前支持的最高版本 v1，请升级程序后再导入"
        );
        assert_eq!(
            parse_workflow_import("{\"format\":\"reqflow-workflow\",\"version\":1}").unwrap_err(),
            "导出文件中没有流程数据"
        );
        assert_eq!(
            parse_workflow_import("{\"format\":\"reqflow-workflow\",\"version\":1,\"workflows\":[]}")
                .unwrap_err(),
            "导出文件中没有流程数据"
        );
    }

    #[test]
    fn parse_collects_per_workflow_issues_and_blocks_data() {
        let text = json!({
            "format": WORKFLOW_EXPORT_FORMAT,
            "version": WORKFLOW_EXPORT_VERSION,
            "workflows": [
                { "nodes": "nope", "edges": [] },
                {
                    "name": "坏节点",
                    "nodes": [{ "id": "", "type": "start", "position": {"x": 0, "y": 0}, "config": {} }],
                    "edges": []
                },
                {
                    "name": "便签连线",
                    "nodes": [
                        { "id": "n1", "type": "stickyNote", "position": {"x": 0, "y": 0}, "config": {} },
                        { "id": "n2", "type": "start", "position": {"x": 0, "y": 0}, "config": {} }
                    ],
                    "edges": [{ "id": "e1", "source": "n1", "target": "n2" }]
                },
                {
                    "name": "坏变量",
                    "nodes": [],
                    "edges": [],
                    "variables": { "k": 42 }
                },
                {
                    "name": "坏config",
                    "nodes": [{ "id": "n1", "type": "httpReplay", "position": {"x": 0, "y": 0}, "config": { "failPolicy": "sometimes" } }],
                    "edges": []
                },
                {
                    "name": "重复id",
                    "nodes": [
                        { "id": "n1", "type": "start", "position": {"x": 0, "y": 0}, "config": {} },
                        { "id": "n1", "type": "start", "position": {"x": 1, "y": 1}, "config": {} }
                    ],
                    "edges": []
                }
            ],
        })
        .to_string();
        let parsed = parse_workflow_import(&text).unwrap();
        assert_eq!(parsed.len(), 6);
        assert!(parsed.iter().all(|workflow| workflow.data.is_none()));
        assert!(parsed[0].issues.contains(&"流程名称缺失或为空".to_owned()));
        assert_eq!(parsed[0].name, UNNAMED_WORKFLOW_NAME);
        assert!(parsed[0].issues.contains(&"nodes 必须是数组".to_owned()));
        assert!(parsed[1].issues.contains(&"节点 #1 缺少有效 id".to_owned()));
        assert!(parsed[2]
            .issues
            .contains(&"连线 #1 连接了便签节点：便签不参与连线".to_owned()));
        assert!(parsed[3]
            .issues
            .contains(&"variables中变量 \"k\" 的值必须是字符串".to_owned()));
        assert!(parsed[4].issues.iter().any(|issue| issue.contains("形状非法")));
        assert!(parsed[5].issues.contains(&"节点 id 重复：n1".to_owned()));
    }

    #[test]
    fn parse_normalizes_edge_handles_and_validates_variables_keys() {
        // 非法 sourceHandle 不落字段（M16-T1 口径），合法手柄保留。
        let text = json!({
            "format": WORKFLOW_EXPORT_FORMAT,
            "version": WORKFLOW_EXPORT_VERSION,
            "workflows": [{
                "name": "手柄归一",
                "nodes": [
                    { "id": "n1", "type": "condition", "position": {"x": 0, "y": 0}, "config": {} },
                    { "id": "n2", "type": "start", "position": {"x": 0, "y": 0}, "config": {} }
                ],
                "edges": [
                    { "id": "e1", "source": "n1", "target": "n2", "sourceHandle": "middle" },
                    { "id": "e2", "source": "n1", "target": "n2", "sourceHandle": "false" }
                ],
                "variables": { "env": "dev", "": "空键被拒" }
            }],
        })
        .to_string();
        let parsed = parse_workflow_import(&text).unwrap();
        // 空键变量表命中宿主键非空校验，流程整体阻断。
        assert!(parsed[0]
            .issues
            .contains(&"variables中变量键不能为空".to_owned()));
        assert!(parsed[0].data.is_none());

        let ok_text = json!({
            "format": WORKFLOW_EXPORT_FORMAT,
            "version": WORKFLOW_EXPORT_VERSION,
            "workflows": [{
                "name": "手柄归一",
                "nodes": [
                    { "id": "n1", "type": "condition", "position": {"x": 0, "y": 0}, "config": {} },
                    { "id": "n2", "type": "start", "position": {"x": 0, "y": 0}, "config": {} }
                ],
                "edges": [
                    { "id": "e1", "source": "n1", "target": "n2", "sourceHandle": "middle" },
                    { "id": "e2", "source": "n1", "target": "n2", "sourceHandle": "false" }
                ],
                "variables": { "env": "dev" },
                "secretVariables": { "token": "" }
            }],
        })
        .to_string();
        let parsed = parse_workflow_import(&ok_text).unwrap();
        assert!(parsed[0].issues.is_empty(), "{:?}", parsed[0].issues);
        let data = parsed[0].data.as_ref().unwrap();
        assert_eq!(data.edges[0].source_handle, None);
        assert_eq!(
            data.edges[1].source_handle,
            Some(ConditionBranchHandle::False)
        );
        assert_eq!(
            data.secret_variables,
            BTreeMap::from([("token".to_owned(), String::new())])
        );
    }

    #[test]
    fn conflict_resolution_renames_names_and_rejects_unvalidated_remap() {
        assert_eq!(dedupe_workflow_name("a", &BTreeSet::new()), "a");
        let taken = BTreeSet::from(["a".to_owned(), "a (导入 2)".to_owned()]);
        assert_eq!(dedupe_workflow_name("a", &taken), "a (导入 3)");
        let mut new_id = || "x".to_owned();
        let mut new_ref_id =|_: &BTreeSet<String>| "aaaaa".to_owned();
        // 校验未通过（data 为 None）的流程不能重映射——调用方编程错误。
        let unvalidated = ParsedWorkflowImport::default();
        assert!(remap_imported_workflow(&unvalidated, &mut new_id, &mut new_ref_id).is_err());
    }

    #[test]
    fn imported_scripts_default_to_cleared_until_confirmed() {
        let text = json!({
            "format": WORKFLOW_EXPORT_FORMAT,
            "version": WORKFLOW_EXPORT_VERSION,
            "workflows": [{
                "name": "带脚本的流程",
                "nodes": [
                    { "id": "n1", "type": "httpReplay", "position": {"x": 0, "y": 0}, "config": {
                        "preProcess": "return input",
                        "postProcess": "return response"
                    } },
                    { "id": "n2", "type": "condition", "position": {"x": 0, "y": 0}, "config": {
                        "expression": "input.ok === true"
                    } }
                ],
                "edges": []
            }],
        })
        .to_string();
        let mut parsed = parse_workflow_import(&text).unwrap();
        let scripts = collect_imported_scripts(&parsed);
        // 顺序：节点下标 → pre / post / expression。
        assert_eq!(scripts.len(), 3);
        assert_eq!(
            scripts
                .iter()
                .map(|script| (script.node_index, script.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "preProcess"), (0, "postProcess"), (1, "expression")]
        );
        assert_eq!(scripts[0].source, "return input");
        assert_eq!(scripts[2].node_id, "n2");

        // 缺省拒绝：未确认的脚本整字段移除（节点保留、脚本不执行）。
        let confirmed = BTreeSet::from([imported_script_key(
            0,
            0,
            ImportedScriptKind::PreProcess,
        )]);
        let unconfirmed: BTreeSet<String> = scripts
            .iter()
            .map(|script| imported_script_key(script.workflow_index, script.node_index, script.kind))
            .filter(|key| !confirmed.contains(key))
            .collect();
        clear_unconfirmed_scripts(&mut parsed[0], 0, &unconfirmed);
        let nodes = &parsed[0].data.as_ref().unwrap().nodes;
        assert_eq!(nodes[0].config.pre_process.as_deref(), Some("return input"));
        assert_eq!(nodes[0].config.post_process, None);
        assert_eq!(nodes[1].config.expression, None);
        // 「整字段移除」：序列化形状与未配置脚本同形，不残留空串。
        let config = serde_json::to_value(&nodes[0].config).unwrap();
        assert!(config.get("postProcess").is_none());
        // 全部确认 → 原样保留。
        let mut untouched = parse_workflow_import(&text).unwrap();
        clear_unconfirmed_scripts(&mut untouched[0], 0, &BTreeSet::new());
        let nodes = &untouched[0].data.as_ref().unwrap().nodes;
        assert_eq!(nodes[0].config.post_process.as_deref(), Some("return response"));
        // 损坏流程（data 为 None）原样放过。
        let mut broken = [ParsedWorkflowImport::default()];
        clear_unconfirmed_scripts(&mut broken[0], 0, &unconfirmed);
    }
}
