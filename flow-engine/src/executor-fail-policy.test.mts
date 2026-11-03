import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "./executor";
import type { NodeRunner, RunSummary } from "./executor";
import type { NodeConfig, NodeFailPolicy, WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";

/**
 * M5-T4 失败策略语义矩阵（continue 接入后的行为锁定）：
 * 节点级 config.failPolicy 与工作流级 defaultFailPolicy 的优先级、
 * continue 下游仍执行 / input 聚合按缺失处理（仅剩其他上游 / 全缺 → null）、
 * run 级「任一 failed → run failed」与错误摘要取首个失败、取消优先、
 * 无效 failPolicy 值按 stop 兜底。
 *
 * 注意：既有 executor.test.ts（M5-T1）不可修改——其锁定的
 * options.failPolicy='continue' 抛错行为是 M5-T1 遗留占位契约，
 * continue 语义经由节点级 config 与 defaultFailPolicy 提供（见 executor.ts 文件头）。
 */

let idSeq = 0;

/** 构造画布节点（默认 httpReplay 类型，config 可覆盖） */
function makeNode(id: string, config: NodeConfig = {}): WorkflowNode {
  return { id: asNodeId(id), type: "httpReplay", position: { x: 0, y: 0 }, config };
}

/** 构造开始节点（纯编排起点，无 config） */
function makeStartNode(): WorkflowNode {
  return { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} };
}

/** 构造带失败策略的节点 */
function makeNodeWithPolicy(id: string, failPolicy: NodeFailPolicy): WorkflowNode {
  return makeNode(id, { failPolicy });
}

/** 构造连线 */
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

/** 从摘要中按字符串 id 取节点执行快照 */
function runOf(summary: RunSummary, nodeId: string) {
  return summary.nodeRuns[asNodeId(nodeId)];
}

describe("executeWorkflow：failPolicy continue（节点级 config.failPolicy）", () => {
  it("线性图：a 失败（continue）→ 下游 b 仍执行，b input 为 null（失败上游按缺失）", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const runner: NodeRunner = async (node) => {
      if (node.id === "a") throw new Error("a-down");
      return `out-${node.id}`;
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    expect(summary.status).toBe("failed"); // 任一节点 failed → run failed（即使跑完）
    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "a").output).toBeNull(); // 失败节点不产出 output
    expect(runOf(summary, "b").status).toBe("success"); // 下游仍执行
    expect(runOf(summary, "b").input).toBeNull(); // 仅剩的其他上游聚合：全缺 → null
    expect(runOf(summary, "b").output).toBe("out-b");
    expect(summary.error).toBe("节点 a 执行失败：a-down");
  });

  it("多下游：a 失败（continue）→ 其全部下游都执行", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("a", "c")],
    );
    const executed: string[] = [];
    const runner: NodeRunner = async (node) => {
      executed.push(node.id);
      if (node.id === "a") throw new Error("a-down");
      return node.id;
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    // s 由内置 start runner 执行（不进 mock runner）；a/b/c 按连线数组顺序继续调度
    expect(executed).toEqual(["a", "b", "c"]);
    expect(summary.status).toBe("failed");
    expect(runOf(summary, "b").status).toBe("success");
    expect(runOf(summary, "c").status).toBe("success");
  });

  it("join：双上游一败一成（continue）→ join 执行，input 只聚合成功的上游（单剩透传）", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNode("b"), makeNode("join")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "join"), makeEdge("b", "join")],
    );
    const runner: NodeRunner = async (node) => {
      if (node.id === "a") throw new Error("a-down");
      return `out-${node.id}`;
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    expect(runOf(summary, "b").status).toBe("success");
    expect(runOf(summary, "join").status).toBe("success");
    // 失败上游 a 按缺失处理：仅剩 b → 原样透传（不包聚合对象）
    expect(runOf(summary, "join").input).toBe("out-b");
    expect(summary.status).toBe("failed");
  });

  it("join：双上游全败（continue）→ join 执行，input 为 null", async () => {
    const workflow = makeWorkflow(
      [
        makeStartNode(),
        makeNodeWithPolicy("a", "continue"),
        makeNodeWithPolicy("b", "continue"),
        makeNode("join"),
      ],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "join"), makeEdge("b", "join")],
    );
    const runner: NodeRunner = async (node) => {
      if (node.id === "join") return "joined";
      throw new Error(`${node.id}-down`);
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    expect(runOf(summary, "join").status).toBe("success");
    expect(runOf(summary, "join").input).toBeNull(); // 全缺 → null
    expect(summary.status).toBe("failed");
    // run 级错误摘要取第一个失败节点（a 先于 b）
    expect(summary.error).toBe("节点 a 执行失败：a-down");
  });

  it("join 等待全部上游结算：一上游未结算时不提前执行", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNode("b"), makeNode("join")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "join"), makeEdge("b", "join")],
    );
    const order: string[] = [];
    const runner: NodeRunner = async (node) => {
      if (node.id === "a") throw new Error("a-down");
      if (node.id === "b") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("b-done");
        return "out-b";
      }
      order.push(node.id);
      return `out-${node.id}`;
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    // s 由内置 start runner 执行（不进 mock runner）；a 失败（continue）先行结算，
    // 但 join 必须等慢上游 b 结算后才执行
    expect(order).toEqual(["b-done", "join"]);
    expect(runOf(summary, "join").status).toBe("success");
    expect(runOf(summary, "join").input).toBe("out-b");
  });

  it("continue 中途再失败：两个节点都 failed，摘要取首个，后续失败记在节点快照", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNodeWithPolicy("b", "continue")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
    const runner: NodeRunner = async (node) => {
      throw new Error(`${node.id}-down`);
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "b").status).toBe("failed");
    expect(runOf(summary, "b").error).toBe("b-down");
    expect(summary.error).toBe("节点 a 执行失败：a-down");
  });

  it("continue 失败节点也触发 onNodeFinish（failed 快照），事件照常成对发出", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue")],
      [makeEdge("s", "a")],
    );
    const onNodeFinish = vi.fn();
    const runner: NodeRunner = async () => {
      throw new Error("boom");
    };
    await executeWorkflow(workflow, { runners: { httpReplay: runner }, onNodeFinish });

    expect(onNodeFinish).toHaveBeenCalledTimes(2); // s（success）+ a（failed）；skipped 才不发出
    expect(onNodeFinish.mock.calls[1][1]).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("executeWorkflow：failPolicy 读取层级（节点级优先，工作流级兜底）", () => {
  const linearFailA = (aConfig: NodeConfig) =>
    makeWorkflow(
      [makeStartNode(), makeNode("a", aConfig), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("a", "b")],
    );
  const failARunner: NodeRunner = async (node) => {
    if (node.id === "a") throw new Error("a-down");
    return `out-${node.id}`;
  };

  it("节点 config.failPolicy=continue 优先于 defaultFailPolicy=stop", async () => {
    const summary = await executeWorkflow(linearFailA({ failPolicy: "continue" }), {
      runners: { httpReplay: failARunner },
      defaultFailPolicy: "stop",
    });
    expect(runOf(summary, "b").status).toBe("success");
  });

  it("节点 config.failPolicy=stop 覆盖 defaultFailPolicy=continue（节点级优先）", async () => {
    const summary = await executeWorkflow(linearFailA({ failPolicy: "stop" }), {
      runners: { httpReplay: failARunner },
      defaultFailPolicy: "continue",
    });
    expect(runOf(summary, "b").status).toBe("skipped"); // stop：下游不再执行
    expect(summary.status).toBe("failed");
  });

  it("仅 defaultFailPolicy=continue：未显式配置的节点也继续", async () => {
    const summary = await executeWorkflow(linearFailA({}), {
      runners: { httpReplay: failARunner },
      defaultFailPolicy: "continue",
    });
    expect(runOf(summary, "b").status).toBe("success");
  });

  it("节点级与工作流级均缺省 → stop（现状语义不变）", async () => {
    const summary = await executeWorkflow(linearFailA({}), {
      runners: { httpReplay: failARunner },
    });
    expect(runOf(summary, "b").status).toBe("skipped");
  });

  it("无效的节点 failPolicy 值不视为显式配置：回退工作流级 defaultFailPolicy", async () => {
    const summary = await executeWorkflow(
      linearFailA({ failPolicy: "bogus" as unknown as NodeFailPolicy }),
      {
        runners: { httpReplay: failARunner },
        defaultFailPolicy: "continue",
      },
    );
    // 'bogus' 非法 → 不按节点级处理，回退工作流级 default（continue）；
    // 执行器宽容兜底、不抛错，无效值的拒绝是 run-controller（消息层）的职责
    expect(summary.status).toBe("failed");
    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "b").status).toBe("success");
  });

  it("无效值且无 defaultFailPolicy → 按 stop 兜底", async () => {
    const summary = await executeWorkflow(
      linearFailA({ failPolicy: 42 as unknown as NodeFailPolicy }),
      { runners: { httpReplay: failARunner } },
    );
    expect(runOf(summary, "b").status).toBe("skipped");
  });
});

describe("executeWorkflow：continue 与取消 / 不可达节点的组合", () => {
  it("continue 下取消仍优先：失败后取消触发 → 剩余 skipped，run cancelled", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("a", "b"), makeEdge("b", "c")],
    );
    const controller = new AbortController();
    const runner: NodeRunner = async (node) => {
      if (node.id === "a") {
        controller.abort(); // a 执行期间取消（continue 策略）
        throw new Error("a-down");
      }
      return `out-${node.id}`;
    };
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: runner },
      signal: controller.signal,
    });

    // 取消优先于失败：a 失败（continue 本应继续调度）但已取消 → 停止调度
    expect(summary.status).toBe("cancelled");
    expect(runOf(summary, "a").status).toBe("failed");
    expect(runOf(summary, "b").status).toBe("skipped");
    expect(runOf(summary, "c").status).toBe("skipped");
  });

  it("continue 不改变不可达 / 环上节点的 skipped 收尾", async () => {
    const workflow = makeWorkflow(
      [makeStartNode(), makeNodeWithPolicy("a", "continue"), makeNode("orphan")],
      [makeEdge("s", "a")],
    );
    const runner: NodeRunner = async (node) => {
      if (node.id === "a") throw new Error("a-down");
      return null;
    };
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: runner } });

    expect(runOf(summary, "orphan").status).toBe("skipped");
    expect(runOf(summary, "orphan").input).toBeNull();
    expect(runOf(summary, "orphan").durationMs).toBe(0);
  });
});
