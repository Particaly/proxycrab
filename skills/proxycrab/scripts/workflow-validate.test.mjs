import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./workflow-validate.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);

test("workflow-validate posts to the validate endpoint and prints the issues", async () => {
  const payload = { issues: [{ code: "orphan_edge", message: "edge target missing", nodeIds: ["n1"] }] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const payload = ${JSON.stringify(payload)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/workflows/wf-1/validate" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        if (init.body !== undefined) throw new Error("Unexpected body: " + init.body);
        return new Response(JSON.stringify({ ok: true, data: payload }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), payload);
});

test("workflow-validate prints an empty issue list for a valid graph", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { issues: [] } }));
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-2",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { issues: [] });
});

test("workflow-validate requires --workflow-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--workflow-id/);
      return true;
    },
  );
});
