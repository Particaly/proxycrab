import type { WorkflowNode, WorkflowNodeConfig, WorkflowNodeType } from "../../api/types";

/**
 * 工作流节点类型的展示元数据（画布卡片 / 配置抽屉 / 面板共用的单一事实来源）：
 * 文案、强调色、手柄布局与配置摘要派生全部集中在这里，节点组件只负责渲染。
 * 配色沿用 ReqFlow 归档实现的类型色规范（开始 = 绿、请求重放 = 蓝等）。
 */

/** 节点手柄布局（与领域模型一致）：仅出边（开始）/ 入边+出边（处理节点）/ 无手柄（便签，不可连线）。 */
export type NodeHandleLayout = "source-only" | "target-source" | "none";

export interface WorkflowNodeMeta {
  type: WorkflowNodeType;
  /** 展示名：节点默认标签 / 面板项文案。 */
  label: string;
  /** 一句话说明（面板提示 / 开始节点摘要）。 */
  description: string;
  /** 强调色 HEX：类型圆点、描边共用。 */
  color: string;
  handles: NodeHandleLayout;
}

/** 已注册的 9 类节点元数据（按画布面板展示顺序排列）。 */
export const WORKFLOW_NODE_META: Record<WorkflowNodeType, WorkflowNodeMeta> = {
  start: {
    type: "start",
    label: "开始",
    description: "流程起点，无需配置",
    color: "#10b981",
    handles: "source-only",
  },
  httpReplay: {
    type: "httpReplay",
    label: "请求重放",
    description: "重放引用的请求快照",
    color: "#0ea5e9",
    handles: "target-source",
  },
  condition: {
    type: "condition",
    label: "条件分支",
    description: "按条件走真 / 假两个出口",
    color: "#8b5cf6",
    handles: "target-source",
  },
  loop: {
    type: "loop",
    label: "循环",
    description: "对数据源逐项执行下游子图并聚合",
    color: "#f59e0b",
    handles: "target-source",
  },
  delay: {
    type: "delay",
    label: "延时",
    description: "等待指定时长后继续",
    color: "#94a3b8",
    handles: "target-source",
  },
  setVariable: {
    type: "setVariable",
    label: "变量赋值",
    description: "从入参 / 节点 / 变量提取值写入运行期变量",
    color: "#d946ef",
    handles: "target-source",
  },
  assert: {
    type: "assert",
    label: "断言",
    description: "校验上游结果，不满足时按失败策略处理",
    color: "#f43f5e",
    handles: "target-source",
  },
  transform: {
    type: "transform",
    label: "数据处理",
    description: "用 JSONPath / JMESPath 提取上游数据",
    color: "#06b6d4",
    handles: "target-source",
  },
  stickyNote: {
    type: "stickyNote",
    label: "便签",
    description: "画布注释卡，不参与执行",
    color: "#94a3b8",
    handles: "none",
  },
};

/** 面板展示顺序（9 类节点）。 */
export const WORKFLOW_NODE_TYPE_ORDER: WorkflowNodeType[] = [
  "start",
  "httpReplay",
  "condition",
  "loop",
  "delay",
  "setVariable",
  "assert",
  "transform",
  "stickyNote",
];

/**
 * 按类型取节点元数据。未知类型回退为请求重放的处理节点语义（与归档实现
 * 的兜底约定一致），保证旧数据 / 未来版本节点在当前版本渲染不抛错。
 */
export function getWorkflowNodeMeta(type: string): WorkflowNodeMeta {
  const meta = WORKFLOW_NODE_META[type as WorkflowNodeType];
  return meta ?? WORKFLOW_NODE_META.httpReplay;
}

/** 形状防御地读取 config 里的字符串字段（存储侧不深度校验 config 内部字段）。 */
function configString(config: WorkflowNodeConfig, key: string): string | undefined {
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** 形状防御地读取 config 里的数组字段。 */
function configArray(config: WorkflowNodeConfig, key: string): unknown[] {
  const value = (config as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

/** 截断摘要文本（title 全文，行内截断）。 */
function truncate(text: string, max = 26): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * 派生节点卡片的第二行配置摘要。全部做运行时形状防御：非法配置按
 * 「未配置」展示而不是抛错（与存储侧宽容读入口径一致）。
 */
export function nodeSummary(node: Pick<WorkflowNode, "type" | "config">): string {
  const config = node.config ?? {};
  switch (node.type) {
    case "start":
      return WORKFLOW_NODE_META.start.description;
    case "httpReplay": {
      const requestId = configString(config, "requestId");
      if (requestId) return truncate(`请求库 ${requestId}`);
      const manual = (config as Record<string, unknown>)["manualRequest"];
      if (manual !== null && typeof manual === "object") {
        const url = configString(manual as WorkflowNodeConfig, "url");
        const method = configString(manual as WorkflowNodeConfig, "method");
        if (url) return truncate(`${method ?? "GET"} ${url}`);
      }
      return "未引用请求";
    }
    case "condition": {
      const expression = configString(config, "expression");
      return expression && expression.trim() !== ""
        ? truncate(expression)
        : "未配置条件（恒走假分支）";
    }
    case "loop": {
      const items = configString(config, "items");
      return items && items.trim() !== "" ? truncate(items) : "未配置数据源";
    }
    case "delay": {
      const raw = (config as Record<string, unknown>)["durationMs"];
      const duration =
        typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
      return duration === undefined
        ? "未配置时长"
        : `等待 ${(duration / 1000).toFixed(duration % 1000 === 0 ? 0 : 1)} 秒`;
    }
    case "setVariable": {
      const count = configArray(config, "assignments").length;
      return count === 0 ? "未配置赋值" : `${count} 项赋值`;
    }
    case "assert": {
      const count = configArray(config, "assertions").length;
      return count === 0 ? "未配置断言（纯透传）" : `${count} 条断言`;
    }
    case "transform": {
      const count = configArray(config, "extractions").length;
      return count === 0 ? "未配置提取（原样透传）" : `${count} 条提取`;
    }
    case "stickyNote": {
      const text = configString(config, "text");
      return text && text.trim() !== "" ? truncate(text) : "空便签";
    }
    default:
      return "";
  }
}

/**
 * 派生节点卡第一行右侧的计数角标（undefined 不渲染）：
 * 循环迭代上限 / 断言条数 / 赋值条数 / 提取条数。
 */
export function nodeBadge(node: Pick<WorkflowNode, "type" | "config">): string | undefined {
  const config = node.config ?? {};
  switch (node.type) {
    case "loop": {
      const raw = (config as Record<string, unknown>)["maxIterations"];
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? `≤${raw}` : undefined;
    }
    case "setVariable":
      return `${configArray(config, "assignments").length}项`;
    case "assert":
      return `${configArray(config, "assertions").length}条`;
    case "transform":
      return `${configArray(config, "extractions").length}条`;
    default:
      return undefined;
  }
}

/* ------------------ 请求重放节点卡增强字段（对齐归档卡片） ------------------ */

/** 请求重放节点卡的第二行徽章字段（对齐归档 HttpReplayNode 的信息密度）。 */
export interface ReplayCardFields {
  /** 请求方法（override → manualRequest → 引用缺省 GET）。 */
  method: string;
  /** URL 摘要（override → manualRequest → 引用短码占位 → 未选择请求）。 */
  url: string;
  /** 失败策略文案（失败即停 / 失败继续）。 */
  failPolicy: string;
  /** 是否失败继续（徽章配色分档）。 */
  failContinue: boolean;
  /** 重放超时角标文案（undefined 不渲染）。 */
  timeout?: string;
  /** 输出已固定（角标渲染）。 */
  pinned: boolean;
}

/** URL 摘要的截断上限（节点卡第二行；title 展示全文）。 */
const REPLAY_URL_MAX = 30;

/**
 * 派生 httpReplay 节点卡的徽章字段；全部形状防御（非法配置按缺省展示，
 * 与 nodeSummary 同口径）。非 httpReplay 节点返回 null。
 */
export function replayCardFields(
  node: Pick<WorkflowNode, "type" | "config">,
): ReplayCardFields | null {
  if (node.type !== "httpReplay") return null;
  const config = (node.config ?? {}) as Record<string, unknown>;
  const override =
    config["override"] !== null && typeof config["override"] === "object"
      ? (config["override"] as Record<string, unknown>)
      : undefined;
  const manual =
    config["manualRequest"] !== null && typeof config["manualRequest"] === "object"
      ? (config["manualRequest"] as Record<string, unknown>)
      : undefined;
  const requestId = typeof config["requestId"] === "string" ? config["requestId"] : undefined;
  const method =
    (typeof override?.["method"] === "string" && override["method"]) ||
    (typeof manual?.["method"] === "string" && manual["method"]) ||
    "GET";
  const rawUrl =
    (typeof override?.["url"] === "string" && override["url"]) ||
    (typeof manual?.["url"] === "string" && manual["url"]) ||
    (requestId !== undefined ? `引用快照 #${requestId.slice(0, 8)}` : "") ||
    "";
  const timeoutRaw = config["timeoutMs"];
  const timeout =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw >= 0
      ? `${timeoutRaw}ms`
      : undefined;
  const pinned = config["pinnedOutput"] !== null && typeof config["pinnedOutput"] === "object";
  return {
    method,
    url: truncate(rawUrl === "" ? "未选择请求" : rawUrl, REPLAY_URL_MAX),
    failPolicy: config["failPolicy"] === "continue" ? "失败继续" : "失败即停",
    failContinue: config["failPolicy"] === "continue",
    ...(timeout !== undefined ? { timeout } : {}),
    pinned,
  };
}
