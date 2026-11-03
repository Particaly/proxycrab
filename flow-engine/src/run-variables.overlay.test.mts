import { describe, expect, it } from "vitest";
import { RunVariableOverlay, RunVariableStore } from "./run-variables";

/**
 * M10-T6 收尾：迭代作用域 overlay（循环并发隔离的底层能力，见
 * run-variables.ts）。锁定：读透传父层 / 写缓冲私有层、合并 last-write-wins
 * （由调用方按迭代完成顺序逐个 mergeBack 实现）、合并键清单、exclude 保留键、
 * overlay 叠加（嵌套迭代），以及既有 store API 不受影响。既有
 * run-variables.test.ts 不重复此处断言。
 */

describe("RunVariableStore.createOverlay：迭代作用域视图", () => {
  it("读透传父层、写缓冲私有层：overlay 写入在合并前不影响父 store", () => {
    const store = new RunVariableStore({ token: "t0" });
    const overlay = store.createOverlay();
    // 未缓冲键透传父层
    expect(overlay.get("token")).toBe("t0");
    expect(overlay.has("token")).toBe(true);
    expect(overlay.has("fresh")).toBe(false);
    expect(overlay.get("fresh")).toBeUndefined();

    overlay.set("token", "t1");
    overlay.set("fresh", 1);
    // 本层缓冲优先
    expect(overlay.get("token")).toBe("t1");
    expect(overlay.get("fresh")).toBe(1);
    expect(overlay.has("fresh")).toBe(true);
    // 父层不受影响
    expect(store.get("token")).toBe("t0");
    expect(store.has("fresh")).toBe(false);
    // snapshot = 父快照 + 缓冲覆盖
    expect(overlay.snapshot()).toEqual({ token: "t1", fresh: 1 });
    expect(store.snapshot()).toEqual({ token: "t0" });
  });

  it("set 返回写入前旧值：首写回退父层、再写取本层缓冲", () => {
    const store = new RunVariableStore({ k: "old" });
    const overlay = store.createOverlay();
    expect(overlay.set("k", "mid")).toBe("old");
    expect(overlay.set("k", "new")).toBe("mid");
    expect(overlay.set("added", 1)).toBeUndefined();
  });

  it("mergeBack：缓冲写回父层，返回合并键清单（首写序），合并后缓冲清空", () => {
    const store = new RunVariableStore({ a: 1 });
    const overlay = store.createOverlay();
    overlay.set("b", 2);
    overlay.set("a", 10);
    overlay.set("b", 20); // 同键多次写：首写序只记一次
    expect(overlay.mergeBack()).toEqual(["b", "a"]);
    expect(store.get("a")).toBe(10);
    expect(store.get("b")).toBe(20);
    // 缓冲已清空：重复合并为空操作（overlay 生命周期 = 单次迭代）
    expect(overlay.mergeBack()).toEqual([]);
    expect(store.snapshot()).toEqual({ a: 10, b: 20 });
  });

  it("mergeBack exclude：保留键不外泄（仍随缓冲丢弃），其余键照常合并", () => {
    const store = new RunVariableStore();
    const overlay = store.createOverlay();
    overlay.set("keep", 1);
    overlay.set("drop", 2);
    expect(overlay.mergeBack(["drop"])).toEqual(["keep"]);
    expect(store.get("keep")).toBe(1);
    expect(store.has("drop")).toBe(false);
  });

  it("同键冲突按合并（迭代完成）顺序 last-write-wins", () => {
    // 先完成先合并：后合并者覆盖
    const store = new RunVariableStore();
    const first = store.createOverlay();
    const second = store.createOverlay();
    first.set("k", "from-first");
    second.set("k", "from-second");
    first.mergeBack();
    second.mergeBack();
    expect(store.get("k")).toBe("from-second");

    // 完成顺序相反时胜者随之互换
    const store2 = new RunVariableStore();
    const a = store2.createOverlay();
    const b = store2.createOverlay();
    a.set("k", "a");
    b.set("k", "b");
    b.mergeBack();
    a.mergeBack();
    expect(store2.get("k")).toBe("a");
  });

  it("叠加：overlay.createOverlay() 链式视图，子层合并先进中间层、随中间层合并才落主 store", () => {
    const store = new RunVariableStore({ root: 0 });
    const outer = store.createOverlay();
    outer.set("loop", "outer");
    const inner = outer.createOverlay();
    // 透传链：子 → 外层 overlay → 主 store
    expect(inner.get("root")).toBe(0);
    expect(inner.get("loop")).toBe("outer");
    // 子层写不直达主 store
    inner.set("x", "inner");
    expect(store.has("x")).toBe(false);
    // 子层合并先进中间层（嵌套迭代的合并落点）
    expect(inner.mergeBack()).toEqual(["x"]);
    expect(outer.get("x")).toBe("inner");
    expect(store.has("x")).toBe(false);
    // 中间层合并才落主 store
    expect(outer.mergeBack()).toEqual(["loop", "x"]);
    expect(store.get("x")).toBe("inner");
  });

  it("空缓冲 mergeBack 为空操作；overlay 是 OverlayCapableVariableStore（可再叠 overlay）", () => {
    const store = new RunVariableStore();
    const overlay = store.createOverlay();
    expect(overlay.mergeBack()).toEqual([]);
    const stacked = overlay.createOverlay();
    expect(stacked).toBeInstanceOf(RunVariableOverlay);
    expect(stacked.get("anything")).toBeUndefined();
  });

  it("既有 store API 不受 overlay 影响：get / has / set / snapshot 语义不变", () => {
    const store = new RunVariableStore({ a: 1 });
    const overlay = store.createOverlay();
    overlay.set("a", 999);
    // store 的 set 返回旧值语义不变（overlay 未合并时读到的是原值）
    expect(store.set("a", 2)).toBe(1);
    expect(store.get("a")).toBe(2);
    expect(store.snapshot()).toEqual({ a: 2 });
    overlay.mergeBack();
    expect(store.get("a")).toBe(999);
  });
});
