import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./request-library-query.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);

test("request-library-query builds the filtered page query and prints the raw page", async () => {
  const page = {
    entries: [{ id: "req-1", name: "GET example.com/api", har: { log: { entries: [] } } }],
    total: 1,
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const page = ${JSON.stringify(page)};
      globalThis.fetch = async (url) => {
        const key = url.pathname + url.search;
        if (key !== "/api/request-library?query=api&tags=a%2Cb&source=capture&limit=50&offset=10") {
          throw new Error("Unexpected request: " + key);
        }
        return new Response(JSON.stringify({ ok: true, data: page }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--query", "api", "--tags", "a,b",
        "--source", "capture", "--limit", "50", "--offset", "10",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), page);
});

test("request-library-query requests a bare path when no filter is given", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async (url) => {
        if (url.pathname !== "/api/request-library" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        return new Response(JSON.stringify({ ok: true, data: { entries: [], total: 0 } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { entries: [], total: 0 });
});

test("request-library-query --json condenses entries by dropping HAR snapshots", async () => {
  const entries = [{
    id: "req-2", name: "POST host/path", tags: ["x"], source: "manual", origin: "",
    har: { log: { entries: [{}] } }, createdAt: 1, updatedAt: 2,
  }];
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true, data: { entries: ${JSON.stringify(entries)}, total: 1 },
      }));
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--json",
        "--base-url", "http://127.0.0.1:18089"];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    total: 1,
    entries: [{ id: "req-2", name: "POST host/path", tags: ["x"], source: "manual", origin: "", createdAt: 1, updatedAt: 2 }],
  });
});

test("request-library-query rejects an unknown source with a usage error", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--source", "wrong", "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--source/);
      return true;
    },
  );
});

test("request-library-query rejects options outside its whitelist", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--capture-id", "7", "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--capture-id/);
      return true;
    },
  );
});
