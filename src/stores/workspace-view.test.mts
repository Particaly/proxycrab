import { afterEach, expect, test, vi } from "vitest";
import { workspaceStore } from "./workspace-view";

const { backend } = vi.hoisted(() => ({ backend: {} as Record<string, unknown> }));
vi.mock("../api/runtime-backend", () => ({
  getBackend: () => backend,
  runtimeBackend: {},
}));

afterEach(() => {
  workspaceStore.section = "capture";
  delete backend.workflows;
  delete backend.requestLibrary;
  delete backend.envSets;
  delete backend.flowRuns;
});

test("section switches between available blocks", () => {
  backend.workflows = { listProjects: vi.fn() };
  workspaceStore.open("workflow");
  expect(workspaceStore.section).toBe("workflow");
  workspaceStore.open("capture");
  expect(workspaceStore.section).toBe("capture");
  backend.flowRuns = { list: vi.fn() };
  workspaceStore.open("runs");
  expect(workspaceStore.section).toBe("runs");
  workspaceStore.open("capture");
  expect(workspaceStore.section).toBe("capture");
});

test("sections without backend capability stay on the current block", () => {
  workspaceStore.open("workflow");
  expect(workspaceStore.section).toBe("capture");
  backend.workflows = { listProjects: vi.fn() };
  workspaceStore.open("workflow");
  expect(workspaceStore.section).toBe("workflow");
  // 能力位消失后不可再切入对应区块
  delete backend.workflows;
  workspaceStore.open("workflow");
  expect(workspaceStore.section).toBe("workflow");
  workspaceStore.open("capture");
  expect(workspaceStore.section).toBe("capture");
  backend.flowRuns = { list: vi.fn() };
  workspaceStore.open("runs");
  expect(workspaceStore.section).toBe("runs");
  delete backend.flowRuns;
  workspaceStore.open("runs");
  expect(workspaceStore.section).toBe("runs");
  workspaceStore.open("capture");
  expect(workspaceStore.section).toBe("capture");
});
