import { reactive } from "vue";
import type { FlowNodeRunRecord } from "../api/types";

/**
 * 编辑器内试跑 / 运行样本会话态（ReqFlow 复刻计划 Task 15 薄片 C Step 4）。
 *
 * 职责：把编辑器内产生的节点级样本收敛为一处会话态（纯内存，不落库不
 * 广播），供三处消费——NodeIoDrawer 的入参 / 出参样本与 trialPaths 样本徽标、
 * 表达式输入的样本上下文（use-expression-preview 的 TemplateSampleContext）、
 * 画布上其他节点的引用预览。按流程 id 分桶、节点 id 定位；会话态随窗口生命周期，
 * 流程关闭时清桶，切换流程保留（回到该流程样本仍在）。
 *
 * 产出方（两处）：
 *   - ScriptEditor 的脚本试跑（Backend.flowScriptDryRun，source = script-dry-run）：
 *     pre 试跑样例 input 即该节点入参样本（引擎口径：上游输出聚合对象），
 *     post 试跑返回值即该节点 output（引擎契约：post 返回本节点 output）；
 *   - 流程运行的节点 checkpoint（source = flow-run，recordRunSamples 并入）：
 *     运行中轮询 / 变更事件拉到的节点运行记录 input / output，打开编辑器时
 *     还会补拉该流程最近一次运行回填——运行后抽屉与表达式建议即有真实数据。
 *
 * 新旧口径：写入按 at（样本时间戳）取新——旧运行回填不会覆盖更新的试跑，
 * 同节点的连续 checkpoint（running → 终态）按 updatedAt 递增逐次落位。
 */

/** 单节点的试跑样本（编辑器内产生或运行记录并入） */
export interface FlowNodeTrial {
  /** 样本来源：脚本试跑 / 流程运行的节点 checkpoint */
  source: "script-dry-run" | "flow-run";
  /** 最近一次样本时间（Unix 毫秒；抽屉与预览行可标注新旧） */
  at: number;
  /** 入参样本（pre 试跑样例 input / 运行 checkpoint 的 input） */
  input?: unknown;
  /** 输出样本（post 试跑返回值 / 运行 checkpoint 的 output） */
  output?: unknown;
}

/** 试跑样本写入补丁（同节点多例试跑合并：pre 只写 input、post 只写 output） */
export interface FlowTrialPatch {
  input?: unknown;
  output?: unknown;
}

/** 样本来源标识（record 缺省按脚本试跑归档；运行记录写入方显式给 flow-run） */
export type FlowTrialSource = FlowNodeTrial["source"];

/** 试跑样本的归属定位（产出方上抛时声明；编辑器内为流程 + 节点） */
export interface FlowTrialTarget {
  workflowId: string;
  nodeId: string;
}

export const flowTrialStore = reactive({
  /** 按流程 id 分桶：workflowId → (nodeId → trial) */
  buckets: {} as Record<string, Record<string, FlowNodeTrial>>,

  /**
   * 记录一次试跑样本：缺省侧保留上次值（先试跑 post 再试跑 pre 不互删）。
   * source / at 缺省按脚本试跑、当前时刻；运行记录写入方显式携带节点
   * checkpoint 时间戳，保证与脚本试跑按时间取新。
   */
  record(
    workflowId: string,
    nodeId: string,
    patch: FlowTrialPatch,
    source: FlowTrialSource = "script-dry-run",
    at: number = Date.now(),
  ): void {
    const bucket = (this.buckets[workflowId] ??= {});
    const previous = bucket[nodeId];
    bucket[nodeId] = {
      source,
      at,
      input: patch.input !== undefined ? patch.input : previous?.input,
      output: patch.output !== undefined ? patch.output : previous?.output,
    };
  },

  /** 读取节点试跑样本；无记录返回 null（抽屉 / 预览走空态） */
  get(workflowId: string, nodeId: string): FlowNodeTrial | null {
    return this.buckets[workflowId]?.[nodeId] ?? null;
  },

  /** 清空某流程的全部试跑样本（流程关闭时调用） */
  clearWorkflow(workflowId: string): void {
    delete this.buckets[workflowId];
  },
});

/**
 * 把一次运行的节点 checkpoint 并入样本桶（流程运行 → 样本的唯一入口）。
 *
 * 逐节点按 checkpoint 时间取新：`updatedAt`（回落 `startedAt`）不早于该节点
 * 既有样本时才写入（running checkpoint 的 input 先落位，终态补 output 递增
 * 落位；编辑器打开时回填的旧运行不会覆盖之后更新的脚本试跑）。字段缺省
 * （running 阶段无 output）只写存在的侧，不互删。
 */
export function recordRunSamples(workflowId: string, nodeRuns: readonly FlowNodeRunRecord[]): void {
  for (const nodeRun of nodeRuns) {
    const patch: FlowTrialPatch = {};
    if (nodeRun.input !== undefined) patch.input = nodeRun.input;
    if (nodeRun.output !== undefined) patch.output = nodeRun.output;
    if (patch.input === undefined && patch.output === undefined) continue;
    const at = nodeRun.updatedAt || nodeRun.startedAt || Date.now();
    const existing = flowTrialStore.get(workflowId, nodeRun.nodeId);
    if (existing !== null && existing.at >= at) continue;
    flowTrialStore.record(workflowId, nodeRun.nodeId, patch, "flow-run", at);
  }
}
