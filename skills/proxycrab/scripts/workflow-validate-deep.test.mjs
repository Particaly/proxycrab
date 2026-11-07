import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./workflow-validate-deep.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

test("workflow-validate-deep sends the stored-definition id", async () => {
  const issues = [
    { severity: "error", code: "template-syntax", message: "unclosed {{", nodeIds: ["n1"] },
  ];
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const issues = ${JSON.stringify(issues)};
      globalThis.fetch = async (url, init) => {
        if (url.pathname !== "/api/flow/validate" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        if (init.method !== "POST") throw new Error("Unexpected method: " + init.method);
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== JSON.stringify({ id: "wf-1" })) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { issues } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--workflow-id", "wf-1",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { issues });
});

test("workflow-validate-deep posts the draft graph from --graph-file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-validate-deep-"));
  const file = join(directory, "graph.json");
  await writeFile(
    file,
    JSON.stringify({
      nodes: [{ id: "n1" }],
      edges: [{ id: "e1" }],
      variables: { pageSize: 20 },
    }),
  );
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        const file = ${JSON.stringify(file)};
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          const expected = {
            nodes: [{ id: "n1" }],
            edges: [{ id: "e1" }],
            variables: { pageSize: 20 },
          };
          if (JSON.stringify(body) !== JSON.stringify(expected)) {
            throw new Error("Unexpected body: " + init.body);
          }
          return new Response(JSON.stringify({ ok: true, data: { issues: [] } }));
        };
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--graph-file", file,
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { issues: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow-validate-deep posts inline draft arrays with table overrides", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const expected = {
          nodes: [{ id: "n1" }],
          edges: [{ id: "e1" }],
          secretVariables: { token: "" },
        };
        if (JSON.stringify(body) !== JSON.stringify(expected)) {
          throw new Error("Unexpected body: " + init.body);
        }
        return new Response(JSON.stringify({ ok: true, data: { issues: [] } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)},
        "--nodes-json", '[{"id":"n1"}]', "--edges-json", '[{"id":"e1"}]',
        "--secret-variables-json", '{"token":""}',
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { issues: [] });
});

test("workflow-validate-deep requires one validation mode", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /provide --workflow-id, --graph-file, or --nodes-json \+ --edges-json/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--nodes-json", '[{"id":"n1"}]', ...baseUrl]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--nodes-json and --edges-json must be provided together/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      scriptPath, "--workflow-id", "wf-1", "--nodes-json", '[{"id":"n1"}]', "--edges-json", "[]", ...baseUrl,
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /cannot be combined/);
      return true;
    },
  );
});
