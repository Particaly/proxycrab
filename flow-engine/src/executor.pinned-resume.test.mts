import { describe, expect, it, vi } from "vitest";
import { computeUpstreamClosure, executeWorkflow, type NodeRunner } from "./executor";
import {
  asEdgeId,
  asNodeId,
  asWorkflowId,
  type NodeConfig,
  type NodeRun,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./types";

/**
 * M10-T5 执行器增量测试：固定输出（pinnedOutputs）与指定节点重跑（resume）。
 * 全部 fake runner 注入，纯逻辑断言，不碰存储 / 网络 / UI。
 */

/* ---------------- 测试图构造工具（与 executor.test.ts 同款口径） ---------------- */

let idSeq = 0;

function makeNode(
  id: string,
  type: WorkflowNodeType = "httpReplay",
  config: NodeConfig = {},
): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
}

function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return { id: asWorkflowId(`wf-pin-${++idSeq}`), nodes, edges };
}

/** 计数 runner：记录被调用的节点 id（固定 / 预置节点不应出现在其中） */
function makeCountingRunner(called: string[], output: unknown = { ok: true }): NodeRunner {
  return vi.fn(async (node: WorkflowNode) => {
    called.push(node.id);
    return output;
  });
}

/* ---------------- 固定输出（pinnedOutputs） ---------------- */

describe("executeWorkflow：pinnedOutputs（M10-T5 固定输出）", () => {
  it("命中固定的节点不执行 runner，output 取固定值，下游照常执行并聚合固定值", async () => {
    // start → A → B；A 固定输出 { token: 'pinned' }，B 正常执行
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const called: string[] = [];
    const started: string[] = [];
    const finished: Array<{ id: string; output: unknown }> = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      pinnedOutputs: { [asNodeId("a")]: { token: "pinned" } },
      onNodeStart: (node) => started.push(node.id),
      onNodeFinish: (node, nodeRun) => finished.push({ id: node.id, output: nodeRun.output }),
    });

    expect(summary.status).toBe("success");
    expect(called).toEqual(["b"]); // A 被固定跳过，B 正常执行
    expect(started).toEqual(["s", "a", "b"]); // 事件照发（画布运行态口径一致）
    expect(finished.find((entry) => entry.id === "a")?.output).toEqual({ token: "pinned" });
    // B 聚合到 A 的固定输出（单上游透传）
    expect(summary.nodeRuns[asNodeId("b")].input).toEqual({ token: "pinned" });
    // 固定节点快照：success、耗时 0
    const pinnedRun = summary.nodeRuns[asNodeId("a")];
    expect(pinnedRun.status).toBe("success");
    expect(pinnedRun.durationMs).toBe(0);
  });

  it("null 是合法固定值；undefined 键不视为固定（节点照常执行）", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const called: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      pinnedOutputs: { [asNodeId("a")]: null, [asNodeId("b")]: undefined },
    });

    expect(summary.status).toBe("success");
    expect(called).toEqual(["b"]); // a 固定为 null 跳过；b 键值为 undefined 照常执行
    expect(summary.nodeRuns[asNodeId("a")].output).toBeNull();
  });

  it("固定节点仍受 join 语义约束：上游未结算前不入队（上游链路固定时逐级瞬时结算）", async () => {
    // start → A → B → C；A、B 都固定——C 仍按序可见两级固定输出聚合
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "c")],
    );
    const called: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      pinnedOutputs: {
        [asNodeId("a")]: { v: 1 },
        [asNodeId("b")]: { v: 2 },
      },
    });

    expect(summary.status).toBe("success");
    expect(called).toEqual(["c"]);
    // C 聚合到 B 的固定输出（B 是直接上游；B 自己的入参来自 A 的固定值）
    expect(summary.nodeRuns[asNodeId("c")].input).toEqual({ v: 2 });
    expect(summary.nodeRuns[asNodeId("b")].input).toEqual({ v: 1 });
  });
});

/* ---------------- 指定节点重跑（resume） ---------------- */

describe("computeUpstreamClosure（M10-T5 上游闭包）", () => {
  it("线性图返回全部传递上游；起点无上游返回空数组", () => {
    const nodes = [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "c")];
    expect(computeUpstreamClosure(nodes, edges, asNodeId("c"))).toEqual([
      asNodeId("b"),
      asNodeId("a"),
      asNodeId("s"),
    ]);
    expect(computeUpstreamClosure(nodes, edges, asNodeId("b"))).toEqual([
      asNodeId("a"),
      asNodeId("s"),
    ]);
    expect(computeUpstreamClosure(nodes, edges, asNodeId("a"))).toEqual([asNodeId("s")]);
    expect(computeUpstreamClosure(nodes, edges, asNodeId("s"))).toEqual([]);
  });

  it("菱形图去重：两路汇聚的上游只出现一次", () => {
    // s → a, s → b, a → c, b → c：c 的闭包 = [a, b, s]（s 只记一次）
    const nodes = [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "c"), makeEdge("b", "c")];
    const closure = computeUpstreamClosure(nodes, edges, asNodeId("c"));
    expect(closure.filter((id) => id === asNodeId("s"))).toHaveLength(1);
    expect(new Set(closure)).toEqual(new Set([asNodeId("a"), asNodeId("b"), asNodeId("s")]));
  });
});

describe("executeWorkflow：resume（M10-T5 指定节点重跑）", () => {
  it("从指定节点起跑：上游闭包预置输出与快照（runner 不再调用），起点及其下游重新执行", async () => {
    // start → A → B → C；从 B 重跑：A 预置（沿用源运行快照），B、C 执行
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "c")],
    );
    const called: string[] = [];
    const sourceARun: NodeRun = {
      status: "success",
      input: null,
      output: { token: "from-source-run" },
      startedAt: 1000,
      durationMs: 40,
    };
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      resume: {
        fromNode: asNodeId("b"),
        outputs: { [asNodeId("s")]: null, [asNodeId("a")]: { token: "from-source-run" } },
        nodeRuns: {
          [asNodeId("s")]: {
            status: "success",
            input: null,
            output: null,
            startedAt: 0,
            durationMs: 0,
          },
          [asNodeId("a")]: sourceARun,
        },
      },
    });

    expect(summary.status).toBe("success");
    expect(called).toEqual(["b", "c"]);
    // A 的快照沿用源运行（入参 / 返回值 / 耗时原样保留）
    expect(summary.nodeRuns[asNodeId("a")]).toEqual(sourceARun);
    // B 聚合到 A 的预置输出
    expect(summary.nodeRuns[asNodeId("b")].input).toEqual({ token: "from-source-run" });
    // C 照常执行并消费 B 的新输出
    expect(summary.nodeRuns[asNodeId("c")].status).toBe("success");
  });

  it("与起点无连通关系的旁支不执行、收尾标 skipped", async () => {
    // start → A → B；start → X（旁支）：从 B 重跑时 X 不执行
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("x")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("s", "x")],
    );
    const called: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      resume: {
        fromNode: asNodeId("b"),
        outputs: { [asNodeId("s")]: null, [asNodeId("a")]: { v: 1 } },
        nodeRuns: {},
      },
    });

    expect(summary.status).toBe("success");
    expect(called).toEqual(["b"]);
    expect(summary.nodeRuns[asNodeId("x")].status).toBe("skipped");
  });

  it("起点不存在于当前流程：整单判 failed，不执行任何节点", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const called: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      resume: { fromNode: asNodeId("ghost"), outputs: {}, nodeRuns: {} },
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("ghost");
    expect(called).toEqual([]);
    expect(Object.keys(summary.nodeRuns)).toHaveLength(0);
  });

  it("上游闭包缺输出：整单判 failed 并逐个列出缺输出的节点，不执行任何节点", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const called: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      // 只预置了 s，缺 a（源运行中 a 失败 / 跳过的场景）
      resume: { fromNode: asNodeId("b"), outputs: { [asNodeId("s")]: null }, nodeRuns: {} },
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("a");
    expect(called).toEqual([]);
    expect(Object.keys(summary.nodeRuns)).toHaveLength(0);
  });

  it("resume 与固定输出可叠加：起点自身被固定时同样直接结算", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const called: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: makeCountingRunner(called) },
      pinnedOutputs: { [asNodeId("b")]: { pinned: true } },
      resume: {
        fromNode: asNodeId("b"),
        outputs: { [asNodeId("s")]: null, [asNodeId("a")]: { v: 1 } },
        nodeRuns: {},
      },
    });

    expect(summary.status).toBe("success");
    expect(called).toEqual([]); // 起点被固定 → 无节点真实执行
    expect(summary.nodeRuns[asNodeId("b")].output).toEqual({ pinned: true });
  });
});
