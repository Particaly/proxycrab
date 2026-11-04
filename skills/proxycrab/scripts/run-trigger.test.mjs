import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./run-trigger.mjs", import.meta.url).href;
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("run-trigger posts workflowId with an explicit session and prints the run record", async () => {
  const record = { id: "run-1", workflowId: "wf-1", status: "running", trigger: "manual" };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const record = ${JSON.stringify(record)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/flow/runs" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== JSON.stringify({ workflowId: "wf-1", sessionId: 3 })) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: record }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        "--session-id", "3", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), record);
});

test("run-trigger omits sessionId and lets the server fall back to the active Session", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== JSON.stringify({ workflowId: "wf-1" })) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { id: "run-2", status: "running" } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { id: "run-2", status: "running" });
});

test("run-trigger appends a readable hint for known failure codes", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        globalThis.fetch = async () => new Response(JSON.stringify({
          ok: false,
          error: { code: "proxy_not_running", message: "proxy is not running" },
        }), { status: 409 });
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      const payload = JSON.parse(error.stderr);
      assert.equal(payload.error.type, "ApiError");
      assert.equal(payload.error.code, "proxy_not_running");
      assert.equal(payload.error.status, 409);
      assert.match(payload.error.message, /start the ProxyCrab proxy/);
      return true;
    },
  );
});
