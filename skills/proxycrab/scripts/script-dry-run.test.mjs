import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./script-dry-run.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("script-dry-run posts an inline pre script with its sample input", async () => {
  const result = { ok: true, value: { url: "https://example.com/api" }, warnings: [] };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const result = ${JSON.stringify(result)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/flow/script/dry-run" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        const expected = {
          side: "pre",
          script: "return { url: input.url }",
          sampleInput: { url: "https://example.com/api" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: result }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--side", "pre",
        "--inline", "return { url: input.url }",
        "--sample-input-json", '{"url":"https://example.com/api"}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), result);
});

test("script-dry-run reads the script from --file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "script-dry-run-"));
  const file = join(directory, "post.js");
  await writeFile(file, "return response.body", "utf8");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const file = ${JSON.stringify(file)};
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          const expected = { side: "post", script: "return response.body" };
          if (JSON.stringify(body) !== JSON.stringify(expected)) {
            throw new Error("Unexpected body: " + init.body);
          }
          return new Response(JSON.stringify({ ok: true, data: { ok: true, value: null, warnings: [] } }));
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--side", "post",
          "--file", file, ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { ok: true, value: null, warnings: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("script-dry-run rejects an unknown --side", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--side", "mid", "--inline", "return 1", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--side must be pre or post/);
      return true;
    },
  );
});

test("script-dry-run requires exactly one script source", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--side", "pre", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exactly one of --file and --inline/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      scriptPath, "--side", "pre", "--inline", "return 1", "--file", "s.js", ...baseUrl,
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exactly one of --file and --inline/);
      return true;
    },
  );
});
