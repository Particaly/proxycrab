//! flow 脚本试跑（ReqFlow 复刻计划 Task 18）。
//!
//! 与执行链路同走宿主 JS 运行时：一次性装配 [`FlowRuntime`]（独立 VM 上下文，
//! 运行结束整体丢弃）+ 引擎载荷（[`FLOW_ENGINE_JS`]），调用载荷暴露的
//! `runPreScript` / `runPostScript` 执行用户脚本（数据形参 pre 为 `input`、
//! post 为 `response`，与引擎侧契约一致）。不建档、不落库、不广播；宿主桥
//! 为最小桩：`replay` 拒绝执行（试跑不发真实出站请求），`log`/`emit` 丢弃。
//!
//! 安全口径（Task 18 Step 3）：脚本超时默认 5s —— VM 三重上限的墙钟预算取该值
//! （指令配额/内存沿用 [`FlowLimits`] 现成默认口径），并传给引擎作为软超时截止；
//! 在 VM 内部上限之外再套一层整体硬超时兜底（脚本 await 宿主调用期间活跃墙钟
//! 不计时，硬超时覆盖该窗口，超时即放弃等待并随 VM 丢弃残留任务）。
//! 错误分类 `syntax|blocked|runtime|timeout|invalid-return` 完整透传到响应
//! （引擎产出的 message 面向用户可读）。

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};

use super::{
    bundle::FLOW_ENGINE_JS,
    host::{FlowCancel, FlowError, FlowErrorKind, FlowHost},
    runtime::{FlowLimits, FlowRuntime},
};

/// 试跑脚本默认超时（计划 Task 18 Step 3）：与引擎 `DEFAULT_SCRIPT_TIMEOUT_MS`
/// 同值，同时作为 VM 活跃墙钟预算与引擎软超时截止。
pub const DEFAULT_DRY_RUN_TIMEOUT_MS: u64 = 5_000;

/// 引擎载荷一次性 eval 的预算（与载荷 smoke 测试口径一致；与脚本超时分离，
/// 避免冷启动慢的机器上载荷加载挤占脚本预算）。预览（render_preview）共用。
pub(crate) const PAYLOAD_LOAD_BUDGET: Duration = Duration::from_secs(30);

/// 脚本侧别：pre = 前置处理（请求前），post = 后置处理（响应后）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptSide {
    Pre,
    Post,
}

impl ScriptSide {
    /// 载荷面对应的引擎函数名。
    fn engine_fn(self) -> &'static str {
        match self {
            Self::Pre => "runPreScript",
            Self::Post => "runPostScript",
        }
    }

    /// 类别名（对应脚本文档的数据形参名：pre 收 `input`，post 收 `response`）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pre => "pre",
            Self::Post => "post",
        }
    }
}

/// 试跑错误分类（对齐引擎 `ScriptError.kind` 的有限集合）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScriptDryRunErrorKind {
    /// 编译失败（语法错误）
    Syntax,
    /// 执行被运行环境拒绝（如试跑通道拒绝宿主能力）
    Blocked,
    /// 执行期异常
    Runtime,
    /// 软/硬超时（引擎软截止、VM 墙钟/指令/内存任一预算耗尽）
    Timeout,
    /// 返回值不是可安全交换的 JSON
    InvalidReturn,
}

impl ScriptDryRunErrorKind {
    /// 从字符串解析类别；未知值由调用方归一为 `Runtime`。
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "syntax" => Self::Syntax,
            "blocked" => Self::Blocked,
            "runtime" => Self::Runtime,
            "timeout" => Self::Timeout,
            "invalid-return" => Self::InvalidReturn,
            _ => return None,
        })
    }

    /// VM 层 [`FlowErrorKind`] 的映射：预算耗尽 → `timeout`，环境性拒绝 →
    /// `blocked`，其余（引擎包装层脚本异常/未分类/无取消来源的防御兜底）→
    /// `runtime`。引擎正常产出的分类错误走结果对象，不经过该映射。
    fn from_flow_kind(kind: FlowErrorKind) -> Self {
        match kind {
            FlowErrorKind::Timeout => Self::Timeout,
            FlowErrorKind::Blocked => Self::Blocked,
            _ => Self::Runtime,
        }
    }
}

/// 试跑失败（分类 + 可读信息，message 直接面向 UI 展示）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScriptDryRunError {
    pub kind: ScriptDryRunErrorKind,
    pub message: String,
}

/// 一次脚本试跑的结果：成功带返回值与警告列表，失败带分类错误。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScriptDryRunOutput {
    pub ok: bool,
    /// 成功时的返回值：pre 为请求上下文覆盖对象（url/headers/body/timeoutMs），
    /// post 为本节点 output（未 return 时引擎默认取 response.body）。
    pub value: JsonValue,
    /// 形状降级说明（pre 的非对象返回 / 未知覆盖键等；post 恒为空）。
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ScriptDryRunError>,
}

/// 试跑宿主桥最小桩：试跑不提供任何真实宿主能力，`replay` 以环境性拒绝
/// （blocked）驳回，保证「不发出真实出站请求」；其余能力按空实现返回。
/// 工作流存储为一次性内存桩：get/put/delete/keys 在本次试跑内生效、不落盘，
/// 便于脚本试跑验证存储读写逻辑（键合法性沿用运行期口径，配额不生效）。
/// 模板渲染预览（render_preview）复用同一桩：零出站口径一致。
pub(crate) struct DryRunHost {
    /// 一次性内存存储（按试跑实例隔离，不落盘）。
    storage: Arc<std::sync::Mutex<BTreeMap<String, JsonValue>>>,
}

impl Default for DryRunHost {
    fn default() -> Self {
        Self {
            storage: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
        }
    }
}

/// 校验试跑存储键名（与运行期宿主桥同口径：非法归 blocked）。
fn dry_run_storage_key(key: &str) -> Result<String, FlowError> {
    super::workflow_data::validate_storage_key(key)
        .map(|()| key.to_owned())
        .map_err(|error| FlowError::new(FlowErrorKind::Blocked, format!("{error:#}")))
}

#[async_trait::async_trait]
impl FlowHost for DryRunHost {
    async fn replay(&self, _payload: JsonValue) -> Result<JsonValue, FlowError> {
        Err(FlowError::new(
            FlowErrorKind::Blocked,
            "试跑不提供 host.replay 能力（真实重放仅在工作流运行中由引擎调度）",
        ))
    }

    async fn now(&self) -> Result<JsonValue, FlowError> {
        Ok(JsonValue::from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis() as u64)
                .unwrap_or_default(),
        ))
    }

    async fn log(&self, _payload: JsonValue) -> Result<JsonValue, FlowError> {
        Ok(JsonValue::Null)
    }

    async fn sleep(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        tokio::time::sleep(Duration::from_millis(payload.as_u64().unwrap_or(0))).await;
        Ok(JsonValue::Null)
    }

    async fn emit(&self, _payload: JsonValue) -> Result<JsonValue, FlowError> {
        Ok(JsonValue::Null)
    }

    async fn cancelled(&self) -> Result<JsonValue, FlowError> {
        Ok(JsonValue::from(false))
    }

    // 同步工作流存储面（内存桩）：键校验沿用运行期口径，配额不生效。

    fn storage_get(&self, key: &str) -> Result<JsonValue, FlowError> {
        let key = dry_run_storage_key(key)?;
        let storage = self.storage.lock().expect("dry run storage poisoned");
        Ok(match storage.get(&key) {
            Some(value) => json!({ "found": true, "value": value }),
            None => json!({ "found": false, "value": null }),
        })
    }

    fn storage_put(&self, key: &str, value: &JsonValue) -> Result<JsonValue, FlowError> {
        let key = dry_run_storage_key(key)?;
        self.storage
            .lock()
            .expect("dry run storage poisoned")
            .insert(key, value.clone());
        Ok(json!({ "updatedAt": 0u64 }))
    }

    fn storage_delete(&self, key: &str) -> Result<JsonValue, FlowError> {
        let key = dry_run_storage_key(key)?;
        let deleted = self
            .storage
            .lock()
            .expect("dry run storage poisoned")
            .remove(&key)
            .is_some();
        Ok(json!({ "deleted": deleted }))
    }

    fn storage_keys(&self) -> Result<JsonValue, FlowError> {
        let keys: Vec<String> = self
            .storage
            .lock()
            .expect("dry run storage poisoned")
            .keys()
            .cloned()
            .collect();
        Ok(json!({ "keys": keys }))
    }
}

/// 按默认安全口径试跑一次脚本（超时 5s + [`FlowLimits`] 现成指令/内存上限）。
pub async fn dry_run_script(
    side: ScriptSide,
    script: &str,
    sample: JsonValue,
) -> Result<ScriptDryRunOutput, FlowError> {
    dry_run_script_with(
        side,
        script,
        sample,
        FlowLimits {
            wall_clock: Duration::from_millis(DEFAULT_DRY_RUN_TIMEOUT_MS),
            ..FlowLimits::default()
        },
    )
    .await
}

/// 按给定上限试跑一次脚本（`limits.wall_clock` 同时作为引擎软超时截止）。
///
/// 失败仅发生在 VM 初始化与引擎载荷加载（基础设施问题，归 [`FlowError`]）；
/// 脚本自身的失败（含预算耗尽）一律归类为 [`ScriptDryRunOutput`] 的错误结果。
pub async fn dry_run_script_with(
    side: ScriptSide,
    script: &str,
    sample: JsonValue,
    limits: FlowLimits,
) -> Result<ScriptDryRunOutput, FlowError> {
    let cancel = FlowCancel::new();
    let vm = FlowRuntime::new(Arc::new(DryRunHost::default()), cancel, limits).await?;
    // 载荷加载：一次性 eval，预算独立于脚本超时。
    tokio::time::timeout(PAYLOAD_LOAD_BUDGET, vm.run(FLOW_ENGINE_JS))
        .await
        .map_err(|_| FlowError::timeout("engine payload did not load in time"))??;

    // 脚本执行：VM 内部上限（活跃墙钟/指令/内存）与引擎软截止之外再套整体
    // 硬超时（覆盖「await 宿主调用期间活跃墙钟不计时」的窗口）。超时即放弃
    // 等待，残留任务随 VM 整体丢弃；脚本执行期的任何失败（含 VM 预算耗尽）
    // 都归类为结果错误，不作为基础设施错误外抛。
    let deadline_ms = u64::try_from(limits.wall_clock.as_millis()).unwrap_or(u64::MAX);
    let call = tokio::time::timeout(
        limits.wall_clock + Duration::from_secs(1),
        vm.run(&build_script_call(side, script, &sample, deadline_ms)?),
    )
    .await;
    let call = match call {
        // 整体硬超时兜底
        Err(_elapsed) => return Ok(timeout_output("脚本试跑超过硬超时上限，执行被强制中止")),
        // VM 层失败（预算耗尽 / 沙箱异常等）按类别转为结果错误
        Ok(Err(error)) => return Ok(classified_output(&error)),
        Ok(Ok(value)) => value,
    };
    Ok(parse_result(&call))
}

/// 构造载荷调用脚本：源码与样例均以 JSON 字面量内嵌（天然防注入），
/// 调用引擎 `runPreScript` / `runPostScript` 并原样返回结果对象。
fn build_script_call(
    side: ScriptSide,
    script: &str,
    sample: &JsonValue,
    timeout_ms: u64,
) -> Result<String, FlowError> {
    let source = serde_json::to_string(script)
        .map_err(|error| FlowError::unknown(format!("script is not representable: {error}")))?;
    let sample = serde_json::to_string(sample)
        .map_err(|error| FlowError::unknown(format!("sample is not representable: {error}")))?;
    Ok(format!(
        "(async () => {{\n  const engine = globalThis.__flowEngine;\n  \
         if (!engine) throw new Error('engine payload missing __flowEngine global');\n  \
         return engine.{engine_fn}({source}, {sample}, {{ timeoutMs: {timeout_ms} }});\n}})()",
        engine_fn = side.engine_fn(),
    ))
}

/// 解析引擎结果对象为试跑输出：`{ok:true, value, warnings}` 与
/// `{ok:false, error:{kind, message}}` 均按引擎契约透传；形状不符时防御性
/// 归一为 runtime 类错误（不向调用方抛错）。
fn parse_result(result: &JsonValue) -> ScriptDryRunOutput {
    match result.get("ok").and_then(JsonValue::as_bool) {
        Some(true) => ScriptDryRunOutput {
            ok: true,
            value: result.get("value").cloned().unwrap_or(JsonValue::Null),
            warnings: result
                .get("warnings")
                .and_then(JsonValue::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            error: None,
        },
        _ => {
            let error = result.get("error");
            let kind = error
                .and_then(|error| error.get("kind"))
                .and_then(JsonValue::as_str)
                .and_then(ScriptDryRunErrorKind::parse)
                .unwrap_or(ScriptDryRunErrorKind::Runtime);
            let message = error
                .and_then(|error| error.get("message"))
                .and_then(JsonValue::as_str)
                .unwrap_or("试跑结果不符合预期（缺少 ok/error 字段）");
            ScriptDryRunOutput {
                ok: false,
                value: JsonValue::Null,
                warnings: Vec::new(),
                error: Some(ScriptDryRunError {
                    kind,
                    message: message.to_owned(),
                }),
            }
        }
    }
}

/// 把 VM 层 [`FlowError`]（基础设施失败）转成管理面可用的分类错误。
pub fn flow_error_to_dry_run_error(error: &FlowError) -> ScriptDryRunError {
    ScriptDryRunError {
        kind: ScriptDryRunErrorKind::from_flow_kind(error.kind),
        message: error.message.clone(),
    }
}

/// 把 VM 层失败包装为失败结果（脚本执行期的失败不外抛）。
fn classified_output(error: &FlowError) -> ScriptDryRunOutput {
    ScriptDryRunOutput {
        ok: false,
        value: JsonValue::Null,
        warnings: Vec::new(),
        error: Some(flow_error_to_dry_run_error(error)),
    }
}

/// 整体硬超时兜底的失败结果。
fn timeout_output(message: &str) -> ScriptDryRunOutput {
    ScriptDryRunOutput {
        ok: false,
        value: JsonValue::Null,
        warnings: Vec::new(),
        error: Some(ScriptDryRunError {
            kind: ScriptDryRunErrorKind::Timeout,
            message: message.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread")]
    async fn pre_script_returns_overrides_and_warnings() {
        let output = dry_run_script(
            ScriptSide::Pre,
            "return { url: input.baseUrl + '/api', headers: { 'x-a': '1' }, extra: 1 }",
            json!({ "baseUrl": "https://example.test" }),
        )
        .await
        .expect("dry run should settle");
        assert!(output.ok, "output: {output:?}");
        assert_eq!(
            output.value,
            json!({ "url": "https://example.test/api", "headers": { "x-a": "1" } })
        );
        assert_eq!(output.warnings, vec!["忽略前置脚本返回的未知覆盖键：extra"]);
        assert!(output.error.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn post_script_output_defaults_to_response_body() {
        let output = dry_run_script(
            ScriptSide::Post,
            "",
            json!({
                "status": 200,
                "headers": { "content-type": "application/json" },
                "body": "{\"ok\":true}",
                "json": { "ok": true },
                "durationMs": 5,
            }),
        )
        .await
        .expect("dry run should settle");
        assert!(output.ok, "output: {output:?}");
        // 未 return：output 默认取 response.body（响应体原文文本）
        assert_eq!(output.value, json!("{\"ok\":true}"));
        assert!(output.warnings.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn post_script_return_value_is_passed_through() {
        let output = dry_run_script(
            ScriptSide::Post,
            "return { token: response.json.token, status: response.status }",
            json!({ "status": 200, "headers": {}, "body": "{\"token\":\"tk\"}", "json": { "token": "tk" }, "durationMs": 1 }),
        )
        .await
        .expect("dry run should settle");
        assert!(output.ok, "output: {output:?}");
        assert_eq!(output.value, json!({ "token": "tk", "status": 200 }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn syntax_error_is_classified() {
        let output = dry_run_script(ScriptSide::Pre, "return {{{", json!(null))
            .await
            .expect("dry run should settle");
        let error = output.error.expect("syntax failure must classify");
        assert!(!output.ok);
        assert_eq!(error.kind, ScriptDryRunErrorKind::Syntax);
        assert!(error.message.contains("语法错误"), "message: {error:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runtime_error_is_classified() {
        let output = dry_run_script(ScriptSide::Pre, "throw new Error('boom')", json!(null))
            .await
            .expect("dry run should settle");
        let error = output.error.expect("runtime failure must classify");
        assert_eq!(error.kind, ScriptDryRunErrorKind::Runtime);
        assert!(error.message.contains("boom"), "message: {error:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_json_return_is_invalid_return() {
        let output = dry_run_script(ScriptSide::Pre, "return () => 1", json!(null))
            .await
            .expect("dry run should settle");
        let error = output.error.expect("function return must classify");
        assert_eq!(error.kind, ScriptDryRunErrorKind::InvalidReturn);
    }

    #[tokio::test]
    async fn dry_run_host_refuses_replay() {
        // 试跑宿主桥必须拒绝重放：不发出真实出站请求（环境性拒绝，kind blocked）
        let host = DryRunHost::default();
        let error = host
            .replay(json!({}))
            .await
            .expect_err("replay must be refused");
        assert_eq!(error.kind, FlowErrorKind::Blocked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runaway_loop_hits_timeout_classification() {
        let output = dry_run_script_with(
            ScriptSide::Pre,
            "while (true) {}",
            json!(null),
            FlowLimits {
                wall_clock: Duration::from_millis(100),
                ..FlowLimits::default()
            },
        )
        .await
        .expect("dry run infrastructure should succeed");
        let error = output.error.expect("runaway loop must classify as timeout");
        assert_eq!(error.kind, ScriptDryRunErrorKind::Timeout);
    }
}
