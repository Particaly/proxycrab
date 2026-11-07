//! httpReplay 节点请求面预览（模板渲染 dry-run，零出站）。
//!
//! 与脚本试跑（[`super::dry_run`]）同属「一次性 VM 试跑」家族：同一引擎载荷
//! （[`FLOW_ENGINE_JS`]）+ 最小宿主桩（[`DryRunHost`]，`replay` 恒拒绝），调用
//! 引擎导出的 `buildPreviewRequest`（flow-engine `replay.ts`）渲染「将要发出」
//! 的完整请求——HAR 基线（请求库投影 / manualRequest 合成）→ 节点 override 覆盖
//! → 浏览器专属头剥离 → `{{ }}` 模板渲染 → 头保真 / Cookie 决策并入出站头。
//! 不发出任何出站请求、不建档、不落库、不广播。
//!
//! 输入装配与运行链（[`super::run`]）同源：变量三层合并（全局 < 项目 < 流程，
//! secret 同层覆盖普通值）、激活环境集快照、工作流存储快照、请求库投影（body
//! blob 回填 base64）与脱敏清单全部复用 [`build_run_inputs`]，保证「预览所见 =
//! 运行所发」的输入口径；调用方可叠加 `variable_overrides`（最高优先级，可为
//! setVariable 声明的运行期变量提供采样值）。
//!
//! 预览边界（响应 warnings 亦有提示）：
//!   - **不执行 preProcess 脚本**：预览覆盖不到脚本对请求的运行期改写（节点配置
//!     了 preProcess 时输出附带提示；脚本验证走 script_dry_run 组合）；
//!   - **无上游数据**：`{{ node.* }}` / `{{ input.* }}`（含裸路径）引用按缺数据
//!     渲染为空串并进 warnings——单节点预览没有上游节点输出；
//!   - **secret 掩码**：渲染结果（请求 + 警告）经 [`mask_secrets_deep`] /
//!     [`mask_secrets_in_text`] 脱敏后才返回——`{{ env.token }}` / secret 变量的
//!     值在响应中恒为 `******`，与 env-sets 读侧恒掩码口径一致。
//!
//! fake 语义：单次预览共用一个 RenderContext——同一 `{{ fake.* }}` 表达式在
//! url / headers / body 中取同一采样值（与单次节点执行一致）；每次预览调用
//! 重新采样。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::Value as JsonValue;

use super::{
    bundle::FLOW_ENGINE_JS,
    dry_run::{DEFAULT_DRY_RUN_TIMEOUT_MS, DryRunHost, PAYLOAD_LOAD_BUDGET},
    env_sets::{mask_secrets_deep, mask_secrets_in_text},
    host::{FlowCancel, FlowError},
    model::{WorkflowNode, WorkflowNodeType},
    run::build_run_inputs,
    runtime::{FlowLimits, FlowRuntime},
    store::FlowStore,
};

/// 预览输入装配失败（前提校验不通过 / 存储失败），管理层逐类映射 HTTP 语义。
#[derive(Debug, thiserror::Error)]
pub enum RenderPreviewLoadError {
    /// 工作流不存在（404）。
    #[error("工作流不存在：{0}")]
    WorkflowNotFound(String),
    /// 节点不存在（404）。
    #[error("节点不存在：{0}")]
    NodeNotFound(String),
    /// 节点类型没有请求面（422，仅 httpReplay 可预览）。
    #[error("节点 {0} 不是 httpReplay，没有可预览的请求面")]
    InvalidNode(String),
    /// 无请求基线（422）：requestId 未命中请求库且未配置 manualRequest。
    #[error("节点 {0} 无可用请求基线（config.requestId 未命中请求库且未配置 manualRequest）")]
    MissingBaseline(String),
    /// 存储故障（内部错误）。
    #[error(transparent)]
    Storage(#[from] anyhow::Error),
}

/// 预览错误分类（响应 `error.kind`，kebab-case）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenderPreviewErrorKind {
    /// 无请求基线（引擎侧基线解析抛错；装配侧前置校验通常已拦截）。
    MissingBaseline,
    /// 引擎 / VM 执行失败（预算耗尽、沙箱异常、结果形状不符等）。
    Engine,
    /// 整体硬超时兜底（VM 预算之外的墙钟上限）。
    Timeout,
}

/// 预览失败（分类 + 可读信息，message 直接面向 UI 展示）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenderPreviewError {
    pub kind: RenderPreviewErrorKind,
    pub message: String,
}

/// 一次节点请求面预览的结果：成功带基线来源 + 渲染后的请求 + 警告，失败带
/// 分类错误。渲染出的请求与警告均已按脱敏清单掩码。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPreviewOutput {
    pub ok: bool,
    /// 请求基线来源：`requestLibrary`（config.requestId 命中投影）|
    /// `manual`（manualRequest 合成）。成功时存在。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
    /// 渲染后的请求面 `{ method, url, headers, body?, bodyBase64?, timeoutMs? }`
    /// （成功时存在；与 httpReplay runner 出站载荷同形；已脱敏）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<JsonValue>,
    /// 渲染警告与提示（未解析引用按空串替换、preProcess 未执行、secret 掩码
    /// 说明等；已脱敏）。
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RenderPreviewError>,
}

/// 一次预览装配好的引擎输入（阻塞阶段产出；JSON 形态对齐引擎契约）。
pub struct RenderPreviewInputs {
    /// 目标节点（serde 序列化，camelCase 对齐引擎 NodeConfig）。
    pub node: JsonValue,
    /// 请求库投影（requestId → HAR 条目，body blob 已回填 base64）。
    pub har_entries: JsonValue,
    /// 三层合并变量表 + 调用方覆盖（最高优先级）。
    pub variables: JsonValue,
    /// 激活环境集快照。
    pub env: JsonValue,
    /// 工作流存储快照。
    pub storage: JsonValue,
    /// 脱敏清单（env secret 值 + 三层变量 secret 值）。
    pub secrets: Vec<String>,
    /// 节点是否配置了非空 preProcess（输出提示用）。
    pub has_pre_process: bool,
}

/// 阻塞装配一次预览的引擎输入：读取工作流与目标节点、复用运行链的
/// [`build_run_inputs`]（变量 / 环境 / 存储 / 请求库投影 / 脱敏清单）、叠加
/// 调用方变量覆盖、并做节点类型与请求基线的前提校验（失败不进 VM）。
pub fn load_render_preview_inputs(
    root: &Path,
    workflow_id: &str,
    node_id: &str,
    variable_overrides: Option<&BTreeMap<String, JsonValue>>,
) -> std::result::Result<RenderPreviewInputs, RenderPreviewLoadError> {
    let store = FlowStore::open(root)?;
    let workflow = store
        .get_workflow(workflow_id)?
        .ok_or_else(|| RenderPreviewLoadError::WorkflowNotFound(workflow_id.to_owned()))?;
    let node: &WorkflowNode = workflow
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .ok_or_else(|| RenderPreviewLoadError::NodeNotFound(node_id.to_owned()))?;
    if node.node_type != WorkflowNodeType::HttpReplay {
        return Err(RenderPreviewLoadError::InvalidNode(node_id.to_owned()));
    }

    let inputs = build_run_inputs(&store, &workflow)?;

    // 调用方变量覆盖（最高优先级，叠加在三层合并表之上；用于给 setVariable
    // 声明的运行期变量提供采样值）。
    let mut variables = inputs.variables;
    if let Some(overrides) = variable_overrides
        && let Some(table) = variables.as_object_mut()
    {
        for (key, value) in overrides {
            table.insert(key.clone(), value.clone());
        }
    }

    // 基线前提校验（与引擎 resolveHarEntryForNode 同口径：requestId 命中投影
    // 优先，否则回退 manualRequest；两者皆缺即 MissingBaseline，不再进 VM）。
    let request_id_hit = node
        .config
        .request_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .is_some_and(|id| inputs.har_entries.get(id).is_some());
    if !request_id_hit && node.config.manual_request.is_none() {
        return Err(RenderPreviewLoadError::MissingBaseline(node_id.to_owned()));
    }

    let secrets = inputs
        .secrets
        .lock()
        .map(|list| list.as_slice().to_vec())
        .unwrap_or_default();
    Ok(RenderPreviewInputs {
        node: serde_json::to_value(node).map_err(|error| anyhow!("节点不可序列化: {error}"))?,
        har_entries: inputs.har_entries,
        variables,
        env: inputs.env,
        storage: inputs.storage,
        secrets,
        has_pre_process: node
            .config
            .pre_process
            .as_deref()
            .is_some_and(|script| !script.trim().is_empty()),
    })
}

/// 按默认安全口径渲染一次节点请求面（超时 5s + [`FlowLimits`] 现成指令/内存
/// 上限）。失败仅发生在 VM 初始化与引擎载荷加载（基础设施问题，归
/// [`FlowError`]）；渲染自身的失败（含预算耗尽 / 无基线）一律归类为
/// [`RenderPreviewOutput`] 的错误结果。
pub async fn render_preview(inputs: RenderPreviewInputs) -> Result<RenderPreviewOutput, FlowError> {
    let limits = FlowLimits {
        wall_clock: Duration::from_millis(DEFAULT_DRY_RUN_TIMEOUT_MS),
        ..FlowLimits::default()
    };
    let cancel = FlowCancel::new();
    let vm = FlowRuntime::new(Arc::new(DryRunHost::default()), cancel, limits).await?;
    // 载荷加载：一次性 eval，预算独立于渲染超时。
    tokio::time::timeout(PAYLOAD_LOAD_BUDGET, vm.run(FLOW_ENGINE_JS))
        .await
        .map_err(|_| FlowError::timeout("engine payload did not load in time"))??;

    // 渲染执行：VM 内部上限之外再套整体硬超时兜底（覆盖「await 宿主调用期间
    // 活跃墙钟不计时」的窗口）。超时即放弃等待，残留任务随 VM 整体丢弃；
    // 渲染期的任何失败（含 VM 预算耗尽）都归类为结果错误，不作为基础设施错误外抛。
    let call = tokio::time::timeout(
        limits.wall_clock + Duration::from_secs(1),
        vm.run(&build_preview_call(&inputs)?),
    )
    .await;
    let call = match call {
        // 整体硬超时兜底
        Err(_elapsed) => return Ok(timeout_output("请求预览超过硬超时上限，执行被强制中止")),
        // VM 层失败（预算耗尽 / 沙箱异常等）按类别转为结果错误
        Ok(Err(error)) => return Ok(classified_output(&error)),
        Ok(Ok(value)) => value,
    };
    Ok(parse_result(call, &inputs))
}

/// 构造载荷调用预览：节点 / 请求库投影 / 变量 / 环境 / 存储均以 JSON 字面量
/// 内嵌（天然防注入），以单一 RenderContext 调用引擎 `buildPreviewRequest`
/// （fake 采样跨槽位一致），并把引擎抛错（无基线）归一为结果对象。
fn build_preview_call(inputs: &RenderPreviewInputs) -> Result<String, FlowError> {
    let dump = |label: &str, value: &JsonValue| -> Result<String, FlowError> {
        serde_json::to_string(value)
            .map_err(|error| FlowError::unknown(format!("{label} is not representable: {error}")))
    };
    let node = dump("node", &inputs.node)?;
    let har_entries = dump("harEntries", &inputs.har_entries)?;
    let variables = dump("variables", &inputs.variables)?;
    let env = dump("env", &inputs.env)?;
    let storage = dump("storage", &inputs.storage)?;
    Ok(format!(
        "(async () => {{\n  const engine = globalThis.__flowEngine;\n  \
         if (!engine) throw new Error('engine payload missing __flowEngine global');\n  \
         const context = {{ node: {{}}, input: null, var: {variables}, env: {env}, storage: {storage} }};\n  \
         try {{\n    return {{ ok: true, result: engine.buildPreviewRequest({{ node: {node}, harEntries: {har_entries} }}, context) }};\n  \
         }} catch (error) {{\n    return {{ ok: false, error: {{ kind: 'missing-baseline', message: String((error && error.message) || error) }} }};\n  }}\n}})()",
    ))
}

/// 解析引擎结果对象为预览输出：成功侧取 `{baseline, request, warnings}`，
/// 失败侧按 kind 分类（未知 kind 归一为 engine）；成功侧再叠加边界提示
/// （preProcess 未执行）与 secret 脱敏（请求 + 警告，替换处附说明）。
fn parse_result(call: JsonValue, inputs: &RenderPreviewInputs) -> RenderPreviewOutput {
    let mut output = match call.get("ok").and_then(JsonValue::as_bool) {
        Some(true) => {
            let result = call.get("result").cloned().unwrap_or(JsonValue::Null);
            RenderPreviewOutput {
                ok: true,
                baseline: result
                    .get("baseline")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                request: Some(result.get("request").cloned().unwrap_or(JsonValue::Null)),
                warnings: warnings_of(result.get("warnings")),
                error: None,
            }
        }
        _ => {
            let error = call.get("error");
            let kind = match error
                .and_then(|error| error.get("kind"))
                .and_then(JsonValue::as_str)
            {
                Some("missing-baseline") => RenderPreviewErrorKind::MissingBaseline,
                _ => RenderPreviewErrorKind::Engine,
            };
            let message = error
                .and_then(|error| error.get("message"))
                .and_then(JsonValue::as_str)
                .unwrap_or("预览结果不符合预期（缺少 ok/result 字段）");
            RenderPreviewOutput {
                ok: false,
                baseline: None,
                request: None,
                warnings: Vec::new(),
                error: Some(RenderPreviewError {
                    kind,
                    message: message.to_owned(),
                }),
            }
        }
    };

    // 边界提示与 secret 脱敏（仅成功侧有请求可脱敏；警告同样过一遍脱敏——
    // 渲染警告可能回显模板表达式，表达式本身不含值，此处兜底不区分）。
    if output.ok {
        if inputs.has_pre_process {
            output.warnings.push(
                "节点配置了 preProcess 脚本：预览不执行脚本，实际请求可能被脚本的运行期覆盖改写（脚本验证可用 script_dry_run 组合）。"
                    .to_owned(),
            );
        }
        let mut request = output.request.take().unwrap_or(JsonValue::Null);
        let masked = mask_secrets_deep(&request, &inputs.secrets);
        if masked != request {
            output
                .warnings
                .push("输出包含 secret 值，已脱敏为 ******。".to_owned());
        }
        request = masked;
        truncate_body_for_display(&mut request, &mut output.warnings);
        output.request = Some(request);
        output.warnings = output
            .warnings
            .iter()
            .map(|warning| mask_secrets_in_text(warning, &inputs.secrets))
            .collect();
    }
    output
}

/// 引擎 warnings 数组的防御性读取（非字符串项静默丢弃）。
fn warnings_of(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// 预览响应中 body / bodyBase64 的展示上限（字节）：请求库基线可能携带大
/// 体积历史 body，原样回传会把 MCP 响应撑爆；截断只影响展示，实际运行发送
/// 完整内容（截断处附说明）。
const PREVIEW_BODY_DISPLAY_LIMIT: usize = 64 * 1024;

/// 对渲染后的请求做展示截断：`body` / `bodyBase64` 超限时按字符边界截断到
/// 上限并追加说明（模板只出现在字符串槽位，二进制 body 本就不渲染，截断
/// 不影响模板核对；url/headers 体量小、不设限）。
fn truncate_body_for_display(request: &mut JsonValue, warnings: &mut Vec<String>) {
    let Some(object) = request.as_object_mut() else {
        return;
    };
    for key in ["body", "bodyBase64"] {
        let Some(JsonValue::String(text)) = object.get(key) else {
            continue;
        };
        if text.len() <= PREVIEW_BODY_DISPLAY_LIMIT {
            continue;
        }
        let original = text.len();
        let mut cut = PREVIEW_BODY_DISPLAY_LIMIT.min(text.len());
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        object.insert(key.to_owned(), JsonValue::String(text[..cut].to_owned()));
        warnings.push(format!(
            "{key} 原始长度 {original} 字节，超过展示上限 {PREVIEW_BODY_DISPLAY_LIMIT}，已截断展示（实际运行将发送完整内容）。"
        ));
    }
}

/// 把 VM 层失败包装为失败结果（渲染执行期的失败不外抛）。
fn classified_output(error: &FlowError) -> RenderPreviewOutput {
    RenderPreviewOutput {
        ok: false,
        baseline: None,
        request: None,
        warnings: Vec::new(),
        error: Some(RenderPreviewError {
            kind: match error.kind {
                super::host::FlowErrorKind::Timeout => RenderPreviewErrorKind::Timeout,
                _ => RenderPreviewErrorKind::Engine,
            },
            message: error.message.clone(),
        }),
    }
}

/// 整体硬超时兜底的失败结果。
fn timeout_output(message: &str) -> RenderPreviewOutput {
    RenderPreviewOutput {
        ok: false,
        baseline: None,
        request: None,
        warnings: Vec::new(),
        error: Some(RenderPreviewError {
            kind: RenderPreviewErrorKind::Timeout,
            message: message.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 构造一份手工装配的预览输入（绕过存储，直测 VM 渲染路径）。
    fn preview_inputs(
        config: JsonValue,
        variables: JsonValue,
        env: JsonValue,
        secrets: Vec<String>,
    ) -> RenderPreviewInputs {
        RenderPreviewInputs {
            node: json!({
                "id": "n1",
                "type": "httpReplay",
                "position": { "x": 0, "y": 0 },
                "config": config,
            }),
            har_entries: json!({}),
            variables,
            env,
            storage: json!({}),
            secrets,
            has_pre_process: false,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn renders_manual_baseline_with_env_var_and_consistent_fake() {
        let inputs = preview_inputs(
            json!({
                "manualRequest": { "method": "POST", "url": "https://api.example.com/base" },
                "override": {
                    "url": "{{ env.baseUrl }}/v1/orders?tag={{ var.runTag }}&phone={{ fake.phone }}",
                    "headers": { "x-phone": "{{ fake.phone }}" },
                    "body": "{\"tag\":\"{{ var.runTag }}\",\"phone\":\"{{ fake.phone }}\"}",
                },
            }),
            json!({ "runTag": "rt-1" }),
            json!({ "baseUrl": "https://env.example.com" }),
            Vec::new(),
        );
        let output = render_preview(inputs).await.expect("preview should settle");
        assert!(output.ok, "output: {output:?}");
        assert_eq!(output.baseline.as_deref(), Some("manual"));
        let request = output.request.expect("request present");
        let url = request.get("url").and_then(JsonValue::as_str).expect("url");
        assert!(
            url.starts_with("https://env.example.com/v1/orders?tag=rt-1&phone="),
            "{url}"
        );
        // 同一 RenderContext：fake.phone 在 url / headers / body 三处一致
        let phone = url.rsplit('=').next().expect("phone in query");
        assert_eq!(
            request
                .get("headers")
                .and_then(|headers| headers.get("x-phone")),
            Some(&JsonValue::from(phone))
        );
        let body: JsonValue = serde_json::from_str(
            request
                .get("body")
                .and_then(JsonValue::as_str)
                .expect("body"),
        )
        .expect("body is json");
        assert_eq!(body.get("phone"), Some(&JsonValue::from(phone)));
        assert!(output.error.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn masks_secret_values_and_appends_masking_warning() {
        let inputs = preview_inputs(
            json!({
                "manualRequest": { "method": "GET", "url": "https://api.example.com/base" },
                "override": { "url": "https://api.example.com/hello?token={{ env.token }}" },
            }),
            json!({}),
            json!({ "token": "pcrab_topsecret_token" }),
            vec!["pcrab_topsecret_token".to_owned()],
        );
        let output = render_preview(inputs).await.expect("preview should settle");
        assert!(output.ok, "output: {output:?}");
        let request = output.request.expect("request present");
        let url = request.get("url").and_then(JsonValue::as_str).expect("url");
        assert!(!url.contains("pcrab_topsecret_token"), "{url}");
        assert!(url.contains("******"), "{url}");
        assert!(
            output
                .warnings
                .iter()
                .any(|warning| warning.contains("secret") && warning.contains("******"))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn missing_baseline_is_classified_not_thrown() {
        let inputs = preview_inputs(
            json!({ "requestId": "missing-id" }),
            json!({}),
            json!({}),
            Vec::new(),
        );
        let output = render_preview(inputs).await.expect("preview should settle");
        assert!(!output.ok);
        let error = output.error.expect("error present");
        assert_eq!(error.kind, RenderPreviewErrorKind::MissingBaseline);
        assert!(error.message.contains("无可用请求基线"), "{error:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pre_process_note_is_appended_for_script_nodes() {
        let inputs = RenderPreviewInputs {
            has_pre_process: true,
            ..preview_inputs(
                json!({
                    "manualRequest": { "method": "GET", "url": "https://api.example.com/base" },
                    "preProcess": "return { url: input.x }",
                }),
                json!({}),
                json!({}),
                Vec::new(),
            )
        };
        let output = render_preview(inputs).await.expect("preview should settle");
        assert!(output.ok, "output: {output:?}");
        assert!(
            output
                .warnings
                .iter()
                .any(|warning| warning.contains("preProcess"))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn oversized_body_is_truncated_for_display() {
        let big = "x".repeat(70_000);
        let inputs = preview_inputs(
            json!({
                "manualRequest": { "method": "POST", "url": "https://api.example.com/base", "body": big },
            }),
            json!({}),
            json!({}),
            Vec::new(),
        );
        let output = render_preview(inputs).await.expect("preview should settle");
        assert!(output.ok, "output: {output:?}");
        let request = output.request.expect("request present");
        let body = request
            .get("body")
            .and_then(JsonValue::as_str)
            .expect("body");
        assert!(body.len() <= 64 * 1024, "truncated body: {}", body.len());
        assert!(
            output
                .warnings
                .iter()
                .any(|warning| warning.contains("已截断展示"))
        );
    }

    #[test]
    fn load_error_display_mentions_node_type() {
        // 装配侧错误分类的 Display 面向调用方（manager 映射 HTTP 语义前可见）。
        let error = RenderPreviewLoadError::InvalidNode("n1".to_owned());
        assert!(error.to_string().contains("httpReplay"));
    }
}
