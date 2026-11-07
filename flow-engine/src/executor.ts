/**
 * 工作流执行器骨架（M5-T1）。
 *
 * ROADMAP M5-T1：按边拓扑执行（先串行 + 简单分支）、runId 生成、状态机。
 * 本模块为纯逻辑、零环境依赖（不依赖 React / 存储 / 网络 / chrome.*），node 环境
 * 可单测；请求重放（M5-T2）、脚本执行（M5-T3）、失败策略细节（M5-T4）、落库
 * （M5-T5）由后续任务通过 NodeRunner 扩展点接入，本层只负责编排骨架。
 *
 * 执行模型（就绪队列 + 拓扑序；M5-T1 为纯串行 FIFO，M15-T6 起就绪集快照批量
 * 并发，见下方「节点级并行调度」增量说明）：
 *   - 从入口 start 节点出发（entryNodeId 显式指定；未指定时图须恰有一个
 *     start，多 start 未指定入口在建档前判 failed），维护「当前可运行节点」
 *     先进先出队列；主循环每轮取至多 maxNodeConcurrency 个就绪节点并发执行，
 *     整批结算后再统一调度；
 *   - 一个节点只有当其全部直接上游都结算后才可运行（join 语义，多上游聚合
 *     才有意义）；节点有多个下游时按边数组顺序逐个入队；
 *   - 每个节点在一次运行内至多执行一次（环状图不会死循环）；自环 / 环中等待
 *     自身或未执行上游的节点永远不满足可运行条件，收尾时统一标 skipped；
 *     （skipped 语义 = 因前序失败/取消而不再执行的节点，含从入口不可达的
 *     孤立节点与未选中的其他 start 链条）。
 *
 * 汇合（join）决策记录（M15-T6）：不新增独立 merge 节点类型——任意节点有多
 * 条入边即汇合（能力内建，与 n8n Merge 节点等价）：isRunnable 要求全部直接
 * 上游结算才放行，aggregateInputs 把多上游输出聚合为
 * `{ [<refId>]: output }` 形状（M15-T2 落地前键为内部节点 id，形状一致；
 * 单上游仍原样透传）。后续若需「任一成功放行 / N-of-M」语义再评估独立节点。
 * 分支交互既有口径沿用：condition 短路的下游 skipped 为终态，其余路径激活
 * 汇合节点时该入边按缺失聚合。continue 策略下失败上游被 collectUpstreamOutputs
 * 剔除（下方实现）——部分失败时汇合节点仍执行、input 缺该上游键（仅剩一个
 * 上游时回退原样透传、全部失败为 null）。
 *
 * 节点级并行调度（M15-T6 增量，join 门槛不变）：主循环从「就绪队列逐节点
 * await」改为「就绪集快照批量并发」——每轮从就绪队列头取至多
 * maxNodeConcurrency（ExecutorOptions 可配，缺省 4）个就绪节点同时起跑
 *（launch 期同步逐个调用 runner），批内全部结算后按**入队序**统一记录
 * （状态机 / 快照 / onNodeFinish）并调度下游、再取下一批——顺序只取决于
 * 就绪集快照序（= 连线数组序），不依赖批内完成先后（确定性可测）。
 * 快照内的节点彼此无未结算上游依赖（isRunnable 门槛在入队时已把关），并发
 * 执行不会读到半截输入；循环节点内部的迭代并发与 isolatedVariableScope 机制
 * （M10-T6）由 loop runner 自管，不受本值影响。并发下的事件语义：onNodeStart
 * 按入队序同步发出；onNodeFinish 在批末按入队序发出；run-progress 广播到达
 * 顺序不再保证与完成顺序一致（画布运行态按节点 id 独立着色，多节点同时
 * running 各自呈现，无需互斥）；快照 startedAt 允许重叠（无依赖上游并行发起）。
 *
 * 失败策略与并发（M15-T6 增量，stop 语义的并发定义）：failPolicy='stop' 的
 * 停机窗口 = 当前批——失败节点结算后，同批已起跑的在途节点让其自然结算
 * （请求已发出，结果照常记录、事件照发），但不再调度任何下游、不再从就绪
 * 队列取下一批：任何新节点都不会在 stop 生效后起跑，串行版「失败后不再启动
 * 新节点」的保证不弱化（窗口不扩大）。continue 语义不变（失败上游按缺失
 * 聚合）；run 级错误摘要按批内入队序取首个失败（确定性）。
 *
 * 失败策略（M5-T4，按节点读取，层级 node.config.failPolicy ?? options.defaultFailPolicy
 * ?? 'stop'；无效值一律按 'stop' 兜底——消息层的拒绝是 run-controller 的职责）：
 *   - 'stop'（默认）：节点 failed → 立即停止调度，剩余未执行节点统一标 skipped，
 *     run = failed；run 级错误摘要即该失败（格式「节点 <id> 执行失败：<原因>」）；
 *   - 'continue'：节点 failed → 该节点无 output，但**下游仍执行**。join 门槛从
 *     「全部上游 success」放宽为「全部上游已结算（success / failed）」；下游 input
 *     聚合时失败上游**按缺失处理**：只聚合仍成功的上游——仅剩一个 → 原样透传，
 *     全部缺失 → null（与无上游一致）；run 级状态：任一节点 failed → run = failed
 *     （即使继续跑完全图），run 级错误摘要取**第一个**失败节点（后续失败见各节点
 *     快照的 error 字段）；
 *   - 注意 ExecutorOptions.failPolicy 是 M5-T1 的遗留占位参数（仅接受 'stop'，
 *     传 'continue' 抛错——既有测试锁定），真实的工作流级默认策略用
 *     defaultFailPolicy，节点级用 node.config.failPolicy。
 *
 * HTTP 失败的归一（M5-T2 约定）：httpReplay runner 对 4xx / 5xx 不抛错（照常
 * 成功返回响应），是否判失败由上层（background/run-controller 的脚本接线 runner
 * 按 isHttpFailure + 本层 failPolicy）决定——本层只认 runner 抛出的错误。
 *
 * 取消约定（AbortSignal）：
 *   - 出队前发现已取消 → 不再启动任何节点；
 *   - 节点执行中发现取消 → 不打断当前节点，待其自然完成（结果照常记录）后停止
 *     调度；取消优先于失败决定 run 级状态（run = cancelled）；
 *   - 节点内部如何响应 signal（超时、fetch 中断等）由 runner 实现者负责（M5-T2）。
 *
 * 事件与记录：执行过程通过 onNodeStart / onNodeFinish / onRunFinish 通知宿主；
 * executeWorkflow 返回 RunSummary（与 onRunFinish 载荷同一对象）。RunSummary 不含
 * id 之外的时间戳字段——buildRunRecordShell 产出落库外壳（id / startedAt /
 * finishedAt 由 M5-T5 落库时填充）。事件回调不应抛错：抛错会中断执行并以异常冒泡。
 *
 * 变量注入（M7-T2 增量，核心调度语义不变）：ExecutorOptions.variables（三层
 * 作用域合并后的运行期变量表，合并逻辑见 run-variables.ts）存在时并入每个
 * 节点的 templateContext.var，模板 `{{ var.<name>.<path> }}` 即可引用；未传
 * 时模板上下文保持既有 { node, input } 形状（既有测试锁定）。
 *
 * 变量供给函数（M7-T1 增量）：variables 允许传 () => Record 形式的供给函数，
 * 执行器在**每个节点**构建 templateContext 时调用一次取当前值——setVariable /
 * loop 节点经 RunVariableStore 写入的运行期变量对同运行的后续节点立即可见
 * （快照表在每次供给时重建）。传普通对象时行为与 M7-T2 完全一致（启动快照）。
 *
 * 环境注入（M10-T4 增量）：ExecutorOptions.env（当前激活环境集合的键值
 * **快照**——运行开始时由调用方定格，运行中切换环境不影响进行中的运行）
 * 存在时并入每个节点的 templateContext.env，模板 `{{ env.<key>.<path> }}`
 * 即可引用；未传时模板上下文保持既有形状（env 引用按「环境变量不存在」
 * 告警渲染为空，见 template.ts）。M10-T4 时环境表是纯读取快照（运行期无写入方），
 * 不需要 variables 那样的供给函数形态；M14-T3 起脚本可写回 env（运行快照立即
 * 更新），env 故同样支持供给函数形态（逐节点取当前值，写回对下游节点可见），
 * 普通对象保持启动快照语义。
 *
 * 下游选择扩展点（M7-T1 增量）：ExecutorOptions.selectDownstream 存在时，
 * 某节点结算后调度下游前先经其过滤——返回 'all' 表示照常调度全部直接下游
 * （等价于未注册），返回 NodeId 数组则只调度其中的 target（数组未含的下游
 * 保持 pending，收尾统一 skipped；若其后续被其它成功路径激活仍会正常执行，
 * enqueued 集合只防重复入队、不阻塞后续调度）。选择器仅影响「调度哪些下游」，
 * 不改变 join 语义（isRunnable 门槛照旧）；未注册时所有下游照常执行（既有
 * 行为不变，有测试锁定）。
 *
 * 嵌套运行快照（M7-T1 增量）：ExecutorOptions.nestedNodeRun 存在时，收尾
 * 阶段 pending 节点先经其解析——循环（loop）节点在 runner 内以子运行逐轮
 * 执行循环体，循环体节点在本层调度器中从未入队；收尾时经本扩展点取回
 * 「最后一轮」的执行快照代替统一 skipped 标记（NodeRun 的快照语义 =
 * 节点最后一次执行，见 types/model.ts）。未提供 / 解析为 undefined 时行为
 * 与既有完全一致（标 skipped）。
 *
 * 固定输出（M10-T5 增量，pinned data）：ExecutorOptions.pinnedOutputs 按
 * 节点 id 给出固定值——队列**出队时**命中的节点不调用 runner，立即按
 * success 结算（output = 固定值、durationMs 0、input 照常聚合），下游照常
 * 调度（n8n 式：固定某节点输出便于迭代下游，上游不再重复消耗）。join 语义
 * 不变（固定节点仍要等上游结算才入队——上游链路本身也固定时逐级瞬时结算）。
 * 值为 undefined 的键不视为固定（hasOwnProperty 判定，null 是合法固定值）。
 *
 * 指定节点重跑（M10-T5 增量，resume）：ExecutorOptions.resume 存在时从
 * fromNode 起跑——其全部传递上游（上游闭包，computeUpstreamClosure）不执行，
 * 以 resume.outputs 预置输出、resume.nodeRuns 预置快照（沿用源运行的入参 /
 * 返回值，保留调试信息）；fromNode 及其下游闭包照常执行；与 fromNode 无
 * 连通关系的旁支节点收尾统一 skipped（重跑语义 = 只重跑该节点所在的下游
 * 分支）。预置阶段发现闭包内任一上游缺输出（源运行中失败 / 跳过 / 缺失）→
 * 整次运行在建档前判 failed（错误信息逐个列出缺输出的节点 id），不启动任何
 * 节点——「半新半旧」的静默混合比直接失败更难排查。
 *
 * 节点快照附加字段（M13-T9 增量，snapshotExtras）：NodeRunContext.snapshotExtras
 * 存在时（runner 执行期间写入），该节点结算（success / failed）的 NodeRun 快照
 * 原样并入其中字段——当前唯一写入方为 loop runner 的逐迭代明细与进度
 * （NodeRun.iterations，见 types/model.ts 的 LoopIterationsSummary）。未写入时
 * 结算快照与既有形状逐字段一致（向后兼容，既有测试锁定）。
 */

import { asRunId } from "./types";
import type {
  NodeFailPolicy,
  NodeId,
  NodeRun,
  NodeRunStatus,
  RunId,
  RunRecord,
  RunStatus,
  RunTrigger,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "./types";
import type { RenderContext } from "./template";
import type { CancelSignal } from "./cancel-signal";
import { hostRandomUuid, hostSetTimeout, hostClearTimeout } from "./host-env";

/* ------------------------------------------------------------------ *
 * runId 生成
 * ------------------------------------------------------------------ */

/** id 生成器：返回全局唯一字符串（可注入以便测试确定性） */
export type IdGenerator = () => string;

/**
 * 默认 id 生成器（宿主注入点）：归档为 crypto.randomUUID 包装；QuickJS 无
 * crypto 全局，改走 host-env 的注入链（注入实现 → globalThis.crypto.randomUUID
 * → 纯 JS 随机回退），Node / 浏览器单测环境行为不变。
 */
export const defaultGenerateId: IdGenerator = () => hostRandomUuid();

/**
 * 生成一次运行的 runId。
 *
 * @param gen 可选注入的生成器；缺省用 crypto.randomUUID
 * @returns 品牌化的 RunId
 */
export function createRunId(gen?: IdGenerator): RunId {
  return asRunId((gen ?? defaultGenerateId)());
}

/* ------------------------------------------------------------------ *
 * 状态机（纯状态机，可独立测试）
 * ------------------------------------------------------------------ */

/** 节点执行视角的完整状态集：NodeRunStatus 之外补充「尚未开始」的 pending */
export type NodeExecutionStatus = NodeRunStatus | "pending";

/**
 * run 级状态迁移表：running → success | failed | cancelled，终态不可迁出。
 * 键为源状态，值为允许的目标状态列表。
 *
 * M9-T4 说明——'interrupted'（运行中断）**刻意不作为本表键**：它是落库专有
 * 终态，由 SW 启动时的孤儿扫描（background/run-recovery.ts）直接 patch
 * IndexedDB 记录完成 running → interrupted，不经内存状态机；执行器自身从不
 * 产生该迁移。索引签名保证 RunStatus 全域可查：查不到的源状态按「无合法
 * 目标」处理（assertRunTransition / finished 已对缺键做空表兜底）。
 * 断点续跑列二期，不做。
 */
export interface RunStatusTransitionTable {
  running: readonly RunStatus[];
  success: readonly RunStatus[];
  failed: readonly RunStatus[];
  cancelled: readonly RunStatus[];
  [status: string]: readonly RunStatus[];
}

export const RUN_STATUS_TRANSITIONS: Readonly<RunStatusTransitionTable> = {
  running: ["success", "failed", "cancelled"],
  success: [],
  failed: [],
  cancelled: [],
};

/**
 * 节点级状态迁移表：pending → running → success | failed | skipped。
 * - pending → skipped：前序失败 / 取消后，尚未执行的节点直接标记 skipped；
 * - running → skipped：为未来「取消时中断在跑节点」类策略预留，当前执行器不使用；
 * - success / failed / skipped 为终态，不可迁出。
 */
export const NODE_STATUS_TRANSITIONS: Readonly<
  Record<NodeExecutionStatus, readonly NodeExecutionStatus[]>
> = {
  pending: ["running", "skipped"],
  running: ["success", "failed", "skipped"],
  success: [],
  failed: [],
  skipped: [],
};

/** 状态迁移非法时抛出的错误（携带源 / 目标状态与迁移类别） */
export class IllegalTransitionError extends Error {
  constructor(
    /** 迁移类别：'run' | 'node' */
    public readonly kind: "run" | "node",
    public readonly from: string,
    public readonly to: string,
  ) {
    const label = kind === "run" ? "运行状态" : "节点状态";
    super(`非法的${label}迁移：${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * 校验一次 run 级状态迁移，非法则抛 IllegalTransitionError。
 * 源状态缺键（M9-T4 的 'interrupted' 不是迁移表键）按空目标表处理——
 * 自 'interrupted' 出发的任何迁移都非法（终态不可迁出）。
 */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!(RUN_STATUS_TRANSITIONS[from] ?? []).includes(to)) {
    throw new IllegalTransitionError("run", from, to);
  }
}

/** 校验一次节点级状态迁移，非法则抛 IllegalTransitionError */
export function assertNodeTransition(from: NodeExecutionStatus, to: NodeExecutionStatus): void {
  if (!NODE_STATUS_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError("node", from, to);
  }
}

/** run 级状态机：持有当前状态并做迁移校验（默认从 running 起步） */
export class RunStatusMachine {
  #status: RunStatus;

  constructor(initial: RunStatus = "running") {
    this.#status = initial;
  }

  /** 当前状态 */
  get status(): RunStatus {
    return this.#status;
  }

  /**
   * 是否已进入终态（success / failed / cancelled / interrupted）。
   * 'interrupted' 不是迁移表键（见 RUN_STATUS_TRANSITIONS 说明），按空目标表
   * 兜底——以中断态起步的机器同样视为已终结。
   */
  get finished(): boolean {
    return (RUN_STATUS_TRANSITIONS[this.#status] ?? []).length === 0;
  }

  /**
   * 迁移到目标状态。
   * @returns 目标状态（便于链式记录）
   * @throws IllegalTransitionError 迁移不在迁移表内时
   */
  transition(next: RunStatus): RunStatus {
    assertRunTransition(this.#status, next);
    this.#status = next;
    return next;
  }
}

/** 节点级状态机：持有当前状态并做迁移校验（默认从 pending 起步） */
export class NodeStatusMachine {
  #status: NodeExecutionStatus = "pending";

  /** 当前状态 */
  get status(): NodeExecutionStatus {
    return this.#status;
  }

  /** 是否已执行完毕（success / failed）或被跳过（skipped），即不再是 pending */
  get settled(): boolean {
    return this.#status !== "pending";
  }

  /**
   * 迁移到目标状态。
   * @returns 目标状态
   * @throws IllegalTransitionError 迁移不在迁移表内时
   */
  transition(next: NodeExecutionStatus): NodeExecutionStatus {
    assertNodeTransition(this.#status, next);
    this.#status = next;
    return next;
  }
}

/* ------------------------------------------------------------------ *
 * 图校验（最小校验）
 * ------------------------------------------------------------------ */

/**
 * 校验工作流图（执行前置检查，最小集合）：
 *   - start 节点至少一个（多 start 已合法：多入口工作流，运行时由
 *     entryNodeId 指定入口，歧义在 executeWorkflow 里判 failed）；
 *   - 连线引用的 source / target 节点必须存在（无未知引用连线）；
 *   - 连线不触及 stickyNote 便签节点（M13-T5：便签是纯注释卡、不可连线——
 *     UI 侧无手柄连不上，此处拦手工构造 / 污染数据，避免下游节点 join 时
 *     等待一个永不执行的便签而被静默 skipped）；
 *   - 节点 id 不重复（执行器内部以 id 建索引，重复会导致状态串位）。
 *
 * @param nodes 画布节点列表
 * @param edges 画布连线列表
 * @returns 错误信息列表；为空数组表示图合法
 */
export function validateWorkflowGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): string[] {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`存在重复的节点 id：${node.id}`);
      continue;
    }
    nodeIds.add(node.id);
  }

  // M15-T2：引用短码 refId 流程内唯一——多上游聚合入参与模板上下文的 node 键
  // 均以 refId（缺省回退 id）为键，重复即解析歧义，与重复 id 同级判非法。
  // 格式（5 位字母）不在执行侧校验：格式不合格不影响按 token 解析，由 UI
  // 校验徽标提示修正
  const refKeys = new Set<string>();
  for (const node of nodes) {
    // 缺失 / 空串按「无短码」处理（与 UI 校验同口径：读取侧回退内部 id）
    if (typeof node.refId !== "string" || node.refId === "") continue;
    if (refKeys.has(node.refId)) {
      errors.push(`存在重复的节点引用短码 refId：${node.refId}`);
      continue;
    }
    refKeys.add(node.refId);
  }

  // 多 start 已合法（多入口工作流）：0 个仍为错误；>1 个由 executeWorkflow
  // 按 entryNodeId 解析入口，未指定入口时在建档前判 failed（入口歧义防御）。
  const startCount = nodes.filter((node) => node.type === "start").length;
  if (startCount === 0) errors.push("缺少开始节点");

  // M13-T5：stickyNote（便签）不入执行拓扑——触及便签的连线一律判非法
  //（与「连线引用不存在的节点」同级 error，fail-fast 暴露脏数据而非静默跳过）
  const stickyIds = new Set(
    nodes.filter((node) => node.type === "stickyNote").map((node) => node.id),
  );
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`连线 ${edge.id} 引用了不存在的源节点：${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`连线 ${edge.id} 引用了不存在的目标节点：${edge.target}`);
    }
    if (stickyIds.has(edge.source) || stickyIds.has(edge.target)) {
      errors.push(
        `连线 ${edge.id} 连接了便签节点：便签不参与连线（${edge.source} → ${edge.target}）`,
      );
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ *
 * input 聚合与模板上下文
 * ------------------------------------------------------------------ */

/**
 * 聚合节点的直接上游输出为该节点的 input（纯函数）：
 *   - 无上游（非 start 节点没有入边，或 start 节点）→ null；
 *   - 单一直接上游 → 上游 output 原样透传（保持引用，不做包装）；
 *   - 多个直接上游 → `{ [<refId>]: output }` 聚合对象（浅拷贝，键序同传入序；
 *     M15-T2 起键为上游节点的引用短码 refId，缺省回退内部 id）。
 *
 * @param upstreamOutputs 直接上游节点输出表（键为模板引用键 refId ?? id；由调用方按连线收集）
 * @returns 聚合后的 input
 */
export function aggregateInputs(upstreamOutputs: Record<string, unknown>): unknown {
  const ids = Object.keys(upstreamOutputs);
  if (ids.length === 0) return null;
  if (ids.length === 1) return upstreamOutputs[ids[0]];
  return { ...upstreamOutputs };
}

/**
 * 构建当前节点的模板渲染上下文（模板约定，供 runner 内配合
 * renderTemplate / renderValueDeep 使用；M5-T2 请求重放渲染参数即用它）：
 *   `{ node: { <nodeId>: <output> }, input: <当前节点 input> }`
 *
 * M7-T2 增量：传入 variables（三层作用域合并后的运行期变量表）时附上
 * `var` 键（浅拷贝，模板 `{{ var.<name>.<path> }}` 的数据源）；未传时
 * 保持 M5-T1 既有形状 `{ node, input }` 不变（既有测试锁定）。
 *
 * @param nodeOutputs 已完成节点的输出表（键为节点 id）
 * @param input 当前节点聚合后的入参
 * @param variables 运行期变量表（可选；M7-T2）
 * @param env 环境变量快照（可选；M10-T4）
 * @param storage 工作流存储快照（可选；`{{ storage.<key> }}` 数据源）
 * @returns RenderContext（node / var 均为浅拷贝，调用方改动不影响原表）
 */
export function buildTemplateContext(
  nodeOutputs: Record<string, unknown>,
  input: unknown = null,
  variables?: Record<string, unknown>,
  env?: Record<string, unknown>,
  storage?: Record<string, unknown>,
): RenderContext {
  const context: RenderContext = { node: { ...nodeOutputs }, input };
  if (variables !== undefined) {
    context.var = { ...variables };
  }
  // M10-T4：env 存在时并入 templateContext.env（浅拷贝；未传保持既有形状，
  // 模板 `{{ env.<key>.<path> }}` 的数据源——运行开始时定格的环境快照）
  if (env !== undefined) {
    context.env = { ...env };
  }
  // 工作流存储快照存在时并入 templateContext.storage（浅拷贝；模板
  // `{{ storage.<key>.<path> }}` 的数据源——镜像快照，host.storage 读写可见）
  if (storage !== undefined) {
    context.storage = { ...storage };
  }
  return context;
}

/* ------------------------------------------------------------------ *
 * 节点运行器扩展点
 * ------------------------------------------------------------------ */

/** 传递给 runner 的节点级上下文（runCtx.nodeCtx） */
export interface NodeExecutionContext {
  /** 已完成节点的输出快照（键为模板引用键 refId ?? id，含当前节点全部已成功上游） */
  nodeOutputs: Record<string, unknown>;
  /** 当前节点的模板渲染上下文（buildTemplateContext 产物：{ node, input }） */
  templateContext: RenderContext;
  /**
   * 节点内部 id → 模板引用键解析（M15-T2，可选）：nodeOutputs 以 refId（缺省
   * 回退 id）为键，runner 手持内部 id 定位输出表（如 setVariable 赋值项
   * from='node'）时经此换算。缺省（旧装配 / 测试直构上下文）时按原样查找，
   * 行为与既有逐字节一致。
   */
  refKeyOf?: (nodeId: NodeId) => string;
}

/** runner 运行上下文：节点执行期间可用的环境信息 */
export interface NodeRunContext {
  /** 本次运行 id（便于 runner 侧日志 / 记录关联） */
  runId: RunId;
  /**
   * 取消信号；runner 应在协作点检查并在取消时尽快返回或抛错。
   * 【宿主注入点替换】归档为 DOM AbortSignal；载荷按结构子集
   * CancelSignal（cancel-signal.ts）依赖——真实 AbortSignal 结构兼容、
   * QuickJS 侧由 createCancelSource 提供等价物。
   */
  signal?: CancelSignal;
  /** 节点级上下文（输出快照 + 模板渲染上下文） */
  nodeCtx: NodeExecutionContext;
  /**
   * 节点快照附加字段槽（M13-T9，可选）：runner 执行期间写入、执行器在该节点
   * 结算（success / failed）时**原样并入** NodeRun 快照的扩展字段。当前唯一
   * 写入方为 loop runner（逐迭代明细与进度，见 types/model.ts 的
   * LoopIterationsSummary）；未提供 / 未写入时结算行为与既有完全一致（快照
   * 零变化，既有测试锁定）。写入时机不限（执行器在 runner settle 后读取）；
   * 重试场景（loop / delay 不参与重试）以后一次写入为准。
   */
  snapshotExtras?: Pick<NodeRun, "iterations">;
}

/**
 * 节点运行器：某种节点类型的具体执行逻辑（扩展点）。
 * 约定全部 Promise 基；超时控制 / signal 响应由 runner 实现者负责（M5-T2）。
 * 抛错（或 reject）视为该节点 failed。
 */
export type NodeRunner = (
  node: WorkflowNode,
  input: unknown,
  runCtx: NodeRunContext,
) => Promise<unknown>;

/** start 节点内置 runner：纯编排起点，no-op，输出固定为 null */
export const startNodeRunner: NodeRunner = async () => null;

/* ------------------------------------------------------------------ *
 * 运行摘要与落库外壳
 * ------------------------------------------------------------------ */

/** 一次运行的结束摘要：executeWorkflow 返回值与 onRunFinish 载荷（同一对象） */
export interface RunSummary {
  /** 本次运行 id */
  runId: RunId;
  /** 所属工作流 id */
  workflowId: Workflow["id"];
  /** 运行结果：图不合法 / 节点失败 → failed；取消 → cancelled；否则 success */
  status: RunStatus;
  /** 运行级错误摘要（failed / cancelled 时存在） */
  error?: string;
  /**
   * 按节点 id 索引的执行快照（覆盖工作流全部节点；图不合法时为空对象。
   * M13-T5 起例外：stickyNote 便签不入执行拓扑，运行记录中不含便签条目）。
   */
  nodeRuns: Record<NodeId, NodeRun>;
}

/** RunRecord 落库外壳：除 id / startedAt / finishedAt 外的全部字段（M5-T5 填充后者） */
export type RunRecordShell = Omit<RunRecord, "id" | "startedAt" | "finishedAt">;

/**
 * 从运行摘要构建落库外壳（不产生 id 与时间戳，落库是 M5-T5 的职责）。
 *
 * @param summary executeWorkflow 的返回摘要
 * @param trigger 触发方式，缺省 'manual'
 * @returns RunRecord 形状的外壳数据
 */
export function buildRunRecordShell(
  summary: RunSummary,
  trigger: RunTrigger = "manual",
): RunRecordShell {
  const shell: RunRecordShell = {
    workflowId: summary.workflowId,
    status: summary.status,
    trigger,
    nodeRuns: summary.nodeRuns,
  };
  if (summary.error !== undefined) shell.error = summary.error;
  return shell;
}

/* ------------------------------------------------------------------ *
 * 执行器选项与主流程
 * ------------------------------------------------------------------ */

/** 下游选择结果：'all' = 全部直接下游照常调度；数组 = 只调度其中的 target */
export type DownstreamSelection = readonly NodeId[] | "all";

/** 执行器选项（全部可选； runners 按节点类型注册） */
export interface ExecutorOptions {
  /** 按节点类型注册的运行器；未注册类型的节点按 failed 处理（见 defaultRunner） */
  runners?: Partial<Record<WorkflowNodeType, NodeRunner>>;
  /** 未注册类型的兜底运行器（优先级低于 runners 与 start 内置 runner） */
  defaultRunner?: NodeRunner;
  /** runId 生成器（缺省 crypto.randomUUID 包装） */
  generateId?: IdGenerator;
  /**
   * 取消信号（可选）；触发后当前节点完成即停，剩余节点 skipped，run = cancelled。
   * 【宿主注入点替换】类型为 CancelSignal 结构子集（DOM AbortSignal 亦兼容）。
   */
  signal?: CancelSignal;
  /**
   * 【M5-T1 遗留占位，保留兼容】仅接受 'stop'（缺省）；传 'continue' 仍按 M5-T1
   * 契约抛错（既有测试锁定该行为，M5-T4 的 continue 语义经由
   * node.config.failPolicy 与 defaultFailPolicy 提供，不走本参数）。
   */
  failPolicy?: NodeFailPolicy;
  /**
   * 工作流级默认失败策略（M5-T4）：节点未在 config.failPolicy 显式指定时生效，
   * 读取层级 node.config.failPolicy ?? defaultFailPolicy ?? 'stop'（节点级优先）。
   * 无效值按 'stop' 兜底（宽容处理，消息层的拒绝是 run-controller 的职责）。
   */
  defaultFailPolicy?: NodeFailPolicy;
  /**
   * 运行期变量表（M7-T2，可选）：三层作用域（工作流级 / 项目级 / 全局级）
   * 合并后的初始变量，注入每个节点的 templateContext.var 供模板
   * `{{ var.<name>.<path> }}` 引用；缺省不注入（模板上下文保持既有形状）。
   *
   * M7-T1 增量：允许传供给函数 () => Record——执行器在**每个节点**构建
   * templateContext 时调用一次取当前值，setVariable / loop 节点经
   * RunVariableStore 的运行期写入对后续节点立即可见；传普通对象时保持
   * M7-T2 的启动快照语义。
   */
  variables?: Record<string, unknown> | (() => Record<string, unknown>);
  /**
   * 环境变量表（M10-T4，可选）：当前激活环境集合的键值快照（运行开始时由
   * 调用方定格——运行中切换激活环境对进行中的运行不生效），注入每个节点的
   * templateContext.env 供模板 `{{ env.<key>.<path> }}` 引用；缺省不注入
   * （模板上下文保持既有形状）。
   *
   * M14-T3 增量：允许传供给函数 () => Record——执行器在**每个节点**构建
   * templateContext 时调用一次取当前值。背景：脚本对 env 的写回（M14-T3）
   * 使运行期出现写入方（运行快照立即更新供下游节点引用），供给函数形态让
   * 写回对同运行的后续节点立即可见；传普通对象时保持 M10-T4 的启动快照语义
   * （既有行为不变，既有测试锁定）。
   */
  env?: Record<string, unknown> | (() => Record<string, unknown>);
  /**
   * 工作流存储快照（可选）：工作流级持久化 KV 的键值表，注入每个节点的
   * templateContext.storage 供模板 `{{ storage.<key>.<path> }}` 引用；缺省
   * 不注入（模板上下文保持既有形状）。
   *
   * 形态与 env 一致（快照对象或供给函数）：runWorkflow 以「镜像快照供给函数」
   * 注入——镜像在运行开始时以派发快照播种，脚本经 host.storage 的读写（引擎
   * 侧包装同步维护镜像）对后续节点的模板立即可见；传普通对象时保持派发快照
   * 语义（既有行为不变）。
   */
  storage?: Record<string, unknown> | (() => Record<string, unknown>);
  /**
   * 下游选择扩展点（M7-T1，可选）：某节点结算后、调度其直接下游前调用
   * （参数为该节点与其 output；失败节点的 output 为 null）。返回 'all' 照常
   * 调度全部下游；返回 NodeId 数组只调度其中的 target（未含者保持 pending，
   * 收尾统一 skipped，除非后续被其它成功路径激活）。选择器抛错视为本次运行
   * 异常（向上冒泡，由宿主兜底），本层不做静默降级。未注册时全部下游照常
   * 调度（既有行为，有测试锁定）。
   */
  selectDownstream?: (node: WorkflowNode, output: unknown) => DownstreamSelection;
  /**
   * 嵌套运行快照解析（M7-T1，可选）：收尾阶段对仍为 pending 的节点先经本
   * 函数解析——loop 节点的循环体在 runner 侧子运行中逐轮执行、本层从未入队，
   * 宿主经此扩展点交回「最后一轮」快照代替统一 skipped 标记（快照语义 =
   * 节点最后一次执行）。返回 undefined 时该节点照旧标 skipped。
   */
  nestedNodeRun?: (node: WorkflowNode) => NodeRun | undefined;
  /**
   * 固定输出表（M10-T5，可选）：键为节点 id，值为该节点的固定输出——出队
   * 命中的节点不执行 runner，按 success 直接结算（output = 固定值）。
   * 通常由 run-controller 从 workflow.nodes 的 config.pinnedOutput 投影而来；
   * 值为 undefined 的键不视为固定（null 是合法固定值）。
   */
  pinnedOutputs?: Partial<Record<NodeId, unknown>>;
  /**
   * 指定节点重跑（M10-T5，可选）：fromNode = 重跑起点（必须存在于图）；
   * outputs / nodeRuns = 源运行中上游闭包节点的输出与执行快照（执行器不做
   * 完整性兜底——调用方（run-controller）预检后传入，闭包内缺输出的上游按
   * 预置表缺失处理并使本次运行在建档前判 failed，见文件头「指定节点重跑」）。
   */
  resume?: {
    /** 重跑起点节点 id */
    fromNode: NodeId;
    /** 上游闭包节点的输出表（键为节点 id） */
    outputs: Record<NodeId, unknown>;
    /** 上游闭包节点的执行快照（沿用源运行，保留入参 / 返回值调试信息） */
    nodeRuns: Record<NodeId, NodeRun>;
  };
  /**
   * 入口选择（多 start 工作流，可选）：指定从哪个 start 节点进入执行——
   * 必须存在于图且 type 为 'start'，否则本次运行在建档前判 failed（不启动
   * 任何节点）；未指定且图恰有一个 start 时取该 start；未指定且存在多个
   * start 时属入口歧义，建档前判 failed（错误列出全部 start id）。未选中
   * 的 start 链条不入队，收尾统一 skipped（与不可达节点同语义）。
   */
  entryNodeId?: NodeId;
  /**
   * 全局最大节点并发（M15-T6，可选）：主循环就绪集快照批量并发时，单批同时
   * 执行的节点数上限；缺省 DEFAULT_MAX_NODE_CONCURRENCY（4）。非有限值 / <1
   * 一律回退缺省（宽容兜底）。只约束本层主循环的调度粒度；循环节点内部的
   * 迭代并发（M10-T6）由 loop runner 自管，不受本值影响。
   */
  maxNodeConcurrency?: number;
  /** 事件：某节点即将开始执行（已聚合 input） */
  onNodeStart?: (node: WorkflowNode, input: unknown) => void;
  /** 事件：某节点执行完毕（success / failed；skipped 节点不发出） */
  onNodeFinish?: (node: WorkflowNode, nodeRun: NodeRun) => void;
  /** 事件：整次运行结束（载荷与返回值同一对象） */
  onRunFinish?: (summary: RunSummary) => void;
}

/** 执行入参：只需工作流的 id / 节点 / 连线三部分 */
export type ExecutableWorkflow = Pick<Workflow, "id" | "nodes" | "edges">;

/** skipped 节点的执行快照：未真正执行，input / output 为 null，无耗时 */
const SKIPPED_NODE_RUN: () => NodeRun = () => ({
  status: "skipped",
  input: null,
  output: null,
  startedAt: 0,
  durationMs: 0,
});

/** 把任意抛出的值转成错误信息字符串 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 解析某节点应使用的 runner：
 * 显式注册的 runners[type] 优先；start 节点回退到内置 no-op runner；
 * 其余类型回退到 defaultRunner；仍无则返回 undefined（按 failed 处理）。
 *
 * M13-T5：stickyNote（便签）**刻意不注册 runner**——纯注释卡不入执行拓扑，
 * 正常数据下不可连线、从 start 不可达，永远不会走到本函数；万一被脏数据
 * 连线入队（执行前置校验已拦截），按 failed 暴露问题而非静默执行。
 */
function resolveRunner(node: WorkflowNode, options: ExecutorOptions): NodeRunner | undefined {
  const explicit = options.runners?.[node.type];
  if (explicit) return explicit;
  if (node.type === "start") return startNodeRunner;
  return options.defaultRunner;
}

/** 解析执行器选项为规范化策略值：仅 'continue' 生效，其余（含无效值）一律 'stop' */
function normalizeFailPolicy(value: NodeFailPolicy | undefined): NodeFailPolicy {
  return value === "continue" ? "continue" : "stop";
}

/** 全局最大节点并发缺省值（M15-T6）：ExecutorOptions.maxNodeConcurrency 未传 / 无效时的兜底 */
export const DEFAULT_MAX_NODE_CONCURRENCY = 4;

/** 规范化最大节点并发：非有限值 / <1 回退缺省，其余向下取整（1 = 退化为串行） */
function normalizeMaxNodeConcurrency(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_NODE_CONCURRENCY;
  }
  return Math.floor(value);
}

/**
 * 解析某节点的生效失败策略（M5-T4 读取层级，节点级优先）：
 * node.config.failPolicy ?? options.defaultFailPolicy ?? 'stop'；
 * 无效值按 'stop' 兜底（宽容处理，消息层负责拒绝非法配置）。
 */
function resolveNodeFailPolicy(node: WorkflowNode, defaultPolicy: NodeFailPolicy): NodeFailPolicy {
  const configured = node.config.failPolicy;
  if (configured === "stop" || configured === "continue") return configured;
  return defaultPolicy;
}

/**
 * 批内槽位（M15-T6 内部）：launch 期登记节点的前置上下文与 runner 承诺，
 * 结算由 launch 期挂接的捕获回调就地写入（回调先于主循环恢复执行——同一
 * promise 上先挂先调），批后主循环按入队序统一记录与调度。
 */
interface BatchSlot {
  /** 本槽节点 */
  node: WorkflowNode;
  /** 节点状态机（批后记录时迁移 success / failed） */
  machine: NodeStatusMachine;
  /** 入队时聚合的 input（起跑事件与快照共用） */
  input: unknown;
  /** 起跑时间戳（快照 startedAt 与耗时基准） */
  startedAt: number;
  /** 节点运行上下文（runner 写入 snapshotExtras，批后记录时读取） */
  runContext: NodeRunContext;
  /**
   * runner 承诺（runWithRetry 产物，拒绝 = 节点失败）。pinned / 缺 runner 的
   * 槽位无承诺——前者 launch 期同步结算记录，后者按 failed 记录。
   */
  raw?: Promise<unknown>;
  /** 结算结果（捕获回调写入）：error 缺省 = 成功，output 为 runner 返回值 */
  output?: unknown;
  /** 结算时间戳（捕获回调写入；耗时计算不含批后等待） */
  settledAt?: number;
  /** 失败错误文本（捕获回调写入；undefined = 成功或尚未结算） */
  error?: string;
  /** 已在 launch 期完成记录（pinned 短路），批后记录跳过 */
  recorded?: boolean;
}

/**
 * Execute a runner with bounded exponential retry and abort-aware backoff waits.
 */
async function runWithRetry(
  runner: NodeRunner,
  node: WorkflowNode,
  input: unknown,
  context: Parameters<NodeRunner>[2],
): Promise<unknown> {
  if (node.type === "loop" || node.type === "delay") return runner(node, input, context);
  const retry = node.config.retry;
  const attempts =
    retry && Number.isFinite(retry.maxAttempts) && retry.maxAttempts >= 1
      ? Math.min(5, Math.floor(retry.maxAttempts))
      : 1;
  const base =
    retry && Number.isFinite(retry.backoffMs) && retry.backoffMs > 0
      ? Math.min(30_000, Math.floor(retry.backoffMs))
      : 0;
  const rawMultiplier = retry?.multiplier;
  const multiplier =
    typeof rawMultiplier === "number" && Number.isFinite(rawMultiplier) && rawMultiplier >= 1
      ? Math.min(4, rawMultiplier)
      : 2;
  for (let attempt = 1; ; attempt++) {
    try {
      return await runner(node, input, context);
    } catch (error) {
      if (attempt >= attempts || context.signal?.aborted) throw error;
      const waitMs = Math.min(30_000, base * multiplier ** (attempt - 1));
      if (waitMs <= 0) continue;
      await new Promise<void>((resolve, reject) => {
        // 【宿主注入点替换】归档直呼 setTimeout / clearTimeout；QuickJS 无该全局，
        // 改走 host-env 注入链（缺省 globalThis，QuickJS 载荷入口以 host.sleep 组装）
        const timer = hostSetTimeout(() => {
          context.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        const onAbort = (): void => {
          hostClearTimeout(timer);
          context.signal?.removeEventListener("abort", onAbort);
          reject(new Error("[cancelled] 重试等待被取消"));
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });
        if (context.signal?.aborted) onAbort();
      });
    }
  }
}

/** 收集某节点的直接上游输出表（键为上游节点的模板引用键 refId ?? id，键序同
 * 连线数组序，同源去重。M15-T2 起键从内部 id 切换为 refId——多上游聚合入参
 * 形状 `{ [<refId>]: output }`、模板 `{{ node.<refId> }}` 的数据源；上游无
 * refId（存量数据 / 测试直构节点）时回退内部 id，行为与既有逐字节一致）。
 * 只有**已成功**（输出表中有记录）的上游才进入聚合：失败上游按缺失处理
 * （M5-T4 continue 语义）；stop 策略下失败后不再调度任何节点，行为不变。 */
function collectUpstreamOutputs(
  nodeId: NodeId,
  edges: readonly WorkflowEdge[],
  outputs: ReadonlyMap<NodeId, unknown>,
  refKeyOf: (id: NodeId) => string,
): Record<string, unknown> {
  const upstream: Record<string, unknown> = {};
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    if (Object.prototype.hasOwnProperty.call(upstream, edge.source)) continue;
    if (!outputs.has(edge.source)) continue; // 失败 / 未执行上游：按缺失处理（无键）
    upstream[refKeyOf(edge.source)] = outputs.get(edge.source);
  }
  return upstream;
}

/**
 * 计算某节点的全部传递上游（上游闭包，M10-T5 指定节点重跑用，纯函数）：
 * 沿连线逆向广度优先遍历，返回能到达 fromNode 的全部节点 id（不含 fromNode
 * 本身；顺序为遍历序——按连线数组序扩展，确定性可测）。孤立边引用（端点不在
 * nodes 里，图校验未过的场景）自动忽略。
 *
 * @param nodes 画布节点列表（存在性判定）
 * @param edges 画布连线列表
 * @param fromNodeId 重跑起点节点 id
 * @returns 上游闭包节点 id 列表（可能为空：起点无上游 / 即 start 节点）
 */
export function computeUpstreamClosure(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  fromNodeId: NodeId,
): NodeId[] {
  const known = new Set<NodeId>(nodes.map((node) => node.id));
  /** 逆向邻接表：target → 直接上游列表（同源去重，保持连线数组序） */
  const reverse = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const list = reverse.get(edge.target);
    if (list === undefined) reverse.set(edge.target, [edge.source]);
    else if (!list.includes(edge.source)) list.push(edge.source);
  }
  const closure: NodeId[] = [];
  const seen = new Set<NodeId>([fromNodeId]);
  const frontier = [fromNodeId];
  while (frontier.length > 0) {
    const current = frontier.shift() as NodeId;
    for (const upstream of reverse.get(current) ?? []) {
      if (seen.has(upstream)) continue;
      seen.add(upstream);
      closure.push(upstream);
      frontier.push(upstream);
    }
  }
  return closure;
}

/**
 * 判断某节点的全部直接上游是否都已结算（join 语义门槛，M5-T4 放宽）：
 * success 照常计入；failed 上游在 continue 策略下也算已结算（下游仍执行）；
 * skipped 上游（入口不可达提前收编 / 收尾统一跳过）同样计入——该入边在
 * 聚合时按缺失处理（collectUpstreamOutputs 对无输出上游无键）。stop 策略下
 * 失败即停、不会再来调度，因此「已结算」与旧「全部 success」在 stop 路径上
 * 行为完全一致；pending / running（未结算）一律不可运行。
 */
function isRunnable(
  nodeId: NodeId,
  edges: readonly WorkflowEdge[],
  statuses: ReadonlyMap<NodeId, NodeStatusMachine>,
): boolean {
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const machine = statuses.get(edge.source);
    if (!machine) return false;
    if (machine.status !== "success" && machine.status !== "failed" && machine.status !== "skipped") {
      return false;
    }
  }
  return true;
}

/**
 * 执行一个工作流（串行 + FIFO 可运行队列，见文件头执行模型说明）。
 *
 * @param workflow 工作流的 id / nodes / edges
 * @param options 执行器选项（runners / signal / 事件回调等）
 * @returns 运行摘要（与 onRunFinish 载荷同一对象）
 * @throws Error 传入 M5-T1 遗留占位参数 options.failPolicy 且值非 'stop' 时
 *   （该行为被既有测试锁定；真正的失败策略见 defaultFailPolicy 与
 *   node.config.failPolicy，见文件头「失败策略」说明）
 */
export async function executeWorkflow(
  workflow: ExecutableWorkflow,
  options: ExecutorOptions = {},
): Promise<RunSummary> {
  // M5-T1 遗留占位参数：非 'stop' 一律抛错（保留既有契约；continue 走节点级 /
  // defaultFailPolicy，见文件头「失败策略」）
  const legacyFailPolicy = options.failPolicy;
  if (legacyFailPolicy !== undefined && legacyFailPolicy !== "stop") {
    throw new Error(
      `failPolicy "${legacyFailPolicy}" 尚未实现（'continue' 策略计划于 M5-T4 接入）`,
    );
  }
  const defaultFailPolicy = normalizeFailPolicy(options.defaultFailPolicy);

  const runId = createRunId(options.generateId);
  const signal = options.signal;

  // 图不合法：直接 failed，不启动任何节点（nodeRuns 保持空）
  const validationErrors = validateWorkflowGraph(workflow.nodes, workflow.edges);
  if (validationErrors.length > 0) {
    const summary: RunSummary = {
      runId,
      workflowId: workflow.id,
      status: "failed",
      error: validationErrors.join("；"),
      nodeRuns: {},
    };
    options.onRunFinish?.(summary);
    return summary;
  }

  /** 每个节点的状态机（图已合法：start 至少一个，入口已解析） */
  const statuses = new Map<NodeId, NodeStatusMachine>();
  /** 已完成（success / failed）与已跳过（skipped）节点的执行快照 */
  const nodeRuns = new Map<NodeId, NodeRun>();
  /** success 节点的输出表（input 聚合与模板上下文的数据源） */
  const outputs = new Map<NodeId, unknown>();
  /** 节点 id → 节点对象（队列入队时取用） */
  const nodeById = new Map<NodeId, WorkflowNode>();
  for (const node of workflow.nodes) {
    statuses.set(node.id, new NodeStatusMachine());
    nodeById.set(node.id, node);
  }

  /**
   * 节点内部 id → 模板引用键（M15-T2）：优先 refId 短码，缺省（存量数据 /
   * 测试直构节点无 refId）回退内部 id——聚合入参 / 模板上下文的 node 键由此
   * 统一换算，既有用例零改动。
   */
  const refKeyOf = (id: NodeId): string => nodeById.get(id)?.refId ?? id;

  // 入口解析（多 start 工作流）：entryNodeId 显式指定 → 必须是图内的 start
  // 节点；未指定时恰一个 start 取之，多个 start 属入口歧义——建档前判
  // failed（错误列出全部 start id），不启动任何节点。未选中的 start 链条
  // 不入队，收尾统一 skipped（与不可达节点同语义）。
  const startNodes = workflow.nodes.filter((node) => node.type === "start");
  let entryNode: WorkflowNode;
  if (options.entryNodeId !== undefined) {
    const matched = workflow.nodes.find(
      (node) => node.id === options.entryNodeId && node.type === "start",
    );
    if (matched === undefined) {
      const summary: RunSummary = {
        runId,
        workflowId: workflow.id,
        status: "failed",
        error: `入口节点不存在或不是开始节点：${options.entryNodeId}`,
        nodeRuns: {},
      };
      options.onRunFinish?.(summary);
      return summary;
    }
    entryNode = matched;
  } else if (startNodes.length > 1) {
    const summary: RunSummary = {
      runId,
      workflowId: workflow.id,
      status: "failed",
      error: `存在多个开始节点（${startNodes.length} 个），需指定入口 entryNodeId：${startNodes
        .map((node) => node.id)
        .join("、")}`,
      nodeRuns: {},
    };
    options.onRunFinish?.(summary);
    return summary;
  } else {
    entryNode = startNodes[0]!;
  }
  let queue: WorkflowNode[] = [entryNode];
  /** 已入队（含已执行）节点集合：保证每节点至多执行一次（环 / 重复边安全） */
  let enqueued = new Set<NodeId>([entryNode.id]);

  /**
   * 指定节点重跑预置（M10-T5）：上游闭包不执行——以 resume.outputs 预置输出、
   * resume.nodeRuns 预置快照（沿用源运行的入参 / 返回值）；起跑队列改为
   * fromNode（其下游闭包照常执行；无连通关系的旁支收尾统一 skipped）。
   * 闭包内任一上游缺输出（源运行中失败 / 跳过 / 缺失）→ 建档前整单判 failed
   * （错误逐个列出），不启动任何节点——见文件头「指定节点重跑」。
   */
  const resume = options.resume;
  if (resume !== undefined) {
    const fromNode = workflow.nodes.find((node) => node.id === resume.fromNode);
    if (fromNode === undefined) {
      const summary: RunSummary = {
        runId,
        workflowId: workflow.id,
        status: "failed",
        error: `重跑起点节点不存在于当前流程：${resume.fromNode}（流程可能在源运行后已改版）`,
        nodeRuns: {},
      };
      options.onRunFinish?.(summary);
      return summary;
    }
    const closure = computeUpstreamClosure(workflow.nodes, workflow.edges, resume.fromNode);
    const missing = closure.filter(
      (id) => !Object.prototype.hasOwnProperty.call(resume.outputs, id),
    );
    if (missing.length > 0) {
      const summary: RunSummary = {
        runId,
        workflowId: workflow.id,
        status: "failed",
        error: `上游节点在源运行中无成功输出，无法从 ${resume.fromNode} 重跑：${missing.join("、")}`,
        nodeRuns: {},
      };
      options.onRunFinish?.(summary);
      return summary;
    }
    for (const id of closure) {
      const machine = statuses.get(id) as NodeStatusMachine;
      // 预置节点的状态机路径：pending → running → success（合法迁移链）
      machine.transition("running");
      machine.transition("success");
      const output = resume.outputs[id];
      outputs.set(id, output);
      const snapshot = resume.nodeRuns[id];
      nodeRuns.set(
        id,
        snapshot ?? {
          status: "success",
          input: null,
          output,
          startedAt: Date.now(),
          durationMs: 0,
        },
      );
    }
    queue = [fromNode];
    enqueued = new Set<NodeId>([resume.fromNode, ...closure]);
  }

  // 入口不可达节点提前收编（多 start 工作流的 join 解锁）：未被选中入口的
  // 链条不再等待收尾统一 skipped，而是在调度前即标 skipped（settled）——
  // 多入口链条汇合到同一后继时，join 节点的「全部直接上游结算」门槛才会在
  // 单入口运行下释放（skipped 也是结算态）。resume 预置的闭包节点不在可达
  // 集内，但已按源运行预置 success，不参与本次跳过。
  const originId = queue[0]!.id;
  const adjacency = new Map<NodeId, NodeId[]>();
  for (const edge of workflow.edges) {
    const targets = adjacency.get(edge.source);
    if (targets) targets.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);
  }
  const reachable = new Set<NodeId>([originId]);
  // for...of Set 迭代会访问遍历期间新增的项（BFS 队列语义）。
  for (const cursor of reachable) {
    for (const target of adjacency.get(cursor) ?? []) {
      if (!reachable.has(target)) reachable.add(target);
    }
  }
  const presetClosure =
    resume !== undefined
      ? computeUpstreamClosure(workflow.nodes, workflow.edges, resume.fromNode)
      : undefined;
  for (const node of workflow.nodes) {
    if (reachable.has(node.id)) continue;
    if (presetClosure !== undefined && presetClosure.includes(node.id)) continue;
    // 便签不入执行拓扑（M13-T5）：运行记录中不出现便签条目（与收尾口径一致）。
    if (node.type === "stickyNote") continue;
    const machine = statuses.get(node.id) as NodeStatusMachine;
    machine.transition("skipped");
    nodeRuns.set(node.id, SKIPPED_NODE_RUN());
  }

  /** 第一个失败节点的 run 级错误摘要（continue 策略下后续失败只记在节点快照） */
  let failureError: string | undefined;
  let cancelled = false;

  /**
   * 解析当前节点的运行期变量表（M7-T1）：variables 为供给函数时逐节点调用取
   * 当前值（运行期写入对后续节点可见）；普通对象 / 未传时原样返回（M7-T2
   * 快照语义 / 既有「不注入」行为不变）。
   */
  const resolveVariables = (): Record<string, unknown> | undefined => {
    const raw = options.variables;
    return typeof raw === "function" ? raw() : raw;
  };

  /**
   * 解析当前节点的环境快照（M14-T3）：env 为供给函数时逐节点调用取当前值
   * （脚本写回的运行快照更新对后续节点立即可见）；普通对象 / 未传时原样返回
   * （M10-T4 快照语义 / 既有「不注入」行为不变）。
   */
  const resolveEnv = (): Record<string, unknown> | undefined => {
    const raw = options.env;
    return typeof raw === "function" ? raw() : raw;
  };

  /**
   * 解析当前节点的工作流存储快照：storage 为供给函数时逐节点调用取当前值
   * （host.storage 读写的镜像更新对后续节点立即可见）；普通对象 / 未传时
   * 原样返回（派发快照语义 / 既有「不注入」行为不变）。
   */
  const resolveStorage = (): Record<string, unknown> | undefined => {
    const raw = options.storage;
    return typeof raw === "function" ? raw() : raw;
  };

  /**
   * 把刚变为可运行（全部直接上游已结算）的下游按连线数组顺序依次入队。
   * success 与 continue 失败两条路径共用（stop 失败直接停机不入队）。
   *
   * M7-T1：options.selectDownstream 注册时先对（本节点, 本节点 output）求值——
   * 返回数组则只调度其中的 target（条件分支 / 循环体排除经此实现）；'all' 或
   * 未注册时全部下游照常调度。join 门槛（isRunnable）不受选择器影响。
   */
  const scheduleDownstream = (sourceNode: WorkflowNode, sourceOutput: unknown): void => {
    let selection: DownstreamSelection = "all";
    if (options.selectDownstream) {
      selection = options.selectDownstream(sourceNode, sourceOutput);
    }
    for (const edge of workflow.edges) {
      if (edge.source !== sourceNode.id) continue;
      // 下游选择过滤（M7-T1）：选择器未命中该 target 时跳过（节点保持 pending，
      // 后续仍可经其它路径激活——enqueued 只防重复入队）
      if (selection !== "all" && !selection.includes(edge.target)) continue;
      if (enqueued.has(edge.target)) continue;
      if (!isRunnable(edge.target, workflow.edges, statuses)) continue;
      enqueued.add(edge.target);
      queue.push(nodeById.get(edge.target) as WorkflowNode);
    }
  };

  // 最大节点并发（M15-T6）：主循环就绪集快照批量的批大小上限（无效值回退缺省）
  const maxConcurrency = normalizeMaxNodeConcurrency(options.maxNodeConcurrency);

  /**
   * 记录一个槽位的结算（success / failed）：状态机迁移、输出表、快照（并入
   * runner 写入的 snapshotExtras）、onNodeFinish 事件与 run 级错误摘要。
   * 批内槽位按入队序依次记录——确定性不依赖批内完成先后。
   */
  const recordSlot = (slot: BatchSlot, nodeError: string | undefined, output: unknown): void => {
    const durationMs = (slot.settledAt ?? Date.now()) - slot.startedAt;
    if (nodeError === undefined) {
      slot.machine.transition("success");
      outputs.set(slot.node.id, output);
      const record: NodeRun = {
        status: "success",
        input: slot.input,
        output,
        startedAt: slot.startedAt,
        durationMs,
        // M13-T9：runner 写入的快照附加字段（loop 逐迭代明细）原样并入；
        // 未写入时无该字段（向后兼容，既有快照形状不变）
        ...slot.runContext.snapshotExtras,
      };
      nodeRuns.set(slot.node.id, record);
      options.onNodeFinish?.(slot.node, record);
      return;
    }

    slot.machine.transition("failed");
    const record: NodeRun = {
      status: "failed",
      input: slot.input,
      output: null,
      error: nodeError,
      startedAt: slot.startedAt,
      durationMs,
      // M13-T9：失败结算同样并入快照附加字段（如 loop 节点失败时已结算轮次
      // 的逐迭代明细——失败轮之前的调试数据不因节点失败而丢失）
      ...slot.runContext.snapshotExtras,
    };
    nodeRuns.set(slot.node.id, record);
    options.onNodeFinish?.(slot.node, record);

    // run 级错误摘要取第一个失败（并发下按批内入队序记录，天然确定性；
    // continue 下可能多个失败，后续见节点快照）
    if (failureError === undefined) {
      failureError = `节点 ${slot.node.id} 执行失败：${nodeError}`;
    }
  };

  while (queue.length > 0) {
    // 批次启动前检查取消：已取消则不再启动任何新节点
    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    // 就绪集快照（M15-T6）：一次取至多 maxConcurrency 个就绪节点并发执行。
    // 快照内节点入队时已过 isRunnable 门槛（全部直接上游结算），并发执行
    // 不会读到半截输入；join 门槛不变（仍等全部上游结算才可能入队）
    const batch = queue.splice(0, maxConcurrency);

    // ---- launch 期：按入队序逐个起跑（前置工作同步完成，runner 立即调用）----
    // 启动前逐节点检查取消——保留串行版「取消后不再启动新节点」的逐节点口径：
    // runner 同步触发取消时，同批尚未启动的节点不再起跑（保持 pending，收尾
    // 统一 skipped）。runner 的结算经 launch 期挂接的捕获回调就地写入槽位
    //（同一 promise 上先挂先调，回调恒先于下方主循环恢复执行），主循环批后
    // 只读槽位、统一记录——结算时序不改变记录与入队顺序（确定性）。
    let launchAborted = false;
    const slots: BatchSlot[] = [];
    const pending: Array<BatchSlot> = [];
    for (const node of batch) {
      if (signal?.aborted) {
        launchAborted = true;
        break;
      }
      const machine = statuses.get(node.id) as NodeStatusMachine;
      // M15-T2：聚合入参的 node 键为引用键 refId ?? id（collectUpstreamOutputs 内换算）
      const input = aggregateInputs(
        collectUpstreamOutputs(node.id, workflow.edges, outputs, refKeyOf),
      );
      machine.transition("running");
      const startedAt = Date.now();
      options.onNodeStart?.(node, input);

      // 固定输出（M10-T5）：命中节点不执行 runner，launch 期直接以固定值结算
      //（success、durationMs 0），事件照发（画布运行态 / 落库口径与真实执行
      // 一致），下游照常调度。值为 undefined 的键不视为固定（null 是合法固定值）
      if (
        options.pinnedOutputs !== undefined &&
        Object.prototype.hasOwnProperty.call(options.pinnedOutputs, node.id) &&
        options.pinnedOutputs[node.id] !== undefined
      ) {
        const slot: BatchSlot = {
          node,
          machine,
          input,
          startedAt,
          // runContext 占位：pinned 槽位 launch 期已记录（recorded），后续不读
          runContext: {
            runId,
            signal,
            nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input } },
          },
          output: options.pinnedOutputs[node.id],
          recorded: true,
        };
        machine.transition("success");
        outputs.set(node.id, slot.output);
        const record: NodeRun = {
          status: "success",
          input,
          output: slot.output,
          startedAt,
          durationMs: 0,
        };
        nodeRuns.set(node.id, record);
        options.onNodeFinish?.(node, record);
        slots.push(slot);
        continue;
      }

      // 已完成节点的输出快照（原 try 块内构建，M13-T9 提前——运行上下文一并提升）；
      // M15-T2 起键换算为模板引用键 refId ?? id（`{{ node.<refId> }}` 的数据源）
      const nodeOutputs: Record<string, unknown> = {};
      for (const [id, value] of outputs) nodeOutputs[refKeyOf(id)] = value;
      // 节点级运行上下文提升为具名引用（M13-T9）：runner 可向 snapshotExtras 写入
      // 快照附加字段（loop 逐迭代明细），批后记录时读取并入
      const slot: BatchSlot = {
        node,
        machine,
        input,
        startedAt,
        runContext: {
          runId,
          signal,
          nodeCtx: {
            nodeOutputs,
            // M7-T2：variables 存在时并入 templateContext.var（未传保持既有形状）；
            // M7-T1：variables 为供给函数时逐节点取当前值（运行期写入可见）；
            // M10-T4：env 快照存在时并入 templateContext.env（{{ env.key }} 引用）；
            // M14-T3：env 允许供给函数形态（脚本写回的运行快照更新逐节点可见）；
            // storage 同 env：镜像快照供给函数逐节点取当前值（host.storage 读写可见）
            templateContext: buildTemplateContext(
              nodeOutputs,
              input,
              resolveVariables(),
              resolveEnv(),
              resolveStorage(),
            ),
            // M15-T2：runner 手持内部 id 定位输出表（setVariable from='node'）时换算
            refKeyOf,
          },
        },
      };
      const runner = resolveRunner(node, options);
      if (!runner) {
        // 缺 runner：与串行版一致按 failed 处理（无承诺，结算信息直接入槽）
        slot.error = `暂不支持的节点类型：${node.type}`;
        slot.settledAt = Date.now();
      } else {
        // 结算捕获：挂在 launch 期（先于主循环的 await 恢复），settledAt 取
        // 结算时刻（不含批内等待慢邻居的耗时）
        slot.raw = runWithRetry(runner, node, input, slot.runContext);
        void slot.raw.then(
          (output) => {
            slot.output = output;
            slot.settledAt = Date.now();
          },
          (error: unknown) => {
            slot.error = toErrorMessage(error);
            slot.settledAt = Date.now();
          },
        );
        pending.push(slot);
      }
      slots.push(slot);
    }

    // ---- 等待期：本批在途节点全部自然结算（含 stop 失败后的同批在途节点，
    // 见批后调度）。单节点批直接 await 原 runner 承诺（捕获回调在同一 promise
    // 上先行执行，无中间层）——线性链路逐波结算的微任务步进与串行版一致；
    // pinned-only 批（无可等待承诺）零等待，同 continuation 完成记录与调度
    if (pending.length === 1) {
      try {
        await (pending[0] as BatchSlot).raw;
      } catch {
        // 节点失败已在捕获回调写入槽位，这里只为吞掉拒绝（批后统一记录）
      }
    } else if (pending.length > 1) {
      await Promise.all(
        pending.map((slot) =>
          (slot.raw as Promise<unknown>).then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    }

    // ---- 批后记录期：按入队序统一记录（确定性不依赖批内完成先后）----
    for (const slot of slots) {
      if (slot.recorded) continue;
      recordSlot(slot, slot.error, slot.error === undefined ? slot.output : null);
    }

    // 取消优先于调度：本批执行期间触发取消 → 批内已结算结果照常保留，
    // 下游不再入队、剩余节点（含本批未启动者）收尾统一 skipped
    if (launchAborted || signal?.aborted) {
      cancelled = true;
      break;
    }

    // ---- 批后调度期：按入队序统一调度，入队顺序只取决于就绪集快照序
    //（= 连线数组序）。stop 失败出现即终止调度——此时同批在途节点已在上方
    // 等待期自然结算，不再有新节点起跑（停机窗口 = 当前批，不随失败扩大）
    let stopRun = false;
    for (const slot of slots) {
      if (slot.error === undefined) {
        // 简单分支 / join 激活：把新变为可运行的下游按连线序入队（join 齐上游才入队）
        scheduleDownstream(slot.node, slot.output);
      } else if (resolveNodeFailPolicy(slot.node, defaultFailPolicy) === "continue") {
        // 失败策略（M5-T4）：continue 不停机，下游仍执行（本节点无 output，
        // 下游聚合时按缺失处理）；选择器（M7-T1）按 null 自行决定放行范围
        scheduleDownstream(slot.node, null);
      } else {
        // stop（缺省）遇错即停：剩余节点在循环外统一 skipped
        stopRun = true;
        break;
      }
    }
    if (stopRun) break;
  }

  // 收尾：仍未执行的节点（因失败 / 取消停在队列里，或从 start 不可达）统一
  // skipped；M7-T1：nestedNodeRun 能解析出快照的 pending 节点（loop 循环体在
  // runner 侧子运行中执行过、本层从未入队）改用「最后一轮」快照——NodeRun 的
  // 快照语义 = 节点最后一次执行（见 types/model.ts），状态机仍走 pending →
  // skipped 的合法迁移（状态机为内部实现细节，对外的 nodeRuns 以快照为准）。
  // M13-T5：stickyNote（便签）显式排除——纯注释卡不入执行拓扑，也不在运行
  // 记录中留下 skipped 快照（运行详情 / 画布运行态均不出现便签条目）。
  for (const node of workflow.nodes) {
    if (node.type === "stickyNote") continue;
    const machine = statuses.get(node.id) as NodeStatusMachine;
    if (machine.status === "pending") {
      machine.transition("skipped");
      const nested = options.nestedNodeRun?.(node);
      nodeRuns.set(node.id, nested ?? SKIPPED_NODE_RUN());
    }
  }

  // run 级状态：取消优先于失败
  const status: RunStatus = cancelled
    ? "cancelled"
    : failureError !== undefined
      ? "failed"
      : "success";
  const summary: RunSummary = {
    runId,
    workflowId: workflow.id,
    status,
    nodeRuns: {},
  };
  for (const [id, record] of nodeRuns) summary.nodeRuns[id] = record;
  if (status === "failed") summary.error = failureError;
  if (status === "cancelled") summary.error = "运行已被取消";

  options.onRunFinish?.(summary);
  return summary;
}
