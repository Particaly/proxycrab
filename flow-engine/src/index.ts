/**
 * 工作流执行引擎（载荷对外契约，ReqFlow 复刻计划 Task 2）。
 *
 * 自归档 `_archive/reqflow/src/engine/index.ts @ 485fa00` 移植并按计划契约重排：
 * 桶文件除既有聚合再导出外，明确给出五类对表面：
 *   - runWorkflow            完整工作流运行入口（装配全部节点 runner，经宿主桥出站）；
 *   - evaluateCondition      条件表达式求值（runConditionExpression 的契约别名）；
 *   - renderTemplate         参数模板渲染（{{ node / input / var / env / $json }}）；
 *   - validateWorkflowGraph  图校验；
 *   - buildReplayRequest     HAR 基线 → 重放请求重建；
 *   - buildPreviewRequest    httpReplay 节点请求面预览（模板渲染 dry-run，零出站）；
 *   - 条件编译 / 断言 / 转换 / 循环语义  condition-builder 与三类逻辑节点 runner。
 *
 * 载荷运行环境：QuickJS（rquickjs）——仅纯 JS + 全局 host 宿主桥对象
 * （host.replay / now / log / sleep / emit / cancelled，由 Rust 侧注入）；
 * 无 DOM / Node / 浏览器 API（平台触点已在各模块内改为宿主注入等价物，
 * 见 flow-engine/README.md 的差异清单）。
 */

export * from "./executor";
export * from "./script";
export * from "./script-port";
export * from "./replay";
export * from "./run-record";
export * from "./error-class";

/* ---- 计划契约对表面（具名再导出，语义见各模块） ---- */

/** 完整工作流运行入口（装配 httpReplay / condition / loop / delay / setVariable / assert / transform 全套 runner） */
export { runWorkflow } from "./run-workflow";
/** httpReplay runner 装配器（host.replay 出站 + 头保真并入 + 响应归一化，见 run-workflow.ts） */
export { createHttpReplayRunner } from "./run-workflow";
export type { ReplayResponseEnvelope, ReplayTransport, RunWorkflowOptions } from "./run-workflow";
/** 条件表达式求值（契约名；实现与归档 runConditionExpression 同一函数） */
export { runConditionExpression as evaluateCondition } from "./logic-nodes";
/** 参数模板渲染 */
export { renderTemplate } from "./template";
/** 工作流图校验 */
export { validateWorkflowGraph } from "./executor";
/** HAR 基线 + 覆盖 → 重放请求重建 */
export { buildReplayRequest } from "./replay";
/** httpReplay 节点请求面预览（模板渲染 dry-run，零出站；见 replay.ts） */
export { buildPreviewRequest } from "./replay";

/* ---- 条件编译（M13-T3 / M16-T2 可视化构建器，纯函数） ---- */
export {
  CONDITION_OPERATORS,
  compileConditionTree,
  describeConditionTree,
  emptyConditionGroup,
  migrateConditionRules,
  operatorNeedsRight,
  parseConditionRules,
  parseConditionTree,
  parseRightValue,
  validateConditionTree,
} from "./condition-builder";

/* ---- 断言 / 转换 / 循环（及其余逻辑节点）执行语义 ---- */
export {
  createAssertRunner,
  evaluateAssertions,
  extractStatusValue,
  formatAssertionFailures,
  resolveAssertionRules,
} from "./assert-nodes";
export { createTransformRunner, evaluateExtractions } from "./transform-nodes";
export {
  DEFAULT_LOOP_MAX_ITERATIONS,
  LOOP_HARD_MAX_ITERATIONS,
  buildBodyWorkflow,
  computeLoopBody,
  createConditionRunner,
  createDelayRunner,
  createLoopRunner,
  createSetVariableRunner,
  createWorkflowDownstreamSelector,
  resolveAssignmentValue,
  resolveLoopExecutionOptions,
  resolveLoopItems,
  resolveLoopMaxIterations,
} from "./logic-nodes";

/* ---- 变量系统 / 依赖推断 / 图快照 / refId / HAR cookie 归一（配套纯函数） ---- */
export { RunVariableStore, RunVariableOverlay, mergeVariableScopes } from "./run-variables";
export {
  JSON_EXTRACT_POST_SCRIPT,
  applySuggestions,
  buildDownstreamSnapshot,
  collectUpstreamCandidates,
  inferDependencies,
  matchDownstreamUpstreams,
} from "./dependency-inference";
export { RUN_GRAPH_SNAPSHOT_MAX_BYTES, buildRunGraphSnapshot } from "./run-graph-snapshot";
export { REF_ID_PATTERN, generateRefId, isValidRefId } from "./ref-id";
export { parseCookieHeader, withNormalizedRequestCookies } from "./har-cookies";
export { detectResponseBody, readResponseHeader } from "./replay-response";
export {
  buildHeaderFidelityRule,
  extractSnapshotCookie,
  resolveCookieDecision,
  resolveHeaderFidelityPlan,
} from "./header-fidelity";
export { evaluateJsonPath, parseJsonPath } from "./json-path";
export { validateJsonSchemaLite } from "./json-schema-lite";
export { jsonDeepEqual } from "./json-equal";
export { parseCsv, resolveCsvDelimiter } from "./csv";

/* ---- 常用类型再导出（载荷消费方的形状契约） ---- */
export type {
  AssertionRule,
  ConditionGroup,
  ConditionNode,
  ConditionOperator,
  NodeConfig,
  NodeId,
  NodeRun,
  RunRecord,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "./types";
export type { ExecutorOptions, NodeRunner, NodeRunContext, RunSummary } from "./executor";
export type {
  BuildPreviewRequestParams,
  BuildPreviewRequestResult,
  PreviewRequest,
  ReplayOverride,
  ReplayRequest,
} from "./replay";
export type { RenderContext, TemplateRef } from "./template";
export type { ScriptExecPort } from "./script-port";
export type { CancelSignal } from "./cancel-signal";
