import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./run-cancel.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("run-cancel posts to the cancel endpoint and prints the updated record", async () => {
  const record = { id: "run-1", status: "cancelled" };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const record = ${JSON.stringify(record)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/flow/runs/run-1/cancel" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        if (init.body !== undefined) throw new Error("Unexpected body: " + init.body);
        return new Response(JSON.stringify({ ok: true, data: record }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--run-id", "run-1",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), record);
});

test("run-cancel requires --run-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--run-id/);
      return true;
    },
  );
});

test("run-cancel rejects options outside its whitelist", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--run-id", "run-1", "--session-id", "3", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--session-id/);
      return true;
    },
  );
});
