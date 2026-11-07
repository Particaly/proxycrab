//! 工作流深度校验（编辑辅助层，`POST /api/flow/validate` 的规则引擎）。
//!
//! 在结构校验（[`super::validate`]，运行门禁）之外，叠加「运行前可静态发现」
//! 的问题检查：请求库引用存在性、模板表达式语法与可解析引用、断言规则形状、
//! 配置未知字段。定位：**编辑诊断**——产物 severity 可为 error（几乎必然运行
//! 失败）或 warning（提示级），但**不参与运行门禁**（run 链建单前仍只跑结构
//! 校验）；存储读取失败按空数据降级（与 run 链的降级口径一致），不把存储故障
//! 伪装成流程问题。
//!
//! 模板语法对齐 flow-engine `template.ts` 的引用集：`{{ node.<id>.<path> }}` /
//! `{{ input.<path> }}`（`$json` 别名）/ 裸路径（input 简写）/
//! `{{ var.<名>.<path> }}` / `{{ env.<键>.<path> }}` / `{{ fake.<名>(<参数>) }}`。
//! input 与裸路径引用运行期才可解析，不做静态检查。
//!
//! 规则清单（issue code，severity 一律标注在括号内）：
//!
//! - `request-id-missing`（error）：httpReplay 节点 `requestId` 引用的请求库条目不存在；
//! - `manual-request-missing-url`（error）：httpReplay 节点无 requestId 且 `manualRequest` 缺 url（无可重放基线）；
//! - `template-syntax`（error）：模板表达式语法坏（未闭合 `{{`、空表达式、未知根/非法路径形态、node/var/env/fake 缺名）；
//! - `fake-generator-unknown`（warning）：`{{ fake.<名> }}` 的生成器名不在引擎名单内（渲染为空串，与引擎的告警口径一致）；
//! - `node-ref-missing`（warning）：`{{ node.<id> }}` 的 id 不在本图节点 id/refId 集合内（渲染为空串）；
//! - `env-key-unknown`（warning）：`{{ env.<键> }}` 不在激活环境集（values+secretValues 键）——提示级：激活集可切换；
//! - `var-key-unknown`（warning）：`{{ var.<名> }}` 不在全局/项目/流程变量表，也非 setVariable 声明的运行期变量（与 run 链的三层合并 + 运行期声明口径一致）；
//! - `assertion-invalid`（error）：断言规则形状不完整（jsonPath 空 path、比较/regex 断言缺 value、status eq 缺期望码、schema 非对象）；
//! - `config-unknown-field`（warning）：节点 config 含 [`NodeConfig`] 已知字段之外的键（读取侧静默忽略，多为拼写错误；仅草稿 inline 模式可检——存量文档在存储读取边界已丢弃未知键）。

use std::collections::BTreeSet;

use serde_json::Value as JsonValue;

use super::model::{
    AssertionRule, JsonPathOperator, LoopItems, NodeConfig, StatusCodeOperator, Workflow,
    WorkflowNodeType,
};
use super::store::FlowStore;
use super::validate::ValidationSeverity;

/// 深度校验问题（code 为稳定 kebab-case 字面量，由 manager 层映射到 wire DTO）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepValidationIssue {
    pub severity: ValidationSeverity,
    pub code: &'static str,
    pub message: String,
    pub node_ids: Vec<String>,
}

impl DeepValidationIssue {
    fn error(code: &'static str, message: impl Into<String>, node_id: &str) -> Self {
        Self {
            severity: ValidationSeverity::Error,
            code,
            message: message.into(),
            node_ids: vec![node_id.to_owned()],
        }
    }

    fn warning(code: &'static str, message: impl Into<String>, node_id: &str) -> Self {
        Self {
            severity: ValidationSeverity::Warning,
            code,
            message: message.into(),
            node_ids: vec![node_id.to_owned()],
        }
    }
}

/// [`NodeConfig`] 的已知字段（camelCase wire 键；9 类节点共用）。未知键当前在
/// 反序列化边界被静默忽略，仅草稿 inline 模式可检（存量文档在存储读取边界已
/// 丢弃未知键，无法复原）。
const KNOWN_CONFIG_FIELDS: &[&str] = &[
    /* httpReplay */
    "requestId",
    "manualRequest",
    "override",
    "preProcess",
    "postProcess",
    "timeoutMs",
    "failPolicy",
    "headerFidelity",
    "cookieMode",
    "cookieValue",
    /* condition */
    "expression",
    "trueTargets",
    "falseTargets",
    "conditionRules",
    "condition",
    /* loop */
    "items",
    "maxIterations",
    "csvText",
    "csvDelimiter",
    "concurrency",
    "intervalMs",
    /* delay */
    "durationMs",
    /* setVariable */
    "assignments",
    /* assert */
    "assertions",
    /* transform */
    "extractions",
    /* stickyNote */
    "text",
    "color",
    "size",
    /* 全节点 */
    "retry",
    "pinnedOutput",
];

/// flow-engine `fake.ts` 的生成器名单（`{{ fake.<名> }}` 的合法名）。
const FAKE_GENERATOR_NAMES: &[&str] = &[
    "phone",
    "name",
    "address",
    "email",
    "idcard",
    "plate",
    "avatar",
    "ip",
    "number",
    "hex",
    "uuid",
    "timestamp",
];

/// 对一份流程图跑全部深度检查：请求库/环境/变量引用基于 store 当前数据（读取
/// 失败按空表降级），`raw_configs` 为草稿模式逐节点原始 JSON（与 `workflow.nodes`
/// 同序），用于未知字段检查；存量 id 模式传 `None` 跳过该检查。产物顺序：
/// 逐节点（图内顺序），节点内 requestId/manual → 模板 → 断言 → 未知字段。
pub fn deep_issues(
    store: &FlowStore,
    workflow: &Workflow,
    raw_configs: Option<&[JsonValue]>,
) -> Vec<DeepValidationIssue> {
    // 请求库条目 id 集合（读失败降级为空表：跳过存在性检查的误报口径）。
    let request_ids: BTreeSet<String> = store
        .list_requests()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.id)
        .collect();

    // env 命名空间键集合 = 激活集 values+secretValues 的键（与 run 链同源）。
    let env_keys: BTreeSet<String> = match (store.active_env_set_id(), store.list_env_sets()) {
        (Ok(Some(active_id)), Ok(sets)) => sets
            .iter()
            .filter(|set| set.id == active_id)
            .flat_map(|set| {
                set.values
                    .keys()
                    .chain(set.secret_values.keys())
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect(),
        _ => BTreeSet::new(),
    };

    // var 命名空间键集合 = 全局 ∪ 项目 ∪ 流程（普通+secret；后层覆盖同名的
    // 合并口径不影响键集合）。
    let mut var_keys: BTreeSet<String> = BTreeSet::new();
    if let Ok(globals) = store.env_globals() {
        var_keys.extend(globals.values.keys().cloned());
        var_keys.extend(globals.secret_values.keys().cloned());
    }
    if let Ok(Some(project)) = store.get_project(&workflow.project_id) {
        var_keys.extend(project.variables.keys().cloned());
        var_keys.extend(project.secret_variables.keys().cloned());
    }
    var_keys.extend(workflow.variables.keys().cloned());
    var_keys.extend(workflow.secret_variables.keys().cloned());

    // 运行期声明的变量（setVariable 节点 assignments[].name）：静态可推导，
    // 并入可解析集合，避免对「先声明后引用」的运行期变量误报（运行期引用先于
    // 赋值时引擎照旧渲染为空串并告警，不在本静态检查的职责内）。
    for node in &workflow.nodes {
        if let Some(assignments) = &node.config.assignments {
            for assignment in assignments {
                var_keys.insert(assignment.name.clone());
            }
        }
    }

    // 模板引用可解析的节点目标集合 = 节点 id ∪ refId（引擎先解析 refId，回退
    // 内部 id）。
    let mut node_targets: BTreeSet<String> =
        workflow.nodes.iter().map(|node| node.id.clone()).collect();
    for node in &workflow.nodes {
        if let Some(ref_id) = node.ref_id.as_deref().filter(|value| !value.is_empty()) {
            node_targets.insert(ref_id.to_owned());
        }
    }

    let mut issues = Vec::new();
    for node in &workflow.nodes {
        // 固定输出节点不执行，全部运行期检查跳过（避免纯展示卡误报）。
        if node.config.pinned_output.is_some() {
            continue;
        }
        check_replay_baseline(node, &request_ids, &mut issues);
        check_templates(node, &node_targets, &env_keys, &var_keys, &mut issues);
        check_assertions(node, &mut issues);
    }
    if let Some(raw_configs) = raw_configs {
        check_unknown_fields(&workflow.nodes, raw_configs, &mut issues);
    }
    issues
}

/// httpReplay 节点的请求基线检查：requestId 引用存在性，或无引用时
/// manualRequest 必须给出 url。
fn check_replay_baseline(
    node: &super::model::WorkflowNode,
    request_ids: &BTreeSet<String>,
    issues: &mut Vec<DeepValidationIssue>,
) {
    if node.node_type != WorkflowNodeType::HttpReplay {
        return;
    }
    match &node.config.request_id {
        Some(request_id) => {
            if !request_ids.contains(request_id) {
                issues.push(DeepValidationIssue::error(
                    "request-id-missing",
                    format!("节点（{}）引用的请求库条目「{request_id}」不存在", node.id),
                    &node.id,
                ));
            }
        }
        None => {
            let has_url = node
                .config
                .manual_request
                .as_ref()
                .is_some_and(|manual| !manual.url.trim().is_empty());
            if !has_url {
                issues.push(DeepValidationIssue::error(
                    "manual-request-missing-url",
                    format!(
                        "节点（{}）未引用请求库条目，manualRequest 也缺 url：无可重放基线",
                        node.id
                    ),
                    &node.id,
                ));
            }
        }
    }
}

/// 模板承载字段的静态检查：语法坏报 error；node/env/var/fake 引用做存在性
/// warning（与引擎渲染期的空串+告警口径一致，不阻断）。
fn check_templates(
    node: &super::model::WorkflowNode,
    node_targets: &BTreeSet<String>,
    env_keys: &BTreeSet<String>,
    var_keys: &BTreeSet<String>,
    issues: &mut Vec<DeepValidationIssue>,
) {
    // (字段定位标签, 文本) 清单：覆盖引擎 renderTemplate 实际消费的配置字段。
    let mut texts: Vec<(&'static str, &String)> = Vec::new();
    let config: &NodeConfig = &node.config;
    if let Some(over) = &config.override_ {
        if let Some(url) = &over.url {
            texts.push(("override.url", url));
        }
        if let Some(headers) = &over.headers {
            for value in headers.values() {
                texts.push(("override.headers", value));
            }
        }
        if let Some(body) = &over.body {
            texts.push(("override.body", body));
        }
    }
    if let Some(manual) = &config.manual_request {
        texts.push(("manualRequest.url", &manual.url));
        if let Some(headers) = &manual.headers {
            for value in headers.values() {
                texts.push(("manualRequest.headers", value));
            }
        }
        if let Some(body) = &manual.body {
            texts.push(("manualRequest.body", body));
        }
    }
    if let Some(value) = &config.cookie_value {
        texts.push(("cookieValue", value));
    }
    if let Some(fidelity) = &config.header_fidelity {
        for (label, item) in [
            ("headerFidelity.origin.value", &fidelity.origin),
            ("headerFidelity.referer.value", &fidelity.referer),
            ("headerFidelity.userAgent.value", &fidelity.user_agent),
        ] {
            if let Some(value) = item.as_ref().and_then(|item| item.value.as_ref()) {
                texts.push((label, value));
            }
        }
    }
    if let Some(LoopItems::Template(template)) = &config.items {
        texts.push(("items", template));
    }
    if let Some(assignments) = &config.assignments {
        for assignment in assignments {
            if let Some(JsonValue::String(value)) = &assignment.value {
                texts.push(("assignments.value", value));
            }
        }
    }

    for (field, text) in texts {
        for expression in template_expressions(text) {
            match expression {
                Err(()) => {
                    issues.push(DeepValidationIssue::error(
                        "template-syntax",
                        format!(
                            "节点（{}）{field} 存在未闭合的 \"{{{{\"，已按字面量处理",
                            node.id
                        ),
                        &node.id,
                    ));
                }
                Ok(content) if content.is_empty() => {
                    issues.push(DeepValidationIssue::error(
                        "template-syntax",
                        format!("节点（{}）{field} 存在空模板表达式 \"{{{{}}}}\"", node.id),
                        &node.id,
                    ));
                }
                Ok(content) => match analyze_expression(&content) {
                    Err(message) => {
                        issues.push(DeepValidationIssue::error(
                            "template-syntax",
                            format!("节点（{}）{field} 模板表达式 \"{{{{ {content} }}}}\" 语法错误：{message}", node.id),
                            &node.id,
                        ));
                    }
                    Ok(ExprRef::Node(target)) => {
                        if !node_targets.contains(&target) {
                            issues.push(DeepValidationIssue::warning(
                                "node-ref-missing",
                                format!(
                                    "节点（{}）{field} 引用的节点「{target}」不在本图（渲染为空串）",
                                    node.id
                                ),
                                &node.id,
                            ));
                        }
                    }
                    Ok(ExprRef::Env(key)) => {
                        if !env_keys.contains(&key) {
                            issues.push(DeepValidationIssue::warning(
                                "env-key-unknown",
                                format!(
                                    "节点（{}）{field} 引用的环境变量「{key}」不在激活集（渲染为空串；激活集可切换）",
                                    node.id
                                ),
                                &node.id,
                            ));
                        }
                    }
                    Ok(ExprRef::Var(name)) => {
                        if !var_keys.contains(&name) {
                            issues.push(DeepValidationIssue::warning(
                                "var-key-unknown",
                                format!(
                                    "节点（{}）{field} 引用的变量「{name}」不在全局/项目/流程变量表，也非 setVariable 声明的变量（渲染为空串）",
                                    node.id
                                ),
                                &node.id,
                            ));
                        }
                    }
                    Ok(ExprRef::Fake(name)) => {
                        if !FAKE_GENERATOR_NAMES.contains(&name.as_str()) {
                            issues.push(DeepValidationIssue::warning(
                                "fake-generator-unknown",
                                format!(
                                    "节点（{}）{field} 的假数据生成器「{name}」未知（渲染为空串）",
                                    node.id
                                ),
                                &node.id,
                            ));
                        }
                    }
                    Ok(ExprRef::Runtime) => {}
                },
            }
        }
    }
}

/// 模板文本里切出的表达式内容；`Err(())` 表示存在未闭合的 `{{`（对齐引擎
/// 「最左 `{{` 开启表达式」的扫描口径）。
fn template_expressions(text: &str) -> Vec<Result<String, ()>> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                out.push(Ok(after[..end].trim().to_owned()));
                rest = &after[end + 2..];
            }
            None => {
                out.push(Err(()));
                break;
            }
        }
    }
    out
}

/// 表达式的静态解析产物（对齐 flow-engine `parseRef` 的引用集）。
enum ExprRef {
    /// input / `$json` / 裸路径引用：运行期取数，无静态可查目标。
    Runtime,
    Node(String),
    Var(String),
    Env(String),
    Fake(String),
}

/// 解析一条表达式内容（已 trim）：返回引用目标或语法错误说明。
fn analyze_expression(content: &str) -> Result<ExprRef, String> {
    let (root, rest) = match content.split_once('.') {
        Some((root, tail)) => (root, tail),
        None => (content, ""),
    };
    match root {
        "input" | "$json" => Ok(ExprRef::Runtime),
        "node" | "var" | "env" => {
            let name = rest.split_once('.').map_or(rest, |(name, _)| name);
            if name.is_empty() {
                return Err(format!(
                    "「{root}」后必须给出{}名",
                    match root {
                        "node" => "节点 id",
                        "var" => "变量",
                        _ => "环境键",
                    }
                ));
            }
            Ok(match root {
                "node" => ExprRef::Node(name.to_owned()),
                "var" => ExprRef::Var(name.to_owned()),
                _ => ExprRef::Env(name.to_owned()),
            })
        }
        "fake" => {
            if rest.is_empty() {
                return Err("「fake」后必须给出生成器名".to_owned());
            }
            let name = match rest.split_once('(') {
                Some((name, args)) => {
                    // 形态：`fake.<名>(<参数>)`；括号后不允许拖尾内容。
                    let Some(close) = args.rfind(')') else {
                        return Err("fake 参数段缺少右括号".to_owned());
                    };
                    if !args[close + 1..].is_empty() {
                        return Err("fake 参数段右括号后存在多余内容".to_owned());
                    }
                    name
                }
                None => rest,
            };
            if name.is_empty() {
                return Err("「fake」后必须给出生成器名".to_owned());
            }
            Ok(ExprRef::Fake(name.to_owned()))
        }
        _ => {
            if is_bare_path(content) {
                Ok(ExprRef::Runtime)
            } else {
                Err(format!("未知引用根「{root}」，且内容不符合裸路径形态"))
            }
        }
    }
}

/// 裸路径（input 简写）形态：点分标识符段，段内允许字母数字 `_` `$` `-`，首段
/// 首字符须为字母/`_`/`$`（对齐 template.ts 的 `BARE_PATH_PATTERN`）。
fn is_bare_path(content: &str) -> bool {
    let mut any_segment = false;
    for (index, segment) in content.split('.').enumerate() {
        if segment.is_empty() {
            return false;
        }
        let mut chars = segment.chars();
        let first = chars.next().unwrap_or('\0');
        let first_ok = if index == 0 {
            first.is_ascii_alphabetic() || first == '_' || first == '$'
        } else {
            first.is_ascii_alphanumeric() || first == '_' || first == '$'
        };
        if !first_ok {
            return false;
        }
        for char in chars {
            if !(char.is_ascii_alphanumeric() || char == '_' || char == '$' || char == '-') {
                return false;
            }
        }
        any_segment = true;
    }
    any_segment
}

/// assert 节点的断言规则形状检查（操作符合法性由反序列化边界保证，这里只查
/// 完整性：比较断言缺 value、空 path、schema 非对象）。
fn check_assertions(node: &super::model::WorkflowNode, issues: &mut Vec<DeepValidationIssue>) {
    if node.node_type != WorkflowNodeType::Assert {
        return;
    }
    for rule in node.config.assertions.iter().flatten() {
        let problem = match rule {
            AssertionRule::Status(status) => {
                if status.op == StatusCodeOperator::Eq && status.value.is_none() {
                    Some("status 断言 op=eq 需要给出期望状态码".to_owned())
                } else {
                    None
                }
            }
            AssertionRule::JsonPath(json_path) => {
                if json_path.path.trim().is_empty() {
                    Some("jsonPath 断言 path 不能为空".to_owned())
                } else if !matches!(json_path.op, JsonPathOperator::Exists)
                    && json_path.value.is_none()
                {
                    Some("jsonPath 断言当前 op 需要给出比较值 value".to_owned())
                } else {
                    None
                }
            }
            AssertionRule::Schema(schema) => {
                if !schema.schema.is_object() {
                    Some("schema 断言的 schema 须为对象形态".to_owned())
                } else {
                    None
                }
            }
        };
        if let Some(problem) = problem {
            issues.push(DeepValidationIssue::error(
                "assertion-invalid",
                format!("节点（{}）断言规则不完整：{problem}", node.id),
                &node.id,
            ));
        }
    }
}

/// 草稿模式的 config 未知字段检查：原始 JSON（与 nodes 同序）中出现
/// [`NodeConfig`] 已知字段之外的键即提示（读取侧会静默忽略，多为拼写错误）。
fn check_unknown_fields(
    nodes: &[super::model::WorkflowNode],
    raw_configs: &[JsonValue],
    issues: &mut Vec<DeepValidationIssue>,
) {
    for (node, raw) in nodes.iter().zip(raw_configs) {
        let Some(config) = raw.get("config").and_then(JsonValue::as_object) else {
            continue;
        };
        let unknown: Vec<&String> = config
            .keys()
            .filter(|key| !KNOWN_CONFIG_FIELDS.contains(&key.as_str()))
            .collect();
        if !unknown.is_empty() {
            issues.push(DeepValidationIssue::warning(
                "config-unknown-field",
                format!(
                    "节点（{}）config 含未知字段（将被忽略，疑似拼写错误）：{}",
                    node.id,
                    unknown
                        .iter()
                        .map(|key| key.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                ),
                &node.id,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::model::{
        ManualRequest, NodeConfig, Position, VariableAssignment, VariableAssignmentSource,
        WorkflowNode, WorkflowNodeType,
    };
    use serde_json::json;

    fn node(id: &str, node_type: WorkflowNodeType, config: NodeConfig) -> WorkflowNode {
        WorkflowNode {
            id: id.to_owned(),
            node_type,
            position: Position { x: 0.0, y: 0.0 },
            config,
            label: None,
            ref_id: None,
        }
    }

    fn workflow(nodes: Vec<WorkflowNode>) -> Workflow {
        Workflow {
            id: "wf-1".into(),
            project_id: "proj-1".into(),
            name: "demo".into(),
            description: String::new(),
            nodes,
            edges: Vec::new(),
            variables: Default::default(),
            secret_variables: Default::default(),
            schema_version: 1,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn codes(issues: &[DeepValidationIssue]) -> Vec<&'static str> {
        issues.iter().map(|issue| issue.code).collect()
    }

    #[test]
    fn template_expression_parsing_mirrors_engine_grammar() {
        let (_guard, store) = mem_store();
        // HttpReplay 无基线会报 manual-request-missing-url；给上基线屏蔽该
        // 规则，只看模板检查。未知 env 键 → warning。
        let flow = workflow(vec![node(
            "r",
            WorkflowNodeType::HttpReplay,
            NodeConfig {
                manual_request: Some(ManualRequest {
                    url: "https://example.com".into(),
                    ..Default::default()
                }),
                cookie_value: Some("Bearer {{ env.token }}".into()),
                ..Default::default()
            },
        )]);
        let issues = deep_issues(&store, &flow, None);
        assert_eq!(codes(&issues), vec!["env-key-unknown"], "{issues:?}");

        // 合法语法（input 别名、裸路径、已知变量、fake 已知生成器）无问题。
        let config = NodeConfig {
            manual_request: Some(ManualRequest {
                url: "https://example.com/{{ input.orderId }}?q={{ headers.x-token }}".into(),
                body: Some("{{ fake.phone }} {{ $json.body }} {{ var.token }}".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut flow = workflow(vec![node("r", WorkflowNodeType::HttpReplay, config)]);
        flow.variables.insert("token".into(), "t".into());
        let issues = deep_issues(&store, &flow, None);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn template_syntax_errors_are_reported() {
        let (_guard, store) = mem_store();
        let config = NodeConfig {
            manual_request: Some(ManualRequest {
                url: "https://example.com/{{ node..path }} {{ var }} {{ fake }} {{ unknown!!! }} {{ input".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let flow = workflow(vec![node("r", WorkflowNodeType::HttpReplay, config)]);
        let issues = deep_issues(&store, &flow, None);
        assert_eq!(codes(&issues), vec!["template-syntax"; 5], "{issues:?}");
    }

    #[test]
    fn request_id_and_manual_request_checks() {
        let (_guard, store) = mem_store();
        let missing = NodeConfig {
            request_id: Some("req-ghost".into()),
            ..Default::default()
        };
        let no_baseline = NodeConfig::default();
        let flow = workflow(vec![
            node("a", WorkflowNodeType::HttpReplay, missing),
            node("b", WorkflowNodeType::HttpReplay, no_baseline),
        ]);
        let issues = deep_issues(&store, &flow, None);
        assert_eq!(
            codes(&issues),
            vec!["request-id-missing", "manual-request-missing-url"],
            "{issues:?}"
        );
    }

    #[test]
    fn pinned_nodes_are_skipped() {
        let (_guard, store) = mem_store();
        let config = NodeConfig {
            pinned_output: Some(crate::flow::model::NodePinnedOutput {
                value: json!(1),
                pinned_at: 0,
                source_run_id: "run".into(),
            }),
            ..NodeConfig::default()
        };
        let flow = workflow(vec![node("r", WorkflowNodeType::HttpReplay, config)]);
        assert!(deep_issues(&store, &flow, None).is_empty());
    }

    #[test]
    fn assertion_shape_checks() {
        let (_guard, store) = mem_store();
        let config = NodeConfig {
            assertions: Some(vec![
                AssertionRule::JsonPath(crate::flow::model::JsonPathAssertionRule {
                    path: "  ".into(),
                    op: JsonPathOperator::Exists,
                    value: None,
                }),
                AssertionRule::JsonPath(crate::flow::model::JsonPathAssertionRule {
                    path: "$.code".into(),
                    op: JsonPathOperator::Eq,
                    value: None,
                }),
                AssertionRule::Status(crate::flow::model::StatusAssertionRule {
                    op: StatusCodeOperator::Class2Xx,
                    value: None,
                }),
            ]),
            ..Default::default()
        };
        let flow = workflow(vec![node("a", WorkflowNodeType::Assert, config)]);
        let issues = deep_issues(&store, &flow, None);
        assert_eq!(codes(&issues), vec!["assertion-invalid"; 2], "{issues:?}");
    }

    #[test]
    fn setvariable_assignments_satisfy_var_references() {
        let (_guard, store) = mem_store();
        // setVariable 节点声明的运行期变量：静态可推导，引用它的模板不再误报。
        let setter = NodeConfig {
            assignments: Some(vec![VariableAssignment {
                name: "runTag".into(),
                from: VariableAssignmentSource::Literal,
                path: None,
                node: None,
                value: Some(json!("tag-{{ fake.hex(4) }}")),
            }]),
            ..Default::default()
        };
        let replay = NodeConfig {
            manual_request: Some(ManualRequest {
                url: "https://example.com/{{ var.runTag }}".into(),
                body: Some("{{ var.runTag }} {{ var.ghost }}".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let flow = workflow(vec![
            node("s", WorkflowNodeType::SetVariable, setter),
            node("r", WorkflowNodeType::HttpReplay, replay),
        ]);
        let issues = deep_issues(&store, &flow, None);
        // 只有真正未声明的 ghost 仍报警；runTag 不再报。
        assert_eq!(codes(&issues), vec!["var-key-unknown"], "{issues:?}");
        assert!(issues[0].message.contains("ghost"), "{issues:?}");
    }

    #[test]
    fn unknown_config_fields_reported_only_in_draft_mode() {
        let (_guard, store) = mem_store();
        let flow = workflow(vec![node(
            "r",
            WorkflowNodeType::HttpReplay,
            NodeConfig {
                manual_request: Some(ManualRequest {
                    url: "https://example.com".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )]);
        let raw = json!({
            "id": "r",
            "type": "httpReplay",
            "position": {"x": 0.0, "y": 0.0},
            "config": {"manualRequest": {"url": "https://example.com"}, "overide": {"url": "x"}}
        });
        let issues = deep_issues(&store, &flow, Some(&[raw]));
        assert_eq!(codes(&issues), vec!["config-unknown-field"]);
        assert!(deep_issues(&store, &flow, None).is_empty());
    }

    /// 构造一个空临时目录上的 store：请求库/env 读取失败或为空时走降级口径，
    /// 正好覆盖降级分支；TempDir 随 guard 存活到断言结束。
    fn mem_store() -> (tempfile::TempDir, FlowStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FlowStore::open(dir.path()).expect("store");
        (dir, store)
    }
}
