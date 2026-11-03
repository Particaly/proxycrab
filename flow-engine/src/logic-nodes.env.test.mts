import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "./types";
import { asNodeId } from "./types";
import { compileConditionTree } from "./condition-builder";
import { createConditionRunner, createLoopRunner, runConditionExpression } from "./logic-nodes";
import type { LoopBodyPlan } from "./logic-nodes";

/**
 * M14-T2 / M14-T3 逻辑节点 env 注入测试（既有 logic-nodes*.test.ts 锁定的
 * 条件 / 循环语义不在此重复）：
 *   - 条件表达式注入 env（可读）+ 写回收集（可写，与脚本同语义）；
 *   - M13-T3 condition-builder 编译产物在新形参签名下照常求值（产物兼容）；
 *   - createConditionRunner 从节点模板上下文取 env 并转发写回（onEnvWrite）；
 *   - loop 子运行经 getEnv 注入环境快照（循环体内节点与主链路同源）。
 */

describe("runConditionExpression：env 注入（M14-T2）", () => {
  it("表达式读取 env 快照（truthy 判定依据）", () => {
    const result = runConditionExpression('return env.flag === "on"', {
      input: null,
      vars: {},
      env: { flag: "on" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it("未传 env → 表达式 env 恒可用（空表；缺键 undefined）", () => {
    const result = runConditionExpression(
      'return env.nope === undefined && typeof env === "object"',
      {
        input: null,
        vars: {},
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it("表达式对 env 赋值 → envWrites 随成功结果回传", () => {
    const result = runConditionExpression('env.hit = "yes"; return true', {
      input: null,
      vars: {},
      env: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
      expect(result.envWrites).toEqual({ hit: "yes" });
    }
  });

  it("表达式失败（runtime）→ 失败结果同样携带已提交写回（不回滚）", () => {
    const result = runConditionExpression("env.k = 1; return undefinedVariable.missing", {
      input: null,
      vars: {},
      env: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("runtime");
      expect(result.envWrites).toEqual({ k: 1 });
    }
  });
});

describe("condition-builder 编译产物兼容（M16-T2 产物 × M14-T2 形参）", () => {
  it("编译产物在新形参签名（input / vars / env）下照常求值，env 引用不受影响", () => {
    // 产物只用 input / vars（env 引用在构建器保存校验被阻断——既有行为锁定，
    // 产物中不出现 env 标识符，env 形参追加不改变其语义）
    const expression = compileConditionTree({
      type: "group",
      op: "and",
      children: [
        { type: "cond", left: "{{ input.status }}", operator: "eq", right: "{{ var.expected }}" },
      ],
    });
    const result = runConditionExpression(expression, {
      input: { status: 200 },
      vars: { expected: "200" },
      env: { baseUrl: "http://dev" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });
});

describe("createConditionRunner：env 注入与写回转发（M14-T2 / T3）", () => {
  it("从节点模板上下文取 env 注入表达式；写回经 onEnvWrite 转发", async () => {
    const written: Array<Record<string, unknown>> = [];
    const runner = createConditionRunner({ onEnvWrite: (writes) => written.push(writes) });
    const node: WorkflowNode = {
      id: asNodeId("cond"),
      type: "condition",
      position: { x: 0, y: 0 },
      config: { expression: 'env.ready = true; return env.mode === "prod"' },
    };
    const output = await runner(
      node,
      { payload: 1 },
      {
        runId: asNodeId("run-x") as never,
        nodeCtx: {
          nodeOutputs: {},
          templateContext: { node: {}, input: { payload: 1 }, env: { mode: "prod" } },
        },
      },
    );
    expect(output).toEqual({ branch: "true", value: true });
    expect(written).toEqual([{ ready: true }]);
  });

  it("模板上下文无 env → 表达式 env 为空表（不抛错）", async () => {
    const runner = createConditionRunner({});
    const node: WorkflowNode = {
      id: asNodeId("cond"),
      type: "condition",
      position: { x: 0, y: 0 },
      config: { expression: 'return typeof env === "object"' },
    };
    const output = await runner(node, null, {
      runId: asNodeId("run-x") as never,
      nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input: null } },
    });
    expect(output).toEqual({ branch: "true", value: true });
  });
});

describe("createLoopRunner：getEnv 注入循环体（M14-T2）", () => {
  /** 构造画布节点 */
  function makeNode(
    id: string,
    type: WorkflowNode["type"],
    config: WorkflowNode["config"] = {},
  ): WorkflowNode {
    return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
  }

  it("循环体内节点经子运行的 templateContext.env 读到主链路环境快照", async () => {
    const loopNode = makeNode("loop", "loop", { items: [{ n: 1 }] });
    const bodyNode = makeNode("body", "httpReplay");
    const seen: Array<Record<string, unknown> | undefined> = [];
    const plan: LoopBodyPlan = {
      bodyNodes: [bodyNode],
      entryIds: [bodyNode.id],
      bodyEdges: [],
      sinkIds: [bodyNode.id],
    };
    const loopRunner = createLoopRunner({
      getBodyPlan: () => plan,
      getRunners: () => ({
        httpReplay: async (_node, _input, runCtx) => {
          seen.push(runCtx.nodeCtx.templateContext.env);
          return null;
        },
      }),
      getEnv: () => ({ baseUrl: "http://dev" }),
    });
    const output = await loopRunner(loopNode, null, {
      runId: asNodeId("run-x") as never,
      nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input: null } },
    });
    expect(output).toEqual([null]);
    expect(seen).toEqual([{ baseUrl: "http://dev" }]);
  });
});
