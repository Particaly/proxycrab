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

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{
    env_sets::strip_secrets_for_export,
    model::Workflow,
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
