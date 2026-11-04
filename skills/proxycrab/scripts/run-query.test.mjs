import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./run-query.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("run-query filters by workflow and status and paginates", async () => {
  const page = { runs: [{ id: "run-1", status: "failed" }], total: 1 };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const page = ${JSON.stringify(page)};
      globalThis.fetch = async (url) => {
        const key = url.pathname + url.search;
        if (key !== "/api/flow/runs?workflowId=wf-1&status=failed&limit=50&offset=10") {
          throw new Error("Unexpected request: " + key);
        }
        return new Response(JSON.stringify({ ok: true, data: page }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        "--status", "failed", "--limit", "50", "--offset", "10",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), page);
});

test("run-query requests a bare path without options", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url) => {
        if (url.pathname !== "/api/flow/runs" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        return new Response(JSON.stringify({ ok: true, data: { runs: [], total: 0 } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { runs: [], total: 0 });
});

test("run-query rejects an unknown status with a usage error", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--status", "done", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--status/);
      return true;
    },
  );
});

test("run-query rejects a limit above the 1000 cap", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--limit", "1001", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--limit/);
      return true;
    },
  );
});
