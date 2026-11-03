import { describe, expect, it } from "vitest";
import { RunVariableStore, mergeVariableScopes } from "./run-variables";

/**
 * M7-T2 运行期变量机制测试：
 * mergeVariableScopes 三层优先级合并（工作流 > 项目 > 全局，同名覆盖、坏表
 * 容错、入参不可变）与 RunVariableStore 存取（get / has / set 同名覆盖 /
 * snapshot 快照隔离）。
 */

describe("mergeVariableScopes：变量作用域优先级合并", () => {
  it("三层合并：工作流级 > 项目级 > 全局级（同名覆盖）", () => {
    const merged = mergeVariableScopes({
      global: { host: "https://global.example", env: "prod", onlyGlobal: "g" },
      project: { env: "staging", onlyProject: "p" },
      workflow: { env: "dev", onlyWorkflow: "w" },
    });
    expect(merged).toEqual({
      host: "https://global.example",
      env: "dev", // 工作流级覆盖项目级，项目级覆盖全局级
      onlyGlobal: "g",
      onlyProject: "p",
      onlyWorkflow: "w",
    });
  });

  it("缺层 / 空表：其余层照常合并", () => {
    expect(mergeVariableScopes({ workflow: { a: "1" } })).toEqual({ a: "1" });
    expect(mergeVariableScopes({ global: { a: "1" } })).toEqual({ a: "1" });
    expect(mergeVariableScopes({})).toEqual({});
    expect(mergeVariableScopes({ global: {}, project: {}, workflow: {} })).toEqual({});
  });

  it("坏表容错：null / 数组 / 原始值按空表跳过，不抛错", () => {
    const merged = mergeVariableScopes({
      global: null as unknown as Record<string, unknown>,
      project: ["not", "object"] as unknown as Record<string, unknown>,
      workflow: { a: "1" },
    });
    expect(merged).toEqual({ a: "1" });
    expect(mergeVariableScopes({ global: 42 as unknown as Record<string, unknown> })).toEqual({});
  });

  it("返回新对象：不改动入参表（合并后修改结果不影响原层）", () => {
    const global = { a: "g" };
    const workflow = { a: "w" };
    const merged = mergeVariableScopes({ global, workflow });
    merged.a = "mutated";
    expect(global.a).toBe("g");
    expect(workflow.a).toBe("w");
  });

  it("值保持引用（浅合并，不做深拷贝）", () => {
    const nested = { deep: { v: 1 } };
    const merged = mergeVariableScopes({ workflow: { nested } });
    expect(merged.nested).toBe(nested);
  });
});

describe("RunVariableStore：运行期变量存取", () => {
  it("初始表读取：get / has（含 falsy 值与不存在的变量）", () => {
    const store = new RunVariableStore({ token: "t1", zero: 0, empty: "", off: false, nil: null });
    expect(store.get("token")).toBe("t1");
    expect(store.get("zero")).toBe(0);
    expect(store.get("off")).toBe(false);
    expect(store.get("nil")).toBeNull();
    expect(store.has("empty")).toBe(true);
    expect(store.has("nope")).toBe(false);
    expect(store.get("nope")).toBeUndefined();
  });

  it("构造时浅拷贝初始表：外部后续改动不影响 store", () => {
    const initial: Record<string, unknown> = { a: 1 };
    const store = new RunVariableStore(initial);
    initial.a = "mutated";
    expect(store.get("a")).toBe(1);
  });

  it("set 写入新变量与同名覆盖，返回旧值；值可为任意 JSON", () => {
    const store = new RunVariableStore({ token: "old" });
    expect(store.set("token", "new")).toBe("old");
    expect(store.get("token")).toBe("new");
    expect(store.set("fresh", { list: [1, 2], ok: true })).toBeUndefined();
    expect(store.get("fresh")).toEqual({ list: [1, 2], ok: true });
    expect(store.set("fresh", 42)).toEqual({ list: [1, 2], ok: true });
  });

  it("has 对 set 后的变量成立；原型链键不算存在", () => {
    const store = new RunVariableStore();
    store.set("added", 1);
    expect(store.has("added")).toBe(true);
    // toString 在原型链上：未被显式写入时不算「存在」
    expect(store.has("toString")).toBe(false);
    expect(store.has("constructor")).toBe(false);
  });

  it("snapshot 导出浅拷贝快照：改快照不影响 store，set 后快照同步", () => {
    const store = new RunVariableStore({ a: 1 });
    const snap1 = store.snapshot();
    snap1.a = "mutated";
    expect(store.get("a")).toBe(1);

    store.set("b", 2);
    expect(store.snapshot()).toEqual({ a: 1, b: 2 });
  });

  it("缺省构造为空表（后续 M7-T1 setVariable 节点的写入起点）", () => {
    const store = new RunVariableStore();
    expect(store.snapshot()).toEqual({});
    store.set("k", "v");
    expect(store.get("k")).toBe("v");
  });
});
