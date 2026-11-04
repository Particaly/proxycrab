import { describe, expect, it } from "vitest";
import {
  IMPORT_BODY_MAX_BYTES,
  buildCurlItem,
  buildDefaultRequestName,
  filterDuplicateItems,
  importDedupKey,
  parseCurlCommand,
  parseHarImport,
  parsePostmanImport,
  parseUrlOrigin,
} from "./request-library-import.ts";

/** 断言解析失败并返回错误信息（类型收窄辅助）。 */
function expectError(command: string): string {
  const result = parseCurlCommand(command);
  if (result.ok) throw new Error(`预期解析失败，实际成功：${command}`);
  return result.error;
}

describe("parseCurlCommand 基础请求", () => {
  it("GET：仅 URL 时方法为 GET、无体、queryString 从 URL 拆出", () => {
    const result = parseCurlCommand("curl https://api.example.com/v1/users?page=2&size=20");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.method).toBe("GET");
    expect(result.request.url).toBe("https://api.example.com/v1/users?page=2&size=20");
    expect(result.request.queryString).toEqual([
      { name: "page", value: "2" },
      { name: "size", value: "20" },
    ]);
    expect(result.request.body).toBeUndefined();
    expect(result.request.mimeType).toBeUndefined();
    expect(result.request.headers).toEqual([]);
  });

  it("无协议头 URL 按 curl 行为补 http:// 前缀", () => {
    const result = parseCurlCommand("curl example.com/api/health");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.url).toBe("http://example.com/api/health");
  });

  it("-X 显式指定方法（大小写归一为大写）", () => {
    const result = parseCurlCommand("curl -X delete 'https://api.example.com/v1/items/3'");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.method).toBe("DELETE");
  });

  it("-I/--head 推断为 HEAD", () => {
    for (const command of ["curl -I https://a.dev", "curl --head https://a.dev"]) {
      const result = parseCurlCommand(command);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.request.method).toBe("HEAD");
    }
  });
});

describe("parseCurlCommand 请求头", () => {
  it("多个 -H 按序收集，值两侧空白被 trim", () => {
    const result = parseCurlCommand(
      [
        "curl https://a.dev/api",
        "-H 'Accept: application/json'",
        '-H "Authorization: Bearer token 123"',
      ].join(" "),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers).toEqual([
      { name: "Accept", value: "application/json" },
      { name: "Authorization", value: "Bearer token 123" },
    ]);
  });

  it("-H 值中的冒号只按第一个拆分", () => {
    const result = parseCurlCommand("curl -H 'X-Time: 12:30:00' https://a.dev");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers).toEqual([{ name: "X-Time", value: "12:30:00" }]);
  });

  it("-H 无冒号的删头写法被忽略；`Name;` 空值头保留", () => {
    const result = parseCurlCommand("curl -H 'X-Drop' -H 'X-Empty;' https://a.dev");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers).toEqual([{ name: "X-Empty", value: "" }]);
  });

  it("-A / -e / -u 生成派生头，-u 走 Basic 认证", () => {
    const result = parseCurlCommand(
      "curl -A 'ReqFlow/1.0' -e 'https://ref.dev' -u 'user:pass' https://a.dev",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers).toEqual([
      { name: "User-Agent", value: "ReqFlow/1.0" },
      { name: "Referer", value: "https://ref.dev" },
      { name: "Authorization", value: `Basic ${btoa("user:pass")}` },
    ]);
  });

  it("--header=value 附着形式等价 -H value", () => {
    const result = parseCurlCommand("curl --header='X-Attached: yes' https://a.dev");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers).toEqual([{ name: "X-Attached", value: "yes" }]);
  });
});

describe("parseCurlCommand 请求体", () => {
  it("JSON body：-d 与 Content-Type 头映射 mimeType，方法默认 POST", () => {
    const result = parseCurlCommand(
      [
        "curl -X POST 'https://api.example.com/v1/orders'",
        "-H 'Content-Type: application/json'",
        `-d '{"sku":"A-1","qty":2}'`,
      ].join(" "),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.method).toBe("POST");
    expect(result.request.body).toBe('{"sku":"A-1","qty":2}');
    expect(result.request.mimeType).toBe("application/json");
  });

  it("多个 -d 按 & 拼接；无 Content-Type 时补表单 MIME", () => {
    const result = parseCurlCommand("curl -d 'a=1' --data 'b=x y' https://a.dev/submit");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toBe("a=1&b=x y");
    expect(result.request.mimeType).toBe("application/x-www-form-urlencoded");
  });

  it("--data-urlencode 对值编码、name 保留", () => {
    const result = parseCurlCommand("curl --data-urlencode 'msg=你好 世界' https://a.dev/post");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toBe(`msg=${encodeURIComponent("你好 世界")}`);
  });

  it("-F 表单字段简化为表单体（@file 读文件报错）", () => {
    const ok = parseCurlCommand("curl -F 'name=A-1' -F 'note=hello world' https://a.dev/upload");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.request.body).toBe(`name=A-1&note=${encodeURIComponent("hello world")}`);
      expect(ok.request.method).toBe("POST");
    }
    expect(expectError("curl -F 'avatar=@a.png' https://a.dev/upload")).toContain("不支持从文件读取");
  });

  it("-d @file / <file 与 -b cookiejar 返回明确错误", () => {
    expect(expectError("curl -d @body.json https://a.dev")).toContain("不支持从文件读取");
    expect(expectError("curl --data-binary @bin https://a.dev")).toContain("不支持从文件读取");
    expect(expectError("curl -b cookies.txt https://a.dev")).toContain("不支持从文件读取");
  });

  it("-b Cookie 串转 Cookie 头与 cookies 数组，且与 -H Cookie 合并", () => {
    const solo = parseCurlCommand("curl -b 'sid=abc; theme=dark' https://a.dev");
    expect(solo.ok).toBe(true);
    if (solo.ok) {
      expect(solo.request.headers).toEqual([{ name: "Cookie", value: "sid=abc; theme=dark" }]);
      expect(solo.request.cookies).toEqual([
        { name: "sid", value: "abc" },
        { name: "theme", value: "dark" },
      ]);
    }
    const merged = parseCurlCommand("curl -H 'Cookie: a=1' -b 'sid=abc' https://a.dev");
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.request.headers).toEqual([{ name: "Cookie", value: "a=1; sid=abc" }]);
    }
  });
});

describe("parseCurlCommand 词法与续行", () => {
  it("多行续行与单双引号混用（'\\'' 惯用法）", () => {
    const result = parseCurlCommand(
      [
        "curl https://a.dev/api \\",
        "  -H 'A: it'\\''s' \\",
        '  -d "line1\\nline2"',
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers).toEqual([{ name: "A", value: "it's" }]);
    // 双引号内未知转义保留反斜杠原样（bash 语义：仅 \$ \` \" \\ 与 \换行 是转义）
    expect(result.request.body).toBe("line1\\nline2");
  });

  it("双引号内未知转义保留反斜杠原样；未加引号区域 \\x 转 x", () => {
    const result = parseCurlCommand('curl -d "a=1\\2" https://a.dev/x\\?y=1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toBe("a=1\\2");
    expect(result.request.url).toContain("y=1");
  });

  it("带参开关（-o/--max-time 等）只吃参数；--compressed 等被忽略", () => {
    const result = parseCurlCommand(
      "curl --compressed -o /tmp/out.json --max-time 5 -sk https://a.dev/data",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.url).toBe("https://a.dev/data");
  });

  it("sudo / 路径前缀 / .exe 后缀的 curl 可识别", () => {
    for (const command of [
      "sudo curl https://a.dev",
      "'C:\\Program Files\\curl.exe' https://a.dev",
      "curl.exe https://a.dev",
    ]) {
      const result = parseCurlCommand(command);
      expect(result.ok).toBe(true);
    }
  });
});

describe("parseCurlCommand -G 与错误路径", () => {
  it("-G：-d 数据并入查询串，方法回到 GET，body 清空", () => {
    const result = parseCurlCommand("curl -G -d 'q=kw word' -d 'page=2' https://a.dev/search");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.method).toBe("GET");
    expect(result.request.url).toBe(`https://a.dev/search?q=${encodeURIComponent("kw word")}&page=2`);
    expect(result.request.queryString).toEqual([
      { name: "q", value: "kw word" },
      { name: "page", value: "2" },
    ]);
    expect(result.request.body).toBeUndefined();
  });

  it("错误输入：空 / 非 curl / 缺 URL / 引号未闭合 / 缺选项参数 / URL 非法", () => {
    expect(expectError("")).toBe("请输入 curl 命令");
    expect(expectError("   \n  ")).toBe("请输入 curl 命令");
    expect(expectError("wget https://a.dev")).toContain("不是 curl 命令");
    expect(expectError("curl")).toBe("未找到请求 URL");
    expect(expectError("curl 'https://a.dev")).toContain("引号未闭合");
    expect(expectError("curl -H")).toContain("缺少参数");
    expect(expectError("curl ://bad")).toContain("URL 无法解析");
  });
});

describe("默认命名与 origin", () => {
  it("buildDefaultRequestName：METHOD host+path，根路径省略 /", () => {
    expect(buildDefaultRequestName("POST", "https://api.example.com:8443/v1/orders")).toBe(
      "POST api.example.com:8443/v1/orders",
    );
    expect(buildDefaultRequestName("get", "https://example.com/")).toBe("GET example.com");
    expect(buildDefaultRequestName("", "https://example.com/a")).toBe("example.com/a");
    expect(buildDefaultRequestName("GET", "not a url")).toBe("GET not a url");
  });

  it("parseUrlOrigin：合法 URL 取 origin；非法 / null origin 返回空串", () => {
    expect(parseUrlOrigin("https://api.example.com:8443/v1/users?x=1")).toBe(
      "https://api.example.com:8443",
    );
    expect(parseUrlOrigin("not a url")).toBe("");
    expect(parseUrlOrigin("file:///tmp/a")).toBe("");
  });
});

describe("parseHarImport", () => {
  /** 组装单条目 HAR 文本（最小合法形状）。 */
  const harText = (entries: unknown[]): string =>
    JSON.stringify({
      log: { version: "1.2", creator: { name: "Test" }, entries },
    });

  it("基础条目：请求侧字段与响应摘要归一，响应体文本不落库", () => {
    const result = parseHarImport(
      harText([
        {
          startedDateTime: "2026-11-01T00:00:00Z",
          time: 120,
          request: {
            method: "POST",
            url: "https://api.example.com/v1/orders?dry=1",
            httpVersion: "HTTP/1.1",
            headers: [{ name: "Content-Type", value: "application/json" }],
            queryString: [{ name: "dry", value: "1" }],
            cookies: [{ name: "sid", value: "abc", path: "/", secure: true }],
            postData: { mimeType: "application/json", text: '{"sku":"A-1"}' },
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: [{ name: "X-Any", value: "1" }],
            content: { size: 42, mimeType: "application/json", text: "should be dropped" },
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toEqual([]);
    const item = result.items[0];
    expect(item.method).toBe("POST");
    expect(item.status).toBe(200);
    expect(item.entry.startedDateTime).toBe("2026-11-01T00:00:00Z");
    expect(item.entry.time).toBe(120);
    expect(item.entry.request.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
    expect(item.entry.request.queryString).toEqual([{ name: "dry", value: "1" }]);
    expect(item.entry.request.cookies).toEqual([{ name: "sid", value: "abc" }]);
    expect(item.entry.request.postData).toEqual({ mimeType: "application/json", text: '{"sku":"A-1"}' });
    expect(item.entry.response).toMatchObject({
      status: 200,
      statusText: "OK",
      content: { size: 42, mimeType: "application/json" },
    });
    expect(item.entry.response?.headers).toEqual([]);
    expect(JSON.stringify(item.entry)).not.toContain("should be dropped");
  });

  it("缺响应条目不携带 response；状态未知条目 status=-1", () => {
    const result = parseHarImport(harText([{ request: { method: "GET", url: "https://a.dev" } }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].status).toBe(-1);
    expect(result.items[0].entry.response).toBeUndefined();
  });

  it("超 64KiB 请求体按 UTF-8 边界截断", () => {
    const big = "你".repeat(40_000); // 120KB UTF-8
    const result = parseHarImport(
      harText([
        {
          request: {
            method: "POST",
            url: "https://a.dev",
            postData: { mimeType: "text/plain", text: big },
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.items[0].entry.request.postData?.text ?? "";
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(IMPORT_BODY_MAX_BYTES);
    expect(text.endsWith("你")).toBe(true); // 不含半字符
  });

  it("条目级失败跳过并记录原因，不中断其余条目", () => {
    const result = parseHarImport(
      harText(["nope", { request: { url: "https://a.dev" } }, { request: { method: "GET", url: "https://b.dev" } }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.url)).toEqual(["https://b.dev"]);
    expect(result.skipped).toEqual([
      { index: 0, reason: "条目不是对象" },
      { index: 1, reason: "缺少 request.method 或 request.url" },
    ]);
  });

  it("文件级失败：空 / 非 JSON / 缺 log / 缺 entries", () => {
    expect(parseHarImport("")).toMatchObject({ ok: false, error: "HAR 文件内容为空" });
    expect(parseHarImport("not json")).toMatchObject({ ok: false, error: "文件内容不是有效的 JSON" });
    expect(parseHarImport("{}")).toMatchObject({ ok: false });
    expect(parseHarImport('{"log":{}}')).toMatchObject({ ok: false });
  });
});

describe("parsePostmanImport", () => {
  it("v2.1 请求：URL 对象 / header / cookie / raw JSON body", () => {
    const result = parsePostmanImport(
      JSON.stringify({
        info: { name: "Demo" },
        item: [
          {
            name: "Create order",
            request: {
              method: "POST",
              url: { raw: "https://api.example.com/v1/orders?dry=1", host: ["api", "example", "com"], path: ["v1", "orders"], query: [{ key: "dry", value: "1" }] },
              header: [
                { key: "Content-Type", value: "application/json" },
                { key: "X-Drop", value: "skip", disabled: true },
              ],
              cookie: [{ key: "sid", value: "abc" }],
              body: { mode: "raw", raw: '{"sku":"A-1"}', options: { raw: { language: "json" } } },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.items[0];
    expect(item.method).toBe("POST");
    expect(item.entry.request.url).toBe("https://api.example.com/v1/orders?dry=1");
    expect(item.entry.request.queryString).toEqual([{ name: "dry", value: "1" }]);
    expect(item.entry.request.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
    expect(item.entry.request.cookies).toEqual([{ name: "sid", value: "abc" }]);
    expect(item.entry.request.postData).toEqual({ mimeType: "application/json", text: '{"sku":"A-1"}' });
  });

  it("urlencoded 补 params 与编码正文；raw 无 language 时回退 Content-Type 头", () => {
    const result = parsePostmanImport(
      JSON.stringify({
        item: [
          {
            request: {
              method: "POST",
              url: "https://a.dev/submit",
              body: { mode: "urlencoded", urlencoded: [{ key: "msg", value: "你好 世界" }] },
            },
          },
          {
            request: {
              method: "POST",
              url: "https://a.dev/raw",
              header: [{ key: "Content-Type", value: "text/csv" }],
              body: { mode: "raw", raw: "plain" },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].entry.request.postData).toEqual({
      mimeType: "application/x-www-form-urlencoded",
      params: [{ name: "msg", value: "你好 世界" }],
      text: `msg=${encodeURIComponent("你好 世界")}`,
    });
    expect(result.items[1].entry.request.postData).toEqual({ mimeType: "text/csv", text: "plain" });
  });

  it("formdata 文本字段组装 multipart 体；文件字段跳过", () => {
    const result = parsePostmanImport(
      JSON.stringify({
        item: [
          {
            request: {
              method: "POST",
              url: "https://a.dev/upload",
              body: {
                mode: "formdata",
                formdata: [
                  { key: "name", value: "A-1", type: "text" },
                  { key: "avatar", type: "file", src: "/tmp/a.png" },
                  { key: "skip", value: "x", disabled: true },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const postData = result.items[0].entry.request.postData;
    expect(postData?.mimeType).toContain("multipart/form-data; boundary=");
    expect(postData?.params).toEqual([{ name: "name", value: "A-1" }]);
    expect(postData?.text).toContain('form-data; name="name"');
    expect(postData?.text).not.toContain("avatar");
  });

  it("目录递归展开；无 request 的条目跳过；method 缺省为 GET", () => {
    const result = parsePostmanImport(
      JSON.stringify({
        item: [
          {
            name: "folder",
            item: [{ request: { url: "https://a.dev/nested" } }],
          },
          { name: "no-request" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].method).toBe("GET");
    expect(result.items[0].url).toBe("https://a.dev/nested");
    expect(result.skipped).toEqual([{ index: 1, reason: "条目没有 request 描述" }]);
  });

  it("graphql body 转 JSON 正文；URL 对象缺 raw 时按 protocol/host/path 拼接", () => {
    const result = parsePostmanImport(
      JSON.stringify({
        item: [
          {
            request: {
              method: "POST",
              url: { protocol: "https", host: ["a", "dev"], path: ["gql"] },
              body: { mode: "graphql", graphql: { query: "{ ping }", variables: { x: 1 } } },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].url).toBe("https://a.dev/gql");
    expect(result.items[0].entry.request.postData?.mimeType).toBe("application/json");
    expect(JSON.parse(result.items[0].entry.request.postData?.text ?? "{}")).toEqual({
      query: "{ ping }",
      variables: { x: 1 },
    });
  });

  it("文件级失败：空 / 非 JSON / 缺 item 数组", () => {
    expect(parsePostmanImport("")).toMatchObject({ ok: false });
    expect(parsePostmanImport("[[[")).toMatchObject({ ok: false, error: "文件内容不是有效的 JSON" });
    expect(parsePostmanImport('{"info":{}}')).toMatchObject({ ok: false, error: "Postman Collection 格式不正确：缺少 item 数组" });
  });
});

describe("去重策略", () => {
  /** 组装单条测试条目（借 HAR 路径构建最小合法形状）。 */
  function item(method: string, url: string) {
    const result = parseHarImport(JSON.stringify({ log: { entries: [{ request: { method, url } }] } }));
    if (!result.ok) throw new Error("构建测试条目失败");
    return result.items[0];
  }

  it("importDedupKey 方法大小写归一；filterDuplicateItems 按键分流", () => {
    expect(importDedupKey(" get ", "https://a.dev/x")).toBe("GET https://a.dev/x");
    const items = [item("GET", "https://a.dev/same"), item("POST", "https://a.dev/new")];
    const { kept, duplicates } = filterDuplicateItems(items, new Set(["GET https://a.dev/same"]));
    expect(kept.map((entry) => entry.url)).toEqual(["https://a.dev/new"]);
    expect(duplicates.map((entry) => entry.url)).toEqual(["https://a.dev/same"]);
  });
});

describe("buildCurlItem", () => {
  it("JSON body：postData 带 mimeType 与原文；无响应交换", () => {
    const parsed = parseCurlCommand(
      "curl -X POST 'https://api.example.com:8443/v1/orders?dry=1' -H 'Content-Type: application/json' -d '{\"sku\":\"A-1\"}'",
    );
    if (!parsed.ok) throw new Error("解析应成功");
    const built = buildCurlItem(parsed.request);
    expect(built.method).toBe("POST");
    expect(built.status).toBe(-1);
    expect(built.entry.response).toBeUndefined();
    expect(built.entry.request.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
    expect(built.entry.request.queryString).toEqual([{ name: "dry", value: "1" }]);
    expect(built.entry.request.postData).toEqual({ mimeType: "application/json", text: '{"sku":"A-1"}' });
  });

  it("表单体补 params 键值对（URL 解码后的展示形态）；Cookie 透传", () => {
    const parsed = parseCurlCommand("curl -b 'sid=abc' -d 'a=1&b=x%20y' https://a.dev/submit");
    if (!parsed.ok) throw new Error("解析应成功");
    const built = buildCurlItem(parsed.request);
    expect(built.entry.request.postData?.mimeType).toBe("application/x-www-form-urlencoded");
    expect(built.entry.request.postData?.params).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "x y" },
    ]);
    expect(built.entry.request.cookies).toEqual([{ name: "sid", value: "abc" }]);
  });

  it("无 body 时不携带 postData 与 cookies 字段", () => {
    const parsed = parseCurlCommand("curl https://a.dev");
    if (!parsed.ok) throw new Error("解析应成功");
    const built = buildCurlItem(parsed.request);
    expect(built.entry.request.postData).toBeUndefined();
    expect(built.entry.request.cookies).toBeUndefined();
  });
});


