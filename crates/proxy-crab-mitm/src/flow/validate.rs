//! 工作流图校验口径（ReqFlow 复刻计划 Task 10 Step 2）。
//!
//! 对领域模型图（[`WorkflowNode`]/[`WorkflowEdge`]）做结构性校验，产出问题
//! 清单；规则与产出顺序对齐归档 ReqFlow `components/flow/graph-validation.ts`
//! 的 error 级子集。定位：**运行门禁**——校验失败（问题清单非空）在创建运行
//! 单之前直接判失败（计划 Task 19 的建单前置检查与 Task 11 的 validate API
//! 共用本模块）；**不是保存门禁**——编辑中的不完整图允许照常落盘（与 ReqFlow
//! 「校验徽标提示、运行按钮拦截」的分层一致；warning/info 级的画布徽标校验
//! 由计划 Task 13 的前端移植承担）。
//!
//! `failPolicy` 合法值不在本模块检查：强类型 [`NodeFailPolicy`] 在反序列化
//! 边界直接拒绝非法值（整份文档判损坏），合法域由类型系统保证。
//!
//! 规则清单（issue code）：
//!   - missing-start    error  无任何开始节点（含空流程：只报本条不重复报）；
//!   - multiple-start   error  存在多个开始节点（nodeIds 列出全部）；
//!   - dangling-edge    error  连线 source/target 指向不存在的节点（每条一条）；
//!   - sticky-note-edge error  便签节点出现连线（便签纯注释不入执行拓扑、
//!     不可连线，落盘数据里出现即结构性错误）；
//!   - refid-invalid    error  节点引用短码非「恰好 5 位字母」（每个坏短码一条；
//!     非法短码不参与冲突判定，避免双重报错）；
//!   - refid-conflict   error  多个节点占用同一引用短码（模板引用将歧义）。
//!
//! 结果顺序固定（缺/多开始 → 坏连线 → 便签连线 → 短码非法 → 短码冲突），
//! 同输入同输出。

use std::collections::{BTreeMap, BTreeSet};

use crate::flow::model::{WorkflowEdge, WorkflowNode, WorkflowNodeType, is_valid_ref_id};

/// 问题类别字面量联合（见模块头规则清单）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationIssueCode {
    MissingStart,
    MultipleStart,
    DanglingEdge,
    StickyNoteEdge,
    RefIdInvalid,
    RefIdConflict,
}

impl ValidationIssueCode {
    /// 类别字符串（对齐归档 issue.code 的 kebab-case 字面量）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingStart => "missing-start",
            Self::MultipleStart => "multiple-start",
            Self::DanglingEdge => "dangling-edge",
            Self::StickyNoteEdge => "sticky-note-edge",
            Self::RefIdInvalid => "refid-invalid",
            Self::RefIdConflict => "refid-conflict",
        }
    }
}

/// 一条校验问题（本模块产出的问题均为阻断级）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub code: ValidationIssueCode,
    /// 可直接展示的信息（含定位所需的节点标识）。
    pub message: String,
    /// 关联节点 id（定位用；流程级问题为空）。
    pub node_ids: Vec<String>,
}

impl ValidationIssue {
    fn new(code: ValidationIssueCode, message: impl Into<String>, node_ids: Vec<String>) -> Self {
        Self {
            code,
            message: message.into(),
            node_ids,
        }
    }
}

/// 校验流程图，返回问题清单（为空 = 图结构合法）。
pub fn validate_workflow_graph(
    nodes: &[WorkflowNode],
    edges: &[WorkflowEdge],
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();

    // 规则一：唯一开始节点（0 个 = 缺开始，覆盖空流程；>1 个 = 多开始）。
    let start_nodes: Vec<&WorkflowNode> = nodes
        .iter()
        .filter(|node| node.node_type == WorkflowNodeType::Start)
        .collect();
    if start_nodes.is_empty() {
        let message = if nodes.is_empty() {
            "流程为空：请先添加节点与「开始」节点"
        } else {
            "缺少开始节点：流程至少需要一个「开始」节点"
        };
        issues.push(ValidationIssue::new(
            ValidationIssueCode::MissingStart,
            message,
            Vec::new(),
        ));
    } else if start_nodes.len() > 1 {
        issues.push(ValidationIssue::new(
            ValidationIssueCode::MultipleStart,
            format!(
                "存在 {} 个开始节点，流程只能有一个开始节点",
                start_nodes.len()
            ),
            start_nodes.iter().map(|node| node.id.clone()).collect(),
        ));
    }

    let node_ids: BTreeSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();

    // 规则二：连线端点必须存在（每条坏连线一条）。
    // 规则三：便签不可连线（入边出边均不允许）。
    let sticky_note_ids: BTreeSet<&str> = nodes
        .iter()
        .filter(|node| node.node_type == WorkflowNodeType::StickyNote)
        .map(|node| node.id.as_str())
        .collect();
    for edge in edges {
        let missing: Vec<&str> = [edge.source.as_str(), edge.target.as_str()]
            .into_iter()
            .filter(|id| !node_ids.contains(id))
            .collect();
        if !missing.is_empty() {
            let locate_ids: Vec<String> = [edge.source.as_str(), edge.target.as_str()]
                .into_iter()
                .filter(|id| node_ids.contains(id))
                .map(str::to_owned)
                .collect();
            issues.push(ValidationIssue::new(
                ValidationIssueCode::DanglingEdge,
                format!(
                    "连线 {} 指向不存在的节点（{}）",
                    edge.id,
                    missing.join("、")
                ),
                locate_ids,
            ));
        }
        if sticky_note_ids.contains(edge.source.as_str())
            || sticky_note_ids.contains(edge.target.as_str())
        {
            issues.push(ValidationIssue::new(
                ValidationIssueCode::StickyNoteEdge,
                format!("便签节点不可连线：连线 {} 涉及便签节点", edge.id),
                [edge.source.as_str(), edge.target.as_str()]
                    .into_iter()
                    .filter(|id| sticky_note_ids.contains(id))
                    .map(str::to_owned)
                    .collect(),
            ));
        }
    }

    // 规则四 / 规则五：引用短码恰好 5 位字母 + 流程内唯一。短码是模板引用
    // `{{ node.<refId> }}` 的解析键，坏键让引用静默失效，冲突产生歧义。
    // 缺省（存量直构节点）合法：读取侧回退内部 id，不在此报问题。
    let mut owners_by_ref_id: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for node in nodes {
        let Some(ref_id) = node.ref_id.as_deref().filter(|value| !value.is_empty()) else {
            continue;
        };
        if !is_valid_ref_id(ref_id) {
            issues.push(ValidationIssue::new(
                ValidationIssueCode::RefIdInvalid,
                format!(
                    "节点（{}）引用短码须为 5 位字母，当前为「{ref_id}」",
                    node.id
                ),
                vec![node.id.clone()],
            ));
            continue;
        }
        owners_by_ref_id.entry(ref_id).or_default().push(&node.id);
    }
    for (ref_id, owners) in owners_by_ref_id {
        if owners.len() <= 1 {
            continue;
        }
        issues.push(ValidationIssue::new(
            ValidationIssueCode::RefIdConflict,
            format!(
                "引用短码 {ref_id} 被 {} 个节点占用，模板引用将产生歧义",
                owners.len()
            ),
            owners.iter().map(|id| (*id).to_owned()).collect(),
        ));
    }

    issues
}

/// 是否存在阻断运行的问题。本模块产出均为阻断级问题：建单前清单非空即判失败。
pub fn has_blocking_issues(issues: &[ValidationIssue]) -> bool {
    !issues.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::model::{NodeConfig, Position};

    fn node(id: &str, node_type: WorkflowNodeType) -> WorkflowNode {
        WorkflowNode {
            id: id.to_owned(),
            node_type,
            position: Position { x: 0.0, y: 0.0 },
            config: NodeConfig::default(),
            label: None,
            ref_id: None,
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.to_owned(),
            source: source.to_owned(),
            target: target.to_owned(),
            source_handle: None,
        }
    }

    #[test]
    fn healthy_start_chain_has_no_issues() {
        let nodes = vec![
            node("s", WorkflowNodeType::Start),
            node("r", WorkflowNodeType::HttpReplay),
        ];
        let edges = vec![edge("e1", "s", "r")];
        assert_eq!(validate_workflow_graph(&nodes, &edges), Vec::new());
    }

    #[test]
    fn empty_graph_reports_missing_start_once() {
        let issues = validate_workflow_graph(&[], &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::MissingStart);
        assert!(issues[0].message.contains("流程为空"));
    }

    #[test]
    fn graph_without_start_reports_missing_start() {
        let nodes = vec![node("r", WorkflowNodeType::HttpReplay)];
        let issues = validate_workflow_graph(&nodes, &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::MissingStart);
    }

    #[test]
    fn multiple_starts_report_all_nodes() {
        let nodes = vec![
            node("s1", WorkflowNodeType::Start),
            node("s2", WorkflowNodeType::Start),
            node("r", WorkflowNodeType::HttpReplay),
        ];
        let issues = validate_workflow_graph(&nodes, &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::MultipleStart);
        assert_eq!(issues[0].node_ids, vec!["s1".to_owned(), "s2".to_owned()]);
    }

    #[test]
    fn dangling_edge_reports_missing_endpoint_and_keeps_existing() {
        let nodes = vec![
            node("s", WorkflowNodeType::Start),
            node("r", WorkflowNodeType::HttpReplay),
        ];
        let issues = validate_workflow_graph(&nodes, &[edge("e1", "s", "ghost")]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::DanglingEdge);
        assert_eq!(issues[0].node_ids, vec!["s".to_owned()]);
    }

    #[test]
    fn sticky_note_edges_are_rejected_on_both_sides() {
        let nodes = vec![
            node("s", WorkflowNodeType::Start),
            node("note", WorkflowNodeType::StickyNote),
            node("r", WorkflowNodeType::HttpReplay),
        ];
        let issues = validate_workflow_graph(&nodes, &[edge("e1", "s", "note")]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::StickyNoteEdge);
        assert_eq!(issues[0].node_ids, vec!["note".to_owned()]);
        // 便签作为 source 同样拒绝。
        let issues = validate_workflow_graph(&nodes, &[edge("e1", "note", "r")]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::StickyNoteEdge);
    }

    #[test]
    fn unconnected_sticky_note_is_allowed() {
        let nodes = vec![
            node("s", WorkflowNodeType::Start),
            node("note", WorkflowNodeType::StickyNote),
        ];
        assert_eq!(validate_workflow_graph(&nodes, &[]), Vec::new());
    }

    #[test]
    fn ref_id_must_be_five_letters_and_unique() {
        let nodes = vec![
            node("s", WorkflowNodeType::Start),
            node("r", WorkflowNodeType::HttpReplay),
        ];
        // 缺省短码合法（读取侧回退内部 id）。
        assert_eq!(validate_workflow_graph(&nodes, &[]), Vec::new());

        let mut invalid = nodes.clone();
        invalid[1].ref_id = Some("ab1".to_owned());
        let issues = validate_workflow_graph(&invalid, &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::RefIdInvalid);

        let mut conflict = nodes.clone();
        conflict[0].ref_id = Some("abcde".to_owned());
        conflict[1].ref_id = Some("abcde".to_owned());
        let issues = validate_workflow_graph(&conflict, &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, ValidationIssueCode::RefIdConflict);
        assert_eq!(issues[0].node_ids, vec!["s".to_owned(), "r".to_owned()]);

        // 合法且唯一的短码通过。
        conflict[1].ref_id = Some("edcba".to_owned());
        assert_eq!(validate_workflow_graph(&conflict, &[]), Vec::new());
    }

    #[test]
    fn issues_are_reported_in_fixed_order() {
        let mut nodes = vec![
            node("s1", WorkflowNodeType::Start),
            node("s2", WorkflowNodeType::Start),
            node("note", WorkflowNodeType::StickyNote),
        ];
        let edges = vec![edge("e1", "s1", "ghost"), edge("e2", "s1", "note")];
        nodes[0].ref_id = Some("abcde".to_owned());
        nodes[1].ref_id = Some("abcde".to_owned());
        nodes[2].ref_id = Some("bad!".to_owned());
        let issues = validate_workflow_graph(&nodes, &edges);
        let codes: Vec<ValidationIssueCode> = issues.iter().map(|issue| issue.code).collect();
        assert_eq!(
            codes,
            vec![
                ValidationIssueCode::MultipleStart,
                ValidationIssueCode::DanglingEdge,
                ValidationIssueCode::StickyNoteEdge,
                ValidationIssueCode::RefIdInvalid,
                ValidationIssueCode::RefIdConflict,
            ]
        );
        assert!(has_blocking_issues(&issues));
    }

    #[test]
    fn empty_issue_list_has_no_blocking() {
        assert!(!has_blocking_issues(&[]));
    }
}
