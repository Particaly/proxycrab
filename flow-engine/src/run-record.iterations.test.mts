import { describe, expect, it } from "vitest";
import { buildRunRecord } from "./run-record";
import { isTruncatedSnapshot, TRUNCATION_MARKER } from "./run-record";
import {
  maskNodeRunForRecord,
  maskRunSummaryForRecord,
  SECRET_MASK_PLACEHOLDER,
} from "./secret-mask";
import { asNodeId, asRunId, asWorkflowId } from "./types";
import type { LoopIterationsSummary, NodeRun } from "./types";
import type { RunSummary } from "./executor";

/**
 * M13-T9 逐迭代明细的记录侧两道防线（既有 run-record / secret-mask 测试锁定
 * 既有行为，不在此重复）：
 *   - 体积控制（buildRunRecord / capNodeRuns）：逐迭代明细的 item / output 与
 *     节点快照同一档位过 capSnapshot，整体降级时同步收紧，进度字段原样保留；
 *   - 脱敏（maskNodeRunForRecord / maskRunSummaryForRecord）：每轮的 item /
 *     output 走深度掩码、失败轮 error 走文本掩码——循环体内回显 secret 的兜底。
 */

/** 构造逐迭代摘要（records 可覆盖） */
function makeIterations(overrides: Partial<LoopIterationsSummary> = {}): LoopIterationsSummary {
  return {
    total: 2,
    done: 2,
    capped: false,
    truncated: false,
    records: [
      { index: 0, item: "a", status: "success", output: { ok: 0 }, startedAt: 1000, durationMs: 5 },
      {
        index: 1,
        item: "b",
        status: "failed",
        output: null,
        startedAt: 1010,
        durationMs: 6,
        error: "第 2 轮失败",
      },
    ],
    ...overrides,
  };
}

/** 构造带迭代明细的 loop 节点快照 */
function makeLoopNodeRun(iterations: LoopIterationsSummary, output: unknown = []): NodeRun {
  return { status: "success", input: null, output, startedAt: 1000, durationMs: 10, iterations };
}

describe("buildRunRecord：逐迭代明细的体积收敛（M13-T9）", () => {
  it("未超限：明细原样保留（同引用形状不变，进度字段齐全）", () => {
    const iterations = makeIterations();
    const summary: RunSummary = {
      runId: asRunId("run-1"),
      workflowId: asWorkflowId("wf-1"),
      status: "success",
      nodeRuns: { [asNodeId("L")]: makeLoopNodeRun(iterations) },
    };
    const record = buildRunRecord({
      summary,
      runId: asRunId("run-1"),
      startedAt: 1,
      finishedAt: 2,
    });
    const loopIterations = record.nodeRuns[asNodeId("L")]!.iterations!;
    expect(loopIterations.total).toBe(2);
    expect(loopIterations.records[0]!.item).toBe("a");
    expect(loopIterations.records[1]!.error).toBe("第 2 轮失败");
  });

  it("单快照超限：每轮 item / output 分别过 capSnapshot（label 带轮次），进度字段不动", () => {
    const longText = "x".repeat(512);
    const iterations = makeIterations({
      records: [
        {
          index: 0,
          item: { payload: longText },
          status: "success",
          output: longText,
          startedAt: 1,
          durationMs: 1,
        },
        {
          index: 1,
          item: "short",
          status: "failed",
          output: null,
          startedAt: 2,
          durationMs: 1,
          error: "boom",
        },
      ],
    });
    const summary: RunSummary = {
      runId: asRunId("run-1"),
      workflowId: asWorkflowId("wf-1"),
      status: "success",
      nodeRuns: { [asNodeId("L")]: makeLoopNodeRun(iterations) },
    };
    const record = buildRunRecord(
      {
        summary,
        runId: asRunId("run-1"),
        startedAt: 1,
        finishedAt: 2,
      },
      { snapshotMaxBytes: 64 },
    );

    const capped = record.nodeRuns[asNodeId("L")]!.iterations!;
    // 进度元数据原样保留
    expect(capped.total).toBe(2);
    expect(capped.done).toBe(2);
    // 第 1 轮：对象 item → 截断包装；字符串 output → 截断文本
    const first = capped.records[0]!;
    expect(isTruncatedSnapshot(first.item)).toBe(true);
    expect(first.output).toContain(TRUNCATION_MARKER);
    // 第 2 轮未超限：原样保留（error 文本不参与快照截断）
    expect(capped.records[1]!.item).toBe("short");
    expect(capped.records[1]!.error).toBe("boom");
  });

  it("整体降级（recordMaxBytes 收紧）：逐迭代明细与节点快照同步收紧", () => {
    const iterations = makeIterations({
      records: [
        {
          index: 0,
          item: "y".repeat(2048),
          status: "success",
          output: "z".repeat(2048),
          startedAt: 1,
          durationMs: 1,
        },
      ],
    });
    const summary: RunSummary = {
      runId: asRunId("run-1"),
      workflowId: asWorkflowId("wf-1"),
      status: "success",
      nodeRuns: { [asNodeId("L")]: makeLoopNodeRun(iterations) },
    };
    // 强制整体超限：极小 recordMaxBytes → 降级档位逐级收紧
    const record = buildRunRecord(
      {
        summary,
        runId: asRunId("run-1"),
        startedAt: 1,
        finishedAt: 2,
      },
      { snapshotMaxBytes: 4096, recordMaxBytes: 512, degradedSnapshotBytes: 64 },
    );

    const item = record.nodeRuns[asNodeId("L")]!.iterations!.records[0]!.item;
    expect(typeof item).toBe("string");
    expect(item as string).toContain(TRUNCATION_MARKER);
    expect((item as string).length).toBeLessThan(2048);
  });
});

describe("maskNodeRunForRecord：逐迭代明细脱敏（M13-T9）", () => {
  const secrets = ["super-secret-token"];

  it("每轮 item / output 深度掩码、失败轮 error 文本掩码，其余字段原样", () => {
    const nodeRun = makeLoopNodeRun(
      makeIterations({
        records: [
          {
            index: 0,
            item: { token: "super-secret-token", plain: "ok" },
            status: "success",
            output: "Bearer super-secret-token",
            startedAt: 1,
            durationMs: 1,
          },
          {
            index: 1,
            item: "super-secret-token 的输入",
            status: "failed",
            output: null,
            startedAt: 2,
            durationMs: 1,
            error: "请求失败：super-secret-token 已回显",
          },
        ],
      }),
    );

    const masked = maskNodeRunForRecord(nodeRun, secrets);
    const records = masked.iterations!.records;
    // 嵌套对象内的 secret 值被整体替换
    expect(records[0]!.item).toEqual({ token: SECRET_MASK_PLACEHOLDER, plain: "ok" });
    expect(records[0]!.output).toBe(`Bearer ${SECRET_MASK_PLACEHOLDER}`);
    // 失败轮 item / error 文本掩码
    expect(records[1]!.item).toBe(`${SECRET_MASK_PLACEHOLDER} 的输入`);
    expect(records[1]!.error).toBe(`请求失败：${SECRET_MASK_PLACEHOLDER} 已回显`);
    // 元数据原样
    expect(records[0]!.status).toBe("success");
    expect(records[1]!.status).toBe("failed");
    // 不改动入参对象
    expect(nodeRun.iterations!.records[0]!.item).toEqual({
      token: "super-secret-token",
      plain: "ok",
    });
  });

  it("无 secret 命中时明细字符串保持原引用（零拷贝），无 iterations 字段不受影响", () => {
    const iterations = makeIterations();
    const nodeRun = makeLoopNodeRun(iterations);
    const masked = maskNodeRunForRecord(nodeRun, secrets);
    expect(masked.iterations!.records[0]!.item).toBe("a");
    // 无迭代明细的普通节点：掩码结果无 iterations 字段
    const plain: NodeRun = {
      status: "success",
      input: "x",
      output: "y",
      startedAt: 1,
      durationMs: 1,
    };
    expect(maskNodeRunForRecord(plain, secrets).iterations).toBeUndefined();
  });

  it("maskRunSummaryForRecord 路径同样覆盖逐迭代明细（定稿前统一脱敏）", () => {
    const summary: RunSummary = {
      runId: asRunId("run-1"),
      workflowId: asWorkflowId("wf-1"),
      status: "success",
      nodeRuns: {
        [asNodeId("L")]: makeLoopNodeRun(
          makeIterations({
            records: [
              {
                index: 0,
                item: "super-secret-token",
                status: "success",
                output: null,
                startedAt: 1,
                durationMs: 1,
              },
            ],
          }),
        ),
      },
    };
    const masked = maskRunSummaryForRecord(summary, secrets);
    expect(masked.nodeRuns[asNodeId("L")]!.iterations!.records[0]!.item).toBe(
      SECRET_MASK_PLACEHOLDER,
    );
  });
});
