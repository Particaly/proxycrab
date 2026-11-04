import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./request-library-ingest.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);

test("request-library-ingest posts the capture body and prints the stored entry", async () => {
  const entry = { id: "req-7", name: "GET example.com/api", tags: ["login"], source: "capture" };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const entry = ${JSON.stringify(entry)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/request-library/from-capture") {
          throw new Error("Unexpected request: " + url.pathname);
        }
        const body = JSON.parse(init.body);
        const expected = { capture_id: 42, session_id: 3, name: "login request", tags: ["a", "b", "c"] };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        return new Response(JSON.stringify({ ok: true, data: entry }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--capture-id", "42",
        "--session-id", "3", "--name", "login request", "--tags", "a, b ,,c",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), entry);
});

test("request-library-ingest omits optional fields when not provided", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== JSON.stringify({ capture_id: 9 })) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { id: "req-8" } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--capture-id", "9",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { id: "req-8" });
});

test("request-library-ingest requires --capture-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--capture-id/);
      return true;
    },
  );
});

test("request-library-ingest rejects empty tag lists", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--capture-id", "1", "--tags", ",,",
      "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--tags/);
      return true;
    },
  );
});
