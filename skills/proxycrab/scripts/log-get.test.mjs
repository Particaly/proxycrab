import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./log-get.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

const detail = {
  id: 5,
  request: { method: "POST", uri: "https://api.example.com/v1/login", body: { type: "text", content: "abc123def456ghi789" } },
  response: { status: 200, body: { type: "json", content: { token: "t", userId: 7 } } },
};

test("log-get prints the full detail without truncation", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const detail = ${JSON.stringify(detail)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/logs/5" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== undefined && init.method !== "GET") {
          throw new Error("Unexpected method: " + init.method);
        }
        return new Response(JSON.stringify({ ok: true, data: detail }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--log-id", "5",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), detail);
});

test("log-get truncates long text bodies but keeps JSON objects", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const detail = ${JSON.stringify(detail)};
      globalThis.fetch = async (url, init) => {
        if (url.search !== "") throw new Error("Unexpected search: " + url.search);
        return new Response(JSON.stringify({ ok: true, data: detail }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--log-id", "5",
        "--max-body-length", "6",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  const printed = JSON.parse(stdout);
  assert.equal(printed.request.body.content, "abc123…[truncated 18 chars total]");
  assert.deepEqual(printed.response.body, { type: "json", content: { token: "t", userId: 7 } });
  assert.equal(printed.id, 5);
});

test("log-get truncates json string content and keeps the session query", async () => {
  const stringDetail = {
    id: 6,
    request: { method: "GET", uri: "https://api.example.com/v1/ping", body: null },
    response: { status: 200, body: { type: "json", content: "a".repeat(10) } },
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const detail = ${JSON.stringify(stringDetail)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/logs/6" || url.search !== "?session_id=3") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        return new Response(JSON.stringify({ ok: true, data: detail }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--log-id", "6",
        "--session-id", "3", "--max-body-length", "4",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  const printed = JSON.parse(stdout);
  assert.equal(printed.response.body.content, `aaaa…[truncated 10 chars total]`);
  assert.deepEqual(printed.request.body, null);
});

test("log-get requires an integer --max-body-length", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--log-id", "5", "--max-body-length", "abc", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--max-body-length must be an integer/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--log-id is required/);
      return true;
    },
  );
});
