import { describe, expect, it, vi } from "vitest";
import { buildTemplateContext, executeWorkflow } from "./executor";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";

/**
 * M7-T2 执行器变量注入测试（纯增量：既有 executor.test.ts 锁定的调度语义
 * 不在此重复，本文件只覆盖新增的 ExecutorOptions.variables 注入链路）：
 * buildTemplateContext 的可选 variables 参数（未传保持既有 { node, input }
 * 形状），executeWorkflow 把变量并入每个节点的 templateContext.var，
 * 未传时上下文形状不变。
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
  return { id: asWorkflowId("wf-var"), nodes, edges };
}

describe("buildTemplateContext：variables 参数（M7-T2）", () => {
  it("传入 variables → 上下文附 var 键（浅拷贝）", () => {
    const variables = { token: "t1", env: { region: "cn" } };
    const ctx = buildTemplateContext({ a: { v: 1 } }, "in", variables);
    expect(ctx).toEqual({
      node: { a: { v: 1 } },
      input: "in",
      var: { token: "t1", env: { region: "cn" } },
    });
    expect(ctx.var).not.toBe(variables); // 浅拷贝：外部改动不影响上下文
    variables.token = "mutated";
    expect(ctx.var?.token).toBe("t1");
  });

  it("未传 variables → 保持既有 { node, input } 形状（无 var 键）", () => {
    expect(buildTemplateContext({})).toEqual({ node: {}, input: null });
    expect("var" in buildTemplateContext({ a: 1 }, null)).toBe(false);
  });

  it("variables 值保持引用（浅拷贝表，不深拷贝值）", () => {
    const nested = { deep: 1 };
    const ctx = buildTemplateContext({}, null, { nested });
    expect(ctx.var?.nested).toBe(nested);
  });
});

describe("executeWorkflow：variables 注入 templateContext.var（M7-T2）", () => {
  it("每个节点的 templateContext.var 均可取到变量（node / input 同在）", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const seen: Array<Record<string, unknown>> = [];
    const summary = await executeWorkflow(workflow, {
      variables: { token: "abc", env: "dev" },
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          seen.push(runCtx.nodeCtx.templateContext.var ?? {});
          return { out: _node.id };
        },
      },
    });
    expect(summary.status).toBe("success");
    expect(seen).toEqual([
      { token: "abc", env: "dev" },
      { token: "abc", env: "dev" },
    ]);
  });

  it("变量注入不改变调度：httpReplay 节点上下文 node / input / var 并存", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const contexts: Array<{ node: unknown; input: unknown; var: unknown }> = [];
    const summary = await executeWorkflow(workflow, {
      variables: { k: "v" },
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          const ctx = runCtx.nodeCtx.templateContext;
          contexts.push({ node: ctx.node, input: ctx.input, var: ctx.var });
          return null;
        },
      },
    });
    // start 节点走内置 no-op runner（不进本 runner）；a 的上下文含上游输出与 var
    expect(summary.status).toBe("success");
    expect(contexts).toEqual([{ node: { s: null }, input: null, var: { k: "v" } }]);
  });

  it("未传 variables：templateContext 无 var 键（既有形状不变），模板渲染走既有路径", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const varKeys: Array<boolean> = [];
    const onNodeStart = vi.fn();
    await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          varKeys.push("var" in runCtx.nodeCtx.templateContext);
          return null;
        },
      },
      onNodeStart,
    });
    expect(varKeys).toEqual([false]);
    expect(onNodeStart).toHaveBeenCalledTimes(2);
  });

  it("变量表为运行快照语义：每个节点拿到的 var 互不影响（浅拷贝隔离）", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const snapshots: Array<Record<string, unknown>> = [];
    await executeWorkflow(workflow, {
      variables: { shared: { count: 1 } },
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          const table = runCtx.nodeCtx.templateContext.var as Record<string, unknown>;
          snapshots.push(table);
          return null;
        },
      },
    });
    // 每个节点拿到独立的表浅拷贝（值共享引用，表本身隔离）
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[0].shared).toBe(snapshots[1].shared);
  });
});
