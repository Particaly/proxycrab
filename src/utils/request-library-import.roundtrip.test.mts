import { expect, test, vi } from "vitest";
import type { Backend } from "../api/backend";
import type { LogDetail } from "../api/types";
import { fullCurl } from "./curl";
import { appendHar } from "./har-export";
import {
  buildImportRequest,
  parseCurlCommand,
  parseHarImport,
} from "./request-library-import.ts";

/**
 * 往返测试（ReqFlow 复刻 Task 8 Step 4）：本仓库既有导出产物可回灌导入。
 *   - cURL：fullCurl（src/utils/curl.ts 的复制用命令）→ parseCurlCommand，
 *     方法 / URL / 头 / 体 / 查询串语义不丢（引号转义经 shellQuote 往返还原）。
 *   - HAR：appendHar（src/utils/har-export.ts 的逐条导出）→ parseHarImport，
 *     请求侧字段（method/url/headers/queryString/cookies/postData）与响应摘要
 *     完整保留；与 Task 9 导出的交叉验证留给集成阶段。
 */

function detail(id: number, changes: Partial<LogDetail> = {}): LogDetail {
  return {
    id,
    session_id: 7,
    created_at: 1700000000000,
    updated_at: 1700000000125,
    source_type: "proxy",
    source_addr: "127.0.0.1:1234",
    stage: "completed",
    outcome: "success",
    error: null,
    request: {
      method: "POST",
      uri: "https://example.com/path?a=1&a=2",
      version: "HTTP/1.1",
      tags: {},
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: { type: "json", content: { a: 1 }, size: 12 },
    },
    response: null,
    request_interceptors: [],
    response_interceptors: [],
    ...changes,
  };
}

test("cURL 往返：fullCurl 产物可完整解析回请求语义", () => {
  const source = detail(1, {
    request: {
      method: "POST",
      uri: "https://api.example.com:8443/v1/orders?dry=1&tag=a%20b",
      version: "HTTP/1.1",
      tags: {},
      headers: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-Token", value: "abc: def" },
      ],
      body: { type: "json", content: { sku: "A-1", note: "it's \"quoted\"" }, size: 40 },
    },
  });
  const parsed = parseCurlCommand(fullCurl(source));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.request.method).toBe("POST");
  expect(parsed.request.url).toBe(source.request.uri);
  expect(parsed.request.headers).toEqual(source.request.headers);
  expect(parsed.request.mimeType).toBe("application/json");
  expect(parsed.request.body).toBe(JSON.stringify(source.request.body.content));
  // 查询串与 HAR 导出（buildHarEntry 的 searchParams 拆分）同口径
  expect(parsed.request.queryString).toEqual([
    { name: "dry", value: "1" },
    { name: "tag", value: "a b" },
  ]);
});

test("cURL 往返：text body 与特殊字符经 shellQuote 引用后原样还原", () => {
  const source = detail(2, {
    request: {
      method: "PUT",
      uri: "https://a.dev/upload",
      version: "HTTP/1.1",
      tags: {},
      headers: [],
      body: { type: "text", content: "line 'one' with \"quotes\" and $dollar `tick`", size: 44 },
    },
  });
  const parsed = parseCurlCommand(fullCurl(source));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.request.method).toBe("PUT");
  expect(parsed.request.body).toBe(source.request.body.content);
});

test("cURL 往返：Content-Length 头被导出剥离且不影响解析", () => {
  const source = detail(3, {
    request: {
      method: "POST",
      uri: "https://a.dev/submit",
      version: "HTTP/1.1",
      tags: {},
      headers: [
        { name: "Content-Length", value: "12" },
        { name: "Accept", value: "*/*" },
      ],
      body: { type: "text", content: "hello", size: 5 },
    },
  });
  const parsed = parseCurlCommand(fullCurl(source));
  if (!parsed.ok) throw new Error("解析应成功");
  expect(parsed.request.headers).toEqual([{ name: "Accept", value: "*/*" }]);
  expect(parsed.request.body).toBe("hello");
});

/** 复用 har-export 的导出通路（stub backend / writer，同 har-export.test.mts）。 */
async function exportHar(records: LogDetail[]): Promise<string> {
  const getLog = vi.fn(async (_sid: number, id: number) => records.find((r) => r.id === id)!);
  const fetchBody = vi.fn(async (_target: unknown, side: string) => {
    const bytes =
      side === "request" ? new TextEncoder().encode('{ "a": 1 }\n') : new Uint8Array([0, 1, 255]);
    return { bytes, contentType: "", decodedSize: bytes.length };
  });
  const chunks: Uint8Array[] = [];
  const writer = {
    append: vi.fn(async (bytes: Uint8Array) => {
      chunks.push(bytes);
    }),
    markAsFinish: vi.fn(),
    markAsError: vi.fn(),
  };
  await appendHar(
    { getLog, fetchBody } as unknown as Backend,
    writer,
    7,
    records.map((record) => record.id),
    new AbortController().signal,
    vi.fn(),
    vi.fn(),
  );
  return chunks.map((bytes) => new TextDecoder().decode(bytes)).join("");
}

test("HAR 往返：appendHar 导出文本经 parseHarImport 回灌，请求侧与响应摘要保留", async () => {
  const harText = await exportHar([
    detail(9, {
      response: {
        status: 302,
        status_text: "Found",
        version: "HTTP/1.1",
        headers: [{ name: "Content-Type", value: "image/png" }],
        body: { type: "binary", size: 3 },
      },
    }),
    detail(3, {
      outcome: "failed",
      response: null,
      error: { stage: "upstream", kind: "test", message: "offline" },
    }),
  ]);
  const result = parseHarImport(harText);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.skipped).toEqual([]);
  expect(result.items).toHaveLength(2);

  const [withResponse, withoutResponse] = result.items;
  expect(withResponse.method).toBe("POST");
  expect(withResponse.url).toBe("https://example.com/path?a=1&a=2");
  expect(withResponse.status).toBe(302);
  expect(withResponse.entry.request.headers).toEqual([
    { name: "Content-Type", value: "application/json" },
  ]);
  expect(withResponse.entry.request.queryString).toEqual([
    { name: "a", value: "1" },
    { name: "a", value: "2" },
  ]);
  expect(withResponse.entry.request.cookies).toBeUndefined();
  expect(withResponse.entry.request.postData).toEqual({
    mimeType: "application/json",
    text: '{ "a": 1 }\n',
  });
  // 响应侧只留摘要：二进制 body 文本丢弃，size/mimeType 保留
  expect(withResponse.entry.response?.content).toEqual({ size: 3, mimeType: "image/png" });
  expect(JSON.stringify(withResponse.entry)).not.toContain("AAH/");
  expect(withResponse.entry.time).toBe(125);

  // 无响应条目：不携带 response，status=-1
  expect(withoutResponse.status).toBe(-1);
  expect(withoutResponse.entry.response).toBeUndefined();

  // 落库组装：单 entry 最小快照，可直传 POST /api/request-library
  const request = buildImportRequest(withResponse, ["import", "regression"]);
  expect(request.har.log.version).toBe("1.2");
  expect(request.har.log.entries).toHaveLength(1);
  expect(request.tags).toEqual(["import", "regression"]);
  expect(request.origin).toBe("https://example.com");
  expect(request.name).toBeUndefined(); // name 省略走服务端默认命名与重名后缀
});

test("HAR 往返：导入产物再序列化后再次解析保持一致（幂等）", async () => {
  const harText = await exportHar([detail(5)]);
  const first = parseHarImport(harText);
  if (!first.ok) throw new Error("首次解析应成功");
  const reexported = JSON.stringify(buildImportRequest(first.items[0]).har);
  const second = parseHarImport(reexported);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.items[0].entry).toEqual(first.items[0].entry);
  expect(second.skipped).toEqual([]);
});
