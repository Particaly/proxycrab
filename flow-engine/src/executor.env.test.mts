import { describe, expect, it } from "vitest";
import { buildTemplateContext, executeWorkflow } from "./executor";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import { renderTemplate } from "./template";

/**
 * M10-T4 执行器环境注入测试（既有 executor.test.ts / executor.variables.test.ts
 * 锁定的调度 / variables 行为不在此重复）：ExecutorOptions.env（激活环境键值
 * 快照）并入每个节点的 templateContext.env，模板 `{{ env.<key> }}` 可在节点
 * 上下文中渲染；未传时上下文保持既有形状（无 env 键）。
 */

/** 构造画布节点（config 空） */
function makeNode(id: string, type: WorkflowNode["type"] = "httpReplay"): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config: {} };
}

/** 构造连线 */
function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

/** 构造最小可执行工作流 */
function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return { id: asWorkflowId("wf-env"), nodes, edges };
}

describe("buildTemplateContext：env 参数（M10-T4）", () => {
  it("传入 env → 上下文附 env 键（浅拷贝，外部改动不影响上下文）", () => {
    const env = { baseUrl: "http://dev" };
    const ctx = buildTemplateContext({ a: 1 }, "in", { token: "t" }, env);
    expect(ctx.env).toEqual({ baseUrl: "http://dev" });
    expect(ctx.env).not.toBe(env);
    env.baseUrl = "mutated";
    expect(ctx.env?.baseUrl).toBe("http://dev");
  });

  it("未传 env → 保持既有形状（无 env 键；variables 同为 undefined 时 { node, input }）", () => {
    expect("env" in buildTemplateContext({})).toBe(false);
    expect("env" in buildTemplateContext({}, null, { k: "v" })).toBe(false);
  });
});

describe("executeWorkflow：env 注入 templateContext.env（M10-T4）", () => {
  it("每个节点的 templateContext.env 均为同一环境快照（与 var 并存）", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const seen: Array<Record<string, unknown>> = [];
    const summary = await executeWorkflow(workflow, {
      variables: { token: "abc" },
      env: { baseUrl: "https://staging.example.com" },
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          const ctx = runCtx.nodeCtx.templateContext;
          seen.push(ctx.env ?? {});
          // 环境值可在节点内按模板渲染（URL 拼接场景）
          expect(renderTemplate("{{ env.baseUrl }}", ctx).value).toBe(
            "https://staging.example.com",
          );
          return { out: _node.id };
        },
      },
    });
    expect(summary.status).toBe("success");
    expect(seen).toEqual([
      { baseUrl: "https://staging.example.com" },
      { baseUrl: "https://staging.example.com" },
    ]);
  });

  it("未传 env：模板上下文无 env 键（{{ env.x }} 按缺省约定告警渲染为空）", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const contexts: Array<Record<string, unknown>> = [];
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          contexts.push(runCtx.nodeCtx.templateContext as unknown as Record<string, unknown>);
          return null;
        },
      },
    });
    expect(summary.status).toBe("success");
    expect(contexts).toEqual([{ node: { s: null }, input: null }]);
  });
});
