import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./request-library-delete.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("request-library-delete issues DELETE against the entry path", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/request-library/req-1" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "DELETE") throw new Error("Unexpected method: " + init.method);
        if (init.body !== undefined) throw new Error("Unexpected body: " + init.body);
        return new Response(JSON.stringify({ ok: true, data: { deleted: "req-1" } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "req-1",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { deleted: "req-1" });
});

test("request-library-delete requires --id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--id is required/);
      return true;
    },
  );
});
