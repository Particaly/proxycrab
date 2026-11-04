import { expect, test, vi } from "vitest";
import type { Workflow, WorkflowExportEnvelope } from "./types";
import {
  collectImportedScripts,
  confirmedScriptKeys,
  downloadWorkflowExport,
  importedScriptKey,
  inspectWorkflowEnvelope,
  WORKFLOW_EXPORT_FILENAME,
} from "./workflow-transfer";

/** 构造一个最小流程定义；scripts 缺省不携带任何可执行脚本。 */
function workflow(id: string, name: string, nodes: Workflow["nodes"] = []): Workflow {
  return {
    id,
    projectId: "proj-x",
    name,
    description: "",
    nodes,
    edges: [],
    variables: {},
    secretVariables: { token: "掩码后的原值" },
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function replayNode(id: string, config: Record<string, unknown>): Workflow["nodes"][number] {
  return { id, type: "httpReplay", position: { x: 0, y: 0 }, config };
}

test("inspect rejects non-envelope shapes with the same reasons as the server", () => {
  expect(inspectWorkflowEnvelope(null).ok).toBe(false);
  expect(inspectWorkflowEnvelope([1]).ok).toBe(false);
  expect(inspectWorkflowEnvelope({}).ok).toBe(false);
  const badFormat = inspectWorkflowEnvelope({ format: "har", version: 1, workflows: [] });
  expect(badFormat).toEqual({
    ok: false,
    reason: '不是 ReqFlow 流程导出文件（format 标识缺失或不符，期望 "reqflow-workflow"）',
  });
  expect(inspectWorkflowEnvelope({ format: "reqflow-workflow" }).ok).toBe(false);
  const future = inspectWorkflowEnvelope({
    format: "reqflow-workflow",
    version: 99,
    workflows: [],
  });
  expect(future.ok).toBe(false);
  expect((future as { reason: string }).reason).toContain("v99 高于当前支持的最高版本 v1");
  expect(
    inspectWorkflowEnvelope({ format: "reqflow-workflow", version: 1, workflows: [] }).ok,
  ).toBe(false);
});

test("inspect summarizes counts, names and the stable script list", () => {
  const envelope: WorkflowExportEnvelope = {
    format: "reqflow-workflow",
    version: 1,
    exportedAt: 1793860000000,
    workflows: [
      workflow("wf-a", "结算链路", [
        replayNode("n1", { preProcess: "input.a", postProcess: "", expression: undefined }),
        { id: "n2", type: "condition", position: { x: 1, y: 1 }, config: { expression: "input.ok === true" } },
        { id: "n3", type: "start", position: { x: 2, y: 2 }, config: {} },
      ]),
      workflow("wf-b", "", [replayNode("n9", { postProcess: "resp.code" })]),
    ],
    requests: [],
    envSets: [{ id: "env-1", name: "默认", values: {}, secretValues: {}, createdAt: 1, updatedAt: 1 }],
  };
  const result = inspectWorkflowEnvelope(envelope);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.summary).toMatchObject({
    version: 1,
    exportedAt: 1793860000000,
    workflowCount: 2,
    scriptCount: 3,
    requestCount: 0,
    envSetCount: 1,
  });
  expect(result.summary.workflowNames).toEqual(["结算链路", "未命名流程 1"]);
  expect(result.summary.scripts.map((script) => script.key)).toEqual([
    "0:0:preProcess",
    "0:1:expression",
    "1:0:postProcess",
  ]);
  expect(result.summary.scripts.map((script) => script.source)).toEqual([
    "input.a",
    "input.ok === true",
    "resp.code",
  ]);
  // 空串/缺失配置不进清单；secret 变量值不被读取进摘要。
  expect(collectImportedScripts(envelope.workflows)).toHaveLength(3);
});

test("script keys and confirmedScripts arrays follow the backend key format", () => {
  expect(importedScriptKey(2, 0, "preProcess")).toBe("2:0:preProcess");
  expect(confirmedScriptKeys(new Set(["1:0:postProcess", "0:2:expression"]))).toEqual([
    "0:2:expression",
    "1:0:postProcess",
  ]);
  expect(confirmedScriptKeys(new Set())).toEqual([]);
});

test("download serializes the envelope through the existing saveFile lifecycle", async () => {
  const envelope: WorkflowExportEnvelope = {
    format: "reqflow-workflow",
    version: 1,
    exportedAt: 1,
    workflows: [workflow("wf-a", "流程 A")],
  };
  let filename = "";
  let bytes = new Uint8Array();
  let cancelled = false;
  const saveFile = vi.fn(async (request: { filename: string }) => {
    filename = request.filename;
    if (cancelled) return null;
    return {
      append: async (data: Uint8Array) => {
        bytes = data;
      },
      markAsFinish: async () => {},
      markAsError: async () => {},
    };
  });
  expect(await downloadWorkflowExport({ saveFile }, envelope)).toBe(true);
  expect(filename).toBe(WORKFLOW_EXPORT_FILENAME);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(envelope);
  cancelled = true;
  expect(await downloadWorkflowExport({ saveFile }, envelope)).toBe(false);
});
