import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./request-library-body.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("request-library-body downloads bytes with the default max_size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "request-library-body-"));
  const out = join(directory, "body.bin");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const out = ${JSON.stringify(out)};
        globalThis.fetch = async (url, init) => {
          if (url.pathname !== "/api/request-library/req-1/body") {
            throw new Error("Unexpected request: " + url.pathname);
          }
          if (url.search !== "?max_size=16777216") {
            throw new Error("Unexpected search: " + url.search);
          }
          if (init.method !== undefined && init.method !== "GET") {
            throw new Error("Unexpected method: " + init.method);
          }
          const bytes = new Uint8Array([104, 101, 108, 108, 111]);
          return new Response(bytes, {
            headers: { "content-type": "application/json", "x-proxycrab-body-size": "5" },
          });
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "req-1",
          "--out", out, ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { output: out, stored_size: 5, content_type: "application/json" });
    assert.deepEqual(new Uint8Array(await readFile(out)), new Uint8Array([104, 101, 108, 108, 111]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request-library-body forwards an explicit --max-size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "request-library-body-"));
  const out = join(directory, "body.bin");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const out = ${JSON.stringify(out)};
        globalThis.fetch = async (url, init) => {
          if (url.search !== "?max_size=1024") {
            throw new Error("Unexpected search: " + url.search);
          }
          return new Response(new Uint8Array([1]), {
            headers: { "content-type": "application/octet-stream" },
          });
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--id", "req-2",
          "--out", out, "--max-size", "1024",
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    const printed = JSON.parse(stdout);
    assert.equal(printed.stored_size, 0);
    assert.equal(printed.content_type, "application/octet-stream");
    assert.equal(printed.output, out);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request-library-body requires --id and --out", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--out", "unused.bin", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--id is required/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--id", "req-1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--out is required/);
      return true;
    },
  );
});
