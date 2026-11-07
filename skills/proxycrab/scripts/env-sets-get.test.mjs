import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./env-sets-get.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("env-sets-get prints the whole masked envelope", async () => {
  const envelope = {
    sets: [
      {
        id: "env-1",
        name: "dev",
        values: { baseUrl: "https://dev.example.com" },
        secretValues: { token: "******" },
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    activeSetId: "env-1",
    globals: { values: { region: "cn-north" }, secretValues: {} },
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const envelope = ${JSON.stringify(envelope)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/env-sets" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "GET") throw new Error("Unexpected method: " + init.method);
        return new Response(JSON.stringify({ ok: true, data: envelope }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)},
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), envelope);
});

test("env-sets-get rejects unknown options", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--bogus", "x", ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /unknown option: --bogus/);
      return true;
    },
  );
});
