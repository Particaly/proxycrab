import { describe, expect, it } from "vitest";
import { buildTemplateContext, createRunId, executeWorkflow } from "./executor";
import type { NodeRunContext, NodeRunner } from "./executor";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import type { NodeId, WorkflowEdge, WorkflowNode } from "./types";
import { RunVariableStore } from "./run-variables";
import {
  LOOP_ENTRY_ID_SUFFIX,
  LOOP_VARIABLE_NAME,
  buildBodyWorkflow,
  computeLoopBody,
  createLoopRunner,
  createWorkflowDownstreamSelector,
} from "./logic-nodes";

/**
 * buildBodyWorkflow 专测：循环体子工作流构造的 id 约定与图形状（Task 22
 * 「重跑该轮」的引擎原语）。既有 logic-nodes.* / executor.* 测试锁定 loop
 * 执行语义，不在此重复；本文件只锁定：
 *   1. 虚拟入口 id 约定（<loopId>::loop-entry，与 LOOP_ENTRY_ID_SUFFIX 一致）；
 *   2. 虚拟入口只接全部纯入口（混合入口以其体内上游为门槛，不接虚拟入口）；
 *   3. 体内部连线原样保持、体节点保持工作流数组原顺序；
 *   4. 汇点保留在子图中（逐轮聚合从汇点 nodeRuns 读取）；
 *   5. 与 loop runner 的子运行同构：同一输入（var.loop）+ 同一 runner 表，
 *      直接执行 buildBodyWorkflow 产物跑出与循环体子运行一致的节点路径与输出。
 */

/* ---------------- 测试图构造工具（与 logic-nodes.test.ts 同款约定） ---------------- */

/** 构造画布节点（默认 httpReplay 类型，config 可覆盖） */
function makeNode(id: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id: asNodeId(id), type: "httpReplay", position: { x: 0, y: 0 }, config };
}

/** 构造连线 */
function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

/**
 * 体形状参考图：s→L；L→a、L→b（纯入口）；a→m、b→m（体内 join）；L→m（混合
 * 入口——m 既是 loop 直接下游又有体内上游）。预期体 = [a, b, m]、纯入口 =
 * [a, b]、汇点 = [m]；z 类体外上游不在本图中（有外部上游者不入体属
 * computeLoopBody 的准入语义，由其既有测试锁定）。
 */
function makeBodyGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; loopId: NodeId } {
  const nodes = [
    makeNode("s"),
    makeNode("L", { items: ["x"] }),
    makeNode("a"),
    makeNode("b"),
    makeNode("m"),
  ];
  const edges = [
    makeEdge("s", "L"),
    makeEdge("L", "a"),
    makeEdge("L", "b"),
    makeEdge("a", "m"),
    makeEdge("b", "m"),
    makeEdge("L", "m"),
  ];
  return { nodes, edges, loopId: asNodeId("L") };
}

/** 回显 runner：output = { node, loop }（依赖 var.loop，供同构对比） */
const echoRunner: NodeRunner = async (node, _input, runCtx) => ({
  node: node.id,
  loop: (runCtx.nodeCtx.templateContext.var ?? {})[LOOP_VARIABLE_NAME] ?? null,
});

/** 构造 runner 直调用的节点级上下文（与执行器同款 templateContext 构建） */
function makeRunCtx(): NodeRunContext {
  const nodeOutputs: Record<string, unknown> = {};
  return {
    runId: createRunId(),
    nodeCtx: { nodeOutputs, templateContext: buildTemplateContext(nodeOutputs, null) },
  };
}

/* ------------------------------------------------------------------ *
 * id 约定与图形状
 * ------------------------------------------------------------------ */

describe("buildBodyWorkflow：id 约定与图形状", () => {
  it("虚拟入口 id = <loopId>::loop-entry，工作流 id 同约定，虚拟入口为唯一 start", () => {
    const { nodes, edges, loopId } = makeBodyGraph();
    const plan = computeLoopBody(loopId, nodes, edges);
    const sub = buildBodyWorkflow(loopId, plan);

    expect(plan.entryIds).toEqual([asNodeId("a"), asNodeId("b")]);
    expect(sub.entryId).toBe(asNodeId(`L${LOOP_ENTRY_ID_SUFFIX}`));
    expect(sub.id).toBe(asWorkflowId(`L${LOOP_ENTRY_ID_SUFFIX}`));
    const virtualStart = sub.nodes[0]!;
    expect(virtualStart.id).toBe(sub.entryId);
    expect(virtualStart.type).toBe("start");
    expect(virtualStart.config).toEqual({});
    // 体节点原样跟随虚拟入口（同一引用），保持工作流数组原顺序
    expect(sub.nodes.slice(1)).toEqual(plan.bodyNodes);
    expect(plan.bodyNodes.map((n) => n.id)).toEqual([asNodeId("a"), asNodeId("b"), asNodeId("m")]);
  });

  it("虚拟入口恰好接全部纯入口各一条边；混合入口不接", () => {
    const { nodes, edges, loopId } = makeBodyGraph();
    const sub = buildBodyWorkflow(loopId, computeLoopBody(loopId, nodes, edges));

    const entryEdges = sub.edges.filter((edge) => edge.source === sub.entryId);
    expect(entryEdges.map((edge) => edge.target)).toEqual([asNodeId("a"), asNodeId("b")]);
    // 混合入口 m（loop 直接下游 + 体内上游 a/b）不接虚拟入口——其在子运行中
    // 以体内上游为门槛
    expect(entryEdges.some((edge) => edge.target === asNodeId("m"))).toBe(false);
    // 虚拟入口只作 source，从不作 target
    expect(sub.edges.some((edge) => edge.target === sub.entryId)).toBe(false);
  });

  it("体内部连线原样保持（同一引用），总边数 = 入口边 + 体边；汇点保留在子图", () => {
    const { nodes, edges, loopId } = makeBodyGraph();
    const plan = computeLoopBody(loopId, nodes, edges);
    const sub = buildBodyWorkflow(loopId, plan);

    // 体内部连线保持：a→m、b→m 与计划中的对象同一引用
    expect(plan.bodyEdges).toHaveLength(2);
    for (const bodyEdge of plan.bodyEdges) {
      expect(sub.edges).toContain(bodyEdge);
    }
    expect(sub.edges).toHaveLength(plan.entryIds.length + plan.bodyEdges.length);
    // 不混入 loop 自身出边（L→a / L→b / L→m 是入口选择依据，不进子图）
    expect(sub.edges.every((edge) => edge.source !== loopId && edge.target !== loopId)).toBe(true);

    // 汇点约定：全部汇点保留在子图节点中，且在子图内无出边（逐轮聚合从汇点
    // nodeRuns 读取——collectIterationResult 的数据源必须在场）
    const subNodeIds = new Set(sub.nodes.map((n) => n.id));
    expect(plan.sinkIds).toEqual([asNodeId("m")]);
    for (const sinkId of plan.sinkIds) {
      expect(subNodeIds.has(sinkId)).toBe(true);
    }
    const sinks = new Set(plan.sinkIds);
    expect(sub.edges.every((edge) => !sinks.has(edge.source))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 与 loop runner 子运行同构
 * ------------------------------------------------------------------ */

describe("buildBodyWorkflow：与 loop runner 子运行同构", () => {
  it("同一输入（var.loop）+ 同一 runner 表：直接执行产物与循环体子运行跑出同一路径与输出", async () => {
    const { nodes, edges, loopId } = makeBodyGraph();
    const plan = computeLoopBody(loopId, nodes, edges);
    const loopNode = nodes[1]!;

    // 路径 A：loop runner 的真实子运行（forwardNodeFinish 记录路径）
    const store = new RunVariableStore();
    const subPathA: Array<{ id: NodeId; output: unknown }> = [];
    const runner = createLoopRunner({
      getBodyPlan: () => plan,
      getRunners: () => ({ httpReplay: echoRunner }),
      getStore: () => store,
      forwardNodeFinish: (node, nodeRun) => subPathA.push({ id: node.id, output: nodeRun.output }),
    });
    const loopOutput = await runner(loopNode, null, makeRunCtx());
    // 单汇点聚合原样：loop output = [汇点 m 的 output]
    expect(loopOutput).toEqual([subPathA.find((r) => r.id === asNodeId("m"))!.output]);

    // 路径 B：Task 22「重跑该轮」的同款构造——buildBodyWorkflow 产物直接执行
    // （同一输入：var.loop = 本轮迭代变量；同一 runner 表；标准下游选择器）
    const sub = buildBodyWorkflow(loopId, plan);
    const storeB = new RunVariableStore();
    storeB.set(LOOP_VARIABLE_NAME, { item: "x", index: 0 });
    const subPathB: Array<{ id: NodeId; output: unknown }> = [];
    const summary = await executeWorkflow(sub, {
      runners: { httpReplay: echoRunner },
      variables: () => storeB.snapshot(),
      selectDownstream: createWorkflowDownstreamSelector(sub.nodes, sub.edges),
      onNodeFinish: (node, nodeRun) => subPathB.push({ id: node.id, output: nodeRun.output }),
    });

    expect(summary.status).toBe("success");
    // 虚拟入口不属于体节点路径（体路径不含 id 为虚拟入口的记录）
    const pathB = subPathB.filter((r) => r.id !== sub.entryId);
    // 同构：节点集合与逐节点输出完全一致（并发下 a/b 顺序不定，按 id 排序对比）
    const normalize = (path: Array<{ id: NodeId; output: unknown }>) =>
      [...path].sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.output]);
    expect(normalize(pathB)).toEqual(normalize(subPathA));
    expect(pathB.map((r) => r.id).sort()).toEqual([asNodeId("a"), asNodeId("b"), asNodeId("m")]);
    // join 语义同构：两条路径中汇点 m 都在 a、b 之后结算
    for (const path of [subPathA, pathB]) {
      const ids = path.map((r) => r.id);
      expect(ids.indexOf(asNodeId("m"))).toBe(ids.length - 1);
    }
  });
});
