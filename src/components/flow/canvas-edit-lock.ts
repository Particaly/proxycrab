import { appStore } from "../../stores/app";

/**
 * 运行期画布编辑锁定提示（Task 13 Step 4）：文案与提示出口的共享模块。
 *
 * 运行进行中画布锁定一切「结构性编辑」入口（增删节点 / 连线、粘贴、拖入、
 * 自动布局、撤销 / 重做、重命名），避免运行态与实际执行结构脱节。锁定语义
 * 是「入口禁用 + 原因提示」而非静默吞掉——工具栏按钮 / 菜单项 / 面板卡用
 * disabled 态 + title 提示（见 CanvasToolbar / NodePanel），而绕过入口直达
 * 动作回调的路径（删除键、快捷键、锁定瞬间落下的拖拽 / 连线）由各守卫调用
 * notifyEditLocked 弹 toast 说明原因。
 *
 * 节点拖动位置 / 视口缩放平移 / 选中与复制不属结构性编辑，保持可用，不走本模块。
 */

/** 锁定提示的长文案（toast 正文：说明原因与解除条件）。 */
export const EDIT_LOCKED_MESSAGE = "运行中不可编辑：请等待运行结束或取消后再修改画布结构";

/** 锁定提示 toast 的展示时长（毫秒）。 */
export const EDIT_LOCKED_TOAST_DURATION_MS = 2600;

/**
 * 弹出「运行中不可编辑」提示 toast（单例）。
 *
 * appStore.toast 无去重语义，这里按「是否已有同文案 toast 存活」判定：
 * 连续触发的守卫（如按住删除键）只复用既有提示的剩余时长，不重复堆叠。
 */
export function notifyEditLocked(): void {
  const existing = appStore.toasts.find((item) => item.message === EDIT_LOCKED_MESSAGE);
  if (existing) {
    // 已有同文案提示存活：刷新其存活时长（移除后重弹一次，保持「刚触发」的观感）
    appStore.dismissToast(existing.id);
  }
  appStore.toast(EDIT_LOCKED_MESSAGE, "info", EDIT_LOCKED_TOAST_DURATION_MS);
}
