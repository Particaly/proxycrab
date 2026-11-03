import { describe, expect, it } from "vitest";
import { RunVariableStore } from "./run-variables";
import { buildTemplateContext, createRunId, executeWorkflow } from "./executor";
import type { NodeRunContext, NodeRunner } from "./executor";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import type {
  LoopIterationRecord,
  LoopIterationsSummary,
  NodeConfig,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "./types";
import { isTruncatedSnapshot, TRUNCATION_MARKER } from "./run-record";
import {
  LOOP_ITERATIONS_MAX_RECORDS,
  LOOP_ITERATION_SNAPSHOT_BYTES,
  LOOP_VARIABLE_NAME,
  computeLoopBody,
  createLoopRunner,
} from "./logic-nodes";

/**
 * M13-T9 循环逐迭代调试：loop runner 的逐迭代明细（NodeRun.iterations 快照
 * 扩展槽）、进度上报（reportLoopProgress 基线 + 逐轮完成序）、明细体积收敛
 * （M5-T5 capSnapshot 惯例）与条数截断。既有 logic-nodes.* / executor.* 测试
 * 锁定执行语义，不在此重复；本文件只锁定 M13-T9 新增行为与向后兼容
 * （无循环体时不写扩展槽）。
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

/** 构造 runner 直调用的节点级上下文（与执行器同款 templateContext 构建） */
function makeRunCtx(signal?: AbortSignal): NodeRunContext {
  const nodeOutputs: Record<string, unknown> = {};
  return {
    runId: createRunId(),
    signal,
    nodeCtx: { nodeOutputs, templateContext: buildTemplateContext(nodeOutputs, null) },
  };
}

/** 读取 var.loop 的回显 runner（体节点：output = { echo: var.loop }） */
const echoLoopRunner: NodeRunner = async (_node, _input, runCtx) => ({
  echo: (runCtx.nodeCtx.templateContext.var ?? {})[LOOP_VARIABLE_NAME],
});

/** 组装 loop runner（默认回显体；deps 可逐项覆盖） */
function setupLoopRunner(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  overrides: {
    runners?: Partial<Record<WorkflowNodeType, NodeRunner>>;
    getStore?: () => RunVariableStore | undefined;
    signal?: AbortSignal;
  } = {},
) {
  const progress: Array<{ node: WorkflowNode; done: number; total: number; capped: boolean }> = [];
  const store = new RunVariableStore();
  const runCtx = makeRunCtx(overrides.signal);
  const runner = createLoopRunner({
    getBodyPlan: (loopNodeId) => computeLoopBody(loopNodeId, nodes, edges),
    getRunners: () => overrides.runners ?? { httpReplay: echoLoopRunner },
    getStore: () => overrides.getStore?.() ?? store,
    reportLoopProgress: (node, p) => progress.push({ node, ...p }),
  });
  return { runner, runCtx, progress, store };
}

/** 读取 runCtx 扩展槽里的迭代摘要（断言前校验形状） */
function iterationsOf(runCtx: NodeRunContext): LoopIterationsSummary {
  const summary = runCtx.snapshotExtras?.iterations;
  expect(summary).toBeDefined();
  return summary as LoopIterationsSummary;
}

/* ------------------------------------------------------------------ *
 * 逐迭代明细：成功 / 失败 / 取消 / 上限截断
 * ------------------------------------------------------------------ */

describe("createLoopRunner：逐迭代明细落库（M13-T9）", () => {
  it("成功轮逐轮记录：index / item / status / 聚合输出 / 耗时，进度按完成序上报", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: ["x", "y"] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const { runner, runCtx, progress } = setupLoopRunner(nodes, edges);

    const output = await runner(nodes[1]!, null, runCtx);
    expect(output).toEqual([{ echo: { item: "x", index: 0 } }, { echo: { item: "y", index: 1 } }]);

    const summary = iterationsOf(runCtx);
    expect(summary.total).toBe(2);
    expect(summary.done).toBe(2);
    expect(summary.capped).toBe(false);
    expect(summary.truncated).toBe(false);
    expect(summary.records.map((r) => [r.index, r.item, r.status])).toEqual([
      [0, "x", "success"],
      [1, "y", "success"],
    ]);
    // 聚合输出与 loop output 的逐轮元素一致；耗时为非负数、startedAt 为时间戳
    expect(summary.records[0]!.output).toEqual({ echo: { item: "x", index: 0 } });
    for (const record of summary.records) {
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.startedAt).toBeGreaterThan(0);
      expect(record.error).toBeUndefined();
    }
    // 进度：基线 done=0 一次 + 每轮结算一次（串行下共 3 次报告）
    expect(progress.map((p) => [p.done, p.total, p.capped])).toEqual([
      [0, 2, false],
      [1, 2, false],
      [2, 2, false],
    ]);
    expect(progress.every((p) => p.node.id === asNodeId("L"))).toBe(true);
  });

  it("失败轮记录 failed 明细（错误文案带轮次）后上抛，成功轮明细不丢失", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [0, 1, 2] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const boomRunner: NodeRunner = async (_node, _input, runCtx) => {
      const loop = (runCtx.nodeCtx.templateContext.var ?? {})[LOOP_VARIABLE_NAME] as {
        index: number;
      };
      if (loop.index === 1) throw new Error("体节点爆炸");
      return { echo: loop };
    };
    const { runner, runCtx } = setupLoopRunner(nodes, edges, {
      runners: { httpReplay: boomRunner },
    });

    const error = await runner(nodes[1]!, null, runCtx).then(
      () => {
        throw new Error("should reject");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain("第 2 轮循环体执行失败");
    expect(error.message).toContain("体节点爆炸");

    const summary = iterationsOf(runCtx);
    expect(summary.done).toBe(2); // 第 1 轮成功 + 第 2 轮失败（第 3 轮未启动）
    expect(summary.records.map((r) => [r.index, r.status])).toEqual([
      [0, "success"],
      [1, "failed"],
    ]);
    const failedRecord = summary.records[1]!;
    expect(failedRecord.output).toBeNull();
    expect(failedRecord.error).toBe("第 2 轮循环体执行失败：节点 a 执行失败：体节点爆炸");
  });

  it("取消：已开始但被取消的轮记 cancelled 明细，未启动轮无记录", async () => {
    const controller = new AbortController();
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [0, 1, 2] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    // 第 2 轮体内触发取消：子运行在本轮节点完成后按取消语义收尾（summary = cancelled）
    const abortOnRound1: NodeRunner = async (_node, _input, runCtx) => {
      const loop = (runCtx.nodeCtx.templateContext.var ?? {})[LOOP_VARIABLE_NAME] as {
        index: number;
      };
      if (loop.index === 1) controller.abort();
      return { echo: loop };
    };
    const { runner, runCtx } = setupLoopRunner(nodes, edges, {
      runners: { httpReplay: abortOnRound1 },
      signal: controller.signal,
    });

    const output = await runner(nodes[1]!, null, runCtx);
    // 取消停迭代：已完成的第 1 轮照常聚合，第 2 轮（cancelled）不进 output
    expect(output).toEqual([{ echo: { item: 0, index: 0 } }]);

    const summary = iterationsOf(runCtx);
    expect(summary.total).toBe(3);
    expect(summary.done).toBe(2);
    expect(summary.records.map((r) => [r.index, r.status])).toEqual([
      [0, "success"],
      [1, "cancelled"],
    ]);
    expect(summary.records[1]!.output).toBeNull();
  });

  it("上限截断：total 为实际轮数并置 capped，明细只含实际执行的轮次", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [0, 1, 2, 3, 4], maxIterations: 2 }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const { runner, runCtx, progress } = setupLoopRunner(nodes, edges);

    const output = (await runner(nodes[1]!, null, runCtx)) as unknown[];
    expect(output).toHaveLength(2);

    const summary = iterationsOf(runCtx);
    expect(summary.total).toBe(2);
    expect(summary.done).toBe(2);
    expect(summary.capped).toBe(true);
    expect(summary.records).toHaveLength(2);
    // 进度如实携带 capped 标注（宿主可展示「上限截断」）
    expect(progress.every((p) => p.capped && p.total === 2)).toBe(true);
  });

  it("明细条数截断：超过 LOOP_ITERATIONS_MAX_RECORDS 时保留 index 前段并置 truncated", async () => {
    const items = Array.from({ length: LOOP_ITERATIONS_MAX_RECORDS + 50 }, (_, i) => i);
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items, maxIterations: items.length }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const { runner, runCtx } = setupLoopRunner(nodes, edges);

    await runner(nodes[1]!, null, runCtx);

    const summary = iterationsOf(runCtx);
    expect(summary.total).toBe(items.length);
    expect(summary.done).toBe(items.length);
    expect(summary.truncated).toBe(true);
    expect(summary.records).toHaveLength(LOOP_ITERATIONS_MAX_RECORDS);
    // 保留 index 升序的前段（第 1 ~ 100 轮）
    expect(summary.records[0]!.index).toBe(0);
    expect(summary.records[summary.records.length - 1]!.index).toBe(
      LOOP_ITERATIONS_MAX_RECORDS - 1,
    );
  });

  it("零轮迭代（items 为空数组、循环体有效）也写入摘要（已迭代 0 / 0）", async () => {
    const nodes = [makeNode("s", "start"), makeNode("L", "loop", { items: [] }), makeNode("a")];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const { runner, runCtx, progress } = setupLoopRunner(nodes, edges);

    const output = await runner(nodes[1]!, null, runCtx);
    expect(output).toEqual([]);

    const summary = iterationsOf(runCtx);
    expect(summary).toEqual({ total: 0, done: 0, capped: false, records: [], truncated: false });
    // 零轮迭代无进度上报（无「已迭代 0 / 0」的广播价值）
    expect(progress).toHaveLength(0);
  });

  it("空循环体（无出边）：不写入扩展槽（向后兼容，快照形状不变）", async () => {
    const nodes = [makeNode("s", "start"), makeNode("L", "loop", { items: [1] })];
    const edges = [makeEdge("s", "L")];
    const { runner, runCtx } = setupLoopRunner(nodes, edges);

    const output = await runner(nodes[1]!, null, runCtx);
    expect(output).toEqual([]);
    expect(runCtx.snapshotExtras).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 明细体积收敛（M5-T5 capSnapshot 惯例）与真并发进度
 * ------------------------------------------------------------------ */

describe("createLoopRunner：明细体积收敛与并发进度（M13-T9）", () => {
  it("超限 item / output 按字节收敛（对象为 TruncatedSnapshot 包装、字符串带截断标记）", async () => {
    const bigItem = { payload: "i".repeat(LOOP_ITERATION_SNAPSHOT_BYTES * 2) };
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [bigItem] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const bigEcho: NodeRunner = async () => "o".repeat(LOOP_ITERATION_SNAPSHOT_BYTES * 2);
    const { runner, runCtx } = setupLoopRunner(nodes, edges, { runners: { httpReplay: bigEcho } });

    await runner(nodes[1]!, null, runCtx);

    const record: LoopIterationRecord = iterationsOf(runCtx).records[0]!;
    // 对象 item → TruncatedSnapshot 包装（读侧可识别、originalBytes 保留）
    expect(isTruncatedSnapshot(record.item)).toBe(true);
    expect((record.item as { originalBytes: number }).originalBytes).toBeGreaterThan(
      LOOP_ITERATION_SNAPSHOT_BYTES,
    );
    // 字符串 output → 截断文本 + 标记
    expect(typeof record.output).toBe("string");
    expect(record.output as string).toContain(TRUNCATION_MARKER);
    expect((record.output as string).length).toBeLessThanOrEqual(
      LOOP_ITERATION_SNAPSHOT_BYTES + 64,
    );
  });

  it("真并发：进度按完成序递增（释放顺序与轮次序相反），明细按 index 升序整理", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [0, 1, 2], concurrency: 3 }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    // 每轮独立栅栏：3 个体节点全部在飞后，按 2 → 1 → 0 的顺序释放（与轮次序
    // 相反）——轮间以真实定时器间隔，保证完成序确定可断言
    const resolvers: Array<() => void> = [];
    const gatesAwait = [0, 1, 2].map(
      (i) =>
        new Promise<void>((resolve) => {
          resolvers[i] = resolve;
        }),
    );
    let arrived = 0;
    const allArrived = new Promise<void>((resolve) => {
      const check = () => {
        if (arrived === 3) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    const gateRunner: NodeRunner = async (_node, _input, runCtx) => {
      const loop = (runCtx.nodeCtx.templateContext.var ?? {})[LOOP_VARIABLE_NAME] as {
        index: number;
      };
      arrived += 1;
      await gatesAwait[loop.index];
      return { echo: loop };
    };
    const finishedOrder: number[] = [];
    const store = new RunVariableStore();
    const runCtx = makeRunCtx();
    const progress: number[] = [];
    const runner = createLoopRunner({
      getBodyPlan: (loopNodeId) => computeLoopBody(loopNodeId, nodes, edges),
      getRunners: () => ({ httpReplay: gateRunner }),
      getStore: () => store,
      forwardNodeFinish: (_node, nodeRun) => {
        finishedOrder.push((nodeRun.output as { echo: { index: number } }).echo.index);
      },
      reportLoopProgress: (_node, p) => progress.push(p.done),
    });

    const outputPromise = runner(nodes[1]!, null, runCtx) as Promise<
      Array<{ echo: { index: number } }>
    >;
    await allArrived;
    // 按完成序 2 → 1 → 0 释放，轮间等待真实定时器保证顺序确定
    for (const index of [2, 1, 0]) {
      resolvers[index]?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const output = await outputPromise;
    // 全部 3 轮完成（栅栏保证并发）
    expect(output).toHaveLength(3);
    // 体节点按完成序结束：2 → 1 → 0
    expect(finishedOrder).toEqual([2, 1, 0]);
    // 进度按完成序递增：基线 0 → 1 → 2 → 3（不与轮次序绑定）
    expect(progress).toEqual([0, 1, 2, 3]);
    // 明细按 index 升序整理（与完成序无关）
    const summary = iterationsOf(runCtx);
    expect(summary.records.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(summary.done).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 执行器集成：NodeRun.iterations 经快照扩展槽并入
 * ------------------------------------------------------------------ */

describe("executeWorkflow 集成：loop 节点快照携带逐迭代明细（M13-T9）", () => {
  it("成功运行：summary.nodeRuns[loop].iterations 完整落入（progress 字段齐全）", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: ["a", "b"] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const store = new RunVariableStore();
    const summary = await executeWorkflow(
      { id: asWorkflowId("wf-loop-debug"), nodes, edges },
      {
        runners: {
          loop: createLoopRunner({
            getBodyPlan: (loopNodeId) => computeLoopBody(loopNodeId, nodes, edges),
            getRunners: () => ({ httpReplay: echoLoopRunner }),
            getStore: () => store,
          }),
          httpReplay: echoLoopRunner,
        },
        variables: () => store.snapshot(),
        selectDownstream: (() => "all") as never,
      },
    );

    expect(summary.status).toBe("success");
    const loopRun = summary.nodeRuns[asNodeId("L")]!;
    expect(loopRun.status).toBe("success");
    const iterations = loopRun.iterations;
    expect(iterations).toBeDefined();
    expect(iterations!.total).toBe(2);
    expect(iterations!.done).toBe(2);
    expect(iterations!.records.map((r) => [r.index, r.status])).toEqual([
      [0, "success"],
      [1, "success"],
    ]);
    // 非 loop 节点快照不携带 iterations 字段（向后兼容）
    expect(summary.nodeRuns[asNodeId("a")]?.iterations).toBeUndefined();
  });

  it("循环体失败：loop 节点 failed 快照同样携带已结算轮次的明细", async () => {
    const nodes = [makeNode("s", "start"), makeNode("L", "loop", { items: [0, 1] }), makeNode("a")];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const boomRunner: NodeRunner = async (_node, _input, runCtx) => {
      const loop = (runCtx.nodeCtx.templateContext.var ?? {})[LOOP_VARIABLE_NAME] as {
        index: number;
      };
      if (loop.index === 1) throw new Error("第二轮失败");
      return { echo: loop };
    };
    const store = new RunVariableStore();
    const summary = await executeWorkflow(
      { id: asWorkflowId("wf-loop-debug-fail"), nodes, edges },
      {
        runners: {
          loop: createLoopRunner({
            getBodyPlan: (loopNodeId) => computeLoopBody(loopNodeId, nodes, edges),
            getRunners: () => ({ httpReplay: boomRunner }),
            getStore: () => store,
          }),
          httpReplay: boomRunner,
        },
        variables: () => store.snapshot(),
        selectDownstream: (() => "all") as never,
      },
    );

    expect(summary.status).toBe("failed");
    const loopRun = summary.nodeRuns[asNodeId("L")]!;
    expect(loopRun.status).toBe("failed");
    expect(loopRun.iterations!.records.map((r) => [r.index, r.status])).toEqual([
      [0, "success"],
      [1, "failed"],
    ]);
    expect(loopRun.iterations!.done).toBe(2);
  });
});
