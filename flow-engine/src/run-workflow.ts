/**
 * runWorkflow —— 完整工作流运行入口（载荷主装配，计划 Task 2 契约）。
 *
 * 归档（@ 485fa00）中「runner 表装配 + 事件转发 + 变量/环境注入」由
 * background/run-controller（浏览器扩展 SW，重 DOM/chrome 依赖）完成，不在
 * 纯逻辑引擎内。载荷基座（Rust 内嵌 QuickJS）没有该层，本模块按归档
 * run-controller 的装配语义补齐最小装配面，作为 `runWorkflow` 对外契约：
 *
 *   - 全套节点 runner：httpReplay / condition / loop / delay / setVariable /
 *     assert / transform（执行语义与归档 engine 逐字段一致）；
 *   - httpReplay 经宿主桥 `host.replay` 出站（真实网络由 Rust 重放管线执行；
 *     二进制请求体以 bodyBase64 进 JSON 载荷，响应信封形状对齐计划 Task 3）；
 *   - 头保真 / Cookie 决策（header-fidelity）直接并入出站 headers——
 *     ProxyCrab 基座由 Rust 直接发头，无 DNR（宿主注入点，见下）；
 *   - 前置 / 后置脚本与条件表达式缺省走本地脚本端口（createLocalScriptPort）：
 *     载荷本身已运行在 Rust 沙箱内（指令 / 内存 / 墙钟三重上限），脚本与引擎
 *     同一 QuickJS realm——归档的 offscreen 沙箱通道由运行时整体替代；
 *     需要外部脚本通道的宿主可经 options.scriptPort 注入（宿主注入点）；
 *   - 运行期变量：内部持有 RunVariableStore（overlay 隔离随 store 能力生效，
 *     循环并发可用）；环境快照经供给函数逐节点下发，脚本 env 写回经
 *     onEnvWrite（宿主注入点）应用并同步到运行内快照。
 *
 * 取消：options.signal（CancelSignal 结构，DOM AbortSignal 兼容）；VM 级取消
 * （超限 / 中断）由 Rust 运行时负责，节点编排级取消走信号语义（与归档一致）。
 *
 * 本模块零 DOM / Node 依赖；QuickJS 侧的全局 host 桥在模块加载时自动探测
 * （见文件尾 installHostBridgeFromGlobalHost）。
 */

import { executeWorkflow } from "./executor";
import type { ExecutorOptions, IdGenerator, NodeRunner, RunSummary } from "./executor";
import type { NodeFailPolicy, NodeId, NodeRun, WorkflowNodeType } from "./types";
import {
  computeLoopBody,
  createConditionRunner,
  createDelayRunner,
  createLoopRunner,
  createSetVariableRunner,
  createWorkflowDownstreamSelector,
  type LoopBodyPlan,
} from "./logic-nodes";
import { createAssertRunner } from "./assert-nodes";
import { createTransformRunner } from "./transform-nodes";
import { buildReplayRequest } from "./replay";
import type { ReplayOverride } from "./replay";
import { detectResponseBody } from "./replay-response";
import { HttpFailureError, ScriptExecutionError, isHttpFailure } from "./error-class";
import { createLocalScriptPort } from "./script-port";
import type { ScriptExecPort } from "./script-port";
import type { EnvWriteHandler, PostProcessResponse } from "./script";
import { resolveCookieDecision, resolveHeaderFidelityPlan } from "./header-fidelity";
import { RunVariableStore } from "./run-variables";
import { encodeBase64 } from "./base64";
import { setHostTimers } from "./host-env";
import type { CancelSignal } from "./cancel-signal";
import type {
  HarEntry,
  ManualRequest,
  NodeConfig,
  RunTrigger,
  Workflow,
  WorkflowNode,
} from "./types";

/* ------------------------------------------------------------------ *
 * 宿主桥信封（host.replay 的 JSON 载荷契约，对齐计划 Task 1/3）
 * ------------------------------------------------------------------ */

/**
 * 宿主重放响应信封：Rust 重放管线回传（计划 Task 3 定稿形状；缺失字段按
 * 本地兜底——body 缺省空串、bodyType 缺省按内容嗅探、durationMs 缺省本地计时）。
 */
export interface ReplayResponseEnvelope {
  /** HTTP 状态码（4xx/5xx 属正常响应，是否判失败由 isHttpFailure 决定） */
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  /** 响应体原文文本（超限截断后的文本；二进制响应由宿主侧按宿主约定处理） */
  body?: string;
  /** 解析后的 JSON 值（仅 JSON 响应存在；宿主已判定时直接透传） */
  json?: unknown;
  /** 响应体类型标记（'json' / 'text' / 'empty'；缺省由引擎按内容嗅探） */
  bodyType?: "json" | "text" | "empty";
  /** 请求耗时毫秒（缺省按本地计时） */
  durationMs?: number;
  /** 响应体是否被截断（宿主侧标记，透传给下游消费） */
  truncated?: boolean;
}

/** 重放传输通道签名（宿主注入点）：JSON 载荷进、响应信封出 */
export type ReplayTransport = (payload: Record<string, unknown>) => Promise<ReplayResponseEnvelope>;

/* ------------------------------------------------------------------ *
 * 请求基线解析
 * ------------------------------------------------------------------ */

/**
 * 把无引用节点的手动请求基线合成为 HAR 条目（buildReplayRequest 的入参形状）。
 * method / url / headers / body 逐字段映射；缺省 HTTP/1.1、空响应摘要。
 */
function manualRequestToHarEntry(manual: ManualRequest): HarEntry {
  return {
    startedDateTime: new Date(0).toISOString(),
    time: 0,
    request: {
      method: manual.method,
      url: manual.url,
      httpVersion: "HTTP/1.1",
      headers: Object.entries(manual.headers ?? {}).map(([name, value]) => ({ name, value })),
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...(manual.body !== undefined ? { postData: { mimeType: "", text: manual.body } } : {}),
    },
    response: {
      status: 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 0, mimeType: "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

/**
 * 解析 httpReplay 节点的重放基线（httpReplay runner 内部步骤）：
 * deps.harEntries[config.requestId]（请求库投影）优先，无引用 / 未命中时回退
 * config.manualRequest 合成基线；两者皆缺 → undefined（节点 failed）。
 */
function resolveHarEntryForNode(
  node: WorkflowNode,
  harEntries: Record<string, HarEntry> | undefined,
): HarEntry | undefined {
  const requestId = node.config.requestId;
  if (typeof requestId === "string" && requestId !== "") {
    const entry = harEntries?.[requestId];
    if (entry !== undefined) return entry;
  }
  const manual = node.config.manualRequest;
  return manual !== undefined ? manualRequestToHarEntry(manual) : undefined;
}

/* ------------------------------------------------------------------ *
 * httpReplay runner（装配面：重建请求 → host.replay → 归一化响应 → 后置脚本）
 * ------------------------------------------------------------------ */

/** httpReplay runner 依赖（run-workflow 装配；均可缺省） */
export interface HttpReplayRunnerDeps {
  /** 请求库投影（requestId → HAR 条目）：重放基线来源 */
  harEntries?: Record<string, HarEntry>;
  /** 脚本执行端口（宿主注入点；缺省本地 eval） */
  scriptPort?: Pick<ScriptExecPort, "runPre" | "runPost">;
  /** env 写回通道（宿主注入点；脚本写回的应用方） */
  onEnvWrite?: EnvWriteHandler;
  /** 重放传输通道（宿主注入点；缺省全局 host.replay） */
  replay?: ReplayTransport;
}

/**
 * 创建 httpReplay 节点 runner（装配语义对齐归档 background/run-controller 的
 * 脚本接线层，执行原语全部来自归档 engine）：
 *
 *   前置脚本（可选）→ buildReplayRequest（HAR 基线 + 节点 override + 前置覆盖，
 *   模板渲染，浏览器专属头剥离）→ 头保真 / Cookie 决策并入出站头（宿主注入点：
 *   ProxyCrab 基座由 Rust 直接发头，无 DNR 网络层）→ host.replay → 响应归一化
 *   （detectResponseBody 自动类型判断）→ HTTP 4xx/5xx 判定（HttpFailureError，
 *   失败响应不进后置脚本）→ 后置脚本（缺省 output = 归一化响应对象）。
 *
 * 出站载荷：{ method, url, headers, body?, bodyBase64?, timeoutMs? }——二进制
 * 请求体（HAR postData.encoding='base64' 的解码产物）以 bodyBase64 进 JSON
 * 载荷（JSON 无法直接携带 Uint8Array），宿主侧解码后按原始字节发送。
 */
export function createHttpReplayRunner(deps?: HttpReplayRunnerDeps): NodeRunner {
  const port = deps?.scriptPort ?? createLocalScriptPort();
  const transport: ReplayTransport = deps?.replay ?? defaultReplayTransport;
  return async (node, input, runCtx) => {
    const config: NodeConfig = node.config;
    const templateContext = runCtx.nodeCtx.templateContext;
    const scriptOpts = templateContext.env !== undefined ? { env: templateContext.env } : undefined;

    // 1) 前置脚本：input → 请求上下文覆盖（失败抛 ScriptExecutionError = 节点 failed）
    let extraOverride: ReplayOverride | undefined;
    if (typeof config.preProcess === "string" && config.preProcess.trim() !== "") {
      const pre = await port.runPre(config.preProcess, input, scriptOpts);
      // 已提交的 env 写回不因脚本失败丢弃（与归档语义一致）
      if (pre.envWrites !== undefined) deps?.onEnvWrite?.(pre.envWrites);
      if (!pre.ok) throw new ScriptExecutionError(pre.error);
      extraOverride = pre.value;
    }

    // 2) 请求重建：HAR 基线 + 节点 override + 前置覆盖（后到优先）+ 模板渲染 + 头剥离
    const harEntry = resolveHarEntryForNode(node, deps?.harEntries);
    if (harEntry === undefined) {
      throw new Error(
        `节点 ${node.id} 无可用请求基线（config.requestId 未命中请求库且未配置 manualRequest）`,
      );
    }
    const request = buildReplayRequest(
      { harEntry, override: config.override, extraOverride },
      templateContext,
    );

    // 3) 头保真 / Cookie 注入决策 → 并入出站头（宿主注入点：归档经 DNR 在网络层
    // set；ProxyCrab 基座由 Rust 重放管线直接发送，决策逻辑复用归档纯函数）
    const removedHeaders = config.override?.removedHeaders;
    const decisions = [
      ...resolveHeaderFidelityPlan({
        fidelity: config.headerFidelity,
        harEntry,
        templateContext,
        removedHeaders,
      }),
    ];
    const cookieDecision = resolveCookieDecision({
      mode: config.cookieMode,
      cookieValue: config.cookieValue,
      harEntry,
      templateContext,
      removedHeaders,
    });
    if (cookieDecision !== undefined) decisions.push(cookieDecision);
    const headers: Record<string, string> = { ...request.headers };
    for (const decision of decisions) headers[decision.header] = decision.value;

    // 4) 出站载荷（JSON 进出宿主桥；二进制 body 走 bodyBase64）
    const payload: Record<string, unknown> = {
      method: request.method,
      url: request.url,
      headers,
    };
    if (request.body !== undefined) {
      if (typeof request.body === "string") payload.body = request.body;
      else payload.bodyBase64 = encodeBase64(request.body);
    }
    const timeoutMs = request.timeoutMs ?? config.timeoutMs;
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;

    // 5) 经宿主桥出站 + 响应归一化（自动类型判断 / 本地耗时兜底）
    const startedAt = Date.now();
    const envelope = await transport(payload);
    const body = typeof envelope.body === "string" ? envelope.body : "";
    const response: PostProcessResponse & { statusText?: string; truncated?: boolean } = {
      status: envelope.status,
      statusText: envelope.statusText ?? "",
      headers: envelope.headers ?? {},
      body,
      durationMs: envelope.durationMs ?? Date.now() - startedAt,
    };
    if (envelope.truncated === true) response.truncated = true;
    if (envelope.bodyType !== undefined) {
      response.bodyType = envelope.bodyType;
      if (envelope.json !== undefined) response.json = envelope.json;
    } else {
      // 宿主未判定：按内容嗅探（宽松规则见 replay-response.ts）
      const detected = detectResponseBody(body, response.headers);
      response.bodyType = detected.bodyType;
      if (detected.bodyType === "json") response.json = detected.json;
    }

    // 6) HTTP 失败判定（4xx/5xx）在后置脚本之前：失败响应不进入后置处理
    if (isHttpFailure(response)) throw new HttpFailureError(response.status, response);

    // 7) 后置脚本：响应 → output（未配置 / 未返回时默认 output = 归一化响应）
    if (typeof config.postProcess === "string" && config.postProcess.trim() !== "") {
      const post = await port.runPost(config.postProcess, response, scriptOpts);
      if (post.envWrites !== undefined) deps?.onEnvWrite?.(post.envWrites);
      if (!post.ok) throw new ScriptExecutionError(post.error);
      return post.value;
    }
    return response;
  };
}

/** 缺省重放传输：全局 host 宿主桥（QuickJS 内由 Rust 注入；缺失即装配缺陷） */
function defaultReplayTransport(payload: Record<string, unknown>): Promise<ReplayResponseEnvelope> {
  const bridge = (globalThis as { host?: { replay?: unknown } }).host;
  const replay = bridge?.replay;
  if (typeof replay !== "function") {
    return Promise.reject(new Error("宿主桥不可用：全局 host.replay 未注入，无法发起重放"));
  }
  return (replay as (payload: unknown) => Promise<ReplayResponseEnvelope>)(payload);
}

/* ------------------------------------------------------------------ *
 * runWorkflow 主入口
 * ------------------------------------------------------------------ */

/** runWorkflow 选项（全部可选；语义见文件头） */
export interface RunWorkflowOptions {
  /** 请求库投影（requestId → HAR 条目）：httpReplay 节点的重放基线来源 */
  harEntries?: Record<string, HarEntry>;
  /** 脚本执行端口（宿主注入点；缺省本地 eval——载荷本身运行在 Rust 沙箱内） */
  scriptPort?: ScriptExecPort;
  /** env 写回通道（宿主注入点）；仅 options.env 提供时接线（与归档 env 语义一致） */
  onEnvWrite?: EnvWriteHandler;
  /** 重放传输通道（宿主注入点；缺省全局 host.replay） */
  replay?: ReplayTransport;
  /**
   * 运行期初始变量表（三层作用域合并后的结果）：内部转为 RunVariableStore，
   * setVariable / loop 的运行期写入与循环并发 overlay 随之可用；缺省空表。
   */
  variables?: Record<string, unknown>;
  /** 环境变量快照（运行开始时定格）：注入模板 {{ env.* }} 与脚本 env 形参 */
  env?: Record<string, unknown>;
  /** 取消信号（CancelSignal 结构；DOM AbortSignal 兼容） */
  signal?: CancelSignal;
  /** 工作流级默认失败策略（节点未显式配置时生效；缺省 'stop'） */
  defaultFailPolicy?: NodeFailPolicy;
  /** 全局最大节点并发（缺省 4，同 ExecutorOptions） */
  maxNodeConcurrency?: number;
  /** 固定输出表（缺省从 workflow.nodes 的 config.pinnedOutput 投影） */
  pinnedOutputs?: Partial<Record<NodeId, unknown>>;
  /** runId 生成器（缺省 host-env 注入链） */
  generateId?: IdGenerator;
  /** 事件：节点开始（透传执行器；loop 循环体事件同样转发至此） */
  onNodeStart?: ExecutorOptions["onNodeStart"];
  /** 事件：节点结束（透传执行器；loop 循环体事件同样转发至此） */
  onNodeFinish?: ExecutorOptions["onNodeFinish"];
  /** 事件：运行结束（载荷与返回值同一对象） */
  onRunFinish?: ExecutorOptions["onRunFinish"];
  /** 触发方式（仅落库外壳需要；runWorkflow 不落库，预留字段对齐 RunRecord） */
  trigger?: RunTrigger;
}

/** runWorkflow 可执行入参：Workflow 的 id / nodes / edges 子集 */
export type RunnableWorkflow = Pick<Workflow, "id" | "nodes" | "edges">;

/**
 * 执行一个完整工作流（runWorkflow 对外契约）：装配全套节点 runner 与
 * 变量 / 环境 / 下游选择 / 循环子运行收集，交执行器调度；返回运行摘要。
 *
 * 失败语义与 executeWorkflow 一致：图不合法 / 节点失败 → failed（error 摘要）、
 * 取消 → cancelled；宿主桥错误（重放网络失败等）按归档 runner 约定冒泡为
 * 节点失败（分类经 error-class）。
 */
export async function runWorkflow(
  workflow: RunnableWorkflow,
  options: RunWorkflowOptions = {},
): Promise<RunSummary> {
  const scriptPort = options.scriptPort ?? createLocalScriptPort();

  // 环境快照（运行开始时定格）：对象入参浅拷贝为运行内快照；脚本写回经
  // onEnvWrite 双写（运行内快照立即更新 + 宿主通道，缺省不接）
  const envSnapshot = options.env !== undefined ? { ...options.env } : undefined;
  const handleEnvWrite: EnvWriteHandler | undefined =
    envSnapshot !== undefined
      ? (writes) => {
          Object.assign(envSnapshot, writes);
          options.onEnvWrite?.(writes);
        }
      : undefined;

  // 运行期变量：内部 RunVariableStore（overlay 能力 → 循环并发隔离可用）
  const variableStore = new RunVariableStore(options.variables ?? {});

  /** 循环体计划缓存（同图 loop 节点只计算一次，与下游选择器共享语义） */
  const bodyPlanCache = new Map<NodeId, LoopBodyPlan>();
  const getBodyPlan = (loopNodeId: NodeId): LoopBodyPlan | undefined => {
    let plan = bodyPlanCache.get(loopNodeId);
    if (plan === undefined) {
      plan = computeLoopBody(loopNodeId, workflow.nodes, workflow.edges);
      bodyPlanCache.set(loopNodeId, plan);
    }
    return plan;
  };

  /** 循环体「最后一轮」快照收集（经 nestedNodeRun 代替统一 skipped） */
  const nestedRuns = new Map<NodeId, NodeRun>();

  /** 固定输出：入参优先，缺省从节点 config.pinnedOutput 投影（归档 run-controller 口径） */
  const pinnedOutputs: Partial<Record<NodeId, unknown>> = { ...options.pinnedOutputs };
  if (options.pinnedOutputs === undefined) {
    for (const node of workflow.nodes) {
      if (node.config.pinnedOutput !== undefined) {
        pinnedOutputs[node.id] = node.config.pinnedOutput.value;
      }
    }
  }

  const httpReplay = createHttpReplayRunner({
    harEntries: options.harEntries,
    scriptPort,
    ...(handleEnvWrite !== undefined ? { onEnvWrite: handleEnvWrite } : {}),
    ...(options.replay !== undefined ? { replay: options.replay } : {}),
  });

  const runners: Partial<Record<WorkflowNodeType, NodeRunner>> = {
    httpReplay,
    condition: createConditionRunner({
      scriptPort,
      ...(handleEnvWrite !== undefined ? { onEnvWrite: handleEnvWrite } : {}),
    }),
    loop: createLoopRunner({
      getBodyPlan,
      getRunners: () => runners,
      getStore: () => variableStore,
      ...(envSnapshot !== undefined ? { getEnv: () => envSnapshot } : {}),
      ...(options.onNodeStart
        ? {
            forwardNodeStart: (node: WorkflowNode, input: unknown) =>
              options.onNodeStart?.(node, input),
          }
        : {}),
      ...(options.onNodeFinish
        ? {
            forwardNodeFinish: (node: WorkflowNode, nodeRun: NodeRun) =>
              options.onNodeFinish?.(node, nodeRun),
          }
        : {}),
      collectNestedRun: (nodeId: NodeId, nodeRun: NodeRun) => {
        nestedRuns.set(nodeId, nodeRun);
      },
    }),
    delay: createDelayRunner(),
    setVariable: createSetVariableRunner({ getStore: () => variableStore }),
    assert: createAssertRunner(),
    transform: createTransformRunner(),
  };

  return executeWorkflow(workflow, {
    runners,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.defaultFailPolicy !== undefined
      ? { defaultFailPolicy: options.defaultFailPolicy }
      : {}),
    ...(options.maxNodeConcurrency !== undefined
      ? { maxNodeConcurrency: options.maxNodeConcurrency }
      : {}),
    variables: () => variableStore.snapshot(),
    ...(envSnapshot !== undefined ? { env: () => envSnapshot } : {}),
    selectDownstream: createWorkflowDownstreamSelector(workflow.nodes, workflow.edges),
    nestedNodeRun: (node: WorkflowNode) => nestedRuns.get(node.id),
    pinnedOutputs,
    ...(options.onNodeStart !== undefined ? { onNodeStart: options.onNodeStart } : {}),
    ...(options.onNodeFinish !== undefined ? { onNodeFinish: options.onNodeFinish } : {}),
    ...(options.onRunFinish !== undefined ? { onRunFinish: options.onRunFinish } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * QuickJS 宿主桥自动接线（宿主注入点）
 * ------------------------------------------------------------------ */

/**
 * 从全局 host 宿主桥安装宿主环境等价物（定时器）：
 * QuickJS 内 host.sleep(ms) 可用 → 以其组装 HostTimers（等待期间取消由运行时
 * 中断等待并归一 cancelled；睡眠自然结束后的回调对已拒绝的 Promise 无副作用）；
 * Node / 浏览器（单测）无全局 host → 维持 globalThis 缺省（fake timers 兼容）。
 */
export function installHostBridgeFromGlobalHost(): void {
  const bridge = (globalThis as { host?: { sleep?: unknown } }).host;
  const sleep = bridge?.sleep;
  if (typeof sleep !== "function") return;
  setHostTimers({
    setTimeout: (callback: () => void, ms: number): unknown => {
      void (sleep as (payload: number) => Promise<unknown>)(ms).then(
        () => callback(),
        () => undefined,
      );
      return undefined;
    },
    // host.sleep 不支持按句柄取消；延时/退避的取消路径由 CancelSignal 监听器
    // 先行拒绝，迟到的 resolve 无副作用（与 QuickJS 运行时的取消语义衔接）
    clearTimeout: (): void => undefined,
  });
}

// 模块加载时自动探测一次：QuickJS 的 host 全局由 Rust 在 eval 载荷前注册。
installHostBridgeFromGlobalHost();

/** 工作流形状类型再导出（RunWorkflowOptions 消费方免深路径引用） */
export type { WorkflowNode, NodeConfig, HarEntry, RunTrigger, CancelSignal };
export type { RunSummary, NodeRun, NodeFailPolicy, IdGenerator };
