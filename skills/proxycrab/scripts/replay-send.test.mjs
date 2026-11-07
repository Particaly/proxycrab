import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./replay-send.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("replay-send posts a raw request to the session pipeline", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/replay" || url.search !== "?session=3") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = {
          method: "POST",
          url: "https://example.com/api?x=1",
          headers: [["content-type", "application/json"]],
          body: { type: "text", text: "{\\"a\\":1}", charset: "utf8" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { log_id: 12 } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--session-id", "3",
        "--method", "POST", "--url", "https://example.com/api?x=1",
        "--headers-json", '[["content-type","application/json"]]',
        "--body-text", '{"a":1}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { log_id: 12 });
});

test("replay-send omits the session query when --session-id is absent", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/replay" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        const body = JSON.parse(init.body);
        const expected = { method: "GET", url: "https://example.com/health", headers: [] };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { log_id: 13 } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)},
        "--method", "GET", "--url", "https://example.com/health",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { log_id: 13 });
});

test("replay-send sends library_id with a verbatim override", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/replay" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        const body = JSON.parse(init.body);
        const expected = {
          library_id: "req-1",
          override: { method: "POST", removed_headers: ["x-draft"], body: "ok" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { log_id: 14 } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)},
        "--library-id", "req-1",
        "--override-json", '{"method":"POST","removed_headers":["x-draft"],"body":"ok"}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { log_id: 14 });
});

test("replay-send refuses --library-id together with raw source fields", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      scriptPath, "--library-id", "req-1", "--method", "GET", ...baseUrl,
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--library-id cannot be combined/);
      return true;
    },
  );
});

test("replay-send rejects malformed --override-json", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--library-id", "req-1", "--override-json", "{oops", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--override-json/);
      return true;
    },
  );
});
