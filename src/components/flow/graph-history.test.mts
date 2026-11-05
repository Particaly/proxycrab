import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  cloneGraphSnapshot,
  commitGraph,
  createGraphHistory,
  GRAPH_HISTORY_LIMIT,
  redoGraph,
  undoGraph,
} from "./graph-history";

/**
 * 图快照历史纯函数测试：快照深拷贝隔离、提交去重与上限裁剪、
 * 撤销 / 重做交换语义、不可变更新。
 */

function node(id: string, x = 0, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: "httpReplay", position: { x, y: 0 }, config };
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

describe("cloneGraphSnapshot", () => {
  it("深拷贝嵌套 config：后续改写原图不影响快照", () => {
    const nodes = [node("n1", 1, { override: { url: "a" } })];
    const snapshot = cloneGraphSnapshot(nodes, [edge("e1", "n1", "n2")]);
    nodes[0]!.config.override.url = "b";
    nodes[0]!.position.x = 99;
    expect(snapshot.nodes[0]?.config).toEqual({ override: { url: "a" } });
    expect(snapshot.nodes[0]?.position).toEqual({ x: 1, y: 0 });
    expect(snapshot.edges).toEqual([edge("e1", "n1", "n2")]);
  });

  it("config 为 reactive Proxy 形态时不抛 DataCloneError（store 下发响应式对象）", () => {
    // 复现：Vue reactive 的节点 config 是 Proxy，structuredClone 直接抛
    // DataCloneError 中断结构提交；JSON 往返应照常克隆出等值纯数据。
    const raw = { override: { url: "a" } };
    const proxied = new Proxy(raw, {});
    const snapshot = cloneGraphSnapshot([node("n1", 1, proxied)], []);
    expect(snapshot.nodes[0]?.config).toEqual({ override: { url: "a" } });
    expect(snapshot.nodes[0]?.config).not.toBe(raw);
  });
});

describe("commitGraph", () => {
  it("提交新图：current 压入 past、future 清空", () => {
    const state = createGraphHistory([node("a")], []);
    const next = commitGraph(state, [node("a", 5)], []);
    expect(next.past).toHaveLength(1);
    expect(next.current.nodes[0]?.position.x).toBe(5);
    expect(next.future).toHaveLength(0);
  });

  it("内容未变不产生新帧（签名去重）", () => {
    const state = createGraphHistory([node("a")], []);
    const same = commitGraph(state, [node("a")], []);
    expect(same).toBe(state);
  });

  it("超过上限时裁掉最旧帧", () => {
    let state = createGraphHistory([node("a")], []);
    for (let i = 1; i <= GRAPH_HISTORY_LIMIT + 5; i += 1) {
      state = commitGraph(state, [node("a", i)], []);
    }
    expect(state.past).toHaveLength(GRAPH_HISTORY_LIMIT);
    // 最旧的初始帧与最早 5 个提交被裁掉：past[0] 是第 6 次提交的前置帧（x=5）
    expect(state.past[0]?.nodes[0]?.position.x).toBe(5);
  });

  it("不可变更新：提交后原状态不被改写", () => {
    const state = createGraphHistory([node("a")], []);
    commitGraph(state, [node("a", 5)], []);
    expect(state.past).toHaveLength(0);
    expect(state.current.nodes[0]?.position.x).toBe(0);
  });
});

describe("undo / redo", () => {
  it("撤销恢复上一帧，再撤销回到初始帧；重做对称返回", () => {
    let state = createGraphHistory([node("a")], []);
    state = commitGraph(state, [node("a", 1)], []);
    state = commitGraph(state, [node("a", 1), node("b", 2)], []);

    const undo1 = undoGraph(state);
    expect(undo1).not.toBeNull();
    expect(undo1?.snapshot.nodes.map((item) => item.id)).toEqual(["a"]);
    state = undo1!.state;

    const undo2 = undoGraph(state);
    expect(undo2?.snapshot.nodes[0]?.position.x).toBe(0);
    state = undo2!.state;

    expect(undoGraph(state)).toBeNull();

    const redo1 = redoGraph(state);
    expect(redo1?.snapshot.nodes.map((item) => item.id)).toEqual(["a"]);
    const redo2 = redoGraph(redo1!.state);
    expect(redo2?.snapshot.nodes.map((item) => item.id)).toEqual(["a", "b"]);
    expect(redoGraph(redo2!.state)).toBeNull();
  });

  it("撤销后提交新图：future 清空（重做分支被丢弃）", () => {
    let state = createGraphHistory([node("a")], []);
    state = commitGraph(state, [node("a", 1)], []);
    state = undoGraph(state)!.state;
    state = commitGraph(state, [node("a", 9)], []);
    expect(state.future).toHaveLength(0);
    expect(redoGraph(state)).toBeNull();
  });

  it("撤销 / 重做返回的快照与历史帧隔离：改写快照不影响后续撤销", () => {
    let state = createGraphHistory([node("a", 3)], []);
    state = commitGraph(state, [node("a", 4)], []);
    const undo1 = undoGraph(state)!;
    undo1.snapshot.nodes[0]!.position.x = 999;
    const undo2 = undoGraph(undo1.state);
    expect(undo2).toBeNull();
    // undo1 的 current 即初始帧，未被改写
    expect(undo1.state.current.nodes[0]?.position.x).toBe(3);
  });
});
