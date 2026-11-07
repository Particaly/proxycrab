import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./render-preview.mjs", import.meta.url).href;
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("render-preview posts workflowId and nodeId with variable overrides", async () => {
  const result = {
    ok: true,
    baseline: "manual",
    request: { method: "POST", url: "https://example.com/orders?tag=rt-1", headers: {} },
    warnings: [],
  };
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `
      const result = ${JSON.stringify(result)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/flow/render-preview" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = {
          workflowId: "wf-preview",
          nodeId: "n1",
          variableOverrides: { runTag: "rt-1" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: result }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-preview",
        "--node-id", "n1", "--variable-overrides-json", '{"runTag":"rt-1"}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.deepEqual(JSON.parse(stdout), result);
});

test("render-preview omits variableOverrides when the flag is absent", async () => {
  const result = { ok: true, baseline: "requestLibrary", request: {}, warnings: [] };
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `
      const result = ${JSON.stringify(result)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/flow/render-preview") {
          throw new Error("Unexpected request: " + url.pathname);
        }
        const body = JSON.parse(init.body);
        const expected = { workflowId: "wf-preview", nodeId: "n1" };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: result }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-preview",
        "--node-id", "n1", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.deepEqual(JSON.parse(stdout), result);
});

test("render-preview rejects invalid override JSON and missing ids", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf",
          "--node-id", "n1", "--variable-overrides-json", "{broken",
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]),
    /invalid JSON for --variable-overrides-json/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf",
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]),
    /--node-id/,
  );
});
