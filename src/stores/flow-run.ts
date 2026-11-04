import { reactive } from "vue";

/**
 * 流程运行态接缝（Task 13 Step 4，占位实现）。
 *
 * 画布的运行期编辑锁定需要一个「某流程是否正在运行」的真实来源；运行状态
 * API（计划 Task 19）尚未合并，这里先立一处唯一的接缝：编辑器窗口按
 * `flowRunStore.runningWorkflowId === workflow.id` 计算锁定。
 *
 * Task 19 集成时只需让运行控制器在运行开始 / 结束（含取消与失败收尾）时
 * 写入 / 清空 `runningWorkflowId`（多流程并行运行时改为 Set 并把本接缝换成
 * 同名语义的查询方法），画布与窗口的锁定链路无需再改。
 */
export const flowRunStore = reactive({
  /** 正在运行的流程 id；无运行时为 null（真实运行 API 接入前恒为 null）。 */
  runningWorkflowId: null as string | null,
});
