import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./request-library-create.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

const har = { log: { entries: [{ request: { method: "GET", url: "https://example.com/health" } }] } };

test("request-library-create posts har with optional metadata", async () => {
  const entry = { id: "req-9", name: "health-check", source: "manual" };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const entry = ${JSON.stringify(entry)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/request-library" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = {
          har: { log: { entries: [{ request: { method: "GET", url: "https://example.com/health" } }] } },
          name: "health-check",
          tags: ["checkout", "debug"],
          origin: "auth spike",
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: entry }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)},
        "--har-json", '${JSON.stringify(har)}',
        "--name", "health-check", "--tags-json", '["checkout","debug"]', "--origin", "auth spike",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), entry);
});

test("request-library-create reads the HAR from --har-file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "request-library-create-"));
  const file = join(directory, "har.json");
  await writeFile(file, JSON.stringify(har));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const file = ${JSON.stringify(file)};
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          const expected = {
            har: { log: { entries: [{ request: { method: "GET", url: "https://example.com/health" } }] } },
          };
          if (JSON.stringify(body) !== JSON.stringify(expected)) {
            throw new Error("Unexpected body: " + init.body);
          }
          return new Response(JSON.stringify({ ok: true, data: { id: "req-10" } }));
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--har-file", file,
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { id: "req-10" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request-library-create refuses both HAR sources at once", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      scriptPath, "--har-json", '{"log":{"entries":[]}}', "--har-file", "har.json", ...baseUrl,
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exactly one of --har-json and --har-file/);
      return true;
    },
  );
});

test("request-library-create refuses a non-array --tags-json", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--har-json", JSON.stringify(har), "--tags-json", '"x"', ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--tags-json/);
      return true;
    },
  );
});
