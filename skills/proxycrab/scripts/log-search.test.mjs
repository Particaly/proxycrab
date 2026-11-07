import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./log-search.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("log-search strips unprovided fields from the predicate body", async () => {
  const page = { session_id: 3, matches: [], truncated: false, next_cursor: null };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const page = ${JSON.stringify(page)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/logs/search" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = { host: "api.example.com" };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: page }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--host", "api.example.com",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), page);
});

test("log-search sends every predicate with regex and paging fields", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const expected = {
          session_id: 3,
          host: "api[.]example[.]com",
          path: "/v1/login",
          method: "POST",
          status: "200",
          keyword: "login",
          regex: true,
          min_id: 10,
          max_id: 2000,
          limit: 50,
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { matches: [], truncated: false } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--session-id", "3",
        "--host", "api[.]example[.]com", "--path", "/v1/login", "--method", "POST",
        "--status", "200", "--keyword", "login", "--regex", "--min-id", "10", "--max-id", "2000",
        "--limit", "50", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { matches: [], truncated: false });
});

test("log-search rejects a non-integer --limit", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--host", "api.example.com", "--limit", "abc", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--limit/);
      return true;
    },
  );
});
