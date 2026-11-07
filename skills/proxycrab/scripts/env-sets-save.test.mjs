import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./env-sets-save.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("env-sets-save sends name and tables without the id key", async () => {
  const stored = { id: "env-1", name: "dev", secretValues: { token: "******" } };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const stored = ${JSON.stringify(stored)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/env-sets/env-1" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "PUT") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = {
          name: "dev",
          values: { baseUrl: "https://dev.example.com" },
          secretValues: { token: "******", apiKey: "brand-new" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        if (Object.hasOwn(body, "id")) throw new Error("body must not carry the id key");
        return new Response(JSON.stringify({ ok: true, data: stored }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "env-1",
        "--name", "dev",
        "--values-json", '{"baseUrl":"https://dev.example.com"}',
        "--secret-values-json", '{"token":"******","apiKey":"brand-new"}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), stored);
});

test("env-sets-save sends only the name when tables are omitted", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== JSON.stringify({ name: "staging" })) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { id: "env-4", name: "staging" } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "env-4",
        "--name", "staging", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { id: "env-4", name: "staging" });
});

test("env-sets-save requires --name for the save contract", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--id", "env-1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--name is required/);
      return true;
    },
  );
});
