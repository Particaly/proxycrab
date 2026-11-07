import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./env-sets-create.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("env-sets-create posts a camelCase body with every provided field", async () => {
  const stored = { id: "env-2", name: "prod", values: {}, secretValues: { token: "******" } };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const stored = ${JSON.stringify(stored)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/env-sets" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = {
          name: "prod",
          copyFrom: "env-1",
          values: { baseUrl: "https://prod.example.com" },
          secretValues: { token: "s3cret" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: stored }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--name", "prod",
        "--copy-from", "env-1",
        "--values-json", '{"baseUrl":"https://prod.example.com"}',
        "--secret-values-json", '{"token":"s3cret"}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), stored);
});

test("env-sets-create sends only the name when no optional field is given", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== JSON.stringify({ name: "dev" })) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { id: "env-3", name: "dev" } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--name", "dev",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { id: "env-3", name: "dev" });
});

test("env-sets-create requires --name", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--name is required/);
      return true;
    },
  );
});

test("env-sets-create rejects malformed JSON tables", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--name", "dev", "--values-json", "{oops", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--values-json/);
      return true;
    },
  );
});
