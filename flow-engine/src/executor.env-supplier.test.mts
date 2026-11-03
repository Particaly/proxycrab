import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";

/**
 * M14-T3 执行器 env 供给函数形态测试（既有 executor.env.test.ts 锁定的
 * M10-T4 普通对象快照语义不在此重复）：脚本写回使运行期出现 env 写入方，
 * env 选项允许供给函数——执行器在每个节点构建 templateContext 时调用一次
 * 取当前值，运行期更新对下游节点立即可见；普通对象保持启动快照语义。
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
  return { id: asWorkflowId("wf-env-supplier"), nodes, edges };
}

describe("executeWorkflow：env 供给函数（M14-T3）", () => {
  it("供给函数逐节点取当前值：上游节点的 env 更新对下游立即可见", async () => {
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const seenByNode: Record<string, Record<string, unknown> | undefined> = {};
    /** 模拟 run-controller 的运行期 env 表（脚本写回的落点） */
    const runtimeEnv: Record<string, unknown> = { baseUrl: "http://dev" };
    const summary = await executeWorkflow(workflow, {
      env: () => ({ ...runtimeEnv }),
      runners: {
        httpReplay: async (node, _input, runCtx) => {
          seenByNode[node.id] = runCtx.nodeCtx.templateContext.env;
          if (node.id === "a") runtimeEnv.token = "fresh"; // 模拟脚本写回更新运行快照
          return { out: node.id };
        },
      },
    });
    expect(summary.status).toBe("success");
    // 节点 a 取到派发初值；节点 b 取到写回后的最新快照
    expect(seenByNode.a).toEqual({ baseUrl: "http://dev" });
    expect(seenByNode.b).toEqual({ baseUrl: "http://dev", token: "fresh" });
  });

  it("供给函数每节点返回新对象：外部表后续变化不影响已构建节点的上下文", async () => {
    const workflow = makeWorkflow([makeNode("s", "start"), makeNode("a")], [makeEdge("s", "a")]);
    const captured: Array<Record<string, unknown> | undefined> = [];
    let mutable: Record<string, unknown> = { k: "v1" };
    const summary = await executeWorkflow(workflow, {
      env: () => mutable,
      runners: {
        httpReplay: async (_node, _input, runCtx) => {
          captured.push(runCtx.nodeCtx.templateContext.env);
          return null;
        },
      },
    });
    expect(summary.status).toBe("success");
    mutable = { k: "v2" };
    // buildTemplateContext 对 env 浅拷贝：调用方表变化不影响已构建上下文
    expect(captured[0]).toEqual({ k: "v1" });
  });
});
