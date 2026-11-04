import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./workflow-get.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);

test("workflow-get reads one definition by id", async () => {
  const workflow = { id: "wf-1", projectId: "proj-1", name: "checkout", nodes: [], edges: [] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const workflow = ${JSON.stringify(workflow)};
      globalThis.fetch = async (url) => {
        if (url.pathname !== "/api/workflows/wf-1" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        return new Response(JSON.stringify({ ok: true, data: workflow }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), workflow);
});

test("workflow-get requires --workflow-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--workflow-id/);
      return true;
    },
  );
});

test("workflow-get rejects options outside its whitelist", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--workflow-id", "wf-1", "--file", "x.json",
      "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--file/);
      return true;
    },
  );
});
