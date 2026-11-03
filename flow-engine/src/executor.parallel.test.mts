import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_NODE_CONCURRENCY,
  executeWorkflow,
  type NodeRunner,
  type RunSummary,
} from "./executor";
import {
  asEdgeId,
  asNodeId,
  asWorkflowId,
  type NodeConfig,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./types";

/**
 * M15-T6 节点级并行调度测试：
 * 无依赖节点并发起跑（startedAt 重叠 / Promise 时序断言）、join 节点等全部
 * 上游结算后才执行且 input 含两份输出、maxNodeConcurrency 上限生效与无效值
 * 兜底、stop 失败在批量并发下的停机语义（批内在途自然结算、不启动新节点）。
 * 全部用 fake runner 注入，不发请求、不落库、不碰 UI。
 */

/* ---------------- 测试图构造工具（与 executor.test.ts 同款，独立成文避免互相依赖） ---------------- */

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

/** 从摘要中按字符串 id 取节点执行快照 */
function runOf(summary: RunSummary, nodeId: string) {
  return summary.nodeRuns[asNodeId(nodeId)];
}

describe("executeWorkflow 并行调度（M15-T6）", () => {
  it("无依赖节点并发起跑：a 阻塞期间 b 已完成（startedAt 重叠），事件按入队序发出", async () => {
    // a 在闸门上等待；b 完成时放行 a——b 能在 a 结算前完成即证明两者并发
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const events: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b")],
      [makeEdge("s", "a"), makeEdge("s", "b")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: (async (node) => {
          events.push(`start:${node.id}`);
          if (node.id === "a") {
            await aGate;
          } else {
            releaseA();
          }
          events.push(`end:${node.id}`);
          return `out-${node.id}`;
        }) satisfies NodeRunner,
      },
    });

    // 时序断言：a 先起跑（入队序）、b 在 a 结算前完成（并发重叠）、a 最后结算
    expect(events).toEqual(["start:a", "start:b", "end:b", "end:a"]);
    expect(summary.status).toBe("success");
    // startedAt 重叠：两节点同批起跑，a（先入队）不晚于 b
    const aRun = runOf(summary, "a");
    const bRun = runOf(summary, "b");
    expect(aRun.startedAt).toBeLessThanOrEqual(bRun.startedAt);
    expect(aRun.output).toBe("out-a");
    expect(bRun.output).toBe("out-b");
  });

  it("join 节点：等双上游都结算后才执行，input 为两份输出的聚合对象", async () => {
    // a 慢（闸门放行）、b 快（完成时放行 a）：join 必须等 a、b 都结算才起跑
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const events: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("join")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "join"), makeEdge("b", "join")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: (async (node, input) => {
          if (node.id === "join") {
            events.push(`start:join(input=${JSON.stringify(input)})`);
            return "joined";
          }
          events.push(`start:${node.id}`);
          if (node.id === "a") {
            await aGate;
          } else {
            releaseA();
          }
          events.push(`end:${node.id}`);
          return { from: node.id };
        }) satisfies NodeRunner,
      },
    });

    // join 在两个上游都结算（end:a、end:b 都已发生）后才起跑
    expect(events).toEqual([
      "start:a",
      "start:b",
      "end:b",
      "end:a",
      'start:join(input={"a":{"from":"a"},"b":{"from":"b"}})',
    ]);
    expect(summary.status).toBe("success");
    const joinRun = runOf(summary, "join");
    expect(joinRun.status).toBe("success");
    // 多上游聚合形状：{ [上游 id]: 上游 output }（M15-T2 落地前键为内部节点 id）
    expect(joinRun.input).toEqual({ a: { from: "a" }, b: { from: "b" } });
    expect(joinRun.output).toBe("joined");
  });

  it("maxNodeConcurrency 限制全局并发上限：5 个无依赖节点任一时刻在途不超过 2", async () => {
    let inflight = 0;
    let peak = 0;
    const workflow = makeWorkflow(
      [
        makeNode("s", "start"),
        makeNode("a"),
        makeNode("b"),
        makeNode("c"),
        makeNode("d"),
        makeNode("e"),
      ],
      [
        makeEdge("s", "a"),
        makeEdge("s", "b"),
        makeEdge("s", "c"),
        makeEdge("s", "d"),
        makeEdge("s", "e"),
      ],
    );
    const summary = await executeWorkflow(workflow, {
      maxNodeConcurrency: 2,
      runners: {
        httpReplay: async (node) => {
          inflight++;
          peak = Math.max(peak, inflight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inflight--;
          return `out-${node.id}`;
        },
      },
    });

    expect(summary.status).toBe("success");
    // 上限生效：批次大小受 maxConcurrency 约束（2 < 缺省 4），峰值恰为 2；
    // start 为内置 no-op runner（瞬时结算），不影响峰值
    expect(peak).toBe(2);
  });

  it("缺省并发上限为 DEFAULT_MAX_NODE_CONCURRENCY（4）：5 节点峰值恰为 4", async () => {
    let inflight = 0;
    let peak = 0;
    const workflow = makeWorkflow(
      [
        makeNode("s", "start"),
        makeNode("a"),
        makeNode("b"),
        makeNode("c"),
        makeNode("d"),
        makeNode("e"),
      ],
      [
        makeEdge("s", "a"),
        makeEdge("s", "b"),
        makeEdge("s", "c"),
        makeEdge("s", "d"),
        makeEdge("s", "e"),
      ],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          inflight++;
          peak = Math.max(peak, inflight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inflight--;
          return `out-${node.id}`;
        },
      },
    });

    expect(summary.status).toBe("success");
    expect(DEFAULT_MAX_NODE_CONCURRENCY).toBe(4);
    expect(peak).toBe(4);
  });

  it("maxNodeConcurrency 无效值（0 / 非有限数）回退缺省 4", async () => {
    const runPeakOf = async (maxNodeConcurrency: number): Promise<number> => {
      let inflight = 0;
      let peak = 0;
      await executeWorkflow(
        makeWorkflow(
          [
            makeNode("s", "start"),
            makeNode("a"),
            makeNode("b"),
            makeNode("c"),
            makeNode("d"),
            makeNode("e"),
          ],
          [
            makeEdge("s", "a"),
            makeEdge("s", "b"),
            makeEdge("s", "c"),
            makeEdge("s", "d"),
            makeEdge("s", "e"),
          ],
        ),
        {
          maxNodeConcurrency,
          runners: {
            httpReplay: async (node) => {
              inflight++;
              peak = Math.max(peak, inflight);
              await new Promise((resolve) => setTimeout(resolve, 5));
              inflight--;
              return `out-${node.id}`;
            },
          },
        },
      );
      return peak;
    };

    // 0 / NaN 等无效值按缺省兜底（宽容处理）
    expect(await runPeakOf(0)).toBe(4);
    expect(await runPeakOf(Number.NaN)).toBe(4);
  });

  it("stop 失败的并发停机语义：同批在途节点自然结算并记录，但不启动任何新节点", async () => {
    // a 快速失败（stop）、b 慢（同批在途）：b 照常结算留痕；join 不再执行
    const events: string[] = [];
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("join")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("a", "join"), makeEdge("b", "join")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: {
        httpReplay: async (node) => {
          events.push(`start:${node.id}`);
          if (node.id === "a") throw new Error("a-down");
          if (node.id === "join") return "joined";
          // b：慢于 a 的失败结算——验证「在途自然结算」而非被中断
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push(`end:${node.id}`);
          return `out-${node.id}`;
        },
      },
    });

    // 同批的 a、b 都已起跑（批量并发）；b 作为在途节点自然结算并记录
    expect(events).toEqual(["start:a", "start:b", "end:b"]);
    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("节点 a 执行失败：a-down");
    expect(runOf(summary, "b").status).toBe("success");
    // join 未随 b 的成功被调度（stop 生效后不再启动任何新节点）→ 终态 skipped
    expect(runOf(summary, "join").status).toBe("skipped");
  });

  it("取消在批内触发：已起跑节点结算留痕，未起跑节点不再启动（skipped）", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    // s → a, b, c（三条无依赖下游）：a 起跑即取消——同批尚未启动的节点不再起跑
    const workflow = makeWorkflow(
      [makeNode("s", "start"), makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("s", "a"), makeEdge("s", "b"), makeEdge("s", "c")],
    );
    const summary = await executeWorkflow(workflow, {
      signal: controller.signal,
      maxNodeConcurrency: 1, // 串行批次：保证取消时 b / c 尚未启动
      runners: {
        httpReplay: async (node) => {
          executed.push(node.id);
          if (node.id === "a") controller.abort();
          return `out-${node.id}`;
        },
      },
    });

    expect(executed).toEqual(["a"]);
    expect(summary.status).toBe("cancelled");
    expect(runOf(summary, "b").status).toBe("skipped");
    expect(runOf(summary, "c").status).toBe("skipped");
  });
});
