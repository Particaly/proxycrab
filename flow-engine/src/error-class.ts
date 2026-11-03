/**
 * 节点错误分类（M5-T4）。
 *
 * 职责：把节点执行期抛出的任意错误归一为有限类别，供运行记录（NodeRun.error
 * 之外的诊断视角）与后续 UI 展示使用。分类依据两类约定：
 *
 *   1. 脚本错误（M5-T3 约定）：runPreScript / runPostScript 产出 ScriptError
 *      （kind: 'syntax' | 'runtime' | 'timeout' | 'invalid-return'）。脚本错误以
 *      结果对象返回而非抛出，background/run-controller 的脚本接线 runner 把它
 *      包成 ScriptExecutionError 再抛出（executor 约定：抛错 = 节点 failed）；
 *      分类时按 kind 归类——'timeout' → 'timeout'，其余 → 'script'。
 *   2. runner 错误 message 前缀（M5-T2 replay-executor 约定）：
 *      '[network]' / '[timeout]' / '[cancelled]' 分别对应网络失败、重放超时、
 *      运行取消。HTTP 4xx / 5xx 在 runner **不抛错**（照常成功返回响应），
 *      由 run-controller 在后置脚本之前按 isHttpFailure 判定并抛出
 *      HttpFailureError（文案「HTTP <status>」），分类为 'http'。
 *
 * 分类顺序（先具体后一般）：脚本 kind → HTTP → 前缀 → AbortError 防御 → unknown。
 * 本模块纯逻辑、零环境依赖；按 ROADMAP 惯例归入 src/engine/（barrel 导出由
 * 集成者追加，消费方暂以 '@/engine/error-class' 直连引用）。
 */

import type { ScriptError } from "./script";

/** 节点错误类别（有限集合，UI / 记录层按此归档）。'blocked' 为 M9-T2 新增：脚本被运行环境（CSP / 沙箱通道不可用）拒绝 */
export type NodeErrorCategory =
  "script" | "timeout" | "blocked" | "network" | "http" | "cancelled" | "unknown";

/** ScriptError.kind 的合法值集合（形状判定用，与 script.ts 的定义保持一致） */
const SCRIPT_ERROR_KINDS: readonly ScriptError["kind"][] = [
  "syntax",
  "blocked",
  "runtime",
  "timeout",
  "invalid-return",
];

/**
 * 脚本执行错误：把 ScriptError（结果对象）转成可抛出的 Error。
 * message 原样保留 runPreScript / runPostScript 产出的可读文案，
 * kind 供 classifyNodeError 归类（'timeout' 归 timeout、'blocked' 归 blocked，
 * 其余归 script）。
 */
export class ScriptExecutionError extends Error {
  /** 底层 ScriptError 的 kind（syntax / blocked / runtime / timeout / invalid-return） */
  public readonly kind: ScriptError["kind"];

  constructor(error: ScriptError) {
    super(error.message);
    this.name = "ScriptExecutionError";
    this.kind = error.kind;
  }
}

/**
 * HTTP 失败错误：重放响应 status >= 400 时由脚本接线 runner 抛出
 * （HTTP 失败判定在 post 脚本之前——失败响应不再进入后置处理）。
 * 文案固定「HTTP <status>」形式（M5-T4 约定），分类为 'http'。
 */
export class HttpFailureError extends Error {
  /** 触发失败的 HTTP 状态码（4xx / 5xx） */
  public readonly status: number;
  /**
   * 被拒绝的归一化响应输出（可选，M13-T1）：HTTP 失败判定发生在后置脚本之前，
   * 失败响应本不进入输出链路——内联试跑（配置抽屉结果区）需要在节点失败的
   * 同时展示状态码与响应体，脚本接线 runner 抛错时把重放归一化响应挂在错误上
   * （形状同 ReplayResponseOutput；是否携带由抛出方决定，历史构造不受影响）。
   */
  public readonly response?: unknown;

  constructor(status: number, response?: unknown) {
    super(`HTTP ${status}`);
    this.name = "HttpFailureError";
    this.status = status;
    this.response = response;
  }
}

/** 从任意抛出值提取 message 文本（非 Error 用 String() 兜底） */
function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把节点执行期抛出的值归类为 NodeErrorCategory。
 *
 * 归类顺序：
 *   1. ScriptError 形状（对象带合法 kind 字段，含 ScriptExecutionError）：
 *      kind 'timeout' → 'timeout'，kind 'blocked' → 'blocked'（M9-T2：CSP 拦截 /
 *      沙箱通道不可用，环境问题单列），其余 kind → 'script'；
 *   2. HttpFailureError（或 message 恰为「HTTP <三位数字>」形态）→ 'http'；
 *   3. message 前缀（M5-T2 约定）：'[network]' → 'network'、'[timeout]' →
 *      'timeout'、'[cancelled]' → 'cancelled'；
 *   4. AbortError / DOMException name === 'AbortError' → 'cancelled'
 *      （防御：runner 未按约定归一前的原始取消错误）；
 *   5. 其余 → 'unknown'。
 *
 * @param error 节点执行期抛出的任意值（含非 Error）
 * @returns 错误类别
 */
export function classifyNodeError(error: unknown): NodeErrorCategory {
  // 1) 脚本错误：ScriptError 形状（对象带合法 kind 字段）
  if (typeof error === "object" && error !== null) {
    const kind = (error as { kind?: unknown }).kind;
    if (typeof kind === "string" && (SCRIPT_ERROR_KINDS as readonly string[]).includes(kind)) {
      if (kind === "timeout") return "timeout";
      if (kind === "blocked") return "blocked";
      return "script";
    }
  }

  // 2) HTTP 失败：实例或「HTTP <status>」文案形态
  if (error instanceof HttpFailureError) return "http";
  if (/^HTTP \d{3}$/.test(toMessage(error))) return "http";

  // 3) runner 错误 message 前缀（M5-T2 约定）
  const message = toMessage(error);
  if (message.startsWith("[network]")) return "network";
  if (message.startsWith("[timeout]")) return "timeout";
  if (message.startsWith("[cancelled]")) return "cancelled";

  // 4) 原始 AbortError 防御（fetch 原生中断等未归一场景）
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  ) {
    return "cancelled";
  }

  return "unknown";
}

/**
 * 判断 runner 的成功输出是否为 HTTP 失败响应（status >= 400）。
 * M5-T2 约定：httpReplay runner 对 4xx / 5xx 不抛错、照常返回归一化响应；
 * 是否判节点失败由调用方（run-controller 脚本接线层）用本函数判定——
 * **在后置脚本之前**判定：失败响应不进入 post 处理。
 *
 * @param output runner 的成功返回值（形状不限）
 * @returns 是类型守卫：true 时 output 可收窄为 { status: number }
 */
export function isHttpFailure(output: unknown): output is { status: number } {
  if (typeof output !== "object" || output === null) return false;
  const status = (output as { status?: unknown }).status;
  return typeof status === "number" && status >= 400;
}
