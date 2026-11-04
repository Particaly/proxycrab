import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./workflow-list.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);

test("workflow-list filters by project and paginates through the query string", async () => {
  const page = {
    workflows: [{ id: "wf-1", projectId: "proj-1", name: "checkout", nodes: [], edges: [] }],
    total: 1,
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const page = ${JSON.stringify(page)};
      globalThis.fetch = async (url) => {
        const key = url.pathname + url.search;
        if (key !== "/api/workflows?projectId=proj-1&limit=50&offset=10") {
          throw new Error("Unexpected request: " + key);
        }
        return new Response(JSON.stringify({ ok: true, data: page }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--project-id", "proj-1",
        "--limit", "50", "--offset", "10", "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), page);
});

test("workflow-list requests a bare path without options", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url) => {
        if (url.pathname !== "/api/workflows" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        return new Response(JSON.stringify({ ok: true, data: { workflows: [], total: 0 } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { workflows: [], total: 0 });
});

test("workflow-list rejects a zero limit with a usage error", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--limit", "0", "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--limit/);
      return true;
    },
  );
});

test("workflow-list rejects options outside its whitelist", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--workflow-id", "wf-1", "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--workflow-id/);
      return true;
    },
  );
});
