import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./storage-get.mjs", import.meta.url).href;
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("storage-get reads one workflow's storage envelope", async () => {
  const payload = {
    workflowId: "wf-1",
    entries: [{ key: "counter", value: 2, updatedAt: 1234 }],
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/workflows/wf-1/storage" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "GET") throw new Error("Unexpected method: " + init.method);
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

test("storage-get requires --workflow-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      new URL("./storage-get.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      ...baseUrl,
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /--workflow-id is required/);
      return true;
    },
  );
});
