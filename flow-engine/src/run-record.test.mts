import { describe, expect, it } from "vitest";
import type { NodeId, NodeRun, RunRecord } from "./types";
import { asNodeId, asRunId, asWorkflowId } from "./types";
import type { RunSummary } from "./executor";
import {
  DEGRADED_SNAPSHOT_BYTES,
  MIN_DEGRADED_SNAPSHOT_BYTES,
  RUN_RECORD_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  TRUNCATION_MARKER,
  buildRunRecord,
  capSnapshot,
  isTruncatedSnapshot,
  updateNodeRunSnapshot,
} from "./run-record";

/**
 * M5-T5 运行记录构建与快照体积控制测试：
 * capSnapshot（字符串 / 对象 / 数组 / 边界值 / 幂等 / 中文多字节 / 循环引用）、
 * buildRunRecord（字段完整映射、缺省值、单快照默认截断、整体超限两级降级到
 * 合规体积）、updateNodeRunSnapshot（最后写入优先的覆盖式合并）。
 * 全部纯函数，不发请求、不落库、不碰 UI。
 */

/* ---------------- 测试工具 ---------------- */

/** 字符串的 UTF-8 字节数（与实现同口径，断言用） */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 生成指定 UTF-8 字节数的 ASCII 串（'a' 每字符 1 字节） */
function asciiOf(bytes: number): string {
  return "a".repeat(bytes);
}

/** 生成指定 UTF-8 字节数的中文串（'中' 每字符 3 字节，余量用 'a' 补齐） */
function chineseOf(bytes: number): string {
  const full = Math.floor(bytes / 3);
  return "中".repeat(full) + "a".repeat(bytes - full * 3);
}

/** 构造节点执行快照（默认 success / 空入参出参） */
function makeNodeRun(partial: Partial<NodeRun> = {}): NodeRun {
  return {
    status: "success",
    input: null,
    output: null,
    startedAt: 1000,
    durationMs: 5,
    ...partial,
  };
}

/** 断言便捷：按字符串 id 读取节点快照（业务键为品牌 NodeId，内部转换） */
function runOf(nodeRuns: Record<NodeId, NodeRun> | undefined, nodeId: string): NodeRun | undefined {
  return nodeRuns ? nodeRuns[asNodeId(nodeId)] : undefined;
}

/** 构造运行摘要（默认 success，nodeRuns 可覆盖） */
function makeSummary(
  nodeRuns: Record<string, NodeRun>,
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId: asRunId("run-1"),
    workflowId: asWorkflowId("wf-1"),
    status: "success",
    nodeRuns,
    ...overrides,
  };
}

describe("run-record：capSnapshot 快照体积控制", () => {
  it("未超限的值原样透传（同引用，capped=false，无 originalBytes）", () => {
    const smallObject = { a: 1, b: "中文", c: [1, 2, 3] };
    for (const value of ["hello", smallObject, [1, 2], null, 42, true]) {
      const result = capSnapshot(value, SNAPSHOT_MAX_BYTES, "n1.output");
      expect(result.capped).toBe(false);
      expect(result.value).toBe(value);
      expect(result.originalBytes).toBeUndefined();
    }
  });

  it("字符串超限：直接截断，尾部附 TRUNCATION_MARKER、label 与原始字节数，整体不超上限", () => {
    const result = capSnapshot(asciiOf(1000), 100, "n1.output");
    expect(result.capped).toBe(true);
    expect(result.originalBytes).toBe(1000);
    const text = result.value as string;
    expect(text.startsWith("aaa")).toBe(true);
    expect(text).toContain(TRUNCATION_MARKER);
    expect(text).toContain("n1.output");
    expect(text.endsWith("原 1000 字节）")).toBe(true);
    expect(byteLength(text)).toBeLessThanOrEqual(100);
  });

  it("中文串超限：按 UTF-8 字节计量截断，切点落在字符边界（无乱码替换符）", () => {
    const result = capSnapshot(chineseOf(300), 50, "n1.output");
    expect(result.capped).toBe(true);
    expect(result.originalBytes).toBe(300);
    const text = result.value as string;
    expect(byteLength(text)).toBeLessThanOrEqual(50);
    const head = text.slice(0, text.indexOf(TRUNCATION_MARKER));
    expect(head.startsWith("中中中")).toBe(true);
    expect(head).not.toContain("\uFFFD");
  });

  it("对象超限：包 TruncatedSnapshot（__truncated/preview/originalBytes），包装整体不超上限", () => {
    const original = { data: asciiOf(1000) };
    const result = capSnapshot(original, 300, "n1.output");
    expect(result.capped).toBe(true);
    expect(result.originalBytes).toBe(byteLength(JSON.stringify(original)));
    const wrapper = result.value;
    expect(isTruncatedSnapshot(wrapper)).toBe(true);
    const snapshot = wrapper as Record<string, unknown>;
    expect(snapshot["__truncated"]).toBe(true);
    expect(typeof snapshot["preview"]).toBe("string");
    const preview = snapshot["preview"] as string;
    expect(preview.startsWith('{"data":"aaa')).toBe(true);
    expect(preview.endsWith(`${TRUNCATION_MARKER}（n1.output）`)).toBe(true);
    expect(byteLength(JSON.stringify(wrapper))).toBeLessThanOrEqual(300);
  });

  it("数组超限：与对象同样走包装路径", () => {
    const original = [asciiOf(500), asciiOf(500)];
    const result = capSnapshot(original, 200, "n1.output");
    expect(result.capped).toBe(true);
    expect(isTruncatedSnapshot(result.value)).toBe(true);
    expect(byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(200);
  });

  it("边界值：序列化字节数恰好等于上限不截断，多 1 字节即截断", () => {
    // 字符串：'a' × 10 按原始 UTF-8 字节计为 10（落库存储口径）
    expect(capSnapshot(asciiOf(10), 10, "x").capped).toBe(false);
    expect(capSnapshot(asciiOf(10), 9, "x").capped).toBe(true);
    // 对象：{"a":"x"} 序列化 9 字节
    expect(capSnapshot({ a: "x" }, 9, "x").capped).toBe(false);
    expect(capSnapshot({ a: "x" }, 8, "x").capped).toBe(true);
  });

  it("幂等：已截断字符串以同上限重入原样返回（capped=false）", () => {
    const first = capSnapshot(asciiOf(1000), 100, "n1.output");
    const second = capSnapshot(first.value, 100, "n1.output");
    expect(second.capped).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it("幂等：已截断包装以同上限重入原样返回（capped=false）", () => {
    const first = capSnapshot({ data: asciiOf(1000) }, 100, "n1.output");
    const second = capSnapshot(first.value, 100, "n1.output");
    expect(second.capped).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it("上限收紧：已截断包装继续收缩 preview，originalBytes 保留最原始值", () => {
    const first = capSnapshot({ data: asciiOf(5000) }, 500, "n1.output");
    const firstWrapper = first.value as Record<string, unknown>;
    expect(firstWrapper["originalBytes"]).toBe(byteLength(JSON.stringify({ data: asciiOf(5000) })));

    const second = capSnapshot(first.value, 100, "n1.output");
    expect(second.capped).toBe(true);
    expect(second.originalBytes).toBe(first.originalBytes);
    const secondWrapper = second.value as Record<string, unknown>;
    expect(isTruncatedSnapshot(secondWrapper)).toBe(true);
    expect((secondWrapper["preview"] as string).length).toBeLessThan(
      (firstWrapper["preview"] as string).length,
    );
    expect(byteLength(JSON.stringify(second.value))).toBeLessThanOrEqual(100);
  });

  it("上限收紧：已截断字符串继续收缩，originalBytes 保留最原始值", () => {
    const first = capSnapshot(asciiOf(5000), 500, "n1.output");
    const second = capSnapshot(first.value, 100, "n1.output");
    expect(second.capped).toBe(true);
    expect(second.originalBytes).toBe(5000);
    expect(byteLength(second.value as string)).toBeLessThanOrEqual(100);
    expect(second.value).toContain("原 5000 字节）");
  });

  it("循环引用：不抛错；未超限原样透传，超限按包装兜底（有界）", () => {
    const circular: Record<string, unknown> = { name: "ok" };
    circular["self"] = circular;
    const small = capSnapshot(circular, SNAPSHOT_MAX_BYTES, "n1.output");
    expect(small.capped).toBe(false);
    expect(small.value).toBe(circular);

    // 占位文本 '<unserializable>' 计 18 字节，上限 10 时超限 → 包装兜底；
    // 上限小于包装结构自身开销属病理配置，只断言有界结构、不断言字节上限
    const capped = capSnapshot(circular, 10, "n1.output");
    expect(capped.capped).toBe(true);
    expect(capped.originalBytes).toBe(18);
    expect(isTruncatedSnapshot(capped.value)).toBe(true);
  });

  it("病理上限（0）：返回有界的截断结果，不抛错", () => {
    const stringResult = capSnapshot(asciiOf(100), 0, "n1.output");
    expect(stringResult.capped).toBe(true);
    const objectResult = capSnapshot({ a: 1 }, 0, "n1.output");
    expect(objectResult.capped).toBe(true);
    expect(isTruncatedSnapshot(objectResult.value)).toBe(true);
  });
});

describe("run-record：updateNodeRunSnapshot 覆盖式合并", () => {
  it("同一节点重跑以最后一次为准，其余节点保留，原表不被修改", () => {
    const first = makeNodeRun({ status: "success", output: "第一次" });
    const rerun = makeNodeRun({ status: "failed", output: null, error: "重跑失败" });
    const other = makeNodeRun({ status: "skipped" });
    const base = { [asNodeId("n1")]: first, [asNodeId("n2")]: other };

    const merged = updateNodeRunSnapshot(base, asNodeId("n1"), rerun);

    expect(runOf(merged, "n1")).toBe(rerun);
    expect(runOf(merged, "n1")?.status).toBe("failed");
    expect(runOf(merged, "n2")).toBe(other);
    expect(Object.keys(merged)).toEqual(["n1", "n2"]);
    // 纯函数：原表不受影响
    expect(runOf(base, "n1")).toBe(first);
    // 新增节点同理
    const added = updateNodeRunSnapshot(merged, asNodeId("n3"), makeNodeRun());
    expect(runOf(added, "n3")).toBeDefined();
    expect(runOf(added, "n1")).toBe(rerun);
  });
});

describe("run-record：buildRunRecord", () => {
  it("字段完整映射：id / workflowId / status / trigger / startedAt / finishedAt / error / nodeRuns", () => {
    const nodeRuns = {
      n1: makeNodeRun({ status: "failed", input: { k: 1 }, output: null, error: "boom" }),
    };
    const record = buildRunRecord({
      summary: makeSummary(nodeRuns, { status: "failed", error: "节点 n1 执行失败：boom" }),
      runId: asRunId("run-9"),
      workflowId: asWorkflowId("wf-9"),
      trigger: "debug",
      startedAt: 1111,
      finishedAt: 2222,
    });

    expect(record.id).toBe("run-9");
    expect(record.workflowId).toBe("wf-9");
    expect(record.status).toBe("failed");
    expect(record.trigger).toBe("debug");
    expect(record.startedAt).toBe(1111);
    expect(record.finishedAt).toBe(2222);
    expect(record.error).toBe("节点 n1 执行失败：boom");
    expect(runOf(record.nodeRuns, "n1")).toEqual(nodeRuns["n1"]);
  });

  it("缺省值：workflowId 取 summary.workflowId，trigger 缺省 manual，finishedAt 未提供不写字段", () => {
    const record = buildRunRecord({
      summary: makeSummary({}),
      runId: asRunId("run-1"),
      startedAt: 1000,
    });
    expect(record.workflowId).toBe("wf-1");
    expect(record.trigger).toBe("manual");
    expect(record.error).toBeUndefined();
    expect("finishedAt" in record).toBe(false);
  });

  it("小快照原样保留，NodeRun 其余字段（status/error/startedAt/durationMs）不受截断影响", () => {
    const nodeRuns = {
      n1: makeNodeRun({ input: { small: "数据" }, output: { ok: true }, durationMs: 33 }),
    };
    const record = buildRunRecord({
      summary: makeSummary(nodeRuns),
      runId: asRunId("run-1"),
      startedAt: 1000,
      finishedAt: 2000,
    });
    expect(runOf(record.nodeRuns, "n1")?.input).toEqual({ small: "数据" });
    expect(runOf(record.nodeRuns, "n1")?.output).toEqual({ ok: true });
    expect(runOf(record.nodeRuns, "n1")?.durationMs).toBe(33);
    expect(isTruncatedSnapshot(runOf(record.nodeRuns, "n1")?.input)).toBe(false);
  });

  it("单快照默认 256KB 上限：超大字符串 output 被截断且整条记录 ≤ 2MB", () => {
    const nodeRuns = {
      n1: makeNodeRun({ output: asciiOf(1024 * 1024) }),
    };
    const record = buildRunRecord({
      summary: makeSummary(nodeRuns),
      runId: asRunId("run-1"),
      startedAt: 1000,
      finishedAt: 2000,
    });
    const output = runOf(record.nodeRuns, "n1")?.output as string;
    expect(output).toContain(TRUNCATION_MARKER);
    expect(output).toContain("n1.output");
    expect(output).toContain("原 1048576 字节）");
    expect(byteLength(output)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(byteLength(JSON.stringify(record))).toBeLessThanOrEqual(RUN_RECORD_MAX_BYTES);
  });

  it("input 与 output 分别独立过 capSnapshot", () => {
    const nodeRuns = {
      n1: makeNodeRun({ input: asciiOf(1024 * 1024), output: { tiny: true } }),
    };
    const record = buildRunRecord({
      summary: makeSummary(nodeRuns),
      runId: asRunId("run-1"),
      startedAt: 1000,
      finishedAt: 2000,
    });
    expect(runOf(record.nodeRuns, "n1")?.output).toEqual({ tiny: true });
    expect(byteLength(runOf(record.nodeRuns, "n1")?.input as string)).toBeLessThanOrEqual(
      SNAPSHOT_MAX_BYTES,
    );
  });

  it("两级降级：整体超 2MB 时先降到 64KB，仍超则继续对半直至合规", () => {
    // 40 节点 × 200KB：256KB 档不截（总 8MB）→ 64KB 档（总约 2.6MB，仍超）→ 32KB 档（约 1.3MB，合规）
    const nodeRuns: Record<string, NodeRun> = {};
    for (let i = 0; i < 40; i++) {
      nodeRuns[`n${i}`] = makeNodeRun({ output: asciiOf(200 * 1024) });
    }
    const record = buildRunRecord({
      summary: makeSummary(nodeRuns),
      runId: asRunId("run-big"),
      startedAt: 1000,
      finishedAt: 2000,
    });

    const total = byteLength(JSON.stringify(record));
    expect(total).toBeLessThanOrEqual(RUN_RECORD_MAX_BYTES);
    // 已低于 64KB 首档，说明发生了逐级对半
    expect(byteLength(runOf(record.nodeRuns, "n0")?.output as string)).toBeLessThanOrEqual(
      DEGRADED_SNAPSHOT_BYTES,
    );
    expect(byteLength(runOf(record.nodeRuns, "n0")?.output as string)).toBeLessThan(200 * 1024);
    // 截断尾部保留最初原始字节数
    expect(runOf(record.nodeRuns, "n0")?.output).toContain("原 204800 字节）");
    // 极端配置（超小降级档位）也要终止：达到下限后如实放行，不无限循环
    const floorRecord = buildRunRecord(
      {
        summary: makeSummary(nodeRuns),
        runId: asRunId("run-floor"),
        startedAt: 1000,
        finishedAt: 2000,
      },
      { degradedSnapshotBytes: MIN_DEGRADED_SNAPSHOT_BYTES, recordMaxBytes: 1024 },
    );
    expect(byteLength(JSON.stringify(floorRecord))).toBeGreaterThan(0);
  });

  it("自定义体积参数生效（snapshotMaxBytes / recordMaxBytes）", () => {
    const nodeRuns = { n1: makeNodeRun({ output: asciiOf(1000) }) };
    const record: RunRecord = buildRunRecord(
      {
        summary: makeSummary(nodeRuns),
        runId: asRunId("run-1"),
        startedAt: 1000,
        finishedAt: 2000,
      },
      { snapshotMaxBytes: 100 },
    );
    expect(byteLength(runOf(record.nodeRuns, "n1")?.output as string)).toBeLessThanOrEqual(100);
  });
});
