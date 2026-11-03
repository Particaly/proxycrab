/**
 * 取消信号端口（宿主桥等价物，计划 Task 2 Step 2）。
 *
 * 归档（@ 485fa00）执行器以 DOM AbortSignal 传递取消：`signal.aborted` 轮询、
 * `addEventListener('abort', …)` 订阅、`removeEventListener` 退订。QuickJS 无
 * AbortController / AbortSignal，故按**结构子集**定义 CancelSignal 端口并附纯
 * JS 实现：
 *
 *   - 引擎内部（executor / logic-nodes）只依赖本结构（aborted + 两个订阅方法），
 *     归档测试直构的 `new AbortController().signal`（vitest / Node 环境天然可用）
 *     结构兼容、零改动通过——DOM AbortSignal 的 addEventListener 签名是本接口
 *     的超集；
 *   - QuickJS 侧由 createCancelSource() 提供等价物（取消 = 调 cancel()）；
 *     运行编排（后续任务）可轮询 `host.cancelled()` 驱动它。
 *
 * 本模块纯逻辑、零环境依赖。
 */

/** 取消信号端口：AbortSignal 的结构子集（引擎执行面实际消费的三个成员） */
export interface CancelSignal {
  /** 是否已取消（只读；取消后恒为 true） */
  readonly aborted: boolean;
  /** 订阅取消事件；once = 触发一次后自动退订 */
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): unknown;
  /** 退订取消事件（未订阅时静默无操作） */
  removeEventListener(type: "abort", listener: () => void): unknown;
}

/**
 * 创建纯 JS 取消源：signal 为 CancelSignal 端口实现，cancel() 幂等
 * （重复取消只触发一次监听器）。语义对齐 AbortController.abort() 的引擎可见面
 * （aborted 置真 + abort 事件同步派发）。
 */
export function createCancelSource(): { signal: CancelSignal; cancel(): void } {
  let aborted = false;
  const listeners = new Set<{ listener: () => void; once?: boolean }>();
  const signal: CancelSignal = {
    get aborted(): boolean {
      return aborted;
    },
    addEventListener(_type: "abort", listener: () => void, options?: { once?: boolean }): void {
      if (aborted) {
        // 已取消后订阅：与 AbortSignal 一致地异步不保证、同步直接触发（once 同样退订）
        listener();
        return;
      }
      listeners.add({ listener, once: options?.once });
    },
    removeEventListener(_type: "abort", listener: () => void): void {
      for (const entry of listeners) {
        if (entry.listener === listener) {
          listeners.delete(entry);
          return;
        }
      }
    },
  };
  return {
    signal,
    cancel(): void {
      if (aborted) return;
      aborted = true;
      // 派发副本：监听器内退订不影响本轮遍历（与 DOM 事件语义一致）
      for (const entry of [...listeners]) {
        if (entry.once) listeners.delete(entry);
        entry.listener();
      }
      listeners.clear();
    },
  };
}
