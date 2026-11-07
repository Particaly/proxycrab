import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./storage-put.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("storage-put sends the value envelope to the key path", async () => {
  const payload = {
    workflowId: "wf-1",
    entries: [{ key: "counter", value: { hits: 3 }, updatedAt: 5678 }],
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/workflows/wf-1/storage/counter" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "PUT") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = { value: { hits: 3 } };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: ${JSON.stringify(payload)} }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        "--key", "counter", "--value-json", '{"hits":3}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), payload);
});

test("storage-put rejects non-JSON values before any request", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      scriptPath, "--workflow-id", "wf-1", "--key", "counter", "--value-json", "{nope", ...baseUrl,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(String(error.stderr), /--value-json is not valid JSON/);
      return true;
    },
  );
});

test("storage-put requires --key and --value-json", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--workflow-id", "wf-1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /--key is required/);
      return true;
    },
  );
});
