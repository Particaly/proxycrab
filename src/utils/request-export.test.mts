import { describe, expect, test } from "vitest";
import type { RequestLibraryEntry, RequestLibraryHarEntry } from "../api/types";
import {
  HAR_EXPORT_INLINE_DISCLOSURE,
  POSTMAN_COLLECTION_SCHEMA,
  REQUEST_EXPORT_FORMATS,
  buildRequestExportFileName,
  exportRequestAsAxios,
  exportRequestAsCurl,
  exportRequestAsFetch,
  exportRequestAsHar,
  exportRequestAsPostman,
  exportRequestAsPython,
  exportRequestSnapshot,
} from "./request-export";

/**
 * 请求库导出生成器测试（Task 9 Step 4；移植上游 request-export.test.ts 口径）。
 *
 * 逐格式锁定：method / headers / body（文本、空、base64 二进制、params 重建、
 * bodyRef 外置）/ 特殊字符转义（shell 单引号）/ 中文保真 / 长字符串换行拼接产物
 * 可直接求值；Postman 产物做 schema 字段完整性断言；文件名与格式清单锁定。
 */

/* ------------------------------- 夹具 ------------------------------- */

/** 最小 HAR entry（缺省 GET 无体；overrides 深合并到 request 上） */
function makeEntry(
  requestOverrides: Partial<RequestLibraryHarEntry["request"]> = {},
): RequestLibraryHarEntry {
  return {
    startedDateTime: "2026-01-01T08:00:00.000Z",
    time: 12,
    request: {
      method: "GET",
      url: "https://api.example.com/v1/users",
      httpVersion: "HTTP/1.1",
      headers: [],
      queryString: [],
      ...requestOverrides,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 10, mimeType: "application/json" },
    },
  };
}

/** 构造待导出的请求库条目（name / entry / bodyRef 可定制） */
function makeLibraryEntry(
  name = "登录冒烟",
  entry: RequestLibraryHarEntry = makeEntry(),
  bodyRef: { path: string; size: number } | null = null,
): RequestLibraryEntry {
  return {
    id: "rl-1",
    name,
    tags: [],
    source: "capture",
    origin: "https://example.com",
    har: {
      log: { version: "1.2", creator: { name: "ProxyCrab", version: "0.1.0" }, entries: [entry] },
    },
    bodyRef,
    createdAt: 1000,
    updatedAt: 2000,
  };
}

/** 构造 entries 为空的快照（防御性形态，正常入库链路不会产生） */
function makeEmptyLibraryEntry(): RequestLibraryEntry {
  const entry = makeLibraryEntry();
  entry.har = { log: { version: "1.2", creator: { name: "ProxyCrab" }, entries: [] } };
  return entry;
}

/* ------------------------------- cURL ------------------------------- */

describe("exportRequestAsCurl", () => {
  test("GET 无体：curl / --request / --url / --header 按快照顺序输出（既有 fullCurl 形态）", () => {
    const entry = makeLibraryEntry(
      "列表",
      makeEntry({
        url: "https://api.example.com/v1/users?page=2",
        headers: [
          { name: "accept", value: "application/json" },
          { name: "authorization", value: "Bearer tok" },
        ],
      }),
    );
    expect(exportRequestAsCurl(entry)).toBe(
      [
        "curl \\",
        "  --request 'GET' \\",
        "  --url 'https://api.example.com/v1/users?page=2' \\",
        "  --header 'accept: application/json' \\",
        "  --header 'authorization: Bearer tok'",
      ].join("\n"),
    );
  });

  test("POST + JSON 文本 body：--data-raw 原样携带（含中文与双引号）", () => {
    const body = '{"sku":"A-1","note":"重放·测试"}';
    const entry = makeLibraryEntry(
      "下单",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "application/json" }],
        postData: { mimeType: "application/json", text: body },
      }),
    );
    const output = exportRequestAsCurl(entry);
    expect(output).toContain("  --request 'POST' \\");
    expect(output).toContain(`  --data-raw '${body}'`);
  });

  test("content-length 头被剔除（避免与实际 body 冲突，既有实现同规则）", () => {
    const entry = makeLibraryEntry(
      "带长度",
      makeEntry({
        method: "POST",
        headers: [
          { name: "Content-Length", value: "12" },
          { name: "content-type", value: "text/plain" },
        ],
        postData: { mimeType: "text/plain", text: "hello" },
      }),
    );
    const output = exportRequestAsCurl(entry);
    expect(output).not.toContain("Content-Length");
    expect(output).toContain("--header 'content-type: text/plain'");
  });

  test("单引号转义：值内单引号按闭引号重开惯用法转义（与既有 shellQuote 一致）", () => {
    const entry = makeLibraryEntry(
      "登录",
      makeEntry({ headers: [{ name: "authorization", value: "Bearer it's" }] }),
    );
    expect(exportRequestAsCurl(entry)).toContain(`  --header 'authorization: Bearer it'"'"'s'`);
  });

  test("base64 二进制 body：顶部注释披露 + --data-binary @-（无 --data-raw）", () => {
    const entry = makeLibraryEntry(
      "上传",
      makeEntry({
        method: "POST",
        postData: { mimeType: "application/octet-stream", text: "aGk=", encoding: "base64" },
      }),
    );
    const output = exportRequestAsCurl(entry);
    expect(output).not.toContain("--data-raw");
    const lines = output.split("\n");
    expect(lines[0]?.startsWith("# 请求体为二进制内容")).toBe(true);
    expect(lines[0]).toContain("2 字节");
    expect(lines[1]).toBe("curl \\");
    expect(lines[lines.length - 1]).toBe("  --data-binary @-");
  });

  test("bodyRef 外置 body：注释披露 blob 体积 + --data-binary @-", () => {
    const entry = makeLibraryEntry(
      "大文件",
      makeEntry({
        method: "PUT",
        postData: { mimeType: "application/octet-stream" },
      }),
      { path: "flow/request-library/bodies/rl-1.body", size: 5 },
    );
    const output = exportRequestAsCurl(entry);
    const lines = output.split("\n");
    expect(lines[0]?.startsWith("# 请求体未内联在快照中")).toBe(true);
    expect(lines[0]).toContain("5 字节");
    expect(lines[lines.length - 1]).toBe("  --data-binary @-");
  });

  test("params-only 的 urlencoded 表单：按 name=value& 重建 body（值重新编码）", () => {
    const entry = makeLibraryEntry(
      "表单",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "application/x-www-form-urlencoded" }],
        postData: {
          mimeType: "application/x-www-form-urlencoded",
          params: [{ name: "q", value: "重放 1" }],
        },
      }),
    );
    expect(exportRequestAsCurl(entry)).toContain("--data-raw 'q=%E9%87%8D%E6%94%BE%201'");
  });

  test("multipart 的 params-only：不重建伪表单体，按无 body 输出", () => {
    const entry = makeLibraryEntry(
      "表单上传",
      makeEntry({
        method: "POST",
        postData: {
          mimeType: "multipart/form-data; boundary=----x",
          params: [{ name: "file", value: "a.png" }],
        },
      }),
    );
    const output = exportRequestAsCurl(entry);
    expect(output).not.toContain("--data-raw");
    expect(output).not.toContain("--data-binary");
  });

  test("空 entries：返回空串（UI 对空串不做动作）", () => {
    expect(exportRequestAsCurl(makeEmptyLibraryEntry())).toBe("");
  });
});

/* ------------------------------- HAR ------------------------------- */

describe("exportRequestAsHar", () => {
  test("单条 HAR：log.version / creator 保留，entry 与入库快照逐字一致（preserving 原样）", () => {
    const har = makeEntry({
      method: "POST",
      postData: { mimeType: "application/json", text: '{"a":1}' },
    });
    const entry = makeLibraryEntry("下单", har);
    const parsed = JSON.parse(exportRequestAsHar(entry)) as {
      log: { version: string; creator: unknown; entries: unknown[]; comment?: string };
    };
    expect(parsed.log.version).toBe("1.2");
    expect(parsed.log.creator).toEqual({ name: "ProxyCrab", version: "0.1.0" });
    expect(parsed.log.entries).toHaveLength(1);
    expect(parsed.log.entries[0]).toEqual(har);
  });

  test("log.comment 统一披露入库 body 内联策略（不对单条 body 做推测性补全）", () => {
    const parsed = JSON.parse(exportRequestAsHar(makeLibraryEntry())) as {
      log: { comment?: string; entries: unknown[] };
    };
    expect(parsed.log.comment).toBe(HAR_EXPORT_INLINE_DISCLOSURE);
    expect(parsed.log.comment).toContain("64 KiB");
    expect(parsed.log.comment).toContain("bodyRef");
    expect(parsed.log.entries).toHaveLength(1);
  });

  test("空 entries：输出 entries: []（仍是合法 HAR）", () => {
    const parsed = JSON.parse(exportRequestAsHar(makeEmptyLibraryEntry())) as {
      log: { entries: unknown[] };
    };
    expect(parsed.log.entries).toEqual([]);
  });
});

/* ------------------------------- Postman ------------------------------- */

/** Postman 产物形状（测试侧松散建模，只取断言需要的字段） */
interface PostmanParsed {
  info: { name: string; schema: string };
  item: Array<{
    name: string;
    request: {
      method: string;
      header: Array<{ key: string; value: string }>;
      url: {
        raw: string;
        protocol?: string;
        host?: string[];
        path?: string[];
        query?: Array<{ key: string; value: string }>;
      };
      body?: { mode: string; raw: string; options?: { raw: { language: string } } };
      description?: string;
    };
  }>;
}

describe("exportRequestAsPostman", () => {
  test("schema 字段完整性：info.schema 为官方 v2.1 地址，info.name / item.name 取请求名", () => {
    const parsed = JSON.parse(
      exportRequestAsPostman(makeLibraryEntry("下单冒烟")),
    ) as PostmanParsed;
    expect(parsed.info.schema).toBe(POSTMAN_COLLECTION_SCHEMA);
    expect(POSTMAN_COLLECTION_SCHEMA).toContain("/collection/v2.1.0/collection.json");
    expect(parsed.info.name).toBe("下单冒烟");
    expect(parsed.item).toHaveLength(1);
    expect(parsed.item[0]?.name).toBe("下单冒烟");
  });

  test("request 结构：method / header（key=value）/ url 对象（raw + protocol/host/path/query）", () => {
    const entry = makeLibraryEntry(
      "下单",
      makeEntry({
        method: "POST",
        url: "https://api.example.com/v1/orders?page=2&tag=%E9%87%8D%E6%94%BE",
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "authorization", value: "Bearer tok" },
        ],
      }),
    );
    const parsed = JSON.parse(exportRequestAsPostman(entry)) as PostmanParsed;
    const request = parsed.item[0]?.request;
    expect(request?.method).toBe("POST");
    expect(request?.header).toEqual([
      { key: "content-type", value: "application/json" },
      { key: "authorization", value: "Bearer tok" },
    ]);
    expect(request?.url.raw).toBe(
      "https://api.example.com/v1/orders?page=2&tag=%E9%87%8D%E6%94%BE",
    );
    expect(request?.url.protocol).toBe("https");
    expect(request?.url.host).toEqual(["api", "example", "com"]);
    expect(request?.url.path).toEqual(["v1", "orders"]);
    expect(request?.url.query).toEqual([
      { key: "page", value: "2" },
      { key: "tag", value: "重放" },
    ]);
  });

  test("body：raw 模式携带原文；JSON mimeType 标注 language=json，其余不标注", () => {
    const jsonEntry = makeLibraryEntry(
      "json",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "application/json; charset=utf-8" }],
        postData: { mimeType: "application/json; charset=utf-8", text: '{"note":"中文"}' },
      }),
    );
    const jsonParsed = JSON.parse(exportRequestAsPostman(jsonEntry)) as PostmanParsed;
    expect(jsonParsed.item[0]?.request.body).toEqual({
      mode: "raw",
      raw: '{"note":"中文"}',
      options: { raw: { language: "json" } },
    });

    const textEntry = makeLibraryEntry(
      "text",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "text/plain" }],
        postData: { mimeType: "text/plain", text: "hello" },
      }),
    );
    const textParsed = JSON.parse(exportRequestAsPostman(textEntry)) as PostmanParsed;
    expect(textParsed.item[0]?.request.body).toEqual({ mode: "raw", raw: "hello" });
  });

  test("无 body：不输出 body 字段；base64 二进制 / bodyRef 外置：以 description 披露", () => {
    const emptyParsed = JSON.parse(exportRequestAsPostman(makeLibraryEntry())) as PostmanParsed;
    expect(emptyParsed.item[0]?.request.body).toBeUndefined();
    expect(emptyParsed.item[0]?.request.description).toBeUndefined();

    const binaryEntry = makeLibraryEntry(
      "上传",
      makeEntry({
        method: "POST",
        postData: { mimeType: "application/octet-stream", text: "aGk=", encoding: "base64" },
      }),
    );
    const binaryParsed = JSON.parse(exportRequestAsPostman(binaryEntry)) as PostmanParsed;
    expect(binaryParsed.item[0]?.request.body).toBeUndefined();
    expect(binaryParsed.item[0]?.request.description).toContain("二进制");
    expect(binaryParsed.item[0]?.request.description).toContain("2 字节");

    const externalEntry = makeLibraryEntry(
      "大文件",
      makeEntry({ method: "PUT", postData: { mimeType: "application/octet-stream" } }),
      { path: "flow/request-library/bodies/rl-1.body", size: 5 },
    );
    const externalParsed = JSON.parse(exportRequestAsPostman(externalEntry)) as PostmanParsed;
    expect(externalParsed.item[0]?.request.body).toBeUndefined();
    expect(externalParsed.item[0]?.request.description).toContain("请求库 blob");
    expect(externalParsed.item[0]?.request.description).toContain("5 字节");
  });

  test("空 entries：输出 item: []（合法空 collection）", () => {
    const parsed = JSON.parse(exportRequestAsPostman(makeEmptyLibraryEntry())) as PostmanParsed;
    expect(parsed.item).toEqual([]);
  });
});

/* ------------------------------- fetch ------------------------------- */

describe("exportRequestAsFetch", () => {
  test("POST JSON：fetch(url, { method, headers, body, credentials: include }) 结构完整", () => {
    const entry = makeLibraryEntry(
      "下单",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "application/json" }],
        postData: { mimeType: "application/json", text: '{"sku":"A-1"}' },
      }),
    );
    const output = exportRequestAsFetch(entry);
    expect(
      output.startsWith('const response = await fetch("https://api.example.com/v1/users", {'),
    ).toBe(true);
    expect(output).toContain('  method: "POST",');
    expect(output).toContain('    "content-type": "application/json",');
    expect(output).toContain('  body: "{\\"sku\\":\\"A-1\\"}",');
    expect(output).toContain('  credentials: "include",');
    expect(output.endsWith("})")).toBe(true);
  });

  test("GET 无体：省略 body 行，credentials 保留；headers 空时省略 headers 块（无 body/无 headers 回退）", () => {
    const output = exportRequestAsFetch(makeLibraryEntry());
    expect(output).not.toContain("body:");
    expect(output).not.toContain("headers:");
    expect(output).toContain('  credentials: "include",');
  });

  test("长 body 换行拼接：产物语法可编译，且拼接求值结果与原文逐字一致", () => {
    const longBody = '{"data":"' + "a".repeat(200) + '"}';
    const entry = makeLibraryEntry(
      "长体",
      makeEntry({ method: "POST", postData: { mimeType: "application/json", text: longBody } }),
    );
    const output = exportRequestAsFetch(entry);
    // 语法校验：整段代码可被 Function 构造器编译（await 包在 async 函数体内）
    expect(() => new Function(`return async () => {\n${output}\n}`)).not.toThrow();
    // 求值校验：抽出 body 表达式执行，结果与原文一致（转义序列跨块不断裂）
    const match = /  body: ([\s\S]*?),\n  credentials/.exec(output);
    expect(match).not.toBeNull();
    const value = new Function(`return (${match?.[1] ?? ""})`)() as string;
    expect(value).toBe(longBody);
    expect(output).toContain('" +'); // 确认确实走了换行拼接形态
  });

  test("中文 body 保真；单引号等特殊字符由 JSON 字面量转义", () => {
    const body = "{'note':'重放·\"引号\"'}";
    const entry = makeLibraryEntry(
      "中文",
      makeEntry({ method: "POST", postData: { mimeType: "text/plain", text: body } }),
    );
    const match = /  body: ([\s\S]*?),\n  credentials/.exec(exportRequestAsFetch(entry));
    const value = new Function(`return (${match?.[1] ?? ""})`)() as string;
    expect(value).toBe(body);
  });

  test("base64 二进制 body：atob + Uint8Array 字节级重建，求值结果等于解码字节", () => {
    const entry = makeLibraryEntry(
      "上传",
      makeEntry({
        method: "POST",
        postData: { mimeType: "application/octet-stream", text: "aGk=", encoding: "base64" },
      }),
    );
    const output = exportRequestAsFetch(entry);
    expect(output).toContain("Uint8Array.from(");
    expect(output).toContain("atob(");
    const match = /  body: ([\s\S]*?),\n  credentials/.exec(output);
    const value = new Function(`return (${match?.[1] ?? ""})`)() as Uint8Array;
    expect(Array.from(value)).toEqual([104, 105]); // 'aGk=' → 'hi'
  });

  test("bodyRef 外置 body：注释行披露 + 无 body 行；空 entries：返回空串", () => {
    const entry = makeLibraryEntry(
      "大文件",
      makeEntry({ method: "PUT", postData: { mimeType: "application/octet-stream" } }),
      { path: "flow/request-library/bodies/rl-1.body", size: 5 },
    );
    const output = exportRequestAsFetch(entry);
    expect(output.startsWith("// 请求体未内联在快照中")).toBe(true);
    expect(output).toContain("5 字节");
    expect(output).not.toContain("  body:");
    expect(output).toContain('  credentials: "include",');

    expect(exportRequestAsFetch(makeEmptyLibraryEntry())).toBe("");
  });
});

/* ------------------------------- axios ------------------------------- */

describe("exportRequestAsAxios", () => {
  test("axios.request 配置对象形态：method / url / headers / data / withCredentials", () => {
    const entry = makeLibraryEntry(
      "下单",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "application/json" }],
        postData: { mimeType: "application/json", text: '{"sku":"A-1"}' },
      }),
    );
    const output = exportRequestAsAxios(entry);
    expect(output.startsWith("const response = await axios.request({")).toBe(true);
    expect(output).toContain('  method: "POST",');
    expect(output).toContain('  url: "https://api.example.com/v1/users",');
    expect(output).toContain('    "content-type": "application/json",');
    expect(output).toContain('  data: "{\\"sku\\":\\"A-1\\"}",');
    expect(output).toContain("  withCredentials: true,");
  });

  test("长 body 换行拼接：产物语法可编译且拼接求值与原文一致；无体时省略 data", () => {
    const longBody = "x".repeat(180);
    const entry = makeLibraryEntry(
      "长体",
      makeEntry({ method: "PUT", postData: { mimeType: "text/plain", text: longBody } }),
    );
    const output = exportRequestAsAxios(entry);
    expect(() => new Function("axios", `return async () => {\n${output}\n}`)).not.toThrow();
    const match = /  data: ([\s\S]*?),\n  withCredentials/.exec(output);
    const value = new Function(`return (${match?.[1] ?? ""})`)() as string;
    expect(value).toBe(longBody);

    const noBody = exportRequestAsAxios(makeLibraryEntry());
    expect(noBody).not.toContain("data:");
    expect(noBody).toContain("  withCredentials: true,");
  });

  test("base64 二进制 body：atob 重建；空 entries：返回空串", () => {
    const entry = makeLibraryEntry(
      "上传",
      makeEntry({
        method: "POST",
        postData: { mimeType: "application/octet-stream", text: "aGk=", encoding: "base64" },
      }),
    );
    const match = /  data: ([\s\S]*?),\n  withCredentials/.exec(exportRequestAsAxios(entry));
    const value = new Function(`return (${match?.[1] ?? ""})`)() as Uint8Array;
    expect(Array.from(value)).toEqual([104, 105]);

    expect(exportRequestAsAxios(makeEmptyLibraryEntry())).toBe("");
  });
});

/* ------------------------------- Python requests ------------------------------- */

describe("exportRequestAsPython", () => {
  test("POST JSON：import requests + requests.request(method, url, headers, data) 结构完整", () => {
    const entry = makeLibraryEntry(
      "下单",
      makeEntry({
        method: "POST",
        headers: [{ name: "content-type", value: "application/json" }],
        postData: { mimeType: "application/json", text: '{"sku":"A-1"}' },
      }),
    );
    expect(exportRequestAsPython(entry)).toBe(
      [
        "import requests",
        "",
        "response = requests.request(",
        '    "POST",',
        '    "https://api.example.com/v1/users",',
        "    headers={",
        '        "content-type": "application/json",',
        "    },",
        '    data="{\\"sku\\":\\"A-1\\"}",',
        ")",
      ].join("\n"),
    );
  });

  test("中文 body 保真；无体时省略 data 参数与 import base64（无 body 回退）", () => {
    const entry = makeLibraryEntry(
      "中文",
      makeEntry({ method: "POST", postData: { mimeType: "text/plain", text: "重放·测试" } }),
    );
    const output = exportRequestAsPython(entry);
    expect(output).toContain('    data="重放·测试",');
    expect(output.startsWith("import requests")).toBe(true);
    expect(output).not.toContain("base64");

    const noBody = exportRequestAsPython(makeLibraryEntry());
    expect(noBody).not.toContain("data=");
    expect(noBody).toContain("response = requests.request(");
  });

  test("长 body 括号内相邻字面量隐式拼接：末块后无逗号（否则会变成元组），拼接值与原文一致", () => {
    const longBody = "y".repeat(200);
    const entry = makeLibraryEntry(
      "长体",
      makeEntry({ method: "POST", postData: { mimeType: "text/plain", text: longBody } }),
    );
    const output = exportRequestAsPython(entry);
    const match = /    data=\(\n([\s\S]*?)\n    \),/.exec(output);
    expect(match).not.toBeNull();
    const literalLines = (match?.[1] ?? "").split("\n");
    expect(literalLines.length).toBeGreaterThan(1);
    let rebuilt = "";
    for (const line of literalLines) {
      // 每行必须是独立的完整双引号字面量（末块后无逗号、无 + 号）
      expect(line).toMatch(/^        "[\s\S]*"$/);
      rebuilt += JSON.parse(line.trim()) as string;
    }
    expect(rebuilt).toBe(longBody);
  });

  test("base64 二进制 body：import base64 + base64.b64decode(...) 字节级重建", () => {
    const entry = makeLibraryEntry(
      "上传",
      makeEntry({
        method: "POST",
        postData: { mimeType: "application/octet-stream", text: "aGk=", encoding: "base64" },
      }),
    );
    const output = exportRequestAsPython(entry);
    expect(output.startsWith("import base64\nimport requests")).toBe(true);
    expect(output).toContain("    data=base64.b64decode(");
    // 短 base64 单行字面量（可被 Python 直接求值解码）
    expect(output).toContain('"aGk="');
  });

  test("bodyRef 外置 body：注释行披露 + 无 data 参数；空 entries：返回空串", () => {
    const entry = makeLibraryEntry(
      "大文件",
      makeEntry({ method: "PUT", postData: { mimeType: "application/octet-stream" } }),
      { path: "flow/request-library/bodies/rl-1.body", size: 5 },
    );
    const output = exportRequestAsPython(entry);
    expect(output.startsWith("# 请求体未内联在快照中")).toBe(true);
    expect(output).toContain("5 字节");
    expect(output).not.toContain("data=");
    expect(output).toContain("response = requests.request(");

    expect(exportRequestAsPython(makeEmptyLibraryEntry())).toBe("");
  });
});

/* ------------------------------- 分发与文件名 ------------------------------- */

describe("REQUEST_EXPORT_FORMATS 与 exportRequestSnapshot", () => {
  test("格式清单：六种格式、菜单文案、交付方式与扩展名正确（顺序即 UI 展示顺序）", () => {
    expect(REQUEST_EXPORT_FORMATS.map((format) => format.id)).toEqual([
      "curl",
      "har",
      "postman",
      "fetch",
      "axios",
      "python",
    ]);
    expect(REQUEST_EXPORT_FORMATS.map((format) => format.label)).toEqual([
      "cURL 命令",
      "HAR 文件",
      "Postman Collection",
      "fetch 代码",
      "axios 代码",
      "Python requests 代码",
    ]);
    expect(REQUEST_EXPORT_FORMATS.map((format) => format.kind)).toEqual([
      "copy",
      "download",
      "download",
      "copy",
      "copy",
      "copy",
    ]);
    expect(REQUEST_EXPORT_FORMATS.map((format) => format.extension)).toEqual([
      null,
      "har",
      "postman_collection.json",
      null,
      null,
      null,
    ]);
  });

  test("分发：各格式与对应生成函数逐字一致", () => {
    const entry = makeLibraryEntry(
      "下单",
      makeEntry({ method: "POST", postData: { mimeType: "application/json", text: '{"a":1}' } }),
    );
    expect(exportRequestSnapshot(entry, "curl")).toBe(exportRequestAsCurl(entry));
    expect(exportRequestSnapshot(entry, "har")).toBe(exportRequestAsHar(entry));
    expect(exportRequestSnapshot(entry, "postman")).toBe(exportRequestAsPostman(entry));
    expect(exportRequestSnapshot(entry, "fetch")).toBe(exportRequestAsFetch(entry));
    expect(exportRequestSnapshot(entry, "axios")).toBe(exportRequestAsAxios(entry));
    expect(exportRequestSnapshot(entry, "python")).toBe(exportRequestAsPython(entry));
  });
});

describe("buildRequestExportFileName", () => {
  const ts = new Date(2026, 9, 31, 12, 0, 0).getTime();

  test("常规名称：proxycrab-<名称>-<YYYY-MM-DD>.<扩展名>（本地时区日期）", () => {
    expect(buildRequestExportFileName("登录冒烟", ts, "har")).toBe(
      "proxycrab-登录冒烟-2026-10-31.har",
    );
    expect(buildRequestExportFileName("登录冒烟", ts, "postman_collection.json")).toBe(
      "proxycrab-登录冒烟-2026-10-31.postman_collection.json",
    );
  });

  test("路径分隔符与 Windows 保留字符替换为「-」，清洗后为空回退 request", () => {
    expect(buildRequestExportFileName('a/b\\c:d*e?f"g<h>i|j', ts, "har")).toBe(
      "proxycrab-a-b-c-d-e-f-g-h-i-j-2026-10-31.har",
    );
    expect(buildRequestExportFileName("???", ts, "har")).toBe("proxycrab-request-2026-10-31.har");
    expect(buildRequestExportFileName("名称...", ts, "har")).toBe("proxycrab-名称-2026-10-31.har");
  });

  test("超长名称截断到 60 字符（与流程导出同一上限）", () => {
    const fileName = buildRequestExportFileName("长".repeat(80), ts, "har");
    expect(fileName).toBe(`proxycrab-${"长".repeat(60)}-2026-10-31.har`);
  });
});
