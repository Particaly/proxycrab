import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./request-library-update.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

const har = { log: { entries: [{ request: { method: "GET", url: "https://example.com/health" } }] } };

test("request-library-update sends only the provided fields", async () => {
  const entry = { id: "req-1", name: "checkout-v2", tags: ["checkout"] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const entry = ${JSON.stringify(entry)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/request-library/req-1" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "PUT") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = { name: "checkout-v2", tags: ["checkout", "debug"] };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: entry }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "req-1",
        "--name", "checkout-v2", "--tags-json", '["checkout","debug"]',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), entry);
});

test("request-library-update replaces the har snapshot when asked", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const har = ${JSON.stringify(har)};
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const expected = { origin: "replay fixup", har };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { id: "req-1" } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "req-1",
        "--origin", "replay fixup", "--har-json", JSON.stringify(har),
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { id: "req-1" });
});

test("request-library-update refuses an update with nothing to change", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--id", "req-1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /nothing to update/);
      return true;
    },
  );
});

test("request-library-update requires --id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--name", "x", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--id is required/);
      return true;
    },
  );
});
