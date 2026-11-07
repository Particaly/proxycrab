//! flow 引擎载荷 smoke 测试（ReqFlow 复刻计划 Task 2 Step 4）。
//!
//! 验收链路：加载 `include_str!` 嵌入的 engine.js（[`FLOW_ENGINE_JS`]）→
//! 桩宿主（实现 Task 1 的 [`FlowHost`]，`replay` 返回固定响应信封）→
//! 在 QuickJS 内以 `runWorkflow` 跑通 start → httpReplay → assert → 结束。
//! 场景断言：运行 success、各节点状态、assert 节点对响应信封的断言结果、
//! 桩宿主收到的出站请求载荷（method / url / headers，含头保真缺省行为）。

use std::{sync::Arc, time::Duration};

use proxy_crab_mitm::flow::{
    bundle::FLOW_ENGINE_JS,
    host::{FlowCancel, FlowError, FlowHost},
    runtime::{FlowLimits, FlowRuntime},
};
use serde_json::{Value as JsonValue, json};

/// 桩宿主：replay 返回固定 200 JSON 信封并记录出站载荷（供断言）；其余宿主
/// 能力为最小实现（sleep 走 tokio 定时器；log/emit 丢弃）。真实重放接线由
/// 后续任务（计划 Task 19/20）提供。
struct StubHost {
    replays: std::sync::Mutex<Vec<JsonValue>>,
}

#[async_trait::async_trait]
impl FlowHost for StubHost {
    async fn replay(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.replays.lock().unwrap().push(payload);
        Ok(json!({
            "status": 200,
            "statusText": "OK",
            "headers": { "content-type": "application/json" },
            "body": "{\"ok\":true,\"token\":\"tk-123\"}",
            "durationMs": 5,
        }))
    }

    async fn now(&self) -> Result<JsonValue, FlowError> {
        Ok(json!(1_700_000_000_000u64))
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
        Ok(json!(false))
    }
}

/// 主流程 smoke 场景的脚本体：加载载荷全局 `__flowEngine`，构造
/// start → httpReplay → assert 三节点工作流并运行，返回可断言的摘要投影。
const SMOKE_SCRIPT: &str = r#"
(async () => {
  const engine = globalThis.__flowEngine;
  if (!engine) throw new Error('engine payload missing __flowEngine global');
  const summary = await engine.runWorkflow({
    id: 'wf-smoke',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'http1',
        type: 'httpReplay',
        position: { x: 1, y: 0 },
        config: {
          manualRequest: {
            method: 'GET',
            url: 'https://example.test/api',
            headers: { accept: 'application/json' },
          },
          timeoutMs: 5000,
        },
      },
      {
        id: 'assert1',
        type: 'assert',
        position: { x: 2, y: 0 },
        config: {
          assertions: [
            { kind: 'status', op: '2xx' },
            { kind: 'jsonPath', path: '$.json.ok', op: 'eq', value: true },
            { kind: 'jsonPath', path: '$.json.token', op: 'eq', value: 'tk-123' },
          ],
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'http1' },
      { id: 'e2', source: 'http1', target: 'assert1' },
    ],
  });
  const httpOutput = summary.nodeRuns.http1.output;
  return {
    status: summary.status,
    error: summary.error === undefined ? null : summary.error,
    startStatus: summary.nodeRuns.start.status,
    httpStatus: summary.nodeRuns.http1.status,
    assertStatus: summary.nodeRuns.assert1.status,
    replayResponseStatus: httpOutput.status,
    replayResponseBodyType: httpOutput.bodyType,
    replayResponseJson: httpOutput.json,
    assertInputStatus: summary.nodeRuns.assert1.input.status,
  };
})()
"#;

#[tokio::test(flavor = "multi_thread")]
async fn engine_payload_runs_start_http_replay_assert_end() {
    let cancel = FlowCancel::new();
    let host = Arc::new(StubHost {
        replays: std::sync::Mutex::new(Vec::new()),
    });
    let vm = FlowRuntime::new(host.clone(), cancel.clone(), FlowLimits::default())
        .await
        .expect("VM creation should not fail");

    // 1) 加载载荷：IIFE 产物在全局作用域挂 `__flowEngine`（同一 VM 上下文内
    // 后续 eval 可见）。
    tokio::time::timeout(Duration::from_secs(30), vm.run(FLOW_ENGINE_JS))
        .await
        .expect("engine payload did not load within 30s")
        .expect("engine payload should evaluate");

    // 2) 场景运行：start → httpReplay（桩宿主）→ assert → 结束。30 秒兜底
    // 超时：三节点运行（一次宿主重放）远小于该预算，超时即视为载荷/运行时缺陷。
    let result = tokio::time::timeout(Duration::from_secs(30), vm.run(SMOKE_SCRIPT))
        .await
        .expect("engine smoke did not settle within 30s")
        .expect("engine smoke script should succeed");

    assert_eq!(result["status"], json!("success"), "summary: {result}");
    assert_eq!(result["error"], json!(null));
    assert_eq!(result["startStatus"], json!("success"));
    assert_eq!(result["httpStatus"], json!("success"));
    assert_eq!(result["assertStatus"], json!("success"));
    // httpReplay 输出为归一化响应（宿主信封 + 自动类型判断）
    assert_eq!(result["replayResponseStatus"], json!(200));
    assert_eq!(result["replayResponseBodyType"], json!("json"));
    assert_eq!(result["replayResponseJson"]["ok"], json!(true));
    // assert 节点的入参 = httpReplay 输出（响应透传，断言全部通过 = 节点 success）
    assert_eq!(result["assertInputStatus"], json!(200));

    // 桩宿主收到一次出站请求：method / url / timeoutMs 按基线与节点配置透传，
    // accept 头保留（非浏览器专属头），cookie 头剥离名单不误伤
    let replays = host.replays.lock().unwrap();
    assert_eq!(
        replays.len(),
        1,
        "expected exactly one replay, got {replays:?}"
    );
    assert_eq!(replays[0]["method"], json!("GET"));
    assert_eq!(replays[0]["url"], json!("https://example.test/api"));
    assert_eq!(replays[0]["timeoutMs"], json!(5000));
    assert_eq!(replays[0]["headers"]["accept"], json!("application/json"));
    assert!(
        replays[0]["headers"].get("Cookie").is_none(),
        "cookie must not be injected without snapshot/custom value: {replays:?}"
    );
}

/// 契约面对照测试：载荷加载后暴露计划 Task 2 约定的全部对表面
/// （runWorkflow / evaluateCondition / renderTemplate / validateWorkflowGraph /
/// buildReplayRequest / buildPreviewRequest / 条件编译 / 断言 / 转换 / 循环语义）。
#[tokio::test(flavor = "multi_thread")]
async fn engine_payload_exposes_contract_surface() {
    let cancel = FlowCancel::new();
    let host = Arc::new(StubHost {
        replays: std::sync::Mutex::new(Vec::new()),
    });
    let vm = FlowRuntime::new(host, cancel, FlowLimits::default())
        .await
        .expect("VM creation should not fail");
    // 先加载载荷（挂 __flowEngine 全局），再探测契约面。
    tokio::time::timeout(Duration::from_secs(30), vm.run(FLOW_ENGINE_JS))
        .await
        .expect("engine payload did not load within 30s")
        .expect("engine payload should evaluate");
    let script = r#"
(async () => {
  const engine = globalThis.__flowEngine;
  return {
    runWorkflow: typeof engine.runWorkflow,
    evaluateCondition: typeof engine.evaluateCondition,
    renderTemplate: typeof engine.renderTemplate,
    validateWorkflowGraph: typeof engine.validateWorkflowGraph,
    buildReplayRequest: typeof engine.buildReplayRequest,
    buildPreviewRequest: typeof engine.buildPreviewRequest,
    compileConditionTree: typeof engine.compileConditionTree,
    createAssertRunner: typeof engine.createAssertRunner,
    createTransformRunner: typeof engine.createTransformRunner,
    createLoopRunner: typeof engine.createLoopRunner,
    createConditionRunner: typeof engine.createConditionRunner,
    createDelayRunner: typeof engine.createDelayRunner,
    createSetVariableRunner: typeof engine.createSetVariableRunner,
    conditionSmoke: engine.evaluateCondition('return input.n > 1', { input: { n: 2 }, vars: {} }),
    templateSmoke: engine.renderTemplate('Bearer {{ token }}', { node: {}, input: { token: 'x' } }).value,
  };
})()
"#;
    let result = tokio::time::timeout(Duration::from_secs(30), vm.run(script))
        .await
        .expect("contract surface probe did not settle within 30s")
        .expect("contract surface probe should succeed");
    for name in [
        "runWorkflow",
        "evaluateCondition",
        "renderTemplate",
        "validateWorkflowGraph",
        "buildReplayRequest",
        "buildPreviewRequest",
        "compileConditionTree",
        "createAssertRunner",
        "createTransformRunner",
        "createLoopRunner",
        "createConditionRunner",
        "createDelayRunner",
        "createSetVariableRunner",
    ] {
        assert_eq!(result[name], json!("function"), "contract member {name}");
    }
    assert_eq!(result["conditionSmoke"]["value"], json!(true));
    assert_eq!(result["templateSmoke"], json!("Bearer x"));
}
