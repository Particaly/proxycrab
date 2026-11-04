import { reactive } from "vue";

/**
 * 编辑器内试跑结果会话态（ReqFlow 复刻计划 Task 15 薄片 C Step 4）。
 *
 * 职责：把编辑器内产生的节点级试跑样本收敛为一处会话态（纯内存，不落库不
 * 广播），供三处消费——NodeIoDrawer 的入参 / 出参样本与 trialPaths 试跑徽标、
 * 表达式输入的样本上下文（use-expression-preview 的 TemplateSampleContext）、
 * 画布上其他节点的引用预览。按流程 id 分桶、节点 id 定位；会话态随窗口生命周期，
 * 流程关闭时清桶，切换流程保留（回到该流程样本仍在）。
 *
 * 产出方（当前仅一处）：ScriptEditor 的脚本试跑（Backend.flowScriptDryRun）。
 *   - pre 试跑：样例 input 即该节点的入参样本（引擎口径：上游输出聚合对象）；
 *   - post 试跑：成功返回值即该节点的 output（引擎契约：post 返回本节点 output）。
 *
 * 已知缺口（本薄片不补，见计划 Task 15 Step 4 报告）：节点级试跑——直接执行
 * httpReplay 节点拿真实请求输出——暂无 API（Task 18 只覆盖脚本试跑，运行链路
 * Task 19/22 尚未接线），故样本只能由脚本试跑喂入；运行记录并入待后续薄片。
 */

/** 单节点的试跑样本（编辑器内产生） */
export interface FlowNodeTrial {
  /** 样本来源（当前仅有脚本试跑；后续运行记录接入时扩展枚举） */
  source: "script-dry-run";
  /** 最近一次试跑时间（Unix 毫秒；抽屉与预览行可标注新旧） */
  at: number;
  /** 入参样本（pre 试跑的样例 input；未试跑过 pre 时 undefined） */
  input?: unknown;
  /** 输出样本（post 试跑的返回值；未试跑过 post 时 undefined） */
  output?: unknown;
}

/** 试跑样本写入补丁（同节点多例试跑合并：pre 只写 input、post 只写 output） */
export interface FlowTrialPatch {
  input?: unknown;
  output?: unknown;
}

/** 试跑样本的归属定位（产出方上抛时声明；编辑器内为流程 + 节点） */
export interface FlowTrialTarget {
  workflowId: string;
  nodeId: string;
}

export const flowTrialStore = reactive({
  /** 按流程 id 分桶：workflowId → (nodeId → trial) */
  buckets: {} as Record<string, Record<string, FlowNodeTrial>>,

  /** 记录一次试跑样本：缺省侧保留上次值（先试跑 post 再试跑 pre 不互删） */
  record(workflowId: string, nodeId: string, patch: FlowTrialPatch): void {
    const bucket = (this.buckets[workflowId] ??= {});
    const previous = bucket[nodeId];
    bucket[nodeId] = {
      source: "script-dry-run",
      at: Date.now(),
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
