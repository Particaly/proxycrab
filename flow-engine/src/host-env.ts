/**
 * 宿主环境端口：定时器与 uuid 的注入点（宿主桥等价物，计划 Task 2 Step 2）。
 *
 * 归档（@ 485fa00）的引擎以两种方式使用宿主全局：
 *   - setTimeout / clearTimeout：重试退避等待（executor.runWithRetry）与
 *     延时/限速等待（logic-nodes 的 abortableDelay）；
 *   - crypto.randomUUID：runId / 连线 id 生成（executor.defaultGenerateId、
 *     dependency-inference.applySuggestions 的缺省生成器）。
 *
 * 载荷运行在 QuickJS（rquickjs）内：无 setTimeout 与 crypto 全局。本模块提供
 * **可注入的等价物**并给出保守缺省：
 *   - 定时器：缺省惰性取 globalThis.setTimeout / clearTimeout（Node / 浏览器
 *     单测环境可用，既有测试含 vi.useFakeTimers 零改动）；QuickJS 侧由载荷
 *     入口（run-workflow 的 installHostBridgeFromHostGlobal）注入——以
 *     `host.sleep(ms)` Promise 实现等价定时器（等待期间取消由运行时中断）。
 *   - uuid：缺省优先 globalThis.crypto.randomUUID，否则纯 JS 随机回退
 *     （Math.random 组装 RFC 4122 v4 形态；QuickJS 无 crypto 全局时仍可用），
 *     也可经 setHostUuid 注入宿主实现。
 *
 * 惰性解析约定：定时器在**每次调用时**从 globalThis 取用而非模块加载时捕获，
 * 保证 vitest 的 fake timers（替换 globalThis.setTimeout）能被引擎感知。
 */

/** 宿主定时器端口：与 globalThis.setTimeout / clearTimeout 同签名 */
export interface HostTimers {
  /** 延迟 ms 后执行回调；返回句柄（仅用于 clearTimeout 取消） */
  setTimeout(callback: () => void, ms: number): unknown;
  /** 取消未触发的定时器（句柄未知 / 已触发时静默无操作） */
  clearTimeout(handle: unknown): void;
}

/** 宿主 uuid 端口：返回 RFC 4122 v4 形态的随机 uuid 字符串 */
export type HostUuid = () => string;

/** 注入的定时器实现（缺省 undefined = 惰性取 globalThis） */
let injectedTimers: HostTimers | undefined;

/** 注入的 uuid 实现（缺省 undefined = crypto.randomUUID 或纯 JS 回退） */
let injectedUuid: HostUuid | undefined;

/**
 * 注入宿主定时器实现（宿主注入点）：QuickJS 载荷入口以 host.sleep 组装；
 * 传 undefined 恢复缺省（globalThis）。注入在引擎首次使用定时器前完成。
 */
export function setHostTimers(timers: HostTimers | undefined): void {
  injectedTimers = timers;
}

/** 注入宿主 uuid 实现（宿主注入点）；传 undefined 恢复缺省。 */
export function setHostUuid(uuid: HostUuid | undefined): void {
  injectedUuid = uuid;
}

/**
 * 解析当前生效的定时器：注入优先；缺省惰性取 globalThis（Node / 浏览器可用，
 * 单测 fake timers 生效）。globalThis 上不存在 setTimeout（裸 QuickJS 未注入）
 * 时抛错——属装配缺陷而非运行期数据问题，显式暴露便于定位。
 */
function resolveTimers(): HostTimers {
  if (injectedTimers !== undefined) return injectedTimers;
  const globalThisTimers = globalThis as {
    setTimeout?: (callback: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  };
  if (typeof globalThisTimers.setTimeout === "function") {
    return {
      setTimeout: (callback, ms) => globalThisTimers.setTimeout!(callback, ms),
      clearTimeout: (handle) => globalThisTimers.clearTimeout?.(handle),
    };
  }
  throw new Error("定时器不可用：当前宿主未提供 setTimeout 且未注入宿主定时器实现");
}

/** 引擎内统一定时器入口（宿主注入点，替代直呼 setTimeout） */
export function hostSetTimeout(callback: () => void, ms: number): unknown {
  return resolveTimers().setTimeout(callback, ms);
}

/** 引擎内统一定时器取消入口（宿主注入点，替代直呼 clearTimeout） */
export function hostClearTimeout(handle: unknown): void {
  resolveTimers().clearTimeout(handle);
}

/**
 * 纯 JS uuid 回退（QuickJS 无 crypto）：Math.random 组装 RFC 4122 v4 形态。
 * 仅用于 id 生成（唯一性目标），不承载密码学语义。
 */
function fallbackRandomUuid(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < 36; index++) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += "-";
    } else if (index === 14) {
      out += "4";
    } else if (index === 19) {
      out += hex[(Math.floor(Math.random() * 4) + 8) as number];
    } else {
      out += hex[Math.floor(Math.random() * 16) as number];
    }
  }
  return out;
}

/**
 * 引擎内统一 uuid 入口（宿主注入点，替代直呼 crypto.randomUUID）：
 * 注入实现 → globalThis.crypto.randomUUID（Node 19+ / 浏览器）→ 纯 JS 回退。
 */
export function hostRandomUuid(): string {
  if (injectedUuid !== undefined) return injectedUuid();
  const cryptoGlobal = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoGlobal?.randomUUID === "function") return cryptoGlobal.randomUUID();
  return fallbackRandomUuid();
}
