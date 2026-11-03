/**
 * 逻辑节点执行语义（M7-T1）：条件分支（condition）、循环（loop）、延时（delay）、
 * 变量赋值 / 提取（setVariable）。本模块为纯逻辑、零环境依赖（不依赖 React /
 * 存储 / 网络 / chrome.*），node 环境可直接单测；runner 装配（注入 RunVariableStore
 * / 事件转发 / 嵌套快照收集）由 background/run-controller 按运行完成。
 *
 * ─── 条件分支（condition）──────────────────────────────────────────────
 *
 * 配置：config.expression 为脚本函数体（复用 M5-T3 的沙箱约定：`"use strict"`
 * 前缀 + new Function，软超时 + `__checkDeadline()` 主动中断），形参为
 * `input`（上游输出聚合的入参）与 `vars`（当前运行期变量表——与模板命名空间
 * var 同源；形参不能叫 `var`，它是保留字）。返回值经 JS truthy 判定：
 * undefined / 空表达式恒为 false。
 *
 * 执行语义：runner 成功返回 { branch: 'true' | 'false', value } 形态输出；
 * 调度器按 ExecutorOptions.selectDownstream（见 createWorkflowDownstreamSelector）
 * 把运行引向分支对应的下游。M16-T1 起分支走向由**出边手柄**表达
 * （WorkflowEdge.sourceHandle）：命中分支手柄的出边放行，未带手柄的出边
 * 照常放行（未迁移存量数据的旧「未绑定 = 两个分支都执行」语义）；节点
 * 无任何带手柄出边时回退 legacy 清单（config.trueTargets / falseTargets）：
 *   - 两份目标都为空 → 直通（全部下游照常调度，等价于未配置分支）；
 *   - 配置了任一份 → 分支目标只约束被勾选的出边：命中分支的下游按分支放行，
 *     **未被任何分支勾选的下游不受条件影响（两个分支都照常执行）**——
 *     「同时被其它成功路径指向的汇合节点」因此天然正常执行（见任务注意点）；
 *   - 未激活分支的下游保持 pending，收尾统一 skipped；若其同时被不受分支
 *     约束的路径指向仍会正常执行（enqueued 集合只防重复入队）；
 *   - 条件节点本身失败（脚本错误 / 超时）+ failPolicy continue → output 为
 *     null、非分支形态 → 选择器放行全部下游（失败不走任何分支）。
 *
 * ─── 循环（loop）──────────────────────────────────────────────────────
 *
 * 配置：config.items（JSON 数组字面量，或模板字符串——按当前节点模板上下文渲染
 * 后 JSON.parse；渲染为空串视为空数组；解析失败 / 结果非数组 → 节点 failed）；
 * config.maxIterations 迭代上限（缺省 100，硬上限 1000——配置超出收敛到 1000，
 * items 超出上限按长度截断、不视为错误）。
 *
 * 执行语义（取舍见 ROADMAP 汇报：核心调度器的 enqueued 集合与状态机终态约束
 * 使「调度器内重执行循环体」风险过高——success 是终态、每节点至多执行一次均有
 * 既有测试锁定——故采用任务书允许的降级方案「每轮以 executeWorkflow 递归执行
 * 循环体子图」）：
 *   1. 循环体 = computeLoopBody 定义的下游子图：从 loop 节点出发沿出边可达、
 *      且每个节点的全部直接上游都属于循环体 ∪ {loop 节点}（有外部上游的节点
 *      留给父调度器按 join 语义在循环结束后执行一次，input 聚合时循环体内的
 *      上游因未写入父运行输出表而按缺失处理——诚实降级，见下「边界」）；
 *   2. 每轮把当前 item / index 写入运行期变量（var.loop = { item, index }，
 *      循环体内模板 `{{ var.loop.item }}` 引用）。变量写入按「迭代作用域是否
 *      隔离」分两条路径（M10-T6 收尾）：
 *      - 隔离模式（变量 store 支持 overlay，见 run-variables.ts 的
 *        RunVariableOverlay）：每轮迭代持有独立 overlay——var.loop 与体内
 *        setVariable 的写入缓冲在本轮 overlay，读取透传父层（可见已完成迭代
 *        合并后的最新值）；迭代结束（成功 / 失败 / 取消）合并回父层，同键按
 *        完成顺序 last-write-wins。嵌套循环时内层迭代的合并**不外泄
 *        var.loop**（外层体内后续节点仍读外层的 item——「保存 / 恢复」语义由
 *        overlay 分层实现）；顶层迭代合并 var.loop（循环结束后保留最后一轮值）；
 *      - 直写模式（store 不支持 overlay，旧装配 / 测试替身）：写入前保存旧值、
 *        本轮结束后恢复——嵌套循环的内层结束后外层值照常恢复（既有语义不变）。
 *   3. 逐轮以子运行执行循环体（虚拟 start 节点接入体入口），子运行与父运行
 *      共享 runner 表、取消信号与 RunVariableStore（变量以供给函数逐节点取
 *      当前快照，循环变量 / setVariable 的写入对体内后续节点立即可见）。
 *      隔离模式下每轮注入自己的 overlay 快照（executeWorkflow 的 variables
 *      供给函数形态），并以注入器包装 runner 表——体内嵌套的 loop /
 *      setVariable 经 runCtx.iterationStore 解析到当前迭代的 overlay（而非
 *      宿主根 store），保证并发迭代互不覆盖。子运行的节点事件转发给宿主
 *      （落库 / 广播），节点「最后一轮」快照经 collectNestedRun 交回宿主，由
 *      父执行器收尾时经 nestedNodeRun 扩展点代替统一 skipped（NodeRun 快照
 *      语义 = 节点最后一次执行；并发下按完成序后写覆盖）；
 *   4. 并发与限速（M10-T6 收尾）：resolveLoopExecutionOptions 能力门控——
 *      隔离模式按 config.concurrency 收敛（整数、1~LOOP_MAX_CONCURRENCY，
 *      非法回退 1）分批 Promise.all 并发执行；未隔离恒串行 1（安全回退，
 *      既有契约不变）。批间等待 config.intervalMs（0~60000，响应取消），
 *      两模式一致；
 *   5. 全部轮次完成后 loop 节点 output = 逐轮聚合结果数组——每轮取循环体
 *      「汇点」（体内无出边指向其它体节点的节点）中成功者的 output：单汇点
 *      → 该输出原样；多汇点 → { <节点id>: output }；无成功汇点 → null；
 *   6. 取消：迭代间隙 / 子运行取消 → 停止迭代、以已完成的轮次聚合照常成功
 *      返回（执行器约定：节点自然完成后停止调度，run 级状态记 cancelled）；
 *   7. 某轮子运行 failed → loop 节点 failed（按节点 failPolicy 走 stop /
 *      continue），错误信息带轮次序号；
 *   8. 逐迭代调试（M13-T9）：每轮结算（成功 / 失败 / 取消）产出一条明细
 *      （index / item / 状态 / 耗时 / 聚合输出 / 失败轮错误），经
 *      runCtx.snapshotExtras 并入 loop 节点的 NodeRun.iterations（见
 *      types/model.ts 的 LoopIterationsSummary）——明细的 item / output 在
 *      产出侧按 LOOP_ITERATION_SNAPSHOT_BYTES 收敛（M5-T5 capSnapshot 惯例），
 *      条数超 LOOP_ITERATIONS_MAX_RECORDS 时按 index 升序保留前段并置
 *      truncated；进度（done / total / capped）经 deps.reportLoopProgress
 *      逐轮上报宿主广播（真并发下按完成序递增），首批发起前有 done=0 的
 *      基线上报。单迭代重跑：宿主以 buildBodyWorkflow 构造同构子工作流、
 *      预置 var.loop = { item, index } 单跑该轮（见 run-controller）。
 *
 * 边界（诚实声明）：循环体在子运行中执行，其输出不写入父运行的输出表——
 * 跨界 join（同时依赖循环体内节点与外部节点的下游）聚合时体内上游按缺失
 * 处理；嵌套循环 + 跨界 join 的组合可能造成节点重复执行，不支持、应避免；
 * 体内含环时环上节点沿 join 语义 skipped（与执行器对环的处理一致）。
 * var.loop 为保留变量名（setVariable 写入同名变量会被循环覆盖 / 恢复；隔离
 * 模式下按迭代封闭——嵌套迭代合并不外泄，顶层循环结束后保留最后一轮值）。
 *
 * ─── 延时（delay）──────────────────────────────────────────────────────
 *
 * 配置：config.durationMs（毫秒；上限 MAX_DELAY_DURATION_MS = 5 分钟，超出 →
 * 节点 failed——超限视为配置错误，不做静默截断；缺省 / 非法值按 0 处理）。
 * 等待期间监听 AbortSignal：被打断 → 抛 '[cancelled]' 前缀错误（节点 failed，
 * run 级按取消语义处理）。output 透传 input（延时是纯等待屏障）。
 *
 * ─── 变量赋值 / 提取（setVariable）────────────────────────────────────
 *
 * 配置：config.assignments 为赋值项列表（VariableAssignment，见 types/model.ts），
 * 按数组顺序执行、后一项可见前一项刚写入的值；任一项失败 → 节点 failed。
 * 来源语义：
 *   - 'input'   ：从聚合入参按 path（resolvePath 语义，空串 = 根值）取值；
 *   - 'node'    ：从指定节点（assignment.node）的 output 取 path 值；节点不在
 *                 上下文（尚未执行 / 非上游）→ failed；
 *   - 'var'     ：从当前运行期变量表取 path 值（path 首段为变量名，与模板
 *                 `{{ var.<name>.<path> }}` 的取值语义一致）；
 *   - 'literal' ：字面量写入（字符串支持 {{ }} 模板——按当前节点模板上下文
 *                 渲染后写入）。
 * 路径不存在 → failed（提取失败应显式暴露，而非静默写空值）。
 * output 透传 input（纯旁路，不改变数据流）。写入经 RunVariableStore（运行装配方
 * 注入），同运行内后续节点的模板 `{{ var.* }}` 经变量供给函数读取到新值。
 *
 * 注意：本文件不通过 src/engine/index.ts 桶文件再导出（与 template.ts /
 * run-variables.ts 同策略：不改动既有桶文件），调用方按路径
 * `@/engine/logic-nodes` 直接引入。
 */

import { buildTemplateContext, executeWorkflow } from "./executor";
import type { DownstreamSelection, NodeRunContext, NodeRunner, RunSummary } from "./executor";
import type { CancelSignal } from "./cancel-signal";
import { hostSetTimeout, hostClearTimeout } from "./host-env";
import { ScriptExecutionError } from "./error-class";
import type { OverlayCapableVariableStore, RunVariableStore } from "./run-variables";
import { resolvePath, renderTemplate } from "./template";
import { parseCsv, resolveCsvDelimiter } from "./csv";
import type { RenderContext } from "./template";
import { capSnapshot } from "./run-record";
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  SANDBOX_CHECK_PARAM,
  SANDBOX_DEADLINE_PARAM,
  SCRIPT_ENV_PARAM_NAME,
  createEnvScriptParam,
  sanitizeJson,
} from "./script";
import type { ScriptError } from "./script";
import type { ScriptExecPort } from "./script-port";
import type {
  LoopIterationRecord,
  LoopIterationsSummary,
  NodeConfig,
  NodeId,
  NodeRun,
  VariableAssignment,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 循环迭代轮数缺省上限（config.maxIterations 缺省 / 非法值回退） */
export const DEFAULT_LOOP_MAX_ITERATIONS = 100;

/** 循环迭代轮数硬上限（config.maxIterations 超出时收敛到该值，防死循环底线） */
export const LOOP_HARD_MAX_ITERATIONS = 1000;

/** 循环批内并发数硬上限（config.concurrency 超出时收敛到该值；隔离模式生效） */
export const LOOP_MAX_CONCURRENCY = 16;

/** 延时时长上限（毫秒，5 分钟；超出按节点 failed） */
export const MAX_DELAY_DURATION_MS = 300_000;

/** 循环变量名（运行期变量表中 var.loop = { item, index }；保留名） */
export const LOOP_VARIABLE_NAME = "loop";

/** 循环变量的状态形状（var.loop 的值） */
export interface LoopVariableState {
  /** 当前轮的迭代项 */
  item: unknown;
  /** 当前轮下标（0 起） */
  index: number;
}

/** 循环体子运行的虚拟入口节点 id 后缀（拼接在 loop 节点 id 之后） */
export const LOOP_ENTRY_ID_SUFFIX = "::loop-entry";

/**
 * 逐迭代明细的单快照字节上限（M13-T9：每轮的 item 与 output 分别计，
 * 产出侧按 M5-T5 capSnapshot 惯例收敛）。逐迭代明细是调试预览性质的数据
 * （完整聚合输出仍在 loop 节点自身的 output 快照里，由落库侧统一截断），
 * 取小预算防止「轮数 × 明细」撑爆运行记录（1000 轮硬上限 × 4KB ≈ 4MB 量级
 * ——超过落库 2MB 总闸会让整条记录的快照被降级到不可读）。
 */
export const LOOP_ITERATION_SNAPSHOT_BYTES = 4 * 1024;

/**
 * 逐迭代明细的记录条数上限（M13-T9）：超出时按 index 升序保留前段并置
 * truncated 标注（进度以 total / done 为准，不因明细截断失真）。
 */
export const LOOP_ITERATIONS_MAX_RECORDS = 100;

/** 条件表达式的缺省软超时（毫秒；与脚本处理的缺省一致） */
export const DEFAULT_CONDITION_TIMEOUT_MS = DEFAULT_SCRIPT_TIMEOUT_MS;

/* ------------------------------------------------------------------ *
 * 条件分支（condition）
 * ------------------------------------------------------------------ */

/** condition 节点 runner 的成功输出形态（选择器据此路由 true / false 分支） */
export interface ConditionOutput {
  /** 命中的分支：条件值为 truthy → 'true'，否则 'false' */
  branch: "true" | "false";
  /** 条件表达式求值后的原始值（已净化，truthy 判定的依据） */
  value: unknown;
}

/**
 * 判断 runner 输出是否为条件分支形态（类型守卫）。
 * 仅对 type === 'condition' 的节点被选择器消费（按节点类型分派），
 * 用户数据偶然同形不会误路由。
 */
export function isConditionBranchOutput(output: unknown): output is ConditionOutput {
  if (typeof output !== "object" || output === null) return false;
  const branch = (output as { branch?: unknown }).branch;
  return branch === "true" || branch === "false";
}

/**
 * 条件表达式求值上下文：input 为聚合入参，vars 为当前运行期变量表。
 * M14-T2：env 为本次运行派发时定格的环境快照（可选；缺省按空表注入——表达式
 * 内 env 恒可用，缺键读取为 undefined）。
 */
export interface ConditionEvalContext {
  input: unknown;
  vars: Record<string, unknown>;
  /** 环境快照（M14-T2，可选；缺省按空表处理） */
  env?: Record<string, unknown>;
}

/**
 * 条件表达式求值结果：成功带原始返回值（已净化），失败带分类错误。
 * M14-T3：两 variants 均可携带 envWrites（表达式对 env 形参的写回收集——与
 * 脚本处理同语义：失败结果同样携带已提交写回，不因表达式失败丢弃）。
 */
export type ConditionEvalResult =
  | { ok: true; value: unknown; envWrites?: import("./script").EnvWritesTable }
  | { ok: false; error: ScriptError; envWrites?: import("./script").EnvWritesTable };

/** `__checkDeadline()` 主动中断用的内部哨兵（对象身份判定，脚本无法伪造） */
const CONDITION_DEADLINE_EXCEEDED: unknown = Object.freeze({ __reqflowConditionDeadline: true });

/**
 * 执行条件表达式（软超时模型与 script.ts 一致，详见其文件头【限制声明】）：
 * `"use strict"` 前缀 + new Function 编译（形参 __deadline / __checkDeadline /
 * input / vars / env），入参先净化，返回值净化后按 JS truthy 判定。
 *
 * M14-T2 / T3：context.env 注入 env 形参（可写代理，与前置 / 后置脚本同语义）；
 * 表达式对 env 的赋值收集为 envWrites 随结果回传（成功与失败结果均携带——已
 * 提交副作用不回滚），由运行装配方（createConditionRunner 的 onEnvWrite 依赖）
 * 应用。env 缺省按空表注入（表达式内 env 恒可用）。
 *
 * @param source 条件脚本文本（函数体，用 return 返回结果；空串返回 undefined → false）
 * @param context 求值上下文（input / vars 均先经 sanitizeJson 净化）
 * @param timeoutMs 软超时毫秒（缺省 DEFAULT_CONDITION_TIMEOUT_MS；0 合法）
 */
export function runConditionExpression(
  source: string,
  context: ConditionEvalContext,
  timeoutMs: number = DEFAULT_CONDITION_TIMEOUT_MS,
): ConditionEvalResult {
  const deadline = Date.now() + timeoutMs;
  const checkDeadline = (): void => {
    if (Date.now() > deadline) throw CONDITION_DEADLINE_EXCEEDED;
  };

  const envParam = createEnvScriptParam(context.env);

  const safeInput = sanitizeJson(context.input);
  if (!safeInput.ok) {
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: `条件表达式入参（input）不是可安全传递的 JSON 数据：${safeInput.reason}`,
      },
    };
  }
  const safeVars = sanitizeJson(context.vars);
  if (!safeVars.ok) {
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: `条件表达式入参（vars）不是可安全传递的 JSON 数据：${safeVars.reason}`,
      },
    };
  }

  let factory: (
    deadline: number,
    check: () => void,
    input: unknown,
    vars: unknown,
    env: unknown,
  ) => unknown;
  try {
    factory = new Function(
      SANDBOX_DEADLINE_PARAM,
      SANDBOX_CHECK_PARAM,
      "input",
      "vars",
      SCRIPT_ENV_PARAM_NAME,
      `"use strict";\n${source}`,
    ) as (
      deadline: number,
      check: () => void,
      input: unknown,
      vars: unknown,
      env: unknown,
    ) => unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "syntax",
        message: `条件表达式语法错误：${toErrorMessage(error)}`,
        cause: error,
      },
    };
  }

  const startedAt = Date.now();
  let value: unknown;
  try {
    value = factory(deadline, checkDeadline, safeInput.value, safeVars.value, envParam.value);
  } catch (error) {
    // 写回在表达式实际执行后即收集（失败结果同样携带——已提交副作用不回滚）
    const envWrites = envParam.takeWrites();
    if (error === CONDITION_DEADLINE_EXCEEDED) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `条件表达式通过 ${SANDBOX_CHECK_PARAM}() 主动中断：已超过截止时间（上限 ${timeoutMs}ms）。`,
        },
        ...(envWrites !== undefined ? { envWrites } : {}),
      };
    }
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: `条件表达式运行时错误：${toErrorMessage(error)}`,
        cause: error,
      },
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }

  // 软超时兜底（表达式已完整跑完，副作用无法回滚——同 script.ts 的限制声明）
  const elapsed = Date.now() - startedAt;
  if (elapsed > timeoutMs) {
    const envWrites = envParam.takeWrites();
    return {
      ok: false,
      error: {
        kind: "timeout",
        message: `条件表达式执行软超时：实际耗时 ${elapsed}ms 超过上限 ${timeoutMs}ms。`,
      },
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }

  const safeReturn = sanitizeJson(value);
  const envWrites = envParam.takeWrites();
  if (!safeReturn.ok) {
    return {
      ok: false,
      error: {
        kind: "invalid-return",
        message: `条件表达式返回值不是合法 JSON：${safeReturn.reason}`,
      },
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }
  return {
    ok: true,
    value: safeReturn.value,
    ...(envWrites !== undefined ? { envWrites } : {}),
  };
}

/**
 * 条件表达式缺省执行端口（本地同线程 eval，与 runConditionExpression 等价）。
 *
 * M9-T2：条件表达式与前置 / 后置脚本同样受 MV3 CSP 限制，生产链路经
 * deps.scriptPort 注入沙箱端口（run-controller 接线）；未注入（既有测试 /
 * 降级路径）时用本缺省——行为与 M7-T1 既有实现逐字段一致。刻意内联构造
 * 而非 import script-port 的 createLocalScriptPort：避免与 script-port 对
 * 本模块的运行时依赖成环（此处只引其类型，类型引用编译期擦除）。
 */
const defaultConditionPort: Pick<ScriptExecPort, "runCondition"> = {
  runCondition: async (source, context, timeoutMs) =>
    runConditionExpression(source, context, timeoutMs),
};

/**
 * 创建 condition 节点 runner：求值条件表达式 → 返回 { branch, value } 输出
 * （分支路由由 selectDownstream 扩展点完成，见 createWorkflowDownstreamSelector）。
 * 脚本错误 / 超时包装为 ScriptExecutionError 抛出（节点 failed，分类 script /
 * timeout / blocked）。
 *
 * M14-T2：env 取自当前节点的 templateContext.env（与模板 `{{ env.* }}` 同源——
 * 执行器经供给函数逐节点取当前快照，上游脚本写回对下游条件立即可见）。
 * M14-T3：表达式的 env 写回经 deps.onEnvWrite 应用（成功与失败结果均转发——
 * 已提交写回不因表达式失败丢弃）。
 *
 * @param deps.timeoutMs 条件表达式软超时（缺省 5 秒）
 * @param deps.scriptPort 脚本执行端口（M9-T2）：缺省本地 eval 实现（见
 *   defaultConditionPort）；生产链路由 run-controller 注入沙箱端口
 * @param deps.onEnvWrite env 写回通道（M14-T3，可选）：缺省不接（写回仅随结果
 *   回传后丢弃——未装配写回通道的调用方既有行为不变）
 */
export function createConditionRunner(deps?: {
  timeoutMs?: number;
  scriptPort?: Pick<ScriptExecPort, "runCondition">;
  onEnvWrite?: import("./script").EnvWriteHandler;
}): NodeRunner {
  const runCondition = deps?.scriptPort ?? defaultConditionPort;
  return async (node, input, runCtx) => {
    const source = typeof node.config.expression === "string" ? node.config.expression : "";
    const vars = runCtx.nodeCtx.templateContext.var ?? {};
    const env = runCtx.nodeCtx.templateContext.env;
    const result = await runCondition.runCondition(
      source,
      { input, vars, ...(env !== undefined ? { env } : {}) },
      deps?.timeoutMs,
    );
    // 写回先于失败抛出应用：表达式失败的已提交写回同样生效（不回滚）
    if (result.envWrites !== undefined) deps?.onEnvWrite?.(result.envWrites);
    if (!result.ok) throw new ScriptExecutionError(result.error);
    return {
      branch: Boolean(result.value) ? "true" : "false",
      value: result.value,
    } satisfies ConditionOutput;
  };
}

/* ------------------------------------------------------------------ *
 * 延时（delay）
 * ------------------------------------------------------------------ */

/**
 * 可中断延时：durationMs 后 resolve；signal 在等待期间触发 → reject
 * '[cancelled]' 前缀错误（error-class 归类为 cancelled）。零 / 负时长立即 resolve。
 *
 * 【宿主注入点替换】归档直呼 setTimeout / clearTimeout 且形参为 DOM
 * AbortSignal；QuickJS 无该全局，改走 host-env 注入链（缺省 globalThis，
 * QuickJS 载荷入口以 host.sleep 组装等价定时器），signal 为 CancelSignal
 * 结构子集（DOM AbortSignal 亦兼容）。
 */
function abortableDelay(durationMs: number, signal?: CancelSignal): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cancelledError = (): Error => new Error("[cancelled] 延时等待被取消");
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const timer = hostSetTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      cleanup();
      reject(cancelledError());
    };
    const cleanup = (): void => {
      hostClearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 创建 delay 节点 runner：等待 config.durationMs 后透传 input。
 * 时长上限 MAX_DELAY_DURATION_MS（超出 → 节点 failed）；等待响应取消。
 */
export function createDelayRunner(): NodeRunner {
  return async (node, input, runCtx) => {
    const raw = node.config.durationMs;
    const duration = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (duration > MAX_DELAY_DURATION_MS) {
      throw new Error(
        `延时时长超出上限：${duration}ms > ${MAX_DELAY_DURATION_MS}ms（5 分钟），请拆分多个延时节点`,
      );
    }
    await abortableDelay(duration, runCtx.signal);
    return input;
  };
}

/* ------------------------------------------------------------------ *
 * 变量赋值 / 提取（setVariable）
 * ------------------------------------------------------------------ */

/** setVariable runner 依赖：变量存储由运行装配方注入（缺省视为装配缺陷，节点 failed） */
export interface SetVariableRunnerDeps {
  /**
   * 返回当前运行的变量存储；undefined（未装配）时节点 failed。
   * M10-T6 循环并发：并发迭代体内时本依赖被 runCtx.iterationStore（当前迭代
   * overlay，由 loop runner 注入）遮蔽——写入缓冲到本轮作用域、迭代结束合并
   * 回父层；未注入（顶层图 / 串行直写）时仍解析宿主 store，行为不变。
   */
  getStore: () => RunVariableStore | undefined;
}

/**
 * 从赋值项解析目标变量名与待写入的值（纯函数，供 runner 与测试复用）。
 *
 * @param assignment 赋值项（容忍存储脏数据，形状非法抛错）
 * @param context 取值上下文：input 聚合入参 / nodeOutputs 已成功节点输出表
 *   （键为模板引用键 refId ?? id，M15-T2）/ vars 当前变量表快照 /
 *   templateContext 字面量模板渲染上下文 / refKeyOf 内部 id → 引用键换算
 *   （可选；缺省按原样查找，既有调用方零改动）
 * @returns name 为去空白后的目标变量名，value 为待写入的值
 * @throws Error 形状非法、变量名为空、来源非法、来源节点不在上下文、路径不存在
 *   （提取失败显式暴露，不静默写空值）
 */
export function resolveAssignmentValue(
  assignment: VariableAssignment,
  context: {
    input: unknown;
    nodeOutputs: Record<string, unknown>;
    vars: Record<string, unknown>;
    templateContext: RenderContext;
    refKeyOf?: (nodeId: NodeId) => string;
  },
): { name: string; value: unknown } {
  if (assignment === null || typeof assignment !== "object") {
    throw new Error("赋值项形状非法（需为对象）");
  }
  const record = assignment as Partial<VariableAssignment>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name === "") throw new Error("赋值项的变量名不能为空");

  let value: unknown;
  if (record.from === "literal") {
    const raw = record.value;
    // 字符串字面量支持模板渲染（如 "Bearer {{ var.token }}"）；其余 JSON 值原样写入
    value = typeof raw === "string" ? renderTemplate(raw, context.templateContext).value : raw;
  } else {
    const path = typeof record.path === "string" ? record.path : "";
    let root: unknown;
    let rootLabel: string;
    if (record.from === "input") {
      root = context.input;
      rootLabel = "input";
    } else if (record.from === "node") {
      const nodeId = record.node;
      if (typeof nodeId !== "string" || nodeId === "") {
        throw new Error(`赋值项「${name}」未指定来源节点（from: 'node' 需提供 node 字段）`);
      }
      // M15-T2：nodeOutputs 以模板引用键（refId ?? id）为键，config 里的裸节点
      // id 经 refKeyOf 换算后定位；refKeyOf 缺省（旧上下文）按原样查找
      const nodeKey = context.refKeyOf !== undefined ? context.refKeyOf(nodeId) : nodeId;
      if (!Object.prototype.hasOwnProperty.call(context.nodeOutputs, nodeKey)) {
        throw new Error(`赋值项「${name}」引用的节点不在上下文中：${nodeId}（尚未执行或非上游）`);
      }
      root = context.nodeOutputs[nodeKey];
      rootLabel = `节点 ${nodeId} 的输出`;
    } else if (record.from === "var") {
      root = context.vars;
      rootLabel = "变量表";
    } else {
      throw new Error(
        `赋值项「${name}」的来源非法：${String(record.from)}（只允许 input / node / var / literal）`,
      );
    }

    const resolved = resolvePath(root, path);
    if (!resolved.found) {
      throw new Error(`赋值项「${name}」的取值路径不存在：${rootLabel} 上的 "${path}"`);
    }
    value = resolved.value;
  }

  return { name, value };
}

/**
 * 创建 setVariable 节点 runner：按顺序执行赋值项写入运行期变量，output 透传
 * input（纯旁路）。任一赋值项失败 → 抛错（节点 failed），已写入的项不回滚
 * （顺序执行的中间状态对外可见性以最终成败为准——失败时后续节点默认不执行）。
 * 写入目标：并发循环迭代体内为当前迭代的 overlay（runCtx.iterationStore，
 * 见 IterationScopedRunContext）；否则为宿主注入的 RunVariableStore。
 */
export function createSetVariableRunner(deps: SetVariableRunnerDeps): NodeRunner {
  return async (node, input, runCtx) => {
    const store = (runCtx as IterationScopedRunContext).iterationStore ?? deps.getStore();
    if (!store) {
      throw new Error("变量存储不可用（本次运行未装配 RunVariableStore），无法写入变量");
    }
    const assignments = Array.isArray(node.config.assignments) ? node.config.assignments : [];
    // 上下文逐项重建：变量表取 store 的当前快照——同一节点内后一个赋值项可读到
    // 前一项刚写入的值（字面量模板 / var 提取的顺序可见性）
    for (const assignment of assignments) {
      const currentVars = store.snapshot();
      const context = {
        input,
        nodeOutputs: runCtx.nodeCtx.nodeOutputs,
        vars: currentVars,
        templateContext: buildTemplateContext(runCtx.nodeCtx.nodeOutputs, input, currentVars),
        // M15-T2：赋值项 from='node' 手持内部 id，经执行器注入的换算定位输出表
        refKeyOf: runCtx.nodeCtx.refKeyOf,
      };
      const { name, value } = resolveAssignmentValue(assignment as VariableAssignment, context);
      store.set(name, value);
    }
    return input;
  };
}

/* ------------------------------------------------------------------ *
 * 循环体子图（loop body）
 * ------------------------------------------------------------------ */

/** 循环体子图计划（computeLoopBody 产物） */
export interface LoopBodyPlan {
  /** 循环体节点（保持工作流节点数组的原顺序） */
  bodyNodes: WorkflowNode[];
  /** 体入口（loop 的直接下游中「体内无其它已入体上游」的纯入口；子运行虚拟 start 只接这些） */
  entryIds: NodeId[];
  /** 循环体内部连线（source 与 target 均在体内；不含 loop 节点自身的出边） */
  bodyEdges: WorkflowEdge[];
  /** 汇点：体内无出边指向其它体节点的节点（逐轮聚合的数据源） */
  sinkIds: NodeId[];
}

/** 空计划（loop 节点不在图中 / 无可达下游） */
function emptyLoopBodyPlan(): LoopBodyPlan {
  return { bodyNodes: [], entryIds: [], bodyEdges: [], sinkIds: [] };
}

/**
 * 计算循环体子图（纯函数）：
 *
 *   1. 可达集 R = 从 loopId 沿出边可达的全部节点（不含 loopId 自身）；
 *   2. 候选准入：全部直接上游 ∈ R ∪ {loopId} 的节点才有入体资格——有外部
 *      上游的节点留给父调度器在循环结束后按 join 语义执行；
 *   3. Kahn 入体：体内入度 = 直接上游中已入体（候选集内）的个数，入度为 0
 *      者先入体并递减下游计数；
 *   4. entryIds = 已入体的 loop 直接下游中、体内再无其它已入体上游的「纯入口」
 *      （混合入口在子运行中以其体内上游为门槛，input 形状保持单上游透传）；
 *   5. sinkIds = 体内无出边指向其它体节点的节点（跨体出边是「出口」）。
 *
 * 体內含环时环上节点无法满足入体规则（上游永远缺一个），整个环不入体——
 * 父调度器按既有环语义将其 skipped。
 *
 * @param loopId 循环节点 id
 * @param nodes 工作流全部节点
 * @param edges 工作流全部连线
 */
export function computeLoopBody(
  loopId: NodeId,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): LoopBodyPlan {
  const nodeById = new Map<NodeId, WorkflowNode>();
  for (const node of nodes) nodeById.set(node.id, node);
  if (!nodeById.has(loopId)) return emptyLoopBodyPlan();

  /** 每个节点的直接上游（去重）与直接下游 */
  const upstreams = new Map<NodeId, NodeId[]>();
  const downstreams = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    if (!upstreams.has(edge.target)) upstreams.set(edge.target, []);
    if (!upstreams.get(edge.target)!.includes(edge.source))
      upstreams.get(edge.target)!.push(edge.source);
    if (!downstreams.has(edge.source)) downstreams.set(edge.source, []);
    if (!downstreams.get(edge.source)!.includes(edge.target))
      downstreams.get(edge.source)!.push(edge.target);
  }

  // 1) 可达集 R（不含 loopId）
  const reachable = new Set<NodeId>();
  const reachQueue = (downstreams.get(loopId) ?? []).filter((id) => id !== loopId);
  while (reachQueue.length > 0) {
    const id = reachQueue.shift() as NodeId;
    if (reachable.has(id) || id === loopId) continue;
    reachable.add(id);
    reachQueue.push(...(downstreams.get(id) ?? []));
  }
  if (reachable.size === 0) return emptyLoopBodyPlan();

  // 2) 候选准入集：全部直接上游 ∈ R ∪ {loopId} 的节点（有外部上游者永远无资格，
  //    留给父调度器在循环结束后按 join 语义执行）。
  //    M13-T5：stickyNote（便签）显式排除——纯注释卡不入执行拓扑，循环体计划
  //    不得把它当体内节点（脏数据下 loop→便签连线即使可达也不准入，避免子运行
  //    尝试执行无 runner 的便签）。
  const admissible = new Set<NodeId>();
  for (const id of reachable) {
    const node = nodeById.get(id);
    if (node?.type === "stickyNote") continue;
    const ups = upstreams.get(id) ?? [];
    if (ups.every((up) => up === loopId || reachable.has(up))) admissible.add(id);
  }
  if (admissible.size === 0) return emptyLoopBodyPlan();

  // 3) Kahn 入体：体内入度 = 直接上游中属于候选集的个数（loopId 上游不算）
  const indegree = new Map<NodeId, number>();
  for (const id of admissible) {
    const count = (upstreams.get(id) ?? []).filter(
      (up) => up !== loopId && admissible.has(up),
    ).length;
    indegree.set(id, count);
  }
  const admitted = new Set<NodeId>();
  const queue: NodeId[] = [...admissible].filter((id) => indegree.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    admitted.add(id);
    for (const next of downstreams.get(id) ?? []) {
      if (!admissible.has(next) || next === loopId || admitted.has(next)) continue;
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }
  if (admitted.size === 0) return emptyLoopBodyPlan();

  // 4) 纯入口 = loop 的直接下游 ∩ 已入体，且体内其它已入体上游为空
  const directTargets = new Set<NodeId>();
  for (const edge of edges) {
    if (edge.source === loopId && edge.target !== loopId && admitted.has(edge.target)) {
      directTargets.add(edge.target);
    }
  }
  const entryIds: NodeId[] = [];
  for (const id of directTargets) {
    const bodyUpstreams = (upstreams.get(id) ?? []).filter(
      (up) => up !== loopId && admitted.has(up),
    );
    if (bodyUpstreams.length === 0) entryIds.push(id);
  }

  // 5) 体内部连线 / 汇点 / 体节点（保持工作流节点数组原顺序）
  const bodyEdges = edges.filter((edge) => admitted.has(edge.source) && admitted.has(edge.target));
  const sinkIds: NodeId[] = [];
  for (const id of admitted) {
    const exits = (downstreams.get(id) ?? []).some((next) => admitted.has(next));
    if (!exits) sinkIds.push(id);
  }
  const bodyNodes = nodes.filter((node) => admitted.has(node.id));

  return { bodyNodes, entryIds, bodyEdges, sinkIds };
}

/**
 * 由循环体计划构建子运行工作流：虚拟 start 节点（id = <loopId>::loop-entry）
 * 接全部纯入口，加上体内部连线。子运行复用执行器的图校验 / join / 取消语义。
 * 返回值附 entryId 供事件转发时过滤虚拟入口。
 *
 * M13-T9 导出：单迭代重跑（run-controller 的 workflow/rerun-iteration）以
 * 同一约定构造「只跑循环体」的调试子工作流（与 loop runner 的子运行完全同构，
 * 保证重跑路径与正常逐轮执行的行为一致）。
 */
export function buildBodyWorkflow(
  loopId: NodeId,
  plan: LoopBodyPlan,
): {
  id: ReturnType<typeof asWorkflowId>;
  entryId: NodeId;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const entryId = asNodeId(`${loopId}${LOOP_ENTRY_ID_SUFFIX}`);
  const virtualStart: WorkflowNode = {
    id: entryId,
    type: "start",
    position: { x: 0, y: 0 },
    config: {},
  };
  const edges: WorkflowEdge[] = plan.entryIds.map((target) => ({
    id: asEdgeId(`${entryId}->${target}`),
    source: entryId,
    target,
  }));
  edges.push(...plan.bodyEdges);
  return {
    id: asWorkflowId(`${loopId}${LOOP_ENTRY_ID_SUFFIX}`),
    entryId,
    nodes: [virtualStart, ...plan.bodyNodes],
    edges,
  };
}

/* ------------------------------------------------------------------ *
 * 循环（loop）runner
 * ------------------------------------------------------------------ */

/** loop runner 依赖（由运行装配方按运行注入，见 background/run-controller） */
export interface LoopRunnerDeps {
  /**
   * 取循环节点的循环体计划（宿主按工作流图预计算 / 缓存；undefined 视为
   * 空循环体——零轮迭代、output 为空数组）。
   */
  getBodyPlan?: (loopNodeId: NodeId) => LoopBodyPlan | undefined;
  /**
   * 子运行使用的 runner 表（与父运行同一装配，循环体内可含 httpReplay /
   * condition / 嵌套 loop 等；缺省空表——未注册类型的体节点按 failed 处理）。
   */
  getRunners?: () => Partial<Record<WorkflowNodeType, NodeRunner>> | undefined;
  /**
   * 运行期变量存储（缺省 / 返回 undefined → 不写循环变量，体内 var.loop 引用
   * 按缺失告警）。store 支持 overlay（RunVariableStore 均支持）→ 隔离模式：
   * 每轮迭代写独立 overlay、结束合并回本 store；不支持（鸭子类型替身）→
   * 直写串行的既有语义。
   */
  getStore?: () => RunVariableStore | undefined;
  /**
   * 环境快照供给（M14-T2，可选）：注入循环体子运行的 ExecutorOptions.env——
   * 供给函数形态（每节点取当前值），主链路脚本对 env 的写回对循环体内后续
   * 节点 / 迭代立即可见。缺省不注入（循环体模板 `{{ env.* }}` 按缺省约定告警
   * 渲染为空、脚本 env 为空表——与 M10-T4 既有行为一致）。
   */
  getEnv?: () => Record<string, unknown>;
  /** 转发循环体子运行的节点开始事件（宿主落库 / 广播；虚拟入口不转发） */
  forwardNodeStart?: (node: WorkflowNode, input: unknown) => void;
  /** 转发循环体子运行的节点结束事件（宿主落库 / 广播；虚拟入口不转发） */
  forwardNodeFinish?: (node: WorkflowNode, nodeRun: NodeRun) => void;
  /**
   * 收集循环体节点的「最后一轮」快照（宿主存入 Map，经父执行器
   * ExecutorOptions.nestedNodeRun 在收尾时代替统一 skipped；同节点多轮后写覆盖）。
   */
  collectNestedRun?: (nodeId: NodeId, nodeRun: NodeRun) => void;
  /**
   * 报告循环节点自身的迭代进度（M13-T9 逐迭代调试）：首批发起前报告 done=0
   * 的基线，此后每轮迭代结算（成功 / 失败 / 取消）后调用一次——done 按完成
   * 序递增（真并发下不等于轮次序）。宿主（run-controller）据此广播「已迭代
   * x / y」进度事件；缺省不接（引擎直调 / 既有测试零影响）。进度只走广播
   * 通道、不落库中间快照：onNodeStart 写入的入参快照保留到终态，逐迭代明细
   * 随终态快照一次性落库（经 runCtx.snapshotExtras → 执行器结算并入）。
   */
  reportLoopProgress?: (
    node: WorkflowNode,
    progress: { done: number; total: number; capped: boolean },
  ) => void;
}

/** 解析循环迭代数据源（见文件头 loop 配置说明）；配置非法时抛错（节点 failed） */
export function resolveLoopItems(config: NodeConfig, ctx: RenderContext): unknown[] {
  if (typeof config.csvText === "string" && config.csvText !== "") {
    return parseCsv(
      renderTemplate(config.csvText, ctx).value,
      resolveCsvDelimiter(config.csvDelimiter),
    );
  }
  const raw = config.items;
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") {
    throw new Error(
      "循环 items 配置非法：需为 JSON 数组字面量或可渲染解析为 JSON 数组的模板字符串",
    );
  }
  // 模板字符串：先按当前节点模板上下文渲染（渲染永不失败，缺数据按空串 + 警告），再 JSON.parse
  const rendered = renderTemplate(raw, ctx).value;
  if (rendered.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch (error) {
    throw new Error(
      `循环 items 渲染后不是合法 JSON：${toErrorMessage(error)}（渲染结果：${truncate(rendered, 80)}）`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`循环 items 渲染后不是 JSON 数组（得到 ${typeof parsed}）`);
  }
  return parsed;
}

/** 解析迭代轮数上限：非法值回退缺省；超出硬上限收敛（防死循环底线） */
export function resolveLoopMaxIterations(config: NodeConfig): number {
  const raw = config.maxIterations;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_LOOP_MAX_ITERATIONS;
  }
  return Math.min(Math.floor(raw), LOOP_HARD_MAX_ITERATIONS);
}

/** resolveLoopExecutionOptions 的能力门控入参（见函数说明） */
export interface LoopExecutionGateOptions {
  /**
   * 迭代变量作用域是否已隔离（每轮迭代持有独立 overlay，并发写互不覆盖）：
   * 仅显式 true 时按 config.concurrency 启用批内并发；缺省 / false 恒为
   * 串行 1（既有契约，既有测试锁定）。
   */
  isolatedVariableScope?: boolean;
}

/**
 * 将循环并发与限速配置收敛到可执行范围。
 *
 * 能力门控（M10-T6 收尾）：并发迭代要求每轮持有独立变量作用域——调用方在
 * 变量 store 支持 overlay 隔离时传 `{ isolatedVariableScope: true }`，此时
 * config.concurrency 收敛为整数并夹取 1~LOOP_MAX_CONCURRENCY（非法值回退 1）；
 * 未传 / false 时恒返回 concurrency: 1（安全串行回退——循环体共享变量上下文
 * 时并发会让 var.loop 与体内 setVariable 写互相覆盖，既有行为逐字不变）。
 * intervalMs 两模式一致：正有限值向下取整并夹取上限 60000，否则 0。
 *
 * @param config 循环节点配置
 * @param opts 能力门控（缺省视为未隔离）
 */
export function resolveLoopExecutionOptions(
  config: NodeConfig,
  opts?: LoopExecutionGateOptions,
): { concurrency: number; intervalMs: number } {
  const intervalMs = config.intervalMs;
  const normalizedInterval =
    typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.min(60_000, Math.floor(intervalMs))
      : 0;
  if (opts?.isolatedVariableScope !== true) {
    return { concurrency: 1, intervalMs: normalizedInterval };
  }
  const raw = config.concurrency;
  const concurrency =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 1
      ? Math.min(LOOP_MAX_CONCURRENCY, raw)
      : 1;
  return { concurrency, intervalMs: normalizedInterval };
}

/** 截断文本（错误信息里回显渲染结果用） */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 收集一轮循环体的聚合结果：汇点中成功者的 output——单汇点原样、多汇点按
 * 节点 id 组对象、无成功汇点为 null。
 */
function collectIterationResult(summary: RunSummary, plan: LoopBodyPlan): unknown {
  const outputs: Array<[NodeId, unknown]> = [];
  for (const sinkId of plan.sinkIds) {
    const record = summary.nodeRuns[sinkId];
    if (record && record.status === "success") outputs.push([sinkId, record.output]);
  }
  if (outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0]![1];
  const grouped: Record<string, unknown> = {};
  for (const [id, output] of outputs) grouped[id] = output;
  return grouped;
}

/**
 * 迭代作用域注入的 runner 上下文（M10-T6 循环并发，本模块内部约定）：隔离
 * 模式下 loop runner 以注入器包装循环体 runner 表（见 injectIterationStore），
 * 体节点经 runCtx.iterationStore 拿到当前迭代的 overlay。仅隔离模式注入；
 * 顶层主图与直写模式不出现该字段（读取方一律回退各自的宿主 store 依赖）。
 */
interface IterationScopedRunContext extends NodeRunContext {
  /** 当前迭代的变量作用域视图（嵌套时 = 外层迭代的 overlay，供本轮 overlay 叠加） */
  iterationStore?: OverlayCapableVariableStore;
}

/**
 * 结构化探测 store 是否支持迭代作用域 overlay：五个成员（get / has / set /
 * snapshot / createOverlay）齐备才视为可用——真实 RunVariableStore 恒通过；
 * 测试替身 / 旧装配的鸭子类型 store 缺 createOverlay 时返回 undefined
 * （loop runner 回退直写串行，既有行为不变）。
 */
function asOverlayCapableStore(
  store: RunVariableStore | undefined,
): OverlayCapableVariableStore | undefined {
  if (store === undefined || typeof store !== "object") return undefined;
  const candidate = store as Partial<OverlayCapableVariableStore>;
  const methods = [
    candidate.get,
    candidate.has,
    candidate.set,
    candidate.snapshot,
    candidate.createOverlay,
  ];
  return methods.every((method) => typeof method === "function")
    ? (store as OverlayCapableVariableStore)
    : undefined;
}

/**
 * 给循环体子运行的 runner 表注入当前迭代作用域（隔离模式专用）：包一层调用
 * 转发，把本轮 overlay 挂到 runCtx.iterationStore——体内嵌套的 loop /
 * setVariable（以及任何读取该字段的 runner）据此把变量读写路由到当前迭代的
 * overlay，而非宿主根 store。对不感知该字段的 runner 等价于透传（上下文为
 * 浅拷贝，nodeCtx / signal 引用不变）。
 *
 * @param runners 宿主提供的 runner 表（原样使用其条目，不改变条目身份）
 * @param scope 本轮迭代的变量作用域视图
 */
function injectIterationStore(
  runners: Partial<Record<WorkflowNodeType, NodeRunner>>,
  scope: OverlayCapableVariableStore,
): Partial<Record<WorkflowNodeType, NodeRunner>> {
  const injected: Partial<Record<WorkflowNodeType, NodeRunner>> = {};
  for (const [type, runner] of Object.entries(runners)) {
    if (!runner) continue;
    injected[type as WorkflowNodeType] = async (node, input, runCtx) =>
      runner(node, input, Object.assign({}, runCtx, { iterationStore: scope }));
  }
  return injected;
}

/**
 * 创建 loop 节点 runner（执行语义见文件头「循环」一节）：
 * 逐项取 items → 写循环变量（隔离模式走独立 overlay、直写模式保存 / 恢复）→
 * 子运行执行循环体 → 聚合逐轮结果；并发按能力门控分批执行、取消停迭代、
 * 子运行失败向上抛、上限截断不报错。
 */
export function createLoopRunner(deps: LoopRunnerDeps): NodeRunner {
  return async (node, _input, runCtx) => {
    const items = resolveLoopItems(node.config, runCtx.nodeCtx.templateContext);
    const maxIterations = resolveLoopMaxIterations(node.config);
    const plan = deps.getBodyPlan?.(node.id);
    const results: unknown[] = [];

    // 无循环体（无出边 / 下游全部有外部上游 / 体为空）：零轮迭代，直接空聚合
    if (!plan || plan.bodyNodes.length === 0 || plan.entryIds.length === 0) {
      return results;
    }

    const subWorkflow = buildBodyWorkflow(node.id, plan);
    const entryId = subWorkflow.entryId;
    const store = deps.getStore?.();
    // 隔离基座：嵌套迭代优先取外层注入的 overlay（叠加父层），否则探测宿主
    // store 是否支持 overlay。支持 → 隔离模式（本轮写缓冲、结束合并）；否则
    // 直写模式（既有保存 / 恢复语义）
    const inheritedScope = (runCtx as IterationScopedRunContext).iterationStore;
    const isolationBase = inheritedScope ?? asOverlayCapableStore(store);
    const count = Math.min(items.length, maxIterations);
    const { concurrency, intervalMs } = resolveLoopExecutionOptions(node.config, {
      isolatedVariableScope: isolationBase !== undefined,
    });
    // 嵌套迭代的合并不外泄 var.loop：外层（父层）缓冲的 var.loop 必须保持为
    // 外层的 item——外层体内后续节点仍读外层值；顶层迭代合并 var.loop（循环
    // 结束后保留最后一轮值，与既有「不再恢复」语义一致）
    const mergeExcludes = inheritedScope !== undefined ? [LOOP_VARIABLE_NAME] : undefined;

    // M13-T9 逐迭代调试：明细按完成序追加、结算前按 index 升序整理；
    // 进度 done 按完成序递增（真并发下不等于轮次序），total 为实际轮数
    // （min(items.length, maxIterations)——上限截断如实计入并置 capped 标注）
    const iterationRecords: LoopIterationRecord[] = [];
    let settledCount = 0;
    const iterationCapped = items.length > maxIterations;
    const reportProgress = (): void => {
      deps.reportLoopProgress?.(node, {
        done: settledCount,
        total: count,
        capped: iterationCapped,
      });
    };
    /** 单轮明细的迭代项 / 聚合输出生成侧体积收敛（M5-T5 capSnapshot 惯例） */
    const capIterationValue = (value: unknown, index: number, kind: "item" | "output"): unknown =>
      capSnapshot(value, LOOP_ITERATION_SNAPSHOT_BYTES, `${node.id}.iteration[${index}].${kind}`)
        .value;
    /** 追加一轮明细并上报进度（三类结算路径共用；并发下按完成序交错追加） */
    const pushIterationRecord = (
      index: number,
      item: unknown,
      startedAt: number,
      status: LoopIterationRecord["status"],
      output: unknown,
      error?: string,
    ): void => {
      settledCount += 1;
      iterationRecords.push({
        index,
        item: capIterationValue(item, index, "item"),
        status,
        output,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(error !== undefined ? { error } : {}),
      });
      reportProgress();
    };

    /** 执行单轮循环体；事件与最后一轮快照沿用既有宿主回调。 */
    const runIteration = async (index: number): Promise<unknown> => {
      if (runCtx.signal?.aborted) return null;
      const item = items[index];
      const iterationStartedAt = Date.now();
      // 隔离模式：本轮持有独立 overlay（读透传父层、写缓冲）；直写模式保持
      // 既有「保存旧值 / 结束恢复」语义
      const scope = isolationBase !== undefined ? isolationBase.createOverlay() : undefined;
      const hadLoopVar =
        scope === undefined && store !== undefined && store.has(LOOP_VARIABLE_NAME);
      const previousLoopVar = hadLoopVar && store ? store.get(LOOP_VARIABLE_NAME) : undefined;
      const effectiveStore = scope ?? store;
      effectiveStore?.set(LOOP_VARIABLE_NAME, { item, index } satisfies LoopVariableState);
      try {
        const summary = await executeWorkflow(subWorkflow, {
          runners:
            scope !== undefined
              ? injectIterationStore(deps.getRunners?.() ?? {}, scope)
              : (deps.getRunners?.() ?? {}),
          signal: runCtx.signal,
          ...(effectiveStore !== undefined
            ? { variables: (): Record<string, unknown> => effectiveStore.snapshot() }
            : {}),
          // 环境快照供给（M14-T2）：循环体与主链路同源（供给函数形态，写回可见）
          ...(deps.getEnv ? { env: deps.getEnv } : {}),
          selectDownstream: createWorkflowDownstreamSelector(subWorkflow.nodes, subWorkflow.edges),
          ...(deps.forwardNodeStart
            ? {
                onNodeStart: (bodyNode: WorkflowNode, bodyInput: unknown): void => {
                  if (bodyNode.id !== entryId) deps.forwardNodeStart?.(bodyNode, bodyInput);
                },
              }
            : {}),
          ...(deps.forwardNodeFinish
            ? {
                onNodeFinish: (bodyNode: WorkflowNode, nodeRun: NodeRun): void => {
                  if (bodyNode.id !== entryId) deps.forwardNodeFinish?.(bodyNode, nodeRun);
                },
              }
            : {}),
        });
        if (summary.status === "cancelled") {
          // 取消轮：已开始但被取消打断（子运行 cancelled）——明细如实记
          // cancelled、无聚合输出；不再抛错（与既有「取消停迭代、已完成轮次
          // 照常聚合」语义一致）
          pushIterationRecord(index, item, iterationStartedAt, "cancelled", null);
          return undefined;
        }
        if (summary.status === "failed") {
          // 失败轮：明细记 failed（错误文案与上抛的节点错误同源），再按既有
          // 语义抛错使 loop 节点 failed——失败前的调试数据不因节点失败丢失
          const message = `第 ${index + 1} 轮循环体执行失败：${summary.error ?? "未知错误"}`;
          pushIterationRecord(index, item, iterationStartedAt, "failed", null, message);
          throw new Error(message);
        }
        if (deps.collectNestedRun) {
          for (const [bodyNodeId, nodeRun] of Object.entries(summary.nodeRuns)) {
            if (bodyNodeId !== entryId) deps.collectNestedRun(asNodeId(bodyNodeId), nodeRun);
          }
        }
        const collected = collectIterationResult(summary, plan);
        pushIterationRecord(
          index,
          item,
          iterationStartedAt,
          "success",
          capIterationValue(collected, index, "output"),
        );
        return collected;
      } finally {
        if (scope !== undefined) {
          // 成功 / 失败 / 取消统一合并：本轮写缓冲按完成顺序 last-write-wins
          // 回父层（同键由各迭代的合并顺序定胜负）；var.loop 按嵌套语义排除
          scope.mergeBack(mergeExcludes);
        } else if (store && hadLoopVar) {
          store.set(LOOP_VARIABLE_NAME, previousLoopVar);
        }
      }
    };

    // 首批发起前的基线进度（done = 0）：宿主尽早拿到 total 展示「已迭代 0 / y」；
    // 信号已中止（零轮将执行）时不发（避免无意义的进度事件）
    if (count > 0 && !runCtx.signal?.aborted) reportProgress();

    try {
      for (let start = 0; start < count; start += concurrency) {
        if (runCtx.signal?.aborted) break;
        if (start > 0 && intervalMs > 0) await abortableDelay(intervalMs, runCtx.signal);
        const indexes = Array.from(
          { length: Math.min(concurrency, count - start) },
          (_, offset) => start + offset,
        );
        const batchResults = await Promise.all(indexes.map((index) => runIteration(index)));
        results.push(...batchResults.filter((value) => value !== undefined));
      }
    } finally {
      // M13-T9：逐迭代明细与进度并入快照扩展槽（执行器在该节点结算时并入
      // NodeRun.iterations）。明细按 index 升序整理；条数超上限时保留前段并
      // 如实标注截断（进度以 total / done 为准，不因明细截断失真）。有效循环
      // 体（含零轮迭代——items 解析为空数组）都写入摘要，运行详情可如实展示
      // 「已迭代 0 / 0」；空计划（无出边 / 无体入口）提前返回、不写入（快照
      // 保持既有形状，向后兼容）。失败轮上抛时同样先定稿扩展槽——失败轮之前
      // 的调试数据不因节点失败而丢失。
      const orderedRecords = [...iterationRecords].sort((a, b) => a.index - b.index);
      const recordsTruncated = orderedRecords.length > LOOP_ITERATIONS_MAX_RECORDS;
      runCtx.snapshotExtras = {
        iterations: {
          total: count,
          done: settledCount,
          capped: iterationCapped,
          records: recordsTruncated
            ? orderedRecords.slice(0, LOOP_ITERATIONS_MAX_RECORDS)
            : orderedRecords,
          truncated: recordsTruncated,
        } satisfies LoopIterationsSummary,
      };
    }

    return results;
  };
}

/* ------------------------------------------------------------------ *
 * 下游选择器（selectDownstream 扩展点的标准装配）
 * ------------------------------------------------------------------ */

/**
 * 创建整图下游选择器（ExecutorOptions.selectDownstream 的标准实现，纯函数
 * 工厂；循环体计划按 loop 节点 id 缓存）：
 *   - loop 节点：放行全部出边 target 中**不属于循环体入口**者（体入口由
 *     loop runner 的子运行逐轮执行；跨界 join 等非体下游照常入队走 join 语义）；
 *   - condition 节点（M16-T1 手柄路由）：出边带 sourceHandle（'true' / 'false'）
 *     时按手柄路由——命中分支手柄的 target 放行，未带手柄的出边（未迁移的
 *     存量数据）照常放行（旧语义「未绑定 = 两个分支都执行」，与 M7-T1 口径
 *     一致）；节点无任何带手柄出边时回退 M7-T1 的 legacy 清单路由
 *     （config.trueTargets / falseTargets，未打开过编辑器的存量流程行为不变）；
 *     输出非分支形态（失败 + continue）→ 'all'（失败不走任何分支）；
 *   - 其余节点：'all'（既有行为不变）。
 */
export function createWorkflowDownstreamSelector(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): (node: WorkflowNode, output: unknown) => DownstreamSelection {
  const bodyPlanCache = new Map<NodeId, LoopBodyPlan>();
  const getBodyPlan = (loopId: NodeId): LoopBodyPlan => {
    let plan = bodyPlanCache.get(loopId);
    if (plan === undefined) {
      plan = computeLoopBody(loopId, nodes, edges);
      bodyPlanCache.set(loopId, plan);
    }
    return plan;
  };
  /** 该 condition 节点是否存在带手柄的出边（决定手柄路由 / legacy 清单路由） */
  const hasHandledOutgoing = (nodeId: NodeId): boolean =>
    edges.some(
      (edge) =>
        edge.source === nodeId && (edge.sourceHandle === "true" || edge.sourceHandle === "false"),
    );

  return (node, output) => {
    if (node.type === "loop") {
      const plan = getBodyPlan(node.id);
      if (plan.bodyNodes.length === 0) return "all";
      const entries = new Set<NodeId>(plan.entryIds);
      const targets: NodeId[] = [];
      for (const edge of edges) {
        if (edge.source !== node.id) continue;
        if (entries.has(edge.target)) continue;
        if (!targets.includes(edge.target)) targets.push(edge.target);
      }
      return targets;
    }

    if (node.type === "condition") {
      if (!isConditionBranchOutput(output)) return "all";
      // M16-T1 手柄路由（连线即分支）：命中分支手柄的 target 放行；未带手柄的
      // 出边照常放行（未迁移存量数据 = 旧「未绑定」语义，画布载入时归一）
      if (hasHandledOutgoing(node.id)) {
        const active: NodeId[] = [];
        for (const edge of edges) {
          if (edge.source !== node.id) continue;
          const handle = edge.sourceHandle;
          if (handle === "true" || handle === "false") {
            if (handle !== output.branch) continue;
          }
          if (!active.includes(edge.target)) active.push(edge.target);
        }
        return active;
      }
      // legacy 清单路由（M7-T1 原语义，存量未迁移流程零行为变化）
      const { trueTargets, falseTargets } = node.config;
      const trueList = Array.isArray(trueTargets) ? trueTargets : [];
      const falseList = Array.isArray(falseTargets) ? falseTargets : [];
      if (trueList.length === 0 && falseList.length === 0) return "all"; // 完全未配置 → 直通
      // 未被任何分支勾选的直接下游不受条件影响（两个分支都放行）：
      // 勾选只约束被勾选的出边，汇合节点（仅部分入边进分支）照常执行
      const branchList = output.branch === "true" ? trueList : falseList;
      const selected = new Set<NodeId>(branchList);
      const active: NodeId[] = [...selected];
      for (const edge of edges) {
        if (edge.source !== node.id) continue;
        if (selected.has(edge.target)) continue;
        if (trueList.includes(edge.target) || falseList.includes(edge.target)) continue;
        if (!active.includes(edge.target)) active.push(edge.target);
      }
      return active;
    }

    return "all";
  };
}

/** toErrorMessage 的模块内兜底（script.ts / executor.ts 同款约定） */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
