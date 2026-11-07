import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkflow } from "./run-workflow";
import { buildTemplateContext } from "./executor";
import { renderTemplate } from "./template";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import type { WorkflowNode } from "./types";

/**
 * 工作流存储（storage）引擎侧测试：
 *   - 模板命名空间：`{{ storage.<key>.<path> }}` 取值 / 缺键告警（渲染不抛错）；
 *   - buildTemplateContext：storage 快照注入与浅拷贝；
 *   - 镜像包装（runWorkflow）：脚本经 host.storage 的 put/get/delete 同步维护
 *     运行内镜像——后续节点模板立即可见；宿主缺 storage 时行为不变；
 *   - 条件表达式：storage 只读快照形参可用。
 *
 * 全部用桩宿主（内存 KV + 假重放），不发请求、不落盘。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 构造画布节点（httpReplay 缺省，config 可覆盖） */
function makeNode(
  id: string,
  type: WorkflowNode["type"] = "httpReplay",
  config: WorkflowNode["config"] = {},
): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
}

/** 构造连线（id 由 source→target 拼出） */
function makeEdge(source: string, target: string) {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

/** 内存 KV 桩（模拟 Rust 侧 host.storage 同步工作流存储面；initial 模拟
 * 「派发快照与宿主同源」——真实链路两者读同一份持久层文件） */
function stubStorageHost(
  initial: Record<string, unknown> = {},
): {
  storage: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
  };
  replay: ReturnType<typeof vi.fn>;
} {
  const table = new Map<string, unknown>(Object.entries(initial));
  const storage = {
    get: vi.fn((key: string) =>
      table.has(key)
        ? { found: true, value: table.get(key) }
        : { found: false, value: null },
    ),
    put: vi.fn((key: string, value: unknown) => {
      table.set(key, value);
      return { updatedAt: 1 };
    }),
    delete: vi.fn((key: string) => ({ deleted: table.delete(key) })),
    keys: vi.fn(() => ({ keys: [...table.keys()].sort() })),
  };
  const replay = vi.fn(async (payload: { url: string }) => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: payload.url }),
    durationMs: 1,
  }));
  vi.stubGlobal("host", { replay, storage });
  return { storage, replay };
}

describe("模板 storage 命名空间", () => {
  it("解析键值与路径取数", () => {
    const ctx = buildTemplateContext({}, null, undefined, undefined, {
      token: "tk-1",
      obj: { a: [1, 2] },
    });
    expect(renderTemplate("{{ storage.token }}", ctx).value).toBe("tk-1");
    expect(renderTemplate("{{ storage.obj.a.1 }}", ctx).value).toBe("2");
    expect(renderTemplate("x{{ storage.token }}y", ctx).value).toBe("xtk-1y");
  });

  it("缺键告警渲染空串，缺 storage 表同样告警不抛错", () => {
    const withTable = buildTemplateContext({}, null, undefined, undefined, { a: 1 });
    const missing = renderTemplate("{{ storage.missing }}", withTable);
    expect(missing.value).toBe("");
    expect(missing.warnings.join("\n")).toContain("存储键不存在");

    const noTable = buildTemplateContext({}, null);
    const absent = renderTemplate("{{ storage.any }}", noTable);
    expect(absent.value).toBe("");
    expect(absent.warnings.join("\n")).toContain("存储键不存在");
  });

  it("storage 未注入时模板上下文保持既有形状", () => {
    const ctx = buildTemplateContext({}, null);
    expect(ctx.storage).toBeUndefined();
    expect(Object.keys(ctx).sort()).toEqual(["input", "node"]);
  });
});

describe("runWorkflow 存储镜像包装", () => {
  it("前置脚本 host.storage.put 对后续节点模板立即可见", async () => {
    const { replay } = stubStorageHost();
    const summary = await runWorkflow(
      {
        id: asWorkflowId("wf-storage-put"),
        nodes: [
          makeNode("s", "start"),
          makeNode("a", "httpReplay", {
            manualRequest: { method: "GET", url: "https://example.test/a" },
            preProcess: `
              host.storage.put("counter", 42);
              return {};
            `,
          }),
          makeNode("b", "httpReplay", {
            manualRequest: {
              method: "GET",
              url: "https://example.test/{{ storage.counter }}",
            },
          }),
        ],
        edges: [makeEdge("s", "a"), makeEdge("a", "b")],
      },
      // 派发种子（空表）触发镜像注入；脚本写入经镜像对节点 b 可见
      { storage: {} },
    );
    expect(summary.status).toBe("success");
    const urls = replay.mock.calls.map((call) => (call[0] as { url: string }).url);
    expect(urls.some((url) => url.includes("/42"))).toBe(true);
  });

  it("host.storage.get 读到派发种子与外部写入（found 语义透传）", async () => {
    stubStorageHost({ seed: { n: 7 } });
    const summary = await runWorkflow(
      {
        id: asWorkflowId("wf-storage-get"),
        nodes: [
          makeNode("s", "start"),
          makeNode("a", "httpReplay", {
            manualRequest: { method: "GET", url: "https://example.test/a" },
            postProcess: `
              const seeded = host.storage.get("seed");
              const missing = host.storage.get("nope");
              return { seeded: seeded.value, seededFound: seeded.found, missingFound: missing.found };
            `,
          }),
        ],
        edges: [makeEdge("s", "a")],
      },
      { storage: { seed: { n: 7 } } },
    );
    expect(summary.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("a")]?.output).toEqual({
      seeded: { n: 7 },
      seededFound: true,
      missingFound: false,
    });
  });

  it("未传 options.storage 时不注入 storage（既有行为不变）", async () => {
    const { replay } = stubStorageHost();
    const summary = await runWorkflow({
      id: asWorkflowId("wf-storage-absent"),
      nodes: [
        makeNode("s", "start"),
        makeNode("a", "httpReplay", {
          manualRequest: {
            method: "GET",
            url: "https://example.test/{{ storage.counter }}",
          },
        }),
      ],
      edges: [makeEdge("s", "a")],
    });
    expect(summary.status).toBe("success");
    // 缺省约定：缺 storage 表 → 告警渲染空串，URL 不含任何注入值
    const url = (replay.mock.calls[0]?.[0] as { url: string }).url;
    expect(url).toBe("https://example.test/");
  });
});

describe("条件表达式 storage 形参", () => {
  it("表达式可读取 storage 只读快照并据此路由", async () => {
    stubStorageHost();
    const summary = await runWorkflow(
      {
        id: asWorkflowId("wf-storage-condition"),
        nodes: [
          makeNode("s", "start"),
          makeNode("c", "condition", {
            expression: `return storage.flag === "on";`,
          }),
          makeNode("t", "httpReplay", {
            manualRequest: { method: "GET", url: "https://example.test/true" },
          }),
        ],
        edges: [makeEdge("s", "c"), makeEdge("c", "t")],
      },
      { storage: { flag: "on" } },
    );
    expect(summary.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("c")]?.output).toMatchObject({ branch: "true" });
    expect(summary.nodeRuns[asNodeId("t")]?.status).toBe("success");
  });

  it("表达式内 storage 为只读快照（赋值不落库也不影响分支求值）", async () => {
    stubStorageHost();
    const summary = await runWorkflow(
      {
        id: asWorkflowId("wf-storage-readonly"),
        nodes: [
          makeNode("s", "start"),
          makeNode("c", "condition", {
            expression: `
              storage.flag = "off"; // 只读快照：赋值仅改本地表，不影响持久层
              return storage.flag === "off";
            `,
          }),
        ],
        edges: [makeEdge("s", "c")],
      },
      { storage: { flag: "on" } },
    );
    expect(summary.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("c")]?.output).toMatchObject({ branch: "true" });
  });
});
