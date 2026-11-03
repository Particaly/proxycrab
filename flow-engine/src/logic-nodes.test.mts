import { describe, expect, it } from "vitest";
import { RunVariableStore } from "./run-variables";
import { buildTemplateContext, createRunId, executeWorkflow } from "./executor";
import type { NodeRunContext, NodeRunner, RunSummary } from "./executor";
import { renderTemplate } from "./template";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import type {
  NodeConfig,
  NodeId,
  NodeRun,
  VariableAssignment,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "./types";
import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  LOOP_ENTRY_ID_SUFFIX,
  LOOP_HARD_MAX_ITERATIONS,
  LOOP_VARIABLE_NAME,
  MAX_DELAY_DURATION_MS,
  computeLoopBody,
  createConditionRunner,
  createDelayRunner,
  createLoopRunner,
  createSetVariableRunner,
  createWorkflowDownstreamSelector,
  isConditionBranchOutput,
  resolveAssignmentValue,
  resolveLoopItems,
  resolveLoopMaxIterations,
  runConditionExpression,
} from "./logic-nodes";

/**
 * M7-T1 逻辑节点测试（纯逻辑层）：条件分支（表达式求值 / truthy / 错误分类 /
 * 分支路由与汇合节点放行）、循环（items 解析 / 上限收敛 / 循环体子图 / 逐轮
 * 执行 / 聚合 / 嵌套变量恢复 / 取消与失败）、延时（上限 / 取消）、变量赋值
 * （四种来源 / 路径提取 / 顺序可见性 / 失败语义），以及四种节点经
 * executeWorkflow 全链路的集成语义（skipped / 运行期变量可见性 / 嵌套快照）。
 * 全部零环境依赖，不发请求、不落库、不碰 chrome.*。
 */

/* ---------------- 测试图构造工具 ---------------- */

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
  return { id: asWorkflowId("wf-logic"), nodes, edges };
}

/** 构造 runner 直调用的节点级上下文（与执行器同款 templateContext 构建） */
function makeRunCtx(
  input: unknown,
  vars?: Record<string, unknown>,
  signal?: AbortSignal,
): NodeRunContext {
  const nodeOutputs: Record<string, unknown> = {};
  return {
    runId: createRunId(),
    signal,
    nodeCtx: { nodeOutputs, templateContext: buildTemplateContext(nodeOutputs, input, vars) },
  };
}

/** 记录型假 runner：执行时记录（节点 id, 可见的 var 表, input），返回固定输出 */
function recordingRunner(
  log: Array<{ nodeId: NodeId; vars: Record<string, unknown>; input: unknown }>,
  output: (node: WorkflowNode, vars: Record<string, unknown>) => unknown = () => null,
): NodeRunner {
  return async (node, input, runCtx) => {
    const vars = (runCtx.nodeCtx.templateContext.var ?? {}) as Record<string, unknown>;
    log.push({ nodeId: node.id, vars, input });
    return output(node, vars);
  };
}

/* ------------------------------------------------------------------ *
 * 条件表达式求值
 * ------------------------------------------------------------------ */

describe("runConditionExpression（条件表达式求值）", () => {
  it("返回值 truthy / falsy 判定：布尔 / 数字 / 字符串 / null / 未 return", () => {
    expect(runConditionExpression("return true", { input: null, vars: {} })).toEqual({
      ok: true,
      value: true,
    });
    expect(runConditionExpression("return 0", { input: null, vars: {} })).toEqual({
      ok: true,
      value: 0,
    });
    expect(runConditionExpression('return "x"', { input: null, vars: {} })).toEqual({
      ok: true,
      value: "x",
    });
    expect(runConditionExpression("return null", { input: null, vars: {} })).toEqual({
      ok: true,
      value: null,
    });
    // 未 return → undefined（合法返回，truthy 判定为假）
    expect(runConditionExpression("", { input: null, vars: {} })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("形参 input / vars 可用（vars 与模板命名空间 var 同源）", () => {
    const result = runConditionExpression('return input.status === 200 && vars.env === "dev"', {
      input: { status: 200 },
      vars: { env: "dev" },
    });
    expect(result).toEqual({ ok: true, value: true });
  });

  it("错误分类：syntax / runtime / timeout / invalid-return", () => {
    const syntax = runConditionExpression("return ===", { input: null, vars: {} });
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) expect(syntax.error.kind).toBe("syntax");

    const runtime = runConditionExpression("return notDefined", { input: null, vars: {} });
    expect(runtime.ok).toBe(false);
    if (!runtime.ok) expect(runtime.error.kind).toBe("runtime");

    // __checkDeadline 主动中断：死循环在截止后真正被打断
    const timeout = runConditionExpression(
      "while (true) { __checkDeadline() }",
      { input: null, vars: {} },
      30,
    );
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.error.kind).toBe("timeout");

    const invalidReturn = runConditionExpression("return () => 1", { input: null, vars: {} });
    expect(invalidReturn.ok).toBe(false);
    if (!invalidReturn.ok) expect(invalidReturn.error.kind).toBe("invalid-return");
  });

  it("入参净化：原型污染键被剔除后进入脚本", () => {
    const malicious = JSON.parse('{"a": 1, "__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;
    const result = runConditionExpression("return Object.keys(input).length === 1", {
      input: malicious,
      vars: {},
    });
    expect(result).toEqual({ ok: true, value: true });
  });
});

describe("createConditionRunner（condition 节点 runner）", () => {
  it("输出 { branch, value } 形态：truthy → true 分支", async () => {
    const runner = createConditionRunner();
    const node = makeNode("c1", "condition", { expression: "return input.n > 1" });
    const output = (await runner(node, { n: 5 }, makeRunCtx({ n: 5 }))) as {
      branch: string;
      value: unknown;
    };
    expect(output.branch).toBe("true");
    expect(output.value).toBe(true);
    expect(isConditionBranchOutput(output)).toBe(true);
  });

  it("空表达式恒走 false 分支（未配置目标时整体直通的前提）", async () => {
    const runner = createConditionRunner();
    const node = makeNode("c1", "condition", {});
    const output = (await runner(node, null, makeRunCtx(null))) as { branch: string };
    expect(output.branch).toBe("false");
  });

  it("脚本错误包装为 ScriptExecutionError（节点 failed，kind 保留）", async () => {
    const runner = createConditionRunner();
    const node = makeNode("c1", "condition", { expression: "return ===" });
    await expect(runner(node, null, makeRunCtx(null))).rejects.toMatchObject({ kind: "syntax" });
  });

  it("非分支输出不被 isConditionBranchOutput 识别（类型守卫）", () => {
    expect(isConditionBranchOutput({ branch: "true" })).toBe(true);
    expect(isConditionBranchOutput({ branch: "other" })).toBe(false);
    expect(isConditionBranchOutput({ status: 200 })).toBe(false);
    expect(isConditionBranchOutput(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 延时（delay）
 * ------------------------------------------------------------------ */

describe("createDelayRunner（delay 节点 runner）", () => {
  it("等待后透传 input（同一引用）", async () => {
    const runner = createDelayRunner();
    const node = makeNode("d1", "delay", { durationMs: 15 });
    const input = { payload: 1 };
    const output = await runner(node, input, makeRunCtx(input));
    expect(output).toBe(input);
  });

  it("缺省 / 非法 / 负数时长按 0 处理（立即透传）", async () => {
    const runner = createDelayRunner();
    for (const durationMs of [undefined, -5, Number.NaN]) {
      const node = makeNode("d1", "delay", { durationMs });
      const output = await runner(node, "in", makeRunCtx("in"));
      expect(output).toBe("in");
    }
  });

  it("时长超出上限（5 分钟）→ 抛错（节点 failed）", async () => {
    const runner = createDelayRunner();
    const node = makeNode("d1", "delay", { durationMs: MAX_DELAY_DURATION_MS + 1 });
    await expect(runner(node, null, makeRunCtx(null))).rejects.toThrow(/超出上限/);
  });

  it("等待期间取消：reject [cancelled] 前缀错误", async () => {
    const runner = createDelayRunner();
    const controller = new AbortController();
    const node = makeNode("d1", "delay", { durationMs: 10_000 });
    const pending = runner(node, null, makeRunCtx(null, undefined, controller.signal));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow(/^\[cancelled\]/);
  });

  it("等待前已取消：立即 reject", async () => {
    const runner = createDelayRunner();
    const controller = new AbortController();
    controller.abort();
    const node = makeNode("d1", "delay", { durationMs: 10 });
    await expect(
      runner(node, null, makeRunCtx(null, undefined, controller.signal)),
    ).rejects.toThrow(/^\[cancelled\]/);
  });
});

/* ------------------------------------------------------------------ *
 * 变量赋值 / 提取（setVariable）
 * ------------------------------------------------------------------ */

describe("resolveAssignmentValue（赋值项取值）", () => {
  const baseContext = (overrides: Partial<Parameters<typeof resolveAssignmentValue>[1]> = {}) => ({
    input: { body: { token: "t1" } } as unknown,
    nodeOutputs: { up1: { x: "vx" } } as Record<string, unknown>,
    vars: { old: { nested: "nv" } } as Record<string, unknown>,
    templateContext: buildTemplateContext(
      { up1: { x: "vx" } },
      { body: { token: "t1" } },
      { old: { nested: "nv" } },
    ),
    ...overrides,
  });

  it("from=input：按路径取值；空路径取根值", () => {
    expect(
      resolveAssignmentValue({ name: "a", from: "input", path: "body.token" }, baseContext()),
    ).toEqual({
      name: "a",
      value: "t1",
    });
    expect(resolveAssignmentValue({ name: "root", from: "input" }, baseContext()).value).toEqual({
      body: { token: "t1" },
    });
  });

  it("from=node：从指定节点输出取值；节点不在上下文抛错", () => {
    expect(
      resolveAssignmentValue(
        { name: "a", from: "node", node: asNodeId("up1"), path: "x" },
        baseContext(),
      ),
    ).toEqual({
      name: "a",
      value: "vx",
    });
    expect(() =>
      resolveAssignmentValue(
        { name: "a", from: "node", node: asNodeId("ghost"), path: "x" },
        baseContext(),
      ),
    ).toThrow(/不在上下文中/);
    expect(() => resolveAssignmentValue({ name: "a", from: "node" }, baseContext())).toThrow(
      /未指定来源节点/,
    );
  });

  it("from=var：变量表为取值根（path 首段为变量名，与模板 var.<name>.<path> 同语义）", () => {
    expect(
      resolveAssignmentValue({ name: "a", from: "var", path: "old.nested" }, baseContext()),
    ).toEqual({
      name: "a",
      value: "nv",
    });
  });

  it("from=literal：原样写入；字符串支持模板渲染", () => {
    expect(
      resolveAssignmentValue({ name: "a", from: "literal", value: 42 }, baseContext()),
    ).toEqual({ name: "a", value: 42 });
    const rendered = resolveAssignmentValue(
      { name: "a", from: "literal", value: "Bearer {{ var.old.nested }}" },
      baseContext(),
    );
    expect(rendered).toEqual({ name: "a", value: "Bearer nv" });
  });

  it("失败语义：变量名 / 来源非法、路径不存在均抛错", () => {
    expect(() =>
      resolveAssignmentValue({ name: "  ", from: "literal", value: 1 }, baseContext()),
    ).toThrow(/变量名不能为空/);
    expect(() =>
      resolveAssignmentValue(
        { name: "a", from: "nope" as VariableAssignment["from"] },
        baseContext(),
      ),
    ).toThrow(/来源非法/);
    expect(() =>
      resolveAssignmentValue({ name: "a", from: "input", path: "missing.path" }, baseContext()),
    ).toThrow(/路径不存在/);
  });
});

describe("createSetVariableRunner（setVariable 节点 runner）", () => {
  it("按顺序执行赋值项：后一项可读到前一项刚写入的值（顺序可见性）", async () => {
    const store = new RunVariableStore();
    const runner = createSetVariableRunner({ getStore: () => store });
    const node = makeNode("sv1", "setVariable", {
      assignments: [
        { name: "token", from: "input", path: "body.token" },
        { name: "auth", from: "literal", value: "Bearer {{ var.token }}" },
        { name: "echo", from: "var", path: "auth" },
      ],
    });
    const input = { body: { token: "t9" } };
    const output = await runner(node, input, makeRunCtx(input));
    expect(output).toBe(input); // 纯旁路：透传 input（同一引用）
    expect(store.get("token")).toBe("t9");
    expect(store.get("auth")).toBe("Bearer t9");
    expect(store.get("echo")).toBe("Bearer t9");
  });

  it("from=node 从上游输出提取；缺失路径 / 未装配存储按节点失败", async () => {
    const store = new RunVariableStore();
    const runner = createSetVariableRunner({ getStore: () => store });
    const runCtx = makeRunCtx(null);
    runCtx.nodeCtx.nodeOutputs.up1 = { body: { id: 7 } };
    const node = makeNode("sv1", "setVariable", {
      assignments: [{ name: "uid", from: "node", node: asNodeId("up1"), path: "body.id" }],
    });
    await runner(node, null, runCtx);
    expect(store.get("uid")).toBe(7);

    const badPath = makeNode("sv2", "setVariable", {
      assignments: [{ name: "x", from: "input", path: "nope" }],
    });
    await expect(
      createSetVariableRunner({ getStore: () => store })(badPath, null, makeRunCtx(null)),
    ).rejects.toThrow(/路径不存在/);
    await expect(
      createSetVariableRunner({ getStore: () => undefined })(badPath, null, makeRunCtx(null)),
    ).rejects.toThrow(/变量存储不可用/);
  });
});

/* ------------------------------------------------------------------ *
 * 循环体子图（computeLoopBody）
 * ------------------------------------------------------------------ */

describe("computeLoopBody（循环体子图计划）", () => {
  it("线性体：全部入体，入口为 loop 直接下游，汇点为末端", () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop"),
      makeNode("a"),
      makeNode("b"),
      makeNode("c"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a"), makeEdge("a", "b"), makeEdge("b", "c")];
    const plan = computeLoopBody(asNodeId("L"), nodes, edges);
    expect(plan.bodyNodes.map((n) => n.id)).toEqual([asNodeId("a"), asNodeId("b"), asNodeId("c")]);
    expect(plan.entryIds).toEqual([asNodeId("a")]);
    expect(plan.bodyEdges).toEqual([makeEdge("a", "b"), makeEdge("b", "c")]);
    expect(plan.sinkIds).toEqual([asNodeId("c")]);
  });

  it("有外部上游的节点不入体（留给父调度器按 join 执行）", () => {
    const nodes = [
      makeNode("L", "loop"),
      makeNode("a"),
      makeNode("b"),
      makeNode("j"),
      makeNode("E"),
    ];
    const edges = [
      makeEdge("L", "a"),
      makeEdge("a", "b"),
      makeEdge("b", "j"),
      makeEdge("E", "j"), // j 的外部上游
    ];
    const plan = computeLoopBody(asNodeId("L"), nodes, edges);
    expect(plan.bodyNodes.map((n) => n.id)).toEqual([asNodeId("a"), asNodeId("b")]);
    expect(plan.sinkIds).toEqual([asNodeId("b")]); // a→b 在体内，b→j 是出口
    expect(plan.bodyEdges).toEqual([makeEdge("a", "b")]);
  });

  it("菱形：混合入口不接虚拟 start（以体内上游为门槛），纯入口接", () => {
    const nodes = [makeNode("L", "loop"), makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("L", "a"), makeEdge("L", "b"), makeEdge("a", "c"), makeEdge("b", "c")];
    const plan = computeLoopBody(asNodeId("L"), nodes, edges);
    expect(plan.entryIds).toEqual([asNodeId("a"), asNodeId("b")]);
    expect(plan.sinkIds).toEqual([asNodeId("c")]);

    const mixed = [makeNode("L", "loop"), makeNode("a"), makeNode("b")];
    const mixedEdges = [makeEdge("L", "a"), makeEdge("L", "b"), makeEdge("a", "b")];
    const mixedPlan = computeLoopBody(asNodeId("L"), mixed, mixedEdges);
    expect(mixedPlan.entryIds).toEqual([asNodeId("a")]); // b 经 a 入体，非纯入口
    expect(mixedPlan.sinkIds).toEqual([asNodeId("b")]);
  });

  it("体外环 / 自环不入体（下游全部有外部上游 → 空计划 → 直通）", () => {
    // 体内部环：a↔b 互相等待，无法满足入体规则
    const cycleNodes = [makeNode("L", "loop"), makeNode("a"), makeNode("b")];
    const cycleEdges = [makeEdge("L", "a"), makeEdge("a", "b"), makeEdge("b", "a")];
    expect(computeLoopBody(asNodeId("L"), cycleNodes, cycleEdges).bodyNodes).toEqual([]);

    // loop 的下游全部有外部上游：空计划
    const extNodes = [makeNode("L", "loop"), makeNode("x"), makeNode("E")];
    const extEdges = [makeEdge("L", "x"), makeEdge("E", "x")];
    const plan = computeLoopBody(asNodeId("L"), extNodes, extEdges);
    expect(plan.bodyNodes).toEqual([]);

    // 自环边被忽略
    const selfNodes = [makeNode("L", "loop"), makeNode("a")];
    const selfEdges = [makeEdge("L", "L"), makeEdge("L", "a")];
    const selfPlan = computeLoopBody(asNodeId("L"), selfNodes, selfEdges);
    expect(selfPlan.entryIds).toEqual([asNodeId("a")]);
  });

  it("loop 节点不在图中 → 空计划；体节点保持工作流数组原顺序", () => {
    const nodes = [makeNode("b"), makeNode("a"), makeNode("L", "loop")];
    const edges = [makeEdge("L", "a"), makeEdge("a", "b")];
    const plan = computeLoopBody(asNodeId("L"), nodes, edges);
    expect(plan.bodyNodes.map((n) => n.id)).toEqual([asNodeId("b"), asNodeId("a")]); // 原顺序
    expect(computeLoopBody(asNodeId("ghost"), nodes, edges).bodyNodes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 循环配置解析
 * ------------------------------------------------------------------ */

describe("resolveLoopItems / resolveLoopMaxIterations（循环配置解析）", () => {
  const ctx = buildTemplateContext({}, null, { list: [1, 2] });

  it("缺省 / null → 空数组；数组字面量原样使用（同一引用）", () => {
    const array = ["a"];
    expect(resolveLoopItems({ items: array }, ctx)).toBe(array);
    expect(resolveLoopItems({}, ctx)).toEqual([]);
    expect(resolveLoopItems({ items: undefined }, ctx)).toEqual([]);
  });

  it("模板字符串：渲染后 JSON.parse；渲染为空串 → 空数组", () => {
    expect(resolveLoopItems({ items: "{{ var.list }}" }, ctx)).toEqual([1, 2]);
    expect(resolveLoopItems({ items: '["x","y"]' }, ctx)).toEqual(["x", "y"]);
    expect(resolveLoopItems({ items: "{{ var.missing }}" }, ctx)).toEqual([]); // 渲染为空串
  });

  it("解析失败 / 非数组 → 抛错（节点 failed）", () => {
    expect(() => resolveLoopItems({ items: "{not json" }, ctx)).toThrow(/不是合法 JSON/);
    expect(() => resolveLoopItems({ items: '"abc"' }, ctx)).toThrow(/不是 JSON 数组/);
    expect(() => resolveLoopItems({ items: 42 as unknown as string }, ctx)).toThrow(/配置非法/);
  });

  it("迭代上限：缺省 100；非法回退 100；负数回退 100；超硬上限收敛；小数向下取整", () => {
    expect(resolveLoopMaxIterations({})).toBe(DEFAULT_LOOP_MAX_ITERATIONS);
    expect(resolveLoopMaxIterations({ maxIterations: 5 })).toBe(5);
    expect(resolveLoopMaxIterations({ maxIterations: -1 })).toBe(DEFAULT_LOOP_MAX_ITERATIONS);
    expect(resolveLoopMaxIterations({ maxIterations: Number.NaN })).toBe(
      DEFAULT_LOOP_MAX_ITERATIONS,
    );
    expect(resolveLoopMaxIterations({ maxIterations: LOOP_HARD_MAX_ITERATIONS + 500 })).toBe(
      LOOP_HARD_MAX_ITERATIONS,
    );
    expect(resolveLoopMaxIterations({ maxIterations: 7.9 })).toBe(7);
  });
});

/* ------------------------------------------------------------------ *
 * 下游选择器
 * ------------------------------------------------------------------ */

describe("createWorkflowDownstreamSelector（下游选择扩展点的标准装配）", () => {
  const branchOutput = (branch: "true" | "false") => ({ branch, value: branch === "true" ? 1 : 0 });

  it("普通节点 / 条件节点失败输出 → all（既有行为不变）", () => {
    const nodes = [makeNode("s", "start"), makeNode("a"), makeNode("c", "condition")];
    const edges = [makeEdge("s", "a"), makeEdge("a", "c")];
    const select = createWorkflowDownstreamSelector(nodes, edges);
    expect(select(nodes[1]!, null)).toBe("all");
    expect(select(nodes[2]!, null)).toBe("all"); // 失败 output=null → 全部放行
  });

  it("条件节点完全未配置目标 → all（直通）", () => {
    const nodes = [makeNode("c", "condition"), makeNode("t"), makeNode("f")];
    const edges = [makeEdge("c", "t"), makeEdge("c", "f")];
    const select = createWorkflowDownstreamSelector(nodes, edges);
    expect(select(nodes[0]!, branchOutput("true"))).toBe("all");
  });

  it("命中分支放行勾选目标；未勾选进任何分支的下游（汇合节点）两个分支都放行", () => {
    const nodes = [makeNode("c", "condition"), makeNode("t"), makeNode("f"), makeNode("m")];
    const edges = [makeEdge("c", "t"), makeEdge("c", "f"), makeEdge("c", "m")];
    const condition = nodes[0]!;
    const select = createWorkflowDownstreamSelector(nodes, edges);
    const config: NodeConfig = { trueTargets: [asNodeId("t")], falseTargets: [asNodeId("f")] };
    const withConfig = { ...condition, config };

    expect(select(withConfig, branchOutput("true"))).toEqual([asNodeId("t"), asNodeId("m")]);
    expect(select(withConfig, branchOutput("false"))).toEqual([asNodeId("f"), asNodeId("m")]);
  });

  it("loop 节点：排除循环体入口，保留非体下游；空计划 → all", () => {
    const nodes = [
      makeNode("L", "loop"),
      makeNode("a"),
      makeNode("b"),
      makeNode("j"),
      makeNode("E"),
    ];
    const edges = [makeEdge("L", "a"), makeEdge("a", "b"), makeEdge("L", "j"), makeEdge("E", "j")];
    const select = createWorkflowDownstreamSelector(nodes, edges);
    // a 是体入口被排除（由 loop runner 子运行执行）；j 有外部上游不入体 → 放行
    expect(select(nodes[0]!, { results: [] })).toEqual([asNodeId("j")]);

    const lonely = [makeNode("L2", "loop"), makeNode("x"), makeNode("E2")];
    const lonelyEdges = [makeEdge("L2", "x"), makeEdge("E2", "x")];
    expect(createWorkflowDownstreamSelector(lonely, lonelyEdges)(lonely[0]!, null)).toBe("all");
  });
});

/* ------------------------------------------------------------------ *
 * loop runner 直调（逐轮执行 / 聚合 / 嵌套恢复 / 取消 / 失败）
 * ------------------------------------------------------------------ */

/** 构造循环集成夹具：s → L → a → b（a 读 var.loop 返回 item，b 汇总透传） */
function makeLoopFixture(items: NodeConfig["items"], config?: Partial<NodeConfig>) {
  const nodes = [
    makeNode("s", "start"),
    makeNode("L", "loop", { items, ...config }),
    makeNode("a"),
    makeNode("b"),
  ];
  const edges = [makeEdge("s", "L"), makeEdge("L", "a"), makeEdge("a", "b")];
  const workflow = makeWorkflow(nodes, edges);
  const store = new RunVariableStore();
  const executed: Array<{ nodeId: NodeId; vars: Record<string, unknown>; input: unknown }> = [];
  const nested = new Map<NodeId, NodeRun>();
  const finishEvents: NodeId[] = [];
  const runner = recordingRunner(executed, (node, vars) =>
    node.id === asNodeId("b") ? { got: vars[LOOP_VARIABLE_NAME] } : vars[LOOP_VARIABLE_NAME],
  );
  const runners: Partial<Record<WorkflowNodeType, NodeRunner>> = { httpReplay: runner };
  const loopRunner = createLoopRunner({
    getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
    getRunners: () => runners,
    getStore: () => store,
    forwardNodeFinish: (node) => finishEvents.push(node.id),
    collectNestedRun: (id, record) => nested.set(id, record),
  });
  return {
    workflow,
    store,
    executed,
    nested,
    finishEvents,
    loopRunner,
    loopNode: nodes[1] as WorkflowNode,
  };
}

describe("createLoopRunner（loop 节点 runner 直调）", () => {
  it("逐项执行循环体：每轮写入 var.loop（item / index），聚合为逐轮结果数组", async () => {
    const fixture = makeLoopFixture(["x", "y"]);
    const output = (await fixture.loopRunner(
      fixture.loopNode,
      null,
      makeRunCtx(null),
    )) as unknown[];
    expect(fixture.executed.map((e) => e.nodeId)).toEqual([
      asNodeId("a"),
      asNodeId("b"),
      asNodeId("a"),
      asNodeId("b"),
    ]);
    // a（体内首节点）每轮可见当轮的 item / index
    expect(fixture.executed[0]!.vars[LOOP_VARIABLE_NAME]).toEqual({ item: "x", index: 0 });
    expect(fixture.executed[2]!.vars[LOOP_VARIABLE_NAME]).toEqual({ item: "y", index: 1 });
    // 聚合 = 单汇点 b 的逐轮输出
    expect(output).toEqual([{ got: { item: "x", index: 0 } }, { got: { item: "y", index: 1 } }]);
    // 嵌套快照 = 最后一轮记录（a / b 均 success）
    expect(fixture.nested.get(asNodeId("a"))?.status).toBe("success");
    expect(fixture.nested.get(asNodeId("b"))?.output).toEqual({ got: { item: "y", index: 1 } });
    // 事件转发逐节点逐轮触发（虚拟入口不转发）
    expect(fixture.finishEvents).toHaveLength(4);
  });

  it("items 为模板字符串（经模板上下文渲染后解析）", async () => {
    const fixture = makeLoopFixture("{{ node.src.body.ids }}");
    fixture.loopNode.config.items = "{{ node.src.body.ids }}";
    const nodeOutputs: Record<string, unknown> = { src: { body: { ids: [7, 8, 9] } } };
    const runCtx: NodeRunContext = {
      runId: createRunId(),
      nodeCtx: { nodeOutputs, templateContext: buildTemplateContext(nodeOutputs, null) },
    };
    const output = (await fixture.loopRunner(fixture.loopNode, null, runCtx)) as unknown[];
    expect(output).toHaveLength(3);
    expect(fixture.executed.filter((e) => e.nodeId === asNodeId("a"))).toHaveLength(3);
  });

  it("迭代上限：items 超出 maxIterations 按长度截断（不视为错误）", async () => {
    const fixture = makeLoopFixture(["x", "y", "z"], { maxIterations: 2 });
    const output = (await fixture.loopRunner(
      fixture.loopNode,
      null,
      makeRunCtx(null),
    )) as unknown[];
    expect(output).toHaveLength(2);
    expect(fixture.executed.filter((e) => e.nodeId === asNodeId("a"))).toHaveLength(2);
  });

  it("空数据源 / 空循环体：零轮迭代，输出空数组，循环体不执行", async () => {
    const emptyItems = makeLoopFixture([]);
    expect(await emptyItems.loopRunner(emptyItems.loopNode, null, makeRunCtx(null))).toEqual([]);
    expect(emptyItems.executed).toHaveLength(0);
    expect(emptyItems.nested.size).toBe(0);

    // 无出边的 loop：空计划 → 零轮
    const lonely = [makeNode("s", "start"), makeNode("L", "loop", { items: [1] })];
    const lonelyRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, lonely, []),
      getStore: () => new RunVariableStore(),
    });
    expect(await lonelyRunner(lonely[1] as WorkflowNode, null, makeRunCtx(null))).toEqual([]);
  });

  it("items 配置非法 → 抛错（节点 failed）", async () => {
    const fixture = makeLoopFixture("{bad json");
    await expect(fixture.loopRunner(fixture.loopNode, null, makeRunCtx(null))).rejects.toThrow(
      /不是合法 JSON/,
    );
  });

  it("循环体失败：抛错并带轮次序号", async () => {
    const nodes = [makeNode("s", "start"), makeNode("L", "loop", { items: [1, 2] }), makeNode("a")];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const workflow = makeWorkflow(nodes, edges);
    let calls = 0;
    const failing: NodeRunner = async () => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return null;
    };
    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({ httpReplay: failing }),
      getStore: () => new RunVariableStore(),
    });
    await expect(loopRunner(nodes[1] as WorkflowNode, null, makeRunCtx(null))).rejects.toThrow(
      /第 2 轮循环体执行失败：节点 a 执行失败：boom/,
    );
  });

  it("取消感知：子运行取消 → 该轮不聚合，已完成轮次照常保留", async () => {
    const controller = new AbortController();
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [1, 2, 3] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const workflow = makeWorkflow(nodes, edges);
    let calls = 0;
    const aborting: NodeRunner = async () => {
      calls += 1;
      if (calls === 2) controller.abort(); // 第二轮执行中取消（该轮子运行 cancelled → 不聚合）
      return "done";
    };
    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({ httpReplay: aborting }),
      getStore: () => new RunVariableStore(),
    });
    const output = (await loopRunner(
      nodes[1] as WorkflowNode,
      null,
      makeRunCtx(null, undefined, controller.signal),
    )) as unknown[];
    expect(output).toEqual(["done"]); // 第一轮完整保留；第二轮（取消轮）丢弃；第三轮不再执行
    expect(calls).toBe(2);
  });

  it("嵌套循环：内层结束后恢复外层的 var.loop（保存 / 恢复语义）", async () => {
    // 图：s → L1 → L2 → c；外层 items ['o1']，内层 items ['i1','i2']
    const nodes = [
      makeNode("s", "start"),
      makeNode("L1", "loop", { items: ["o1"] }),
      makeNode("L2", "loop", { items: ["i1", "i2"] }),
      makeNode("c"),
    ];
    const edges = [makeEdge("s", "L1"), makeEdge("L1", "L2"), makeEdge("L2", "c")];
    const workflow = makeWorkflow(nodes, edges);
    const store = new RunVariableStore();
    const seenByC: Array<unknown> = [];
    const innerOutputs: unknown[] = [];

    const runners: Partial<Record<WorkflowNodeType, NodeRunner>> = {
      // c 是内层循环体汇点：记录每轮可见的 var.loop（应为内层的 item）
      httpReplay: async (_node, _input, runCtx) => {
        const vars = runCtx.nodeCtx.templateContext.var ?? {};
        innerOutputs.push((vars[LOOP_VARIABLE_NAME] as Record<string, unknown> | undefined)?.item);
        return null;
      },
    };
    // c 的替身观察点：内层循环结束后（外层体内）var.loop 应恢复为外层 item——
    // 通过在 L2 输出之后执行的节点观察。这里直接给 L2 的下游 c 换专用 runner 不可行
    // （runner 按类型注册），改为在内层结束后由外层聚合侧观察 store：
    runners.loop = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => runners,
      getStore: () => store,
    });

    // 外层循环结束后 store 里的 var.loop 应为「最后一轮」（外层 item）——
    // 恢复语义的直接验证点：内层把 var.loop 写成了 { item: 'i2', index: 1 }，
    // 内层结束恢复外层值 { item: 'o1', index: 0 }，外层结束后不再恢复（保留最后一轮）
    const loopRunner = runners.loop;
    await loopRunner(nodes[1] as WorkflowNode, null, makeRunCtx(null));
    expect(seenByC).toEqual([]);
    expect(innerOutputs).toEqual(["i1", "i2"]); // 内层逐轮可见内层 item
    expect(store.get(LOOP_VARIABLE_NAME)).toEqual({ item: "o1", index: 0 }); // 恢复为外层值
  });

  it("无变量存储：循环照常执行（var.loop 不写入，体内引用按缺失告警）", async () => {
    const nodes = [makeNode("s", "start"), makeNode("L", "loop", { items: [1] }), makeNode("a")];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    const workflow = makeWorkflow(nodes, edges);
    const executed: Array<{ nodeId: NodeId; vars: Record<string, unknown>; input: unknown }> = [];
    const loopRunner = createLoopRunner({
      getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
      getRunners: () => ({ httpReplay: recordingRunner(executed) }),
    });
    const output = (await loopRunner(
      nodes[1] as WorkflowNode,
      null,
      makeRunCtx(null),
    )) as unknown[];
    expect(output).toEqual([null]); // 单汇点 a 输出 null
    expect(executed).toHaveLength(1);
    expect(executed[0]!.vars[LOOP_VARIABLE_NAME]).toBeUndefined();
  });

  it("虚拟入口 id 常量：拼接在 loop 节点 id 之后（子运行过滤依据）", () => {
    expect(LOOP_ENTRY_ID_SUFFIX).toBe("::loop-entry");
  });
});

/* ------------------------------------------------------------------ *
 * executeWorkflow 全链路集成（调度语义 + 运行期变量可见性 + 嵌套快照）
 * ------------------------------------------------------------------ */

/** 与 background/run-controller 同款的全链路装配（测试镜像，零环境依赖） */
function wireWorkflow(
  workflow: ReturnType<typeof makeWorkflow>,
  options: {
    initialVars?: Record<string, unknown>;
    httpReplay?: NodeRunner;
    signal?: AbortSignal;
  } = {},
) {
  const store = new RunVariableStore(options.initialVars ?? {});
  const nested = new Map<NodeId, NodeRun>();
  const finishLog: Array<{ nodeId: NodeId; status: NodeRun["status"] }> = [];
  const runners: Partial<Record<WorkflowNodeType, NodeRunner>> = {
    condition: createConditionRunner(),
    delay: createDelayRunner(),
    setVariable: createSetVariableRunner({ getStore: () => store }),
    httpReplay:
      options.httpReplay ??
      (async () => {
        throw new Error("测试未配置 httpReplay runner");
      }),
  };
  runners.loop = createLoopRunner({
    getBodyPlan: (id) => computeLoopBody(id, workflow.nodes, workflow.edges),
    getRunners: () => runners,
    getStore: () => store,
    forwardNodeFinish: (node, nodeRun) =>
      finishLog.push({ nodeId: node.id, status: nodeRun.status }),
    collectNestedRun: (id, record) => nested.set(id, record),
  });
  const run = executeWorkflow(workflow, {
    runners,
    signal: options.signal,
    variables: () => store.snapshot(),
    selectDownstream: createWorkflowDownstreamSelector(workflow.nodes, workflow.edges),
    nestedNodeRun: (node) => nested.get(node.id),
    onNodeFinish: (node, nodeRun) => finishLog.push({ nodeId: node.id, status: nodeRun.status }),
  });
  return { run, store, nested, finishLog, runners };
}

describe("executeWorkflow 集成：条件分支（M7-T1）", () => {
  it("真分支命中：true 目标执行，false 目标 skipped；c 输出为分支形态", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("c", "condition", {
        expression: "return vars.go === true",
        trueTargets: [asNodeId("t")],
        falseTargets: [asNodeId("f")],
      }),
      makeNode("t"),
      makeNode("f"),
    ];
    const edges = [makeEdge("s", "c"), makeEdge("c", "t"), makeEdge("c", "f")];
    const ran: NodeId[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      initialVars: { go: true },
      httpReplay: async (node) => {
        ran.push(node.id);
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(ran).toEqual([asNodeId("t")]);
    expect(summary.nodeRuns[asNodeId("f")]?.status).toBe("skipped");
    expect(summary.nodeRuns[asNodeId("c")]?.output).toMatchObject({ branch: "true", value: true });
  });

  it("汇合节点（未被任何分支勾选）：两个分支都放行，与其它成功路径共同执行", async () => {
    // c→t（真分支）、c→f（假分支）、c→m（未勾选汇合）；m 同时被 s 指向
    const nodes = [
      makeNode("s", "start"),
      makeNode("c", "condition", {
        expression: "return vars.n % 2 === 0",
        trueTargets: [asNodeId("t")],
        falseTargets: [asNodeId("f")],
      }),
      makeNode("t"),
      makeNode("f"),
      makeNode("m"),
    ];
    const edges = [
      makeEdge("s", "c"),
      makeEdge("s", "m"),
      makeEdge("c", "t"),
      makeEdge("c", "f"),
      makeEdge("c", "m"),
    ];
    const ran: NodeId[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      initialVars: { n: 3 },
      httpReplay: async (node) => {
        ran.push(node.id);
        return node.id;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    // vars.n 为奇数 → 假分支：f 执行；t skipped；m 不受分支影响照常执行（仅一次）
    expect(ran.filter((id) => id === asNodeId("m"))).toHaveLength(1);
    expect(ran).toContain(asNodeId("f"));
    expect(summary.nodeRuns[asNodeId("t")]?.status).toBe("skipped");
  });

  it("未配置分支目标的条件节点：直通（全部下游照常执行）", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("c", "condition", { expression: "return false" }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "c"), makeEdge("c", "a")];
    const ran: NodeId[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (node) => {
        ran.push(node.id);
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(ran).toEqual([asNodeId("a")]);
  });

  it("条件节点失败 + failPolicy continue：不走任何分支，全部下游放行", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("c", "condition", { expression: "return input.x.missing", failPolicy: "continue" }),
      makeNode("t"),
      makeNode("f"),
    ];
    const edges = [makeEdge("s", "c"), makeEdge("c", "t"), makeEdge("c", "f")];
    const ran: NodeId[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (node) => {
        ran.push(node.id);
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("节点 c 执行失败");
    expect(ran.sort()).toEqual([asNodeId("f"), asNodeId("t")].sort());
  });
});

describe("executeWorkflow 集成：运行期变量可见性（M7-T1）", () => {
  it("setVariable 写入后，后续节点的模板 var.* 立即可读到新值", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("sv", "setVariable", {
        assignments: [{ name: "token", from: "literal", value: "abc" }],
      }),
      makeNode("reader"),
    ];
    const edges = [makeEdge("s", "sv"), makeEdge("sv", "reader")];
    const rendered: string[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (_node, _input, runCtx) => {
        rendered.push(renderTemplate("{{ var.token }}", runCtx.nodeCtx.templateContext).value);
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(rendered).toEqual(["abc"]);
  });

  it("setVariable 从上游节点输出提取（node 来源）", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("http1"),
      makeNode("sv", "setVariable", {
        assignments: [{ name: "uid", from: "node", node: asNodeId("http1"), path: "body.id" }],
      }),
      makeNode("reader"),
    ];
    const edges = [makeEdge("s", "http1"), makeEdge("http1", "sv"), makeEdge("sv", "reader")];
    const seenVars: Array<Record<string, unknown>> = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (node, _input, runCtx) => {
        if (node.id === asNodeId("http1")) return { body: { id: 7 } };
        seenVars.push((runCtx.nodeCtx.templateContext.var ?? {}) as Record<string, unknown>);
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(seenVars).toEqual([{ uid: 7 }]);
  });
});

describe("executeWorkflow 集成：循环（M7-T1）", () => {
  it("循环体逐轮执行：体内节点每轮可见 var.loop；聚合与嵌套快照正确", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: ["x", "y"] }),
      makeNode("a"),
      makeNode("b"),
      makeNode("after"),
    ];
    const edges = [
      makeEdge("s", "L"),
      makeEdge("L", "a"),
      makeEdge("a", "b"),
      makeEdge("b", "after"),
    ];
    const seenLoops: Array<unknown> = [];
    const afterInputs: unknown[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (node, input, runCtx) => {
        const vars = runCtx.nodeCtx.templateContext.var ?? {};
        if (node.id === asNodeId("b")) {
          seenLoops.push(vars[LOOP_VARIABLE_NAME]);
          return { round: (vars[LOOP_VARIABLE_NAME] as { index: number }).index };
        }
        if (node.id === asNodeId("after")) {
          // after 的全部上游都在体内 → after 也属于循环体、每轮执行；
          // input 聚合自体内上游 b（体内部数据流与父图 join 语义一致）
          afterInputs.push(input);
          return { echo: (input as { round: number }).round };
        }
        return vars[LOOP_VARIABLE_NAME];
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(seenLoops).toEqual([
      { item: "x", index: 0 },
      { item: "y", index: 1 },
    ]);
    expect(afterInputs).toEqual([{ round: 0 }, { round: 1 }]);
    // L 的 output = 逐轮聚合（单汇点 after）
    expect(summary.nodeRuns[asNodeId("L")]?.output).toEqual([{ echo: 0 }, { echo: 1 }]);
    // 循环体内节点快照 = 最后一轮（非 skipped；nestedNodeRun 扩展点生效）
    expect(summary.nodeRuns[asNodeId("a")]?.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("b")]?.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("after")]?.status).toBe("success");
  });

  it("循环体内节点不重复执行（子运行承担逐轮，父调度器不重跑体入口）", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [1, 2, 3] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    let aRuns = 0;
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async () => {
        aRuns += 1;
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(aRuns).toBe(3); // 恰好每轮一次，无父调度器的额外执行
  });

  it("循环体内条件分支按轮路由（condition 在体内照常工作）", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [0, 1] }),
      makeNode("c", "condition", {
        expression: "return vars.loop.index % 2 === 0",
        trueTargets: [asNodeId("even")],
        falseTargets: [asNodeId("odd")],
      }),
      makeNode("even"),
      makeNode("odd"),
    ];
    const edges = [
      makeEdge("s", "L"),
      makeEdge("L", "c"),
      makeEdge("c", "even"),
      makeEdge("c", "odd"),
    ];
    const ran: NodeId[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (node) => {
        ran.push(node.id);
        return node.id;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    // 第 0 轮 index 0 → even；第 1 轮 index 1 → odd
    expect(ran).toEqual([asNodeId("even"), asNodeId("odd")]);
    // 聚合 = 每轮汇点（even / odd 互为分支，各自的轮次汇点输出）
    expect(summary.nodeRuns[asNodeId("L")]?.output).toEqual([asNodeId("even"), asNodeId("odd")]);
  });

  it("循环体失败：loop 节点 failed，run 级错误带轮次", async () => {
    const nodes = [makeNode("s", "start"), makeNode("L", "loop", { items: [1, 2] }), makeNode("a")];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    let calls = 0;
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async () => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        return null;
      },
    });
    const summary: RunSummary = await run;
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("第 2 轮循环体执行失败");
  });

  it("运行中取消：取消中的轮次不聚合，loop 以部分结果成功返回，run = cancelled", async () => {
    const controller = new AbortController();
    const nodes = [
      makeNode("s", "start"),
      makeNode("L", "loop", { items: [1, 2, 3] }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "L"), makeEdge("L", "a")];
    let calls = 0;
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      signal: controller.signal,
      httpReplay: async () => {
        calls += 1;
        if (calls === 2) controller.abort(); // 第二轮执行中取消（该轮子运行 cancelled → 不聚合）
        return calls;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(calls).toBe(2); // 第三轮不再执行
    // 第一轮完整保留；第二轮（取消轮）的体被中途打断 → 整轮丢弃
    expect(summary.nodeRuns[asNodeId("L")]?.output).toEqual([1]);
  });
});

describe("executeWorkflow 集成：延时（M7-T1）", () => {
  it("等待后透传 input，耗时计入 durationMs", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("d", "delay", { durationMs: 20 }),
      makeNode("a"),
    ];
    const edges = [makeEdge("s", "d"), makeEdge("d", "a")];
    const inputs: unknown[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (_node, input) => {
        inputs.push(input);
        return null;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("d")]?.durationMs).toBeGreaterThanOrEqual(15);
    // delay 输出透传 input（s 的输出 null）
    expect(summary.nodeRuns[asNodeId("d")]?.output).toBeNull();
    expect(inputs).toEqual([null]);
  });

  it("等待期间取消：节点 failed + run = cancelled（取消优先于失败）", async () => {
    const controller = new AbortController();
    const nodes = [makeNode("s", "start"), makeNode("d", "delay", { durationMs: 10_000 })];
    const edges = [makeEdge("s", "d")];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(summary.nodeRuns[asNodeId("d")]?.status).toBe("failed");
    expect(summary.nodeRuns[asNodeId("d")]?.error).toMatch(/^\[cancelled\]/);
  });
});

describe("executeWorkflow 集成：既有行为不变（选择器注册的边界）", () => {
  it("未使用逻辑节点的流程在选择器注册后行为与既有完全一致", async () => {
    const nodes = [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("join")];
    const edges = [
      makeEdge("s", "a"),
      makeEdge("s", "b"),
      makeEdge("a", "join"),
      makeEdge("b", "join"),
    ];
    const ran: NodeId[] = [];
    const { run } = wireWorkflow(makeWorkflow(nodes, edges), {
      httpReplay: async (node) => {
        ran.push(node.id);
        return node.id;
      },
    });
    const summary = await run;
    expect(summary.status).toBe("success");
    expect(ran).toEqual([asNodeId("a"), asNodeId("b"), asNodeId("join")]);
    // join 聚合多上游输出
    expect(summary.nodeRuns[asNodeId("join")]?.input).toEqual({
      a: asNodeId("a"),
      b: asNodeId("b"),
    });
  });
});

describe("变量供给函数（executor 扩展的直测，M7-T1）", () => {
  it("variables 为供给函数时逐节点取当前值；普通对象保持启动快照语义", async () => {
    const store = new RunVariableStore({ k: "v0" });
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const seen: Array<Record<string, unknown>> = [];
    const summary = await executeWorkflow(workflow, {
      variables: () => store.snapshot(),
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          seen.push((runCtx.nodeCtx.templateContext.var ?? {}) as Record<string, unknown>);
          if (_node.id === asNodeId("a")) store.set("k", "v1"); // 运行期写入
          return null;
        },
      },
    });
    expect(summary.status).toBe("success");
    expect(seen).toEqual([{ k: "v0" }, { k: "v1" }]); // b 读到 a 写入的新值
  });
});
