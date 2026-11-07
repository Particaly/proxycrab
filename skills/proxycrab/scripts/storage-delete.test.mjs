import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./storage-delete.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("storage-delete removes one key when --key is given", async () => {
  const payload = { workflowId: "wf-1", entries: [] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/workflows/wf-1/storage/counter" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "DELETE") throw new Error("Unexpected method: " + init.method);
        return new Response(JSON.stringify({ ok: true, data: ${JSON.stringify(payload)} }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        "--key", "counter", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), payload);
});

test("storage-delete clears the whole storage without --key", async () => {
  const payload = { workflowId: "wf-1", entries: [] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/workflows/wf-1/storage" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "DELETE") throw new Error("Unexpected method: " + init.method);
        return new Response(JSON.stringify({ ok: true, data: ${JSON.stringify(payload)} }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), payload);
});

test("storage-delete requires --workflow-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /--workflow-id is required/);
      return true;
    },
  );
});
