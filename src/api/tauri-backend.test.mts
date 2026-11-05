import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createTauriBackend } from "./tauri-backend.ts";
import { BodyFetchError, DEFAULT_BODY_MAX_SIZE, UI_BODY_MAX_SIZE } from "./body.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  { kind: "log", id: 42, sessionId: 3 },
  { kind: "interceptor", id: 42, sessionId: 3, executionId: 17 },
  { kind: "breakpoint", id: 7 },
] as const)("desktop preview loads $kind bytes through IPC without HTTP", async (target) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(invoke).mockResolvedValue({ bytes: [0, 255, 13, 10], contentType: "image/png" });
  const body = await createTauriBackend().fetchBody(target, "response");
  expect(body).toEqual({
    bytes: new Uint8Array([0, 255, 13, 10]),
    decodedSize: 4,
    contentType: "image/png",
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("fetch_body", {
    target,
    side: "response",
    maxSize: DEFAULT_BODY_MAX_SIZE,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("desktop preview preserves size errors for manual loading and forwards the larger limit", async () => {
  const target = { kind: "log", id: 42, sessionId: 3 } as const;
  const error = {
    code: "body_too_large",
    message: "too large",
    actual_size: 32000000,
    max_size: DEFAULT_BODY_MAX_SIZE,
  };
  vi.mocked(invoke).mockRejectedValueOnce(error);
  await expect(createTauriBackend().fetchBody(target, "request")).rejects.toMatchObject({
    name: "BodyFetchError",
    code: error.code,
    actualSize: error.actual_size,
    maxSize: error.max_size,
  });
  vi.mocked(invoke).mockResolvedValueOnce({ bytes: [], contentType: "application/octet-stream" });
  await createTauriBackend().fetchBody(target, "request", UI_BODY_MAX_SIZE);
  expect(invoke).toHaveBeenLastCalledWith("fetch_body", {
    target,
    side: "request",
    maxSize: UI_BODY_MAX_SIZE,
  });
});

test.each([0, -1, 1.5, NaN, UI_BODY_MAX_SIZE + 1])(
  "invalid preview limit %s never invokes IPC",
  async (maxSize) => {
    await expect(
      createTauriBackend().fetchBody({ kind: "breakpoint", id: 7 }, "response", maxSize),
    ).rejects.toBeInstanceOf(BodyFetchError);
    expect(invoke).not.toHaveBeenCalled();
  },
);

test("desktop Session sharing groups redaction and persistence into config", async () => {
  const state = { session_id: 7, enabled: true, persistent: true, token: "same-token" };
  vi.mocked(invoke).mockResolvedValue(state);
  const backend = createTauriBackend();
  expect(
    await backend.enableSessionShare(7, { redactionScript: "mask", persistent: true }),
  ).toEqual(state);
  expect(invoke).toHaveBeenLastCalledWith(
    "enable_session_share",
    {
      sessionId: 7,
      sessionShareConfig: { redaction_script: "mask", persistent: true },
    },
    undefined,
  );
  expect(await backend.enableSessionShare(7, { redactionScript: null, persistent: false })).toEqual(
    state,
  );
  expect(invoke).toHaveBeenLastCalledWith(
    "enable_session_share",
    {
      sessionId: 7,
      sessionShareConfig: { redaction_script: null, persistent: false },
    },
    undefined,
  );
  await backend.enableSessionShare(7);
  expect(invoke).toHaveBeenLastCalledWith(
    "enable_session_share",
    {
      sessionId: 7,
      sessionShareConfig: undefined,
    },
    undefined,
  );
});

test("desktop batch share summaries use their dedicated read IPC", async () => {
  const payload = { shares: [{ session_id: 3, persistent: true }] };
  vi.mocked(invoke).mockResolvedValue(payload);
  expect(await createTauriBackend().listSessionShares!()).toEqual(payload);
  expect(invoke).toHaveBeenLastCalledWith("list_session_shares", undefined, undefined);
});

test("desktop writer opens before data, sends bounded raw chunks and commits", async () => {
  vi.mocked(invoke).mockResolvedValueOnce("writer-7").mockResolvedValue(undefined);
  const writer = await createTauriBackend().saveFile({ filename: "capture.har" });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "save_file_open",
    { filename: "capture.har" },
    undefined,
  );
  await writer!.append(new Uint8Array(256 * 1024 + 1));
  const calls = vi.mocked(invoke).mock.calls.filter(([method]) => method === "save_file_append");
  expect(calls.map(([, data]) => (data as Uint8Array).length)).toEqual([256 * 1024, 1]);
  expect(calls[0]![2]).toEqual({ headers: { "x-proxycrab-writer": "writer-7" } });
  await writer!.markAsFinish();
  expect(invoke).toHaveBeenLastCalledWith("save_file_finish", { handle: "writer-7" }, undefined);
});
test("desktop picker cancellation returns no writer", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await createTauriBackend().saveFile({ filename: "capture.har" })).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("share IPC distinguishes omitted, inherited and explicitly unredacted policy", async () => {
  const backend = createTauriBackend();
  await backend.enableSessionShare(7, { persistent: true });
  expect(vi.mocked(invoke).mock.calls.at(-1)![1]).toEqual({
    sessionId: 7,
    sessionShareConfig: { persistent: true },
  });
  await backend.enableSessionShare(7, { persistent: true, redactionScript: "" });
  expect(vi.mocked(invoke).mock.calls.at(-1)![1]).toEqual({
    sessionId: 7,
    sessionShareConfig: { persistent: true, redaction_script: "" },
  });
  await backend.enableSessionShare(7, { persistent: true, redactionScript: null });
  expect(vi.mocked(invoke).mock.calls.at(-1)![1]).toEqual({
    sessionId: 7,
    sessionShareConfig: { persistent: true, redaction_script: null },
  });
  expect(Reflect.get(backend, "setSessionShareRedaction")).toBeUndefined();
});

test("desktop asset upload sends binary IPC with its path and MIME type", async () => {
  const file = new Blob([new Uint8Array([0, 255, 1])], { type: "image/png" });
  const metadata = { id: "images/icon.png", size: 3 };
  vi.mocked(invoke).mockResolvedValue(metadata);
  expect(await createTauriBackend().uploadAsset!(metadata.id, file)).toEqual(metadata);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("upload_asset", await file.arrayBuffer(), {
    headers: { "x-asset-id": metadata.id, "x-asset-content-type": "image/png" },
  });
});

test("desktop bundle import passes file bytes and explicit intent IDs through IPC", async () => {
  vi.mocked(invoke).mockResolvedValue({ import_id: null, files: [], sessions: [] });
  const backend = createTauriBackend();
  await backend.importBundle!(new File([new Uint8Array([1, 2, 3])], "bundle.zip"), ["chosen"]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "import_bundle",
    {
      bytes: [1, 2, 3],
      acceptedIntentIds: ["chosen"],
    },
    undefined,
  );
  vi.mocked(invoke).mockClear();
  await backend.resolveBundle!("pending", [
    { path: "assets/a.txt", action: "keep", fingerprint: "sha" },
  ]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "resolve_bundle",
    {
      id: "pending",
      resolutions: [{ path: "assets/a.txt", action: "keep", fingerprint: "sha" }],
    },
    undefined,
  );
});

test("desktop exposes the workflow, run, dry-run and MCP capability groups", () => {
  const backend = createTauriBackend();
  expect(Object.keys(backend.workflows!).sort()).toEqual([
    "createProject",
    "createWorkflow",
    "deleteProject",
    "deleteWorkflow",
    "exportWorkflows",
    "getWorkflow",
    "importWorkflows",
    "listProjects",
    "listWorkflows",
    "saveWorkflowGraph",
    "validateWorkflow",
  ]);
  expect(Object.keys(backend.flowRuns!).sort()).toEqual(["cancel", "get", "list", "trigger"]);
  expect(typeof backend.flowScriptDryRun).toBe("function");
  expect(Object.keys(backend.mcpTiers!).sort()).toEqual(["get", "save", "toolCount"]);
  expect(Object.keys(backend.mcpAudit!).sort()).toEqual(["list"]);
});

test("desktop workflow CRUD calls snake_case commands with camelCase argument keys", async () => {
  const workflows = createTauriBackend().workflows!;
  const graph = { nodes: [], edges: [] };
  const cases: {
    run: () => Promise<unknown>;
    command: string;
    args?: Record<string, unknown>;
    result?: unknown;
  }[] = [
    {
      run: () => workflows.listProjects(),
      command: "list_flow_projects",
      args: { query: {} },
      result: { projects: [], total: 0 },
    },
    {
      run: () => workflows.createProject({ name: "演示项目" }),
      command: "create_flow_project",
      args: { request: { name: "演示项目" } },
      result: { id: "proj-1", name: "演示项目" },
    },
    {
      run: () => workflows.deleteProject("proj-1"),
      command: "delete_flow_project",
      args: { id: "proj-1" },
    },
    {
      run: () => workflows.listWorkflows("proj-1"),
      command: "list_workflows",
      args: { query: { projectId: "proj-1" } },
      result: { workflows: [], total: 0 },
    },
    {
      run: () => workflows.getWorkflow("wf-1"),
      command: "get_workflow",
      args: { id: "wf-1" },
      result: { id: "wf-1", projectId: "proj-1" },
    },
    {
      run: () => workflows.createWorkflow({ projectId: "proj-1", name: "流程" }),
      command: "create_workflow",
      args: { request: { projectId: "proj-1", name: "流程" } },
      result: { id: "wf-1", projectId: "proj-1" },
    },
    {
      run: () => workflows.saveWorkflowGraph("wf-1", graph),
      command: "save_workflow_graph",
      args: { id: "wf-1", request: graph },
      result: { id: "wf-1", projectId: "proj-1" },
    },
    {
      run: () => workflows.deleteWorkflow("wf-1"),
      command: "delete_workflow",
      args: { id: "wf-1" },
    },
  ];
  for (const item of cases) {
    vi.mocked(invoke).mockResolvedValueOnce(item.result ?? null);
    expect(await item.run()).toEqual(item.result ?? null);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(item.command, item.args, undefined);
    vi.mocked(invoke).mockClear();
  }
});

test("desktop workflow validation wraps the raw issue array into the {issues} page", async () => {
  const issues = [{ code: "missing-start", message: "缺少开始节点", nodeIds: [] }];
  vi.mocked(invoke).mockResolvedValue(issues);
  expect(await createTauriBackend().workflows!.validateWorkflow("wf-1")).toEqual({ issues });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("validate_workflow", { id: "wf-1" }, undefined);
});

test("desktop workflow export returns the raw envelope document through IPC", async () => {
  const envelope = { format: "reqflow-workflow", version: 1, exportedAt: 1, workflows: [] };
  vi.mocked(invoke).mockResolvedValue(envelope);
  expect(await createTauriBackend().workflows!.exportWorkflows(["wf-1", "wf-2"])).toEqual(envelope);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "export_workflows",
    { ids: ["wf-1", "wf-2"] },
    undefined,
  );
});

test("desktop workflow import passes the envelope request verbatim", async () => {
  const result = {
    imported: [{ index: 0, id: "wf-2", name: "流程（导入 1）" }],
    skipped: [],
    requests: { imported: 0, skipped: [] },
    envSets: { imported: 1, skipped: [] },
  };
  const request = {
    file: { format: "reqflow-workflow", version: 1, exportedAt: 1, workflows: [] },
    projectId: "proj-1",
    confirmScripts: true,
    confirmedScripts: ["0:0:preProcess"],
  };
  vi.mocked(invoke).mockResolvedValue(result);
  expect(await createTauriBackend().workflows!.importWorkflows(request)).toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("import_workflows", { request }, undefined);
});

test("desktop run history lists, reads and triggers through dedicated commands", async () => {
  const flowRuns = createTauriBackend().flowRuns!;
  vi.mocked(invoke).mockResolvedValueOnce({ runs: [], total: 0 });
  expect(
    await flowRuns.list({ workflowId: "wf-1", status: "failed", limit: 50, offset: 0 }),
  ).toEqual({ runs: [], total: 0 });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "list_flow_runs",
    { query: { workflowId: "wf-1", status: "failed", limit: 50, offset: 0 } },
    undefined,
  );
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockResolvedValueOnce({ id: "run-1", status: "running", nodeRuns: [] });
  expect(await flowRuns.get("run-1")).toEqual({ id: "run-1", status: "running", nodeRuns: [] });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "get_flow_run_detail",
    { runId: "run-1" },
    undefined,
  );
  vi.mocked(invoke).mockClear();
  const record = { id: "run-2", status: "running" };
  vi.mocked(invoke).mockResolvedValueOnce(record);
  expect(await flowRuns.trigger({ workflowId: "wf-1", sessionId: 3 })).toEqual(record);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "trigger_flow_run",
    { request: { workflowId: "wf-1", sessionId: 3 } },
    undefined,
  );
});

test("desktop run cancel swallows the null success return", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  expect(await createTauriBackend().flowRuns!.cancel("run-1")).toBeUndefined();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("cancel_flow_run", { runId: "run-1" }, undefined);
});

test("desktop script dry-run posts the sample payload through IPC without HTTP", async () => {
  const result = { ok: true, value: { url: "https://example.com" }, warnings: [] };
  const request = {
    side: "pre",
    script: "return { url: input.url }",
    sampleInput: { url: "https://example.com" },
  } as const;
  vi.mocked(invoke).mockResolvedValue(result);
  expect(await createTauriBackend().flowScriptDryRun!(request)).toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("flow_script_dry_run", { request }, undefined);
});

test("desktop MCP tier switches round-trip through commands without raw JSON-RPC", async () => {
  const backend = createTauriBackend();
  const tiers = { read: true, write: false, execute: false };
  vi.mocked(invoke).mockResolvedValueOnce(tiers);
  expect(await backend.mcpTiers!.get()).toEqual(tiers);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_mcp_tiers", undefined, undefined);
  vi.mocked(invoke).mockClear();
  const enabled = { read: true, write: true, execute: false };
  vi.mocked(invoke).mockResolvedValueOnce(enabled);
  expect(await backend.mcpTiers!.save(enabled)).toEqual(enabled);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "replace_mcp_tiers",
    { tiers: enabled },
    undefined,
  );
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  expect(await backend.mcpTiers!.toolCount()).toBe(7);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_mcp_tool_count", undefined, undefined);
});

test("desktop MCP audit wraps the entry vector into the {entries} page shape", async () => {
  const entry = {
    seq: 2,
    timestampMs: 1_700_000_000_000,
    tool: "workflow_runs_list",
    identity: "local",
    argumentsSummary: "{}",
    outcome: "ok",
    decision: "allowed",
  };
  vi.mocked(invoke).mockResolvedValue([entry]);
  const backend = createTauriBackend();
  expect(await backend.mcpAudit!.list(50)).toEqual({ entries: [entry] });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("list_mcp_audit", { limit: 50 }, undefined);
  await backend.mcpAudit!.list();
  expect(invoke).toHaveBeenLastCalledWith("list_mcp_audit", { limit: undefined }, undefined);
});
