import { reactive } from "vue";

/**
 * 编辑器聚焦请求接缝（计划 Task 22 Step 3「在编辑器打开」）。
 *
 * 运行详情的节点快照面板发起「在编辑器打开」：写入待聚焦目标后经
 * workspace-view 切到工作流手风琴区块；工作流主区视图 watch 本接缝，
 * 消费一次即清空（挂载时也会兜底消费一次挂载前到达的请求）。
 */
export const editorFocusStore = reactive({
  /** 待聚焦目标（workflowId + nodeId）；消费后置 null。 */
  pending: null as null | { workflowId: string; nodeId: string },
  /** 请求序号：同目标重复请求也能再次触发编辑器侧 watch。 */
  version: 0,
});

/** 发起「在编辑器打开」：定位流程并选中节点（编辑器侧尽力而为）。 */
export function requestEditorFocus(workflowId: string, nodeId: string): void {
  editorFocusStore.pending = { workflowId, nodeId };
  editorFocusStore.version += 1;
}

/** 工作流主区视图消费一次聚焦请求（无待处理请求时返回 null）。 */
export function consumeEditorFocus(): { workflowId: string; nodeId: string } | null {
  const pending = editorFocusStore.pending;
  editorFocusStore.pending = null;
  return pending;
}
