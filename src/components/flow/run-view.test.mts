import { describe, expect, test } from "vitest";
import type { FlowNodeRunRecord, FlowRunRecord, WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  buildRunListQuery,
  countFailedNodeRuns,
  formatDurationMs,
  formatRunDuration,
  hasActiveFilters,
  iterationProgress,
  listStaleNodeRuns,
  nodeRunsToRunStates,
  nodeRunStatusLabel,
  nodeTypeLabel,
  parseGraphSnapshot,
  resolveRunGraph,
  runGraphDisclosures,
  runPageCount,
  runStatusLabel,
  runTriggerLabel,
  sortNodeRunsByExecution,
  withEdgeRunClasses,
} from "./run-view";
import { getWorkflowNodeMeta } from "./node-meta";

/** 造一条最小运行记录（列表 / 图还原口径）。 */
function sampleRun(overrides: Partial<FlowRunRecord> = {}): FlowRunRecord {
  return {
    id: "run-1234567890",
    workflowId: "wf-1",
    workflowName: "演示流程",
    trigger: "manual",
    status: "success",
    startedAt: 1000,
    ...overrides,
  };
}

/** 造一条最小节点 checkpoint。 */
function sampleNodeRun(
  overrides: Partial<FlowNodeRunRecord> & { nodeId: string },
): FlowNodeRunRecord {
  return {
    runId: "run-1234567890",
    status: "success",
    updatedAt: 1100,
    ...overrides,
  };
}

const sampleNodes: WorkflowNode[] = [
  { id: "s", type: "start", position: { x: 0, y: 0 }, config: {} },
  { id: "n1", type: "httpReplay", position: { x: 200, y: 0 }, config: {} },
];
const sampleEdges: WorkflowEdge[] = [{ id: "e1", source: "s", target: "n1" }];

describe("状态与触发方式文案", () => {
  test("运行状态中文文案齐全，未知取值原样返回", () => {
    expect(runStatusLabel("running")).toBe("进行中");
    expect(runStatusLabel("success")).toBe("成功");
    expect(runStatusLabel("failed")).toBe("失败");
    expect(runStatusLabel("cancelled")).toBe("已取消");
    expect(runStatusLabel("interrupted")).toBe("已中断");
    expect(runStatusLabel("mystery")).toBe("mystery");
  });

  test("触发方式文案：manual 手动、debug 调试、未知原样", () => {
    expect(runTriggerLabel("manual")).toBe("手动");
    expect(runTriggerLabel("debug")).toBe("调试");
    expect(runTriggerLabel("other")).toBe("other");
  });

  test("节点状态文案：中断运行里停留的 running 按「未完成」中性口径", () => {
    expect(nodeRunStatusLabel("running", false)).toBe("执行中");
    expect(nodeRunStatusLabel("running", true)).toBe("未完成");
    expect(nodeRunStatusLabel("skipped", true)).toBe("跳过");
    expect(nodeRunStatusLabel("cancelled", false)).toBe("已取消");
  });

  test("节点展示名：行内改名优先，否则类型标签；未知类型回落请求重放", () => {
    expect(nodeTypeLabel("delay", undefined)).toBe(getWorkflowNodeMeta("delay").label);
    expect(nodeTypeLabel("delay", "  等一等  ")).toBe("等一等");
    expect(nodeTypeLabel("future-type", undefined)).toBe(getWorkflowNodeMeta("future-type").label);
  });
});

describe("耗时格式化", () => {
  test("毫秒 / 秒 / 分秒档与进位边界", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(850)).toBe("850ms");
    expect(formatDurationMs(1200)).toBe("1.2s");
    expect(formatDurationMs(59_950)).toBe("1 分 0 秒");
    expect(formatDurationMs(65_400)).toBe("1 分 5 秒");
    expect(formatDurationMs(-5)).toBe("0ms");
  });

  test("由运行记录计算耗时：running 缺 finishedAt 显示进行中，其余按时长", () => {
    expect(formatRunDuration({ status: "running", startedAt: 0, finishedAt: undefined })).toBe(
      "进行中…",
    );
    expect(formatRunDuration({ status: "success", startedAt: 0, finishedAt: 1500 })).toBe("1.5s");
    expect(formatRunDuration({ status: "failed", startedAt: 100, finishedAt: undefined })).toBe(
      "—",
    );
  });
});

describe("列表筛选参数组装与分页", () => {
  test("『all』哨兵与空值不下发，页码换算 offset，limit 恒为每页条数", () => {
    expect(buildRunListQuery({ workflowId: "all", status: "all" }, 0)).toEqual({
      limit: 20,
      offset: 0,
    });
    expect(buildRunListQuery({ workflowId: "wf-1", status: "failed" }, 2)).toEqual({
      workflowId: "wf-1",
      status: "failed",
      limit: 20,
      offset: 40,
    });
    expect(buildRunListQuery({ workflowId: "", status: "success" }, 0)).toEqual({
      status: "success",
      limit: 20,
      offset: 0,
    });
  });

  test("负页码按 0 处理", () => {
    expect(buildRunListQuery({ workflowId: "all", status: "all" }, -3)).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  test("页数与筛选生效判定", () => {
    expect(runPageCount(0)).toBe(1);
    expect(runPageCount(21)).toBe(2);
    expect(hasActiveFilters({ workflowId: "all", status: "all" })).toBe(false);
    expect(hasActiveFilters({ workflowId: "wf-1", status: "all" })).toBe(true);
    expect(hasActiveFilters({ workflowId: "all", status: "failed" })).toBe(true);
  });
});

describe("图快照解析与三态还原", () => {
  test("快照优先：nodes / edges / truncated 透传", () => {
    const resolved = resolveRunGraph(
      sampleRun({ graphSnapshot: { nodes: sampleNodes, edges: sampleEdges, truncated: true } }),
      null,
    );
    expect(resolved).toEqual({
      nodes: sampleNodes,
      edges: sampleEdges,
      source: "snapshot",
      truncated: true,
    });
  });

  test("无快照旧记录回落当前流程定义（source=workflow，truncated=false）", () => {
    const resolved = resolveRunGraph(sampleRun({ graphSnapshot: undefined }), {
      id: "wf-1",
      nodes: sampleNodes,
      edges: sampleEdges,
    } as Workflow & Record<string, never>);
    expect(resolved.source).toBe("workflow");
    expect(resolved.nodes).toBe(sampleNodes);
    expect(resolved.truncated).toBe(false);
  });

  test("无快照且流程已删除 → source=none（画布空态）", () => {
    const resolved = resolveRunGraph(sampleRun({ graphSnapshot: null }), null);
    expect(resolved.source).toBe("none");
    expect(resolved.nodes).toEqual([]);
  });

  test("防御解析：非对象 / 缺字段 / 非法 position 收敛为可渲染形状", () => {
    expect(parseGraphSnapshot("junk")).toEqual({ nodes: [], edges: [], truncated: false });
    const parsed = parseGraphSnapshot({
      nodes: [
        { id: "a", type: "delay", position: { x: 1, y: 2 }, config: { durationMs: 5 } },
        { id: "b" },
        "junk",
      ],
      edges: [{ id: "e", source: "a", target: "b", sourceHandle: "true" }, "junk"],
      truncated: true,
      extra: "ignored",
    });
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes).toEqual([
      { id: "a", type: "delay", position: { x: 1, y: 2 }, config: { durationMs: 5 } },
      { id: "b", type: "httpReplay", position: { x: 0, y: 0 }, config: {} },
    ]);
    expect(parsed.edges).toEqual([{ id: "e", source: "a", target: "b", sourceHandle: "true" }]);
  });

  test("披露文案：降级 / 回落 / 不可还原三态", () => {
    const degraded = { nodes: [], edges: [], source: "snapshot" as const, truncated: true };
    expect(runGraphDisclosures(degraded, true)).toHaveLength(1);
    expect(runGraphDisclosures(degraded, true)[0]).toContain("图快照已降级");

    const fallback = { nodes: [], edges: [], source: "workflow" as const, truncated: false };
    const fallbackMessages = runGraphDisclosures(fallback, true);
    expect(fallbackMessages).toHaveLength(1);
    expect(fallbackMessages[0]).toContain("图快照缺失，按当前流程定义显示");

    expect(
      runGraphDisclosures({ nodes: [], edges: [], source: "none", truncated: false }, true),
    ).toEqual(["流程定义已删除且无图快照，画布不可还原"]);
    expect(
      runGraphDisclosures({ nodes: [], edges: [], source: "none", truncated: false }, false),
    ).toEqual(["图快照缺失且后端未提供流程定义能力，画布不可还原"]);

    // 完整快照无需披露
    expect(
      runGraphDisclosures({ nodes: [], edges: [], source: "snapshot", truncated: false }, true),
    ).toEqual([]);
  });
});

describe("节点运行态着色投影", () => {
  test("状态直映射 + error 随行携带", () => {
    const states = nodeRunsToRunStates(
      [
        sampleNodeRun({ nodeId: "n1", status: "success" }),
        sampleNodeRun({ nodeId: "n2", status: "failed", error: "boom" }),
        sampleNodeRun({ nodeId: "n3", status: "cancelled" }),
        sampleNodeRun({ nodeId: "n4", status: "skipped" }),
        sampleNodeRun({ nodeId: "n5", status: "running" }),
      ],
      "running",
    );
    expect(states.n1).toMatchObject({ status: "success", rawStatus: "success" });
    expect(states.n2).toMatchObject({ status: "failed", error: "boom" });
    expect(states.n3?.status).toBe("cancelled");
    expect(states.n4?.status).toBe("skipped");
    expect(states.n5?.status).toBe("running");
  });

  test("中断运行里停留在 running 的节点映射为中性档（rawStatus 保留 running）", () => {
    const states = nodeRunsToRunStates(
      [
        sampleNodeRun({ nodeId: "n1", status: "success" }),
        sampleNodeRun({ nodeId: "n2", status: "running" }),
      ],
      "interrupted",
    );
    expect(states.n1?.status).toBe("success");
    expect(states.n2).toMatchObject({
      status: "skipped",
      rawStatus: "running",
      runInterrupted: true,
    });
  });

  test("非中断运行的 running 节点保持 running（转圈脉冲）", () => {
    const states = nodeRunsToRunStates(
      [sampleNodeRun({ nodeId: "n1", status: "running" })],
      "running",
    );
    expect(states.n1).toMatchObject({ status: "running", runInterrupted: false });
  });

  test("循环迭代进度防御提取：正常 / 缺字段 / 非对象", () => {
    expect(
      iterationProgress({ total: 5, done: 2, capped: true, records: [], truncated: false }),
    ).toEqual({
      total: 5,
      done: 2,
      capped: true,
    });
    expect(iterationProgress({ done: 1 } as FlowNodeRunRecord["iterations"])).toBeNull();
    expect(iterationProgress(undefined)).toBeNull();
    expect(iterationProgress(null)).toBeNull();
  });

  test("进度并入运行态 map（已迭代 done/total/capped）", () => {
    const states = nodeRunsToRunStates(
      [
        sampleNodeRun({
          nodeId: "loop",
          iterations: { total: 5, done: 2, capped: true, records: [], truncated: false },
        }),
      ],
      "success",
    );
    expect(states.loop).toMatchObject({
      iterationsDone: 2,
      iterationsTotal: 5,
      iterationsCapped: true,
    });
  });
});

describe("执行顺序与陈旧节点", () => {
  test("按 startedAt 升序，同毫秒按 nodeId 字典序稳定排序", () => {
    const entries = sortNodeRunsByExecution([
      sampleNodeRun({ nodeId: "b", startedAt: 20 }),
      sampleNodeRun({ nodeId: "a", startedAt: 20 }),
      sampleNodeRun({ nodeId: "c", startedAt: 10 }),
      sampleNodeRun({ nodeId: "d", startedAt: undefined }),
    ]);
    expect(entries.map((entry) => entry.nodeId)).toEqual(["d", "c", "a", "b"]);
  });

  test("失败计数与陈旧节点清单", () => {
    const nodeRuns = [
      sampleNodeRun({ nodeId: "s", status: "success" }),
      sampleNodeRun({ nodeId: "n1", status: "failed" }),
      sampleNodeRun({ nodeId: "ghost", status: "failed" }),
    ];
    expect(countFailedNodeRuns(nodeRuns)).toBe(2);
    const stale = listStaleNodeRuns(nodeRuns, sampleNodes);
    expect(stale.map((entry) => entry.nodeId)).toEqual(["ghost"]);
  });
});

describe("边运行态", () => {
  test("仅目标端 running 加流动动画类，其余边显式清除 class", () => {
    // 执行到节点 b：流入 b 的 e1 动画，b 的出边 e2 保持常态（source running
    // 不点亮出边——动画语义是「数据正流入执行中节点」）
    const states = nodeRunsToRunStates(
      [
        sampleNodeRun({ nodeId: "a", status: "success" }),
        sampleNodeRun({ nodeId: "b", status: "running" }),
      ],
      "running",
    );
    const edges = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ];
    const withClasses = withEdgeRunClasses(edges, states);
    expect(withClasses[0]).toEqual({
      id: "e1",
      source: "a",
      target: "b",
      class: "flow-edge-running",
    });
    // 未命中边显式 class: undefined——Vue Flow 按 Object.assign 合并边更新，
    // 缺席键不清除旧值，动画类会永久滞留（运行结束停不下来）
    expect(withClasses[1]).toEqual({ id: "e2", source: "b", target: "c", class: undefined });

    // 执行推进到 c 后：e1 的动画清除，e2 点亮
    const nextStates = nodeRunsToRunStates(
      [
        sampleNodeRun({ nodeId: "b", status: "success" }),
        sampleNodeRun({ nodeId: "c", status: "running" }),
      ],
      "running",
    );
    const advanced = withEdgeRunClasses(edges, nextStates);
    expect(advanced[0]).toEqual({ id: "e1", source: "a", target: "b", class: undefined });
    expect(advanced[1]).toEqual({
      id: "e2",
      source: "b",
      target: "c",
      class: "flow-edge-running",
    });
  });

  test("运行态关闭（null）时全部边显式清除 class", () => {
    const edges = [{ id: "e1", source: "a", target: "b" }];
    expect(withEdgeRunClasses(edges, null)).toEqual([
      { id: "e1", source: "a", target: "b", class: undefined },
    ]);
  });

  test("运行结束（终态无 running）时全部边保持常态", () => {
    const states = nodeRunsToRunStates(
      [
        sampleNodeRun({ nodeId: "a", status: "success" }),
        sampleNodeRun({ nodeId: "b", status: "success" }),
      ],
      "success",
    );
    const edges = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ];
    for (const edge of withEdgeRunClasses(edges, states)) {
      expect(edge.class).toBeUndefined();
    }
  });
});
