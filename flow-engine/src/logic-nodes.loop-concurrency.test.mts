import { describe, expect, it } from "vitest";
import { RunVariableStore } from "./run-variables";
import type { OverlayCapableVariableStore } from "./run-variables";
import { buildTemplateContext, createRunId } from "./executor";
import type { NodeRunContext, NodeRunner } from "./executor";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import type { NodeConfig, NodeId, WorkflowEdge, WorkflowNode, WorkflowNodeType } from "./types";
import {
  LOOP_MAX_CONCURRENCY,
  LOOP_VARIABLE_NAME,
  computeLoopBody,
  createLoopRunner,
  createSetVariableRunner,
  resolveLoopExecutionOptions,
} from "./logic-nodes";

/**
 * M10-T6 收尾：循环迭代变量作用域隔离 + 真并发（能力门控）。锁定：
 * resolveLoopExecutionOptions 的门控契约（未隔离恒串行、隔离后按配置收敛）、
 * 隔离模式下并发迭代互不覆盖（setVariable / var.loop 走各自 overlay）、嵌套
 * loop 的 overlay 叠加（内层合并不外泄 var.loop）、未隔离（store 不支持
 * overlay）时安全回退串行。既有 logic-nodes.* 测试不重复此处断言。
 */

/* ---------------- 测试图构造工具（与 logic-nodes.test.ts 同款约定） ---------------- */

/** 构造画布节点（默认 httpReplay 类型，config 可覆盖） */
function makeNode(
  id: string,
  type: WorkflowNodeType = "httpReplay",
  config: NodeConfig = {},
): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
}

/** 构造连线 */
function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

/** 构造最小可执行工作流入参 */
function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return { id: asWorkflowId("wf-loop-concurrency"), nodes, edges };
}

/** 构造 runner 直调用的节点级上下文（与执行器同款 templateContext 构建） */
function makeRunCtx(signal?: AbortSignal): NodeRunContext {
  const nodeOutputs: Record<string, unknown> = {};
  return {
    runId: createRunId(),
    signal,
    nodeCtx: { nodeOutputs, templateContext: buildTemplateContext(nodeOutputs, null) },
  };
}

/** 读取 runner 上下文里的当前 var 表（模板命名空间 var 的快照） */
function varsOf(runCtx: NodeRunContext): Record<string, unknown> {
  return (runCtx.nodeCtx.templateContext.var ?? {}) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * resolveLoopExecutionOptions：能力门控
 * ------------------------------------------------------------------ */

describe("resolveLoopExecutionOptions：并发能力门控（M10-T6 收尾）", () => {
  it("未传 / false 门控：恒串行 1（既有契约），intervalMs 收敛不变", () => {
    expect(resolveLoopExecutionOptions({ concurrency: 4, intervalMs: 125 })).toEqual({
      concurrency: 1,
      intervalMs: 125,
    });
    expect(resolveLoopExecutionOptions({ concurrency: 4, intervalMs: 125 }, {})).toEqual({
      concurrency: 1,
      intervalMs: 125,
    });
    expect(
      resolveLoopExecutionOptions({ concurrency: 4 }, { isolatedVariableScope: false }),
    ).toEqual({ concurrency: 1, intervalMs: 0 });
    expect(resolveLoopExecutionOptions({ concurrency: -1, intervalMs: 99_999 })).toEqual({
      concurrency: 1,
      intervalMs: 60_000,
    });
  });

  it("隔离门控：按 config.concurrency 收敛（整数、1..16，非法回退 1），intervalMs 逻辑不变", () => {
    const gate = { isolatedVariableScope: true };
    expect(resolveLoopExecutionOptions({ concurrency: 4 }, gate)).toEqual({
      concurrency: 4,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({ concurrency: 1 }, gate)).toEqual({
      concurrency: 1,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({ concurrency: LOOP_MAX_CONCURRENCY }, gate)).toEqual({
      concurrency: 16,
      intervalMs: 0,
    });
    // 超上限收敛、负数 / 小数 / NaN / 缺省回退 1
    expect(resolveLoopExecutionOptions({ concurrency: 99 }, gate)).toEqual({
      concurrency: 16,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({ concurrency: 0 }, gate)).toEqual({
      concurrency: 1,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({ concurrency: -3 }, gate)).toEqual({
      concurrency: 1,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({ concurrency: 2.5 }, gate)).toEqual({
      concurrency: 1,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({ concurrency: Number.NaN }, gate)).toEqual({
      concurrency: 1,
      intervalMs: 0,
    });
    expect(resolveLoopExecutionOptions({}, gate)).toEqual({ concurrency: 1, intervalMs: 0 });
    // intervalMs 收敛与门控正交
    expect(resolveLoopExecutionOptions({ concurrency: 3, intervalMs: 99_999 }, gate)).toEqual({
      concurrency: 3,
      intervalMs: 60_000,
    });
    expect(resolveLoopExecutionOptions({ concurrency: 3, intervalMs: -1 }, gate)).toEqual({
      concurrency: 3,
      intervalMs: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * createLoopRunner：隔离模式（store 支持 overlay）
 * ------------------------------------------------------------------ */

describe("createLoopRunner：迭代作用域隔离 + 真并发（M10-T6 收尾）", () => {
  it("并发迭代互不覆盖：setVariable 写入与 var.loop 按迭代隔离，结束后合并回父层", async () => {
    // 图：s → L（并发 3）→ sv（setVariable 写 seen = loop.item）→ sink
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: ["i0", "i1", "i2"], concurrency: 3 }),
      makeNode("sv", "setVariable", {
        assignments: [{ name: "seen", from: "var", path: "loop.item" }],
      }),
      makeNode("sink", "httpReplay"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "sv"), makeEdge("sv", "sink")];
    const workflow = makeWorkflow(nodes, edges);
    const store = new RunVariableStore();
    const sinkVars: Array<Record<string, unknown>> = [];

    // 栅栏：3 个 sink 同时在飞才放行——串行回退会等待超时并以明确错误失败
    let arrived = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("迭代未并发执行（栅栏超时）")), 2_000);
      release = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const sinkRunner: NodeRunner = async (node, input, runCtx) => {
      arrived += 1;
      if (arrived === 3) release?.();
      await gate;
      sinkVars.push(varsOf(runCtx));
      return { nodeId: node.id, input };
    };

    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({
        httpReplay: sinkRunner,
        setVariable: createSetVariableRunner({ getStore: () => store }),
      }),
      getStore: () => store,
    });

    const output = (await loopRunner(nodes[1] as WorkflowNode, null, makeRunCtx())) as unknown[];
    expect(output).toHaveLength(3);
    // 3 轮确实同时执行（栅栏全部放行）
    expect(sinkVars).toHaveLength(3);
    // 每轮可见自己的 var.loop 与自己的 setVariable 写入（并发下互不覆盖）
    expect(sinkVars.map((vars) => vars.seen).sort()).toEqual(["i0", "i1", "i2"]);
    for (const vars of sinkVars) {
      expect(vars.seen).toBe((vars[LOOP_VARIABLE_NAME] as { item: string }).item);
    }
    // 迭代结束合并回父层：同键按完成序 last-write-wins（值域判定——完成序不固定）
    expect(["i0", "i1", "i2"]).toContain(store.get("seen"));
    // 顶层迭代合并 var.loop：保留某个完成轮次的值
    expect(["i0", "i1", "i2"]).toContain((store.get(LOOP_VARIABLE_NAME) as { item: string }).item);
  });

  it("隔离串行（缺省并发 1）：读透传父层——上一轮合并的 setVariable 写入对下一轮可见", async () => {
    // 图：s → L → reader（读 seen）→ sv（写 seen = loop.item）→ sink
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: ["i0", "i1"] }),
      makeNode("reader", "httpReplay"),
      makeNode("sv", "setVariable", {
        assignments: [{ name: "seen", from: "var", path: "loop.item" }],
      }),
      makeNode("sink", "httpReplay"),
    ];
    const edges = [
      makeEdge("s", "L"),
      makeEdge("L", "reader"),
      makeEdge("reader", "sv"),
      makeEdge("sv", "sink"),
    ];
    const workflow = makeWorkflow(nodes, edges);
    const store = new RunVariableStore();
    const seenByNode: Array<{ nodeId: NodeId; seen: unknown }> = [];
    const readers: NodeRunner = async (node, _input, runCtx) => {
      seenByNode.push({ nodeId: node.id, seen: varsOf(runCtx).seen });
      return null;
    };
    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({
        httpReplay: readers,
        setVariable: createSetVariableRunner({ getStore: () => store }),
      }),
      getStore: () => store,
    });
    await loopRunner(nodes[1] as WorkflowNode, null, makeRunCtx());
    // reader 每轮一次：第一轮无 seen；第二轮读透传父层——第一轮迭代结束合并
    // 的写入可见（sv / sink 同为 httpReplay，按节点 id 过滤）
    const readerSeen = seenByNode
      .filter((entry) => entry.nodeId === asNodeId("reader"))
      .map((entry) => entry.seen);
    expect(readerSeen).toEqual([undefined, "i0"]);
    // 本轮内 sv 的写入对同轮后续节点立即可见（overlay 快照）
    const sinkSeen = seenByNode
      .filter((entry) => entry.nodeId === asNodeId("sink"))
      .map((entry) => entry.seen);
    expect(sinkSeen).toEqual(["i0", "i1"]);
  });

  it("嵌套 loop 的 overlay 叠加：内层合并后外层体内仍读外层 item（并发下亦然）", async () => {
    // 图：s → L1（并发 2）→ L2（并发 2）→ c；L1 → x（与 L2 同为体入口，
    // 子运行按边数组序先调度 L2——x 在内层循环全部结束后执行，观察外层 var.loop）
    const nodes = [
      makeNode("s", "start"),
      makeNode("L1", "loop", { items: ["o1", "o2"], concurrency: 2 }),
      makeNode("L2", "loop", { items: ["i1", "i2"], concurrency: 2 }),
      makeNode("x", "httpReplay"),
      makeNode("c", "httpReplay"),
    ];
    const edges = [
      makeEdge("s", "L1"),
      makeEdge("L1", "L2"),
      makeEdge("L1", "x"),
      makeEdge("L2", "c"),
    ];
    const workflow = makeWorkflow(nodes, edges);
    const store = new RunVariableStore();
    const itemsSeenByX: Array<string | undefined> = [];
    const itemsSeenByC: Array<string | undefined> = [];
    const runners: Partial<Record<WorkflowNodeType, NodeRunner>> = {
      httpReplay: async (node, _input, runCtx) => {
        const loop = varsOf(runCtx)[LOOP_VARIABLE_NAME] as { item: string } | undefined;
        if (node.id === asNodeId("x")) itemsSeenByX.push(loop?.item);
        else itemsSeenByC.push(loop?.item);
        return null;
      },
    };
    // 内外层共用同一 runner 装配（与 background/run-controller 同款形态）
    runners.loop = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => runners,
      getStore: () => store,
    });

    await (runners.loop as NodeRunner)(nodes[1] as WorkflowNode, null, makeRunCtx());
    // 内层循环体每轮可见内层 item（2 外层轮 × 2 内层轮）
    expect(itemsSeenByC.sort()).toEqual(["i1", "i1", "i2", "i2"]);
    // 关键断言（overlay 叠加）：内层迭代合并不外泄 var.loop——外层体内节点
    // 在内层循环结束后读到的仍是**外层** item（直写共享 store 时会被内层覆盖）
    expect(itemsSeenByX.slice().sort()).toEqual(["o1", "o2"]);
    // 顶层迭代合并 var.loop：保留外层某轮的值
    expect(["o1", "o2"]).toContain((store.get(LOOP_VARIABLE_NAME) as { item: string }).item);
  });

  it("未隔离（store 不支持 overlay）：并发配置安全回退串行，直写语义不变", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [1, 2, 3], concurrency: 3 }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const workflow = makeWorkflow(nodes, edges);
    // 鸭子类型 store：无 createOverlay（旧装配 / 测试替身形状）→ 门控判不隔离
    const fakeStore = {
      table: {} as Record<string, unknown>,
      get(name: string): unknown {
        return this.table[name];
      },
      has(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.table, name);
      },
      set(name: string, value: unknown): unknown {
        const previous = this.table[name];
        this.table[name] = value;
        return previous;
      },
      snapshot(): Record<string, unknown> {
        return { ...this.table };
      },
    };
    const order: string[] = [];
    const recorder: NodeRunner = async (node, _input, runCtx) => {
      const loop = varsOf(runCtx)[LOOP_VARIABLE_NAME] as { index: number } | undefined;
      order.push(`${node.id}#${loop?.index}`);
      return null;
    };
    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({ httpReplay: recorder }),
      getStore: () => fakeStore as unknown as RunVariableStore,
    });
    await loopRunner(nodes[1] as WorkflowNode, null, makeRunCtx());
    // 严格串行：逐轮执行、无并发批次
    expect(order).toEqual(["a#0", "a#1", "a#2"]);
    // 直写语义：var.loop 直接落在替身 store（无 overlay 缓冲）。既有「保存 /
    // 恢复」行为的忠实锁定：每轮结束恢复进入本轮前的旧值——无先前值时，首轮
    // 写入的值由后续轮次的恢复动作留存（首轮的 item / index）
    expect(fakeStore.table[LOOP_VARIABLE_NAME]).toEqual({ item: 1, index: 0 });
  });

  it("隔离模式下合并回写宿主 store：setVariable 写入对循环后的父图可见", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: ["i0", "i1"], concurrency: 2 }),
      makeNode("sv", "setVariable", {
        assignments: [{ name: "seen", from: "var", path: "loop.item" }],
      }),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "sv")];
    const workflow = makeWorkflow(nodes, edges);
    const store = new RunVariableStore();
    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({ setVariable: createSetVariableRunner({ getStore: () => store }) }),
      getStore: () => store,
    });
    await loopRunner(nodes[1] as WorkflowNode, null, makeRunCtx());
    // 迭代结束合并：seen 必然落回宿主 store（完成序胜者，值域判定）
    expect(["i0", "i1"]).toContain(store.get("seen"));
  });
});

/* ------------------------------------------------------------------ *
 * 类型契约：OverlayCapableVariableStore 结构化探测
 * ------------------------------------------------------------------ */

describe("迭代作用域视图类型契约", () => {
  it("RunVariableStore 结构化满足 OverlayCapableVariableStore（可作隔离基座）", () => {
    const store = new RunVariableStore({ a: 1 });
    const view: OverlayCapableVariableStore = store;
    expect(view.get("a")).toBe(1);
    expect(view.has("a")).toBe(true);
    expect(view.set("a", 2)).toBe(1);
    expect(view.snapshot()).toEqual({ a: 2 });
    expect(view.createOverlay().get("a")).toBe(2);
  });

  it("NodeId 品牌类型在测试内可复用（防误用裸字符串断言节点 id）", () => {
    const id: NodeId = asNodeId("L");
    expect(id).toBe(asNodeId("L"));
  });
});
