import { reactive } from "vue";
import { getBackend } from "../api/runtime-backend";

/**
 * 主界面手风琴导航状态：左侧边栏「抓包 / 工作流 / 请求库 / 环境变量 /
 * 运行记录」五个互斥区块的当前展开项，主内容区跟随切换。
 *
 * 原工作流 / 请求库 / 环境变量 / 运行记录浮窗改为内嵌视图后，工具栏菜单与
 * 运行详情的「在编辑器打开」等入口统一经 `open()` 切换区块；后端能力位缺失
 * 时入口不应出现（v-if 把关），此处再防御一次保证状态始终指向已渲染的区块。
 */
export type WorkspaceSection = "capture" | "workflow" | "library" | "env" | "runs";

/** 区块能力位映射：缺失对应 API 的区块不可切换（抓包始终可用）。 */
function sectionAvailable(section: WorkspaceSection): boolean {
  const backend = getBackend();
  switch (section) {
    case "workflow":
      return Boolean(backend.workflows);
    case "library":
      return Boolean(backend.requestLibrary);
    case "env":
      return Boolean(backend.envSets);
    case "runs":
      return Boolean(backend.flowRuns);
    default:
      return true;
  }
}

export const workspaceStore = reactive({
  /** 当前展开区块（互斥；点已展开区块头不收起，避免主区空屏）。 */
  section: "capture" as WorkspaceSection,

  /** 切换展开区块；能力位缺失时保持当前区块不变。 */
  open(section: WorkspaceSection): void {
    if (!sectionAvailable(section)) return;
    this.section = section;
  },
});
