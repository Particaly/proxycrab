import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./workflow-save.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

async function withGraphFile(content) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-save-"));
  const file = join(directory, "graph.json");
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("workflow-save creates a definition through POST", async () => {
  const workflow = { id: "wf-9", projectId: "proj-1", name: "checkout", nodes: [], edges: [] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const workflow = ${JSON.stringify(workflow)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/workflows" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = { projectId: "proj-1", name: "checkout", description: "d" };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: workflow }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--project-id", "proj-1",
        "--name", "checkout", "--description", "d", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { action: "created", workflow });
});

test("workflow-save sends nodes and edges from --file together", async () => {
  const graph = { nodes: [{ id: "n1" }], edges: [{ id: "e1" }], variables: { a: 1 } };
  const { file, cleanup } = await withGraphFile(graph);
  try {
    const workflow = { id: "wf-1", name: "checkout", nodes: graph.nodes, edges: graph.edges };
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const workflow = ${JSON.stringify(workflow)};
        const file = ${JSON.stringify(file)};
        globalThis.fetch = async (url, init) => {
          if (url.pathname !== "/api/workflows/wf-1") {
            throw new Error("Unexpected request: " + url.pathname);
          }
          if (init.method !== "PUT") throw new Error("Unexpected method: " + init.method);
          const body = JSON.parse(init.body);
          const expected = { name: "checkout", nodes: [{ id: "n1" }], edges: [{ id: "e1" }], variables: { a: 1 } };
          if (JSON.stringify(body) !== JSON.stringify(expected)) {
            throw new Error("Unexpected body: " + init.body);
          }
          return new Response(JSON.stringify({ ok: true, data: workflow }));
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
          "--name", "checkout", "--file", file, ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { action: "updated", workflow });
  } finally {
    await cleanup();
  }
});

test("workflow-save ignores identity fields inside a full workflow document", async () => {
  const document = {
    id: "wf-other", projectId: "proj-other", name: "ignored", createdAt: 1, updatedAt: 2,
    nodes: [], edges: [{ id: "e1" }],
  };
  const { file, cleanup } = await withGraphFile(document);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const file = ${JSON.stringify(file)};
        globalThis.fetch = async (url, init) => {
          if (url.pathname !== "/api/workflows/wf-1") {
            throw new Error("Unexpected request: " + url.pathname);
          }
          const body = JSON.parse(init.body);
          const expected = { nodes: [], edges: [{ id: "e1" }] };
          if (JSON.stringify(body) !== JSON.stringify(expected)) {
            throw new Error("Unexpected body: " + init.body);
          }
          return new Response(JSON.stringify({ ok: true, data: { id: "wf-1" } }));
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
          "--file", file, ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { action: "updated", workflow: { id: "wf-1" } });
  } finally {
    await cleanup();
  }
});

test("workflow-save rejects a graph file without the nodes+edges pair", async () => {
  const { file, cleanup } = await withGraphFile({ nodes: [{ id: "n1" }] });
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, "--workflow-id", "wf-1", "--file", file, ...baseUrl]),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /nodes and edges together/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("workflow-save refuses an update with nothing to change", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--workflow-id", "wf-1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /nothing to update/);
      return true;
    },
  );
});

test("workflow-save requires --project-id and --name when creating", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--project-id", "proj-1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--name/);
      return true;
    },
  );
});
