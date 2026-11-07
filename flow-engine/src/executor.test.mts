import { describe, expect, it, vi } from "vitest";
import {
  IllegalTransitionError,
  NODE_STATUS_TRANSITIONS,
  NodeStatusMachine,
  RUN_STATUS_TRANSITIONS,
  RunStatusMachine,
  aggregateInputs,
  buildRunRecordShell,
  buildTemplateContext,
  createRunId,
  executeWorkflow,
  validateWorkflowGraph,
  type NodeExecutionStatus,
  type NodeRunContext,
  type NodeRunner,
  type RunSummary,
} from "./executor";
import {
  asEdgeId,
  asNodeId,
  asRunId,
  asWorkflowId,
  type NodeConfig,
  type RunStatus,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./types";

/**
 * M5-T1 执行器骨架测试：
 * runId 生成、run/节点两级状态机迁移矩阵、图校验、input 聚合、模板上下文、
 * 串行拓扑执行（线性 / 分支 / join 聚合）、缺 runner 兜底、图不合法、
 * 取消（pre-aborted 与 mid-run）、skipped 传播、事件与落库外壳。
 * 全部用 fake runner 注入，不发请求、不落库、不碰 UI。
 */

/* ---------------- 测试图构造工具 ---------------- */

let idSeq = 0;

/** 构造画布节点（默认 httpReplay 类型，config 可覆盖） */
function makeNode(
  id: string,
  type: WorkflowNodeType = "httpReplay",
  config: NodeConfig = {},
): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
}

/** 构造连线（id 由 source→target 拼出） */
function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

/** 构造可执行工作流入参 */
function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return { id: asWorkflowId(`wf-${++idSeq}`), nodes, edges };
}

/** 便捷构造：只回传成功值的最简 runner */
function okRunner(output: unknown): NodeRunner {
  return async () => output;
}

/** 从摘要中按字符串 id 取节点执行快照 */
function runOf(summary: RunSummary, nodeId: string) {
  return summary.nodeRuns[asNodeId(nodeId)];
}

/** 构造一个已处于指定状态的 run 级状态机（沿合法路径前进） */
function runMachineIn(status: RunStatus): RunStatusMachine {
  const machine = new RunStatusMachine();
  if (status !== "running") machine.transition(status);
  return machine;
}

/** 构造一个已处于指定状态的节点级状态机（沿合法路径前进） */
function nodeMachineIn(status: NodeExecutionStatus): NodeStatusMachine {
  const machine = new NodeStatusMachine();
  if (status === "running" || status === "success" || status === "failed") {
    machine.transition("running");
  }
  if (status === "success" || status === "failed") machine.transition(status);
  if (status === "skipped") machine.transition("skipped");
  return machine;
}

/* ---------------- runId 生成 ---------------- */

describe("createRunId", () => {
  it("缺省生成器产出 UUID 形态的 RunId，且每次不同", () => {
    const id = createRunId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(createRunId()).not.toBe(id);
  });

  it("注入生成器时使用注入值", () => {
    let calls = 0;
    expect(createRunId(() => `fixed-${++calls}`)).toBe("fixed-1");
    expect(createRunId(() => "again")).toBe("again");
  });
});

/* ---------------- 状态机迁移矩阵 ---------------- */

describe("RunStatusMachine（run 级状态机）", () => {
  it("迁移表：running 可迁往三个终态，终态为空", () => {
    expect(RUN_STATUS_TRANSITIONS.running).toEqual(["success", "failed", "cancelled"]);
    expect(RUN_STATUS_TRANSITIONS.success).toEqual([]);
    expect(RUN_STATUS_TRANSITIONS.failed).toEqual([]);
    expect(RUN_STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  it("完整迁移矩阵：迁移表内允许，表外一律抛 IllegalTransitionError", () => {
    const statuses = Object.keys(RUN_STATUS_TRANSITIONS) as RunStatus[];
    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = RUN_STATUS_TRANSITIONS[from].includes(to);
        if (allowed) {
          expect(() => runMachineIn(from).transition(to), `${from} → ${to}`).not.toThrow();
          continue;
        }
        let thrown: unknown;
        try {
          runMachineIn(from).transition(to);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(IllegalTransitionError);
        const illegal = thrown as IllegalTransitionError;
        expect(illegal.kind).toBe("run");
        expect(illegal.from).toBe(from);
        expect(illegal.to).toBe(to);
      }
    }
  });

  it("running → success 后为终态，任何再迁移都抛错", () => {
    const machine = new RunStatusMachine();
    expect(machine.status).toBe("running");
    expect(machine.finished).toBe(false);
    expect(machine.transition("success")).toBe("success");
    expect(machine.status).toBe("success");
    expect(machine.finished).toBe(true);
    expect(() => machine.transition("running")).toThrow(IllegalTransitionError);
    expect(() => machine.transition("success")).toThrow(/非法的运行状态迁移/);
  });
});

describe("NodeStatusMachine（节点级状态机）", () => {
  it("迁移表：pending → running|skipped，running → success|failed|skipped", () => {
    expect(NODE_STATUS_TRANSITIONS.pending).toEqual(["running", "skipped"]);
    expect(NODE_STATUS_TRANSITIONS.running).toEqual(["success", "failed", "skipped"]);
    expect(NODE_STATUS_TRANSITIONS.success).toEqual([]);
    expect(NODE_STATUS_TRANSITIONS.failed).toEqual([]);
    expect(NODE_STATUS_TRANSITIONS.skipped).toEqual([]);
  });

  it("完整迁移矩阵：迁移表内允许，表外一律抛 IllegalTransitionError", () => {
    const statuses = Object.keys(NODE_STATUS_TRANSITIONS) as NodeExecutionStatus[];
    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = NODE_STATUS_TRANSITIONS[from].includes(to);
        if (allowed) {
          expect(() => nodeMachineIn(from).transition(to), `${from} → ${to}`).not.toThrow();
          continue;
        }
        let thrown: unknown;
        try {
          nodeMachineIn(from).transition(to);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(IllegalTransitionError);
        expect((thrown as IllegalTransitionError).kind).toBe("node");
        expect((thrown as IllegalTransitionError).from).toBe(from);
        expect((thrown as IllegalTransitionError).to).toBe(to);
      }
    }
  });

  it("pending 不允许直达 success / failed；running 不允许回 pending 或原地迁移", () => {
    expect(() => new NodeStatusMachine().transition("success")).toThrow(/pending → success/);
    expect(() => new NodeStatusMachine().transition("failed")).toThrow(/pending → failed/);
    const machine = new NodeStatusMachine();
    machine.transition("running");
    expect(() => machine.transition("pending")).toThrow(/running → pending/);
    expect(() => machine.transition("running")).toThrow(/running → running/);
  });

  it("pending → skipped 合法（前序失败 / 取消时未执行节点直接跳过）", () => {
    const machine = new NodeStatusMachine();
    expect(machine.settled).toBe(false);
    expect(machine.transition("skipped")).toBe("skipped");
    expect(machine.settled).toBe(true);
    expect(() => machine.transition("running")).toThrow(/skipped → running/);
  });
});

/* ---------------- 图校验 ---------------- */

describe("validateWorkflowGraph", () => {
  it("合法线性图返回空错误列表", () => {
    const errors = validateWorkflowGraph(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    expect(errors).toEqual([]);
  });

  it("缺少开始节点", () => {
    const errors = validateWorkflowGraph([makeNode("a")], []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("缺少开始节点");
  });

  it("多个开始节点（多入口工作流合法：校验层不再报错）", () => {
    const errors = validateWorkflowGraph([makeNode("s1", "start"), makeNode("s2", "start")], []);
    expect(errors).toEqual([]);
  });

  it("连线引用不存在的节点", () => {
    const errors = validateWorkflowGraph(
      [makeNode("s", "start"), makeNode("a")],
      [makeEdge("s", "ghost"), makeEdge("phantom", "a")],
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("ghost");
    expect(errors[1]).toContain("phantom");
  });

  it("重复节点 id", () => {
    const errors = validateWorkflowGraph(
      [makeNode("s", "start"), makeNode("a"), makeNode("a")],
      [],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("重复的节点 id");
  });
});

/* ---------------- input 聚合与模板上下文 ---------------- */

describe("aggregateInputs", () => {
  it("无上游 → null", () => {
    expect(aggregateInputs({})).toBeNull();
  });

  it("单一直接上游 → output 原样透传（保持引用）", () => {
    const output = { token: "t-1", list: [1, 2] };
    expect(aggregateInputs({ "n-1": output })).toBe(output);
  });

  it("多上游 → { [nodeId]: output } 聚合对象", () => {
    const outA = { a: 1 };
    const outB = "raw-string";
    expect(aggregateInputs({ a: outA, b: outB })).toEqual({ a: outA, b: outB });
  });
});

describe("buildTemplateContext", () => {
  it("产出 { node, input } 形状；node 为浅拷贝", () => {
    const outputs = { a: { v: 1 }, b: "x" };
    const input = { hello: "world" };
    const ctx = buildTemplateContext(outputs, input);
    expect(ctx).toEqual({ node: { a: { v: 1 }, b: "x" }, input });
    expect(ctx.input).toBe(input);
    expect(ctx.node).not.toBe(outputs);
    ctx.node.a = "mutated";
    expect(outputs.a).toEqual({ v: 1 });
  });

  it("input 缺省为 null", () => {
    expect(buildTemplateContext({})).toEqual({ node: {}, input: null });
  });
});

/* ---------------- 串行拓扑执行 ---------------- */

describe("executeWorkflow：线性图", () => {
  it("start → a → b 串行执行，单上游 output 原样透传为 input", async () => {
    const order: string[] = [];
    const received: Record<string, unknown> = {};
    const aOut = { token: "t-1" };
    const bOut = { done: true };
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node, input) => {
          order.push(node.id);
          received[node.id] = input;
          return node.id === "a" ? aOut : bOut;
        },
      },
    });

    expect(order).toEqual(["a", "b"]);
    expect(summary.status).toBe("success");
    expect(summary.error).toBeUndefined();
    expect(summary.workflowId).toBe(workflow.id);
    expect(summary.runId).toBeTruthy();

    // start：内置 runner（未注册也执行），input = null（无上游），output = null
    const startRun = runOf(summary, "s");
    expect(startRun.status).toBe("success");
    expect(startRun.input).toBeNull();
    expect(startRun.output).toBeNull();

    // a：单上游 start → input = start 的 output（null）；b：单上游 a → input = a 的 output（原引用）
    expect(received.a).toBeNull();
    expect(received.b).toBe(aOut);
    const aRun = runOf(summary, "a");
    const bRun = runOf(summary, "b");
    expect(aRun.input).toBeNull();
    expect(aRun.output).toBe(aOut);
    expect(bRun.output).toBe(bOut);

    // NodeRun 形状：时间戳与耗时已填充
    for (const id of ["s", "a", "b"]) {
      const run = runOf(summary, id);
      expect(run.status).toBe("success");
      expect(typeof run.startedAt).toBe("number");
      expect(run.startedAt).toBeGreaterThan(0);
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(run.error).toBeUndefined();
    }
  });

  it("事件按 start/a 顺序发出；onRunFinish 载荷与返回值是同一对象", async () => {
    const onNodeStart = vi.fn();
    const onNodeFinish = vi.fn();
    const onRunFinish = vi.fn();
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("out-a") },
      onNodeStart,
      onNodeFinish,
      onRunFinish,
    });

    expect(onNodeStart.mock.calls.map((call) => call[0].id)).toEqual(["s", "a"]);
    expect(onNodeStart.mock.calls[0][1]).toBeNull(); // start 的 input
    expect(onNodeStart.mock.calls[1][1]).toBeNull(); // a 的 input（start output = null）
    expect(onNodeFinish.mock.calls.map((call) => call[0].id)).toEqual(["s", "a"]);
    expect(onNodeFinish.mock.calls[0][1]).toBe(runOf(summary, "s"));
    expect(onRunFinish).toHaveBeenCalledTimes(1);
    expect(onRunFinish.mock.calls[0][0]).toBe(summary);
  });

  it("runner 收到 runCtx：runId / signal / nodeCtx（输出快照 + 模板上下文）", async () => {
    const controller = new AbortController();
    const contexts: NodeRunContext[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const summary = await executeWorkflow(workflow, {
      signal: controller.signal,
      runners: {
        httpReplay: async (node, _input, runCtx) => {
          contexts.push(runCtx);
          return `${node.id}-out`;
        },
      },
    });

    expect(contexts).toHaveLength(2);
    const [ctxA, ctxB] = contexts;
    // 运行环境信息
    expect(ctxA.runId).toBe(summary.runId);
    expect(ctxA.signal).toBe(controller.signal);
    // a 执行时：唯一已成功节点是 start（output null）
    expect(ctxA.nodeCtx.nodeOutputs).toEqual({ s: null });
    expect(ctxA.nodeCtx.templateContext).toEqual({ node: { s: null }, input: null });
    // b 执行时：能拿到全部已成功节点输出，模板上下文 = { node: 输出表, input: 当前入参 }
    expect(ctxB.nodeCtx.nodeOutputs).toEqual({ s: null, a: "a-out" });
    expect(ctxB.nodeCtx.templateContext.node).toEqual({ s: null, a: "a-out" });
    expect(ctxB.nodeCtx.templateContext.input).toBe("a-out");
  });

  it("buildRunRecordShell 产出 RunRecord 形状外壳（不含 id / startedAt / finishedAt）", async () => {
    const workflow = makeWorkflow([makeNode("s", "start")], []);
    const summary = await executeWorkflow(workflow);
    const shell = buildRunRecordShell(summary);
    expect(shell).toEqual({
      workflowId: summary.workflowId,
      status: "success",
      trigger: "manual",
      nodeRuns: summary.nodeRuns,
    });
    expect("id" in shell).toBe(false);
    expect("startedAt" in shell).toBe(false);
    expect("finishedAt" in shell).toBe(false);
    expect("error" in shell).toBe(false);
    expect(buildRunRecordShell(summary, "debug").trigger).toBe("debug");
  });
});

describe("executeWorkflow：分支与 join", () => {
  it("简单分支：多下游按连线数组顺序逐个串行执行", async () => {
    const order: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "b"), makeEdge("s", "a"), makeEdge("a", "c")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          order.push(node.id);
          return node.id;
        },
      },
    });

    expect(summary.status).toBe("success");
    // s 成功后 b、a 按连线顺序入队；a 完成后 c 才可运行
    expect(order).toEqual(["b", "a", "c"]);
    // 每个分支下游拿到的都是 start 的 output（null 原样透传）
    expect(runOf(summary, "b").input).toBeNull();
    expect(runOf(summary, "a").input).toBeNull();
    expect(runOf(summary, "c").input).toBe("a");
  });

  it("多上游 join：全部上游成功后执行，runner 收到 { [nodeId]: output } 聚合 input", async () => {
    const received: Record<string, unknown> = {};
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "c"), makeEdge("b", "c")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node, input) => {
          received[node.id] = input;
          return { from: node.id };
        },
      },
    });

    expect(summary.status).toBe("success");
    expect(received.c).toEqual({
      a: { from: "a" },
      b: { from: "b" },
    });
    const cRun = runOf(summary, "c");
    expect(cRun.status).toBe("success");
    expect(cRun.input).toEqual(received.c);
  });

  it("环状图不死循环：环上节点因 join 语义永远不满足而 skipped，运行正常结束", async () => {
    const order: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "a"), makeEdge("a", "c")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          order.push(node.id);
          return node.id;
        },
      },
    });
    // a 需同时等 s 与环上前驱 b（Kahn 语义），b 又等 a → 环上节点全部 skipped，绝不死循环
    expect(order).toEqual([]);
    expect(summary.status).toBe("success");
    expect(runOf(summary, "s").status).toBe("success");
    expect(runOf(summary, "a").status).toBe("skipped");
    expect(runOf(summary, "b").status).toBe("skipped");
    expect(runOf(summary, "c").status).toBe("skipped");
  });

  it("重复连线不导致节点重复执行（每节点至多执行一次）", async () => {
    const order: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("a", "b")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          order.push(node.id);
          return node.id;
        },
      },
    });
    expect(order).toEqual(["a", "b"]);
    expect(summary.status).toBe("success");
  });

  it("自环节点等待自身输出、永远不可运行 → skipped（join 语义的诚实结果）", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a")],
      [makeEdge("s", "a"), makeEdge("a", "a")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: async (node) => node.id },
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "a").status).toBe("skipped");
  });

  it("从 start 不可达的孤立节点标 skipped", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("lonely")],
      [makeEdge("s", "a")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("x") },
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "a").status).toBe("success");
    expect(runOf(summary, "lonely").status).toBe("skipped");
    expect(runOf(summary, "lonely").input).toBeNull();
    expect(runOf(summary, "lonely").output).toBeNull();
  });
});

describe("executeWorkflow：runner 解析与缺 runner", () => {
  it("未注册类型的节点按 failed 处理，错误信息为「暂不支持的节点类型」，下游 skipped", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const summary = await executeWorkflow(workflow, { runners: {} });

    expect(summary.status).toBe("failed");
    const aRun = runOf(summary, "a");
    expect(aRun.status).toBe("failed");
    expect(aRun.error).toContain("暂不支持的节点类型");
    expect(aRun.output).toBeNull();
    expect(runOf(summary, "b").status).toBe("skipped");
    expect(summary.error).toContain("节点 a 执行失败");
  });

  it("defaultRunner 兜底未注册类型", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      defaultRunner: okRunner("fallback"),
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "a").output).toBe("fallback");
  });

  it("runners[type] 优先于 defaultRunner；start 内置 runner 不被 defaultRunner 抢占", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("explicit") },
      defaultRunner: okRunner("fallback"),
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "a").output).toBe("explicit");
    expect(runOf(summary, "s").output).toBeNull();
  });

  it("runner 抛错（Error 与非 Error）→ 节点 failed，error 为消息文本", async () => {
    const summary = await executeWorkflow(
      makeWorkflow(
        [makeNode("s", "start"), makeNode("a"), makeNode("b")],
        [makeEdge("s", "a"), makeEdge("a", "b")],
      ),
      {
        runners: {
          httpReplay: async (node) => {
            if (node.id === "a") throw new Error("boom");
            return "never";
          },
        },
      },
    );
    expect(summary.status).toBe("failed");
    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "a").error).toBe("boom");
    expect(runOf(summary, "b").status).toBe("skipped");

    // 非 Error 抛出值：String() 兜底为消息文本
    const summary2 = await executeWorkflow(
      makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]),
      {
        runners: {
          httpReplay: async () => {
            throw "plain-string";
          },
        },
      },
    );
    expect(runOf(summary2, "a").error).toBe("plain-string");
  });
});

describe("executeWorkflow：图不合法", () => {
  it("缺开始节点 → failed + 明确错误，不执行任何节点，无节点事件", async () => {
    const onNodeStart = vi.fn();
    const onNodeFinish = vi.fn();
    const onRunFinish = vi.fn();
    const workflow = makeWorkflow([makeNode("a")], []);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("x") },
      onNodeStart,
      onNodeFinish,
      onRunFinish,
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("缺少开始节点");
    expect(summary.nodeRuns).toEqual({});
    expect(onNodeStart).not.toHaveBeenCalled();
    expect(onNodeFinish).not.toHaveBeenCalled();
    expect(onRunFinish).toHaveBeenCalledWith(summary);
  });

  it("连线引用未知节点 → failed + 明确错误", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a")],
      [makeEdge("s", "ghost")],
    );
    const summary = await executeWorkflow(workflow);
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("ghost");
    expect(Object.keys(summary.nodeRuns)).toEqual([]);
  });
});

describe("executeWorkflow：多 start 入口选择", () => {
  const multiStartWorkflow = () =>
    makeWorkflow(
      [makeNode("s1", "start"), makeNode("a"), makeNode("s2", "start"), makeNode("b")],
      [makeEdge("s1", "a"), makeEdge("s2", "b")],
    );

  it("未指定 entryNodeId → 入口歧义 failed，错误列出全部 start id，不执行任何节点", async () => {
    const onNodeStart = vi.fn();
    const summary = await executeWorkflow(multiStartWorkflow(), {
      runners: { httpReplay: okRunner("x") },
      onNodeStart,
    });
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("存在多个开始节点");
    expect(summary.error).toContain("s1");
    expect(summary.error).toContain("s2");
    expect(summary.error).toContain("entryNodeId");
    expect(summary.nodeRuns).toEqual({});
    expect(onNodeStart).not.toHaveBeenCalled();
  });

  it("指定 entryNodeId → 只执行选中入口链条，另一 start 链条收尾 skipped", async () => {
    const summary = await executeWorkflow(multiStartWorkflow(), {
      runners: { httpReplay: okRunner("x") },
      entryNodeId: asNodeId("s2"),
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "s2").status).toBe("success");
    expect(runOf(summary, "b").status).toBe("success");
    expect(runOf(summary, "s1").status).toBe("skipped");
    expect(runOf(summary, "a").status).toBe("skipped");
    expect(runOf(summary, "s1").input).toBeNull();
    expect(runOf(summary, "a").output).toBeNull();
  });

  it("entryNodeId 指向不存在的节点 → 建档前 failed", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("x") },
      entryNodeId: asNodeId("ghost"),
    });
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("入口节点不存在");
    expect(summary.nodeRuns).toEqual({});
  });

  it("entryNodeId 指向非 start 节点 → 建档前 failed", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("x") },
      entryNodeId: asNodeId("a"),
    });
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("不是开始节点");
    expect(summary.nodeRuns).toEqual({});
  });

  it("单 start 图显式传 entryNodeId → 与缺省行为一致", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("x") },
      entryNodeId: asNodeId("s"),
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "s").status).toBe("success");
    expect(runOf(summary, "a").status).toBe("success");
  });

  it("双入口汇合同一后继（join）：单入口运行时未选链条提前 skipped，join 正常释放", async () => {
    // j 汇聚两条入口链（s1→a→j、s2→b→j）：join 门槛要求全部直接上游结算，
    // 未选入口的链条必须在调度前标 skipped，否则 j 永不释放（多入口核心回归）。
    const workflow = makeWorkflow(
      [
        makeNode("s1", "start"),
        makeNode("a"),
        makeNode("s2", "start"),
        makeNode("b"),
        makeNode("j"),
      ],
      [makeEdge("s1", "a"), makeEdge("a", "j"), makeEdge("s2", "b"), makeEdge("b", "j")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: okRunner("x") },
      entryNodeId: asNodeId("s1"),
    });
    expect(summary.status).toBe("success");
    expect(runOf(summary, "a").status).toBe("success");
    expect(runOf(summary, "j").status).toBe("success");
    expect(runOf(summary, "s2").status).toBe("skipped");
    expect(runOf(summary, "b").status).toBe("skipped");
  });
});

describe("executeWorkflow：skipped 传播", () => {
  it("中间节点失败 → 其全部下游（含更深层）skipped，run failed", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "c")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          if (node.id === "a") throw new Error("upstream-down");
          return node.id;
        },
      },
    });

    expect(summary.status).toBe("failed");
    expect(runOf(summary, "s").status).toBe("success");
    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "b").status).toBe("skipped");
    expect(runOf(summary, "c").status).toBe("skipped");
    // skipped 节点的快照形状：未真正执行，无耗时
    const bRun = runOf(summary, "b");
    expect(bRun.input).toBeNull();
    expect(bRun.output).toBeNull();
    expect(bRun.durationMs).toBe(0);
    // 运行级错误摘要指明失败节点
    expect(summary.error).toBe("节点 a 执行失败：upstream-down");
  });

  // M15-T6 基线翻转：主循环改就绪集批量并发后，a 与 b 同批起跑——stop 语义的
  // 停机窗口为当前批：失败节点结算后，同批在途节点（b）让其自然结算（请求已
  // 发出、结果照常记录），但不再调度任何下游、不再取下一批（join 仍 skipped）
  it("join 场景：失败节点同批在途兄弟自然结算，join 不再执行（stop 窗口=当前批）", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("join")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "join"), makeEdge("b", "join")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          if (node.id === "a") throw new Error("a-fail");
          return node.id;
        },
      },
    });
    expect(summary.status).toBe("failed");
    expect(runOf(summary, "a").status).toBe("failed");
    // b 与 a 同批起跑（就绪集快照），在途结果自然结算为 success
    expect(runOf(summary, "b").status).toBe("success");
    // join 不再调度（stop 下失败后不启动任何新节点）
    expect(runOf(summary, "join").status).toBe("skipped");
  });
});

describe("executeWorkflow：取消", () => {
  it("pre-aborted：不执行任何节点，全部 skipped，run cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const onNodeStart = vi.fn();
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      signal: controller.signal,
      runners: { httpReplay: okRunner("x") },
      onNodeStart,
    });

    expect(summary.status).toBe("cancelled");
    expect(summary.error).toBe("运行已被取消");
    expect(onNodeStart).not.toHaveBeenCalled();
    expect(runOf(summary, "s").status).toBe("skipped");
    expect(runOf(summary, "a").status).toBe("skipped");
  });

  it("mid-run：当前节点完成即停（结果保留），剩余 skipped，run cancelled", async () => {
    const controller = new AbortController();
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "c")],
    );
    const summary = await executeWorkflow(workflow, {
      signal: controller.signal,
      runners: {
        httpReplay: async (node) => {
          if (node.id === "a") controller.abort(); // a 执行期间触发取消
          return `${node.id}-out`;
        },
      },
    });

    expect(summary.status).toBe("cancelled");
    // a 在取消触发前已入队、正常完成，结果照常记录
    expect(runOf(summary, "s").status).toBe("success");
    expect(runOf(summary, "a").status).toBe("success");
    expect(runOf(summary, "a").output).toBe("a-out");
    expect(runOf(summary, "b").status).toBe("skipped");
    expect(runOf(summary, "c").status).toBe("skipped");
  });

  it("取消后不再启动新节点（即使已随前序一起入队）", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("s", "b")],
    );
    const summary = await executeWorkflow(workflow, {
      signal: controller.signal,
      runners: {
        httpReplay: async (node) => {
          executed.push(node.id);
          if (node.id === "a") controller.abort();
          return node.id;
        },
      },
    });
    // b 已随 a 一起入队，但 a 完成后检测到取消，b 未启动
    expect(executed).toEqual(["a"]);
    expect(summary.status).toBe("cancelled");
    expect(runOf(summary, "b").status).toBe("skipped");
  });

  it("节点失败与取消同时发生：取消优先，run cancelled，节点记 failed", async () => {
    const controller = new AbortController();
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const summary = await executeWorkflow(workflow, {
      signal: controller.signal,
      runners: {
        httpReplay: async (node) => {
          if (node.id === "a") {
            controller.abort();
            throw new Error("late-failure");
          }
          return null;
        },
      },
    });
    expect(summary.status).toBe("cancelled");
    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "a").error).toBe("late-failure");
  });
});

describe("executeWorkflow：failPolicy 预留", () => {
  it('failPolicy "continue" 尚未实现，传入即抛错（M5-T4 接入）', async () => {
    const workflow = makeWorkflow([makeNode("s", "start")], []);
    await expect(executeWorkflow(workflow, { failPolicy: "continue" })).rejects.toThrow(
      /failPolicy "continue" 尚未实现/,
    );
  });

  it('failPolicy 缺省与 "stop" 正常执行', async () => {
    const workflow = makeWorkflow([makeNode("s", "start")], []);
    await expect(executeWorkflow(workflow, { failPolicy: "stop" })).resolves.toMatchObject({
      status: "success",
    });
  });
});

/* ---------------- asRunId 等品牌工具在本模块的协作（导入自 @/types） ---------------- */

describe("id 品牌工具协作", () => {
  it("asRunId 仅为编译期标记，运行时保持原字符串", () => {
    expect(asRunId("run-1")).toBe("run-1");
  });
});
