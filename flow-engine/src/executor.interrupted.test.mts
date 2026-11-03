import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  RUN_STATUS_TRANSITIONS,
  RunStatusMachine,
  assertRunTransition,
} from "./executor";

/**
 * M9-T4 运行状态枚举增量 'interrupted' 与执行器状态机的关系（node 环境）：
 * 'interrupted' 是**落库专有终态**——孤儿扫描（background/run-recovery.ts）
 * 直接 patch IndexedDB 记录完成 running → interrupted，不经内存状态机，因此
 * 刻意不是 RUN_STATUS_TRANSITIONS 的键（既有迁移矩阵测试锁定 running 的三个
 * 终态目标，见该测试；状态机对中断态按空目标表兜底：不可迁出、视为终结）。
 * 既有 executor.test.ts 零修改；本文件为增量用例。
 */

describe("RUN_STATUS_TRANSITIONS 与 interrupted（M9-T4）", () => {
  it("interrupted 不是迁移表键（落库专有终态，不经内存状态机）", () => {
    expect(RUN_STATUS_TRANSITIONS["interrupted"]).toBeUndefined();
  });

  it("内存状态机不产生 running → interrupted（迁移由孤儿扫描直接写库完成）", () => {
    expect(() => assertRunTransition("running", "interrupted")).toThrow(IllegalTransitionError);
    expect(() => new RunStatusMachine().transition("interrupted")).toThrow(IllegalTransitionError);
  });

  it("以 interrupted 起步按空目标表兜底：任何再迁移非法、视为已终结", () => {
    expect(() => assertRunTransition("interrupted", "success")).toThrow(IllegalTransitionError);
    expect(() => assertRunTransition("interrupted", "failed")).toThrow(IllegalTransitionError);
    const machine = new RunStatusMachine("interrupted");
    expect(machine.finished).toBe(true);
    expect(machine.status).toBe("interrupted");
  });

  it("既有四个状态的迁移表行为不变", () => {
    expect(RUN_STATUS_TRANSITIONS["running"]).toEqual(["success", "failed", "cancelled"]);
    expect(RUN_STATUS_TRANSITIONS["success"]).toEqual([]);
    expect(RUN_STATUS_TRANSITIONS["cancelled"]).toEqual([]);
    expect(new RunStatusMachine().finished).toBe(false);
  });
});
