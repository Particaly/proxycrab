import { describe, expect, it } from "vitest";
import { executeWorkflow, validateWorkflowGraph, type NodeRunner } from "./executor";
import { createSetVariableRunner } from "./logic-nodes";
import { RunVariableStore } from "./run-variables";
import {
  asEdgeId,
  asNodeId,
  asRunId,
  asWorkflowId,
  type NodeConfig,
  type WorkflowEdge,
  type WorkflowNode,
} from "./types";

/**
 * 执行器的引用短码（refId）键位测试（M15-T2）：
 * 多上游聚合入参与模板上下文的 node 键改走 refId（缺省回退内部 id——存量
 * 数据 / 既有用例行为不变）、重复短码判非法、setVariable 赋值项 from='node'
 * 以内部 id 经 refKeyOf 换算定位输出表。
 */

let idSeq = 0;

/** 构造画布节点（refId 可选；type 可覆盖为 start） */
function makeNode(
  id: string,
  config: NodeConfig = {},
  refId?: string,
  type: WorkflowNode["type"] = "httpReplay",
): WorkflowNode {
  return {
    id: asNodeId(id),
    type,
    position: { x: 0, y: 0 },
    config,
    ...(refId !== undefined ? { refId } : {}),
  };
}

/** 构造连线 */
function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return { id: asWorkflowId(`wf-${++idSeq}`), nodes, edges };
}

/** 捕获指定节点运行上下文的 runner 工厂：记录 (input, templateContext.node) */
function captureRunner(
  captured: Array<{ input: unknown; node: Record<string, unknown> }>,
  targetId: string,
): NodeRunner {
  return async (node, input, runCtx) => {
    if (node.id === asNodeId(targetId)) {
      captured.push({ input, node: runCtx.nodeCtx.templateContext.node });
    }
    return `out-${node.refId ?? node.id}`;
  };
}

describe("executeWorkflow：refId 键位（M15-T2）", () => {
  it("join（多上游）聚合入参与模板上下文的 node 键 = 上游 refId", async () => {
    const captured: Array<{ input: unknown; node: Record<string, unknown> }> = [];
    const workflow = makeWorkflow(
      [
        makeNode("start", {}, undefined, "start"),
        makeNode("uuid-a", {}, "alpha"),
        makeNode("uuid-b", {}, "bravo"),
        makeNode("joiner", {}, "join1"),
      ],
      [
        makeEdge("start", "uuid-a"),
        makeEdge("start", "uuid-b"),
        makeEdge("uuid-a", "joiner"),
        makeEdge("uuid-b", "joiner"),
      ],
    );
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: captureRunner(captured, "joiner") },
    });
    expect(summary.status).toBe("success");
    // 多上游 input 形状 { [<refId>]: output }；模板上下文 node 键同为 refId
    expect(captured).toHaveLength(1);
    expect(captured[0]!.input).toEqual({ alpha: "out-alpha", bravo: "out-bravo" });
    // 模板上下文 node 键 = refId（joiner 尚在执行、不在自身上下文；start 输出 null）
    expect(captured[0]!.node).toEqual({
      start: null,
      alpha: "out-alpha",
      bravo: "out-bravo",
    });
  });

  it("上游无 refId（存量 / 既有用例形态）时键回退内部 id，行为与既有逐字节一致", async () => {
    const captured: Array<{ input: unknown; node: Record<string, unknown> }> = [];
    const workflow = makeWorkflow(
      [makeNode("start", {}, undefined, "start"), makeNode("n1"), makeNode("n2")],
      [makeEdge("start", "n1"), makeEdge("n1", "n2")],
    );
    await executeWorkflow(workflow, { runners: { httpReplay: captureRunner(captured, "n2") } });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.input).toBe("out-n1"); // 单上游原样透传
    expect(captured[0]!.node).toEqual({ start: null, n1: "out-n1" });
  });

  it("混合：有短码的上游按短码、无短码的上游按内部 id（同一 join 内共存）", async () => {
    const captured: Array<{ input: unknown; node: Record<string, unknown> }> = [];
    const workflow = makeWorkflow(
      [
        makeNode("start", {}, undefined, "start"),
        makeNode("legacy"),
        makeNode("modern", {}, "modeRn"),
        makeNode("j", {}, "jj"),
      ],
      [
        makeEdge("start", "legacy"),
        makeEdge("start", "modern"),
        makeEdge("legacy", "j"),
        makeEdge("modern", "j"),
      ],
    );
    await executeWorkflow(workflow, { runners: { httpReplay: captureRunner(captured, "j") } });
    expect(captured[0]!.input).toEqual({ legacy: "out-legacy", modeRn: "out-modeRn" });
  });

  it("validateWorkflowGraph：重复 refId 判非法；缺失 refId（含既有图形状）不报短码问题", () => {
    const errors = validateWorkflowGraph(
      [
        makeNode("s", {}, undefined, "start"),
        makeNode("a", {}, "sameX"),
        makeNode("b", {}, "sameX"),
        makeNode("c"),
      ],
      [],
    );
    expect(errors).toContain("存在重复的节点引用短码 refId：sameX");
    // 除该条重复短码错误外无其它短码问题
    expect(errors.filter((message) => message.includes("refId"))).toHaveLength(1);
    expect(
      validateWorkflowGraph(
        [makeNode("s", {}, undefined, "start"), makeNode("a"), makeNode("b")],
        [],
      ),
    ).toEqual([]);
  });

  it("重复 refId 的流程在运行前置校验被拒（不启动任何节点）", async () => {
    const workflow = makeWorkflow([makeNode("a", {}, "dupXX"), makeNode("b", {}, "dupXX")], []);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: captureRunner([], "a") },
    });
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("dupXX");
    expect(Object.keys(summary.nodeRuns)).toHaveLength(0);
  });
});

describe("setVariable 赋值项 from=node 的 refId 换算（M15-T2）", () => {
  it("config 持内部 id 时经 refKeyOf 定位 refId 键的输出表", async () => {
    const store = new RunVariableStore();
    const setVariable = createSetVariableRunner({ getStore: () => store });
    const workflow = makeWorkflow(
      [
        makeNode("start", {}, undefined, "start"),
        makeNode("uuid-up", {}, "upRef"),
        makeNode(
          "setter",
          {
            assignments: [
              { name: "token", from: "node", node: asNodeId("uuid-up"), path: "body.token" },
            ],
          },
          "setRef",
          "setVariable",
        ),
      ],
      [makeEdge("start", "uuid-up"), makeEdge("uuid-up", "setter")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async () => ({ body: { token: "t-1" } }),
        setVariable,
      },
    });
    expect(summary.status).toBe("success");
    expect(store.snapshot()["token"]).toBe("t-1");
  });

  it("refKeyOf 缺省（直调 runner 的旧上下文）按原样查找，行为不变", async () => {
    const runner = createSetVariableRunner({ getStore: () => new RunVariableStore() });
    const node = makeNode("setter", {
      assignments: [{ name: "x", from: "node", node: asNodeId("up"), path: "" }],
    });
    await expect(
      runner(node, null, {
        runId: asRunId("run"),
        nodeCtx: { nodeOutputs: { up: "v" }, templateContext: { node: {}, input: null } },
      }),
    ).resolves.toBe(null);
  });
});
