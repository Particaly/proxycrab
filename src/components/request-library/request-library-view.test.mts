import { expect, test } from "vitest";
import type { RequestLibraryEntry } from "../api/types.ts";
import {
  base64DecodedSize,
  buildRequestGroups,
  collectGroupItemIds,
  extractHost,
  formatUrlParts,
  parseTagInput,
  requestBodyPayload,
  requestMethod,
  requestSize,
  requestUrl,
  sortRequests,
  tagsEqual,
  UNKNOWN_HOST_GROUP_LABEL,
  UNTAGGED_GROUP_LABEL,
} from "./request-library-view.ts";

/** 构造一个最小请求库条目（仅覆盖测试关注字段）。 */
function entry(overrides: Partial<RequestLibraryEntry> & { id: string }): RequestLibraryEntry {
  return {
    name: `name-${overrides.id}`,
    tags: [],
    source: "manual",
    origin: "",
    createdAt: 1000,
    updatedAt: 1000,
    har: {
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "GET",
              url: "https://example.com/api?a=1",
              headers: [],
              queryString: [],
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

test("HAR snapshot field readers fall back safely on incomplete snapshots", () => {
  const full = entry({ id: "a" });
  expect(requestUrl(full)).toBe("https://example.com/api?a=1");
  expect(requestMethod(full)).toBe("GET");
  expect(requestSize(full)).toBe(0);
  const sized = entry({
    id: "b",
    har: {
      log: {
        version: "1.2",
        entries: [
          {
            request: { method: "", url: "", headers: [], queryString: [] },
            response: { status: 200, content: { size: 2048, mimeType: "application/json" } },
          },
        ],
      },
    },
  });
  expect(requestSize(sized)).toBe(2048);
  expect(requestMethod(sized)).toBe("");
  const broken = entry({
    id: "c",
    har: { log: { version: "1.2", entries: [] } },
  });
  expect(requestUrl(broken)).toBe("");
  expect(requestBodyPayload(broken)).toEqual({ type: "empty" });
});

test("host extraction and URL display splitting", () => {
  expect(extractHost("https://api.example.com:8443/x/y")).toBe("api.example.com");
  expect(extractHost("//fallback.example.com/path")).toBe("fallback.example.com");
  expect(extractHost("user@host.example.com")).toBe("");
  expect(extractHost("")).toBe("");
  expect(formatUrlParts("https://example.com/path?q=1")).toEqual({
    host: "example.com",
    path: "/path?q=1",
  });
  expect(formatUrlParts("https://example.com")).toEqual({ host: "example.com", path: "/" });
  expect(formatUrlParts("not-a-url")).toEqual({ host: "", path: "not-a-url" });
});

test("sort comparators order by created time, name and response size", () => {
  const a = entry({ id: "a", name: "alpha", createdAt: 300 });
  const b = entry({ id: "b", name: "beta", createdAt: 200 });
  const c = entry({ id: "c", name: "alpha", createdAt: 100 });
  expect(sortRequests([b, c, a], "created-desc").map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(sortRequests([a, b, c], "created-asc").map((item) => item.id)).toEqual(["c", "b", "a"]);
  // 同名时按 id 兜底。
  expect(sortRequests([c, a], "name-asc").map((item) => item.id)).toEqual(["a", "c"]);
  const big = entry({
    id: "big",
    har: {
      log: {
        version: "1.2",
        entries: [
          {
            request: { method: "GET", url: "", headers: [], queryString: [] },
            response: { status: 200, content: { size: 5000, mimeType: "" } },
          },
        ],
      },
    },
  });
  expect(sortRequests([a, big], "size-desc").map((item) => item.id)).toEqual(["big", "a"]);
});

test("grouping flattens tags many-to-many and parks fallback groups last", () => {
  const items = [
    entry({ id: "1", tags: ["登录", "核心"] }),
    entry({ id: "2", tags: ["登录"] }),
    entry({ id: "3", tags: [] }),
    entry({
      id: "4",
      har: {
        log: {
          version: "1.2",
          entries: [
            {
              request: { method: "GET", url: "not-a-url", headers: [], queryString: [] },
            },
          ],
        },
      },
    }),
  ];
  const groups = buildRequestGroups(items, { groupBy: "tag", sortBy: "created-desc" });
  expect(groups.map((group) => group.label)).toEqual(["核心", "登录", UNTAGGED_GROUP_LABEL]);
  expect(groups[1]!.items.map((item) => item.id)).toEqual(["1", "2"]);
  // 同一条目出现在每个标签组。
  expect(groups[0]!.items.map((item) => item.id)).toEqual(["1"]);

  const hostGroups = buildRequestGroups(items, { groupBy: "host", sortBy: "created-asc" });
  expect(hostGroups.map((group) => group.label)).toEqual(["example.com", UNKNOWN_HOST_GROUP_LABEL]);
  expect(hostGroups[0]!.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
  expect(hostGroups[1]!.items.map((item) => item.id)).toEqual(["4"]);

  const none = buildRequestGroups(items, { groupBy: "none", sortBy: "name-asc" });
  expect(none).toHaveLength(1);
  expect(collectGroupItemIds(none)).toHaveLength(4);
  expect(
    collectGroupItemIds(buildRequestGroups([], { groupBy: "tag", sortBy: "name-asc" })),
  ).toEqual([]);
});

test("request body payload derives inline text, base64 and blob references", () => {
  const inline = entry({
    id: "inline",
    har: {
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "POST",
              url: "https://example.com",
              headers: [],
              queryString: [],
              postData: { mimeType: "application/json", text: '{"a":1}' },
            },
          },
        ],
      },
    },
  });
  expect(requestBodyPayload(inline)).toEqual({
    type: "text",
    content: '{"a":1}',
    size: 7,
  });

  const base64 = entry({
    id: "b64",
    har: {
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "POST",
              url: "",
              headers: [],
              queryString: [],
              postData: {
                mimeType: "application/octet-stream",
                text: "AQIDBA==",
                encoding: "base64",
              },
            },
          },
        ],
      },
    },
  });
  expect(requestBodyPayload(base64)).toEqual({ type: "binary", size: 4 });
  expect(base64DecodedSize("AQIDBA==")).toBe(4);
  expect(base64DecodedSize("AQIDBA")).toBe(4);
  expect(base64DecodedSize("")).toBe(0);

  const blob = entry({
    id: "blob",
    bodyRef: { path: "request-library/bodies/blob.body", size: 4096 },
  });
  expect(requestBodyPayload(blob)).toEqual({ type: "binary", size: 4096 });

  const mimeOnly = entry({
    id: "mime",
    har: {
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "POST",
              url: "",
              headers: [],
              queryString: [],
              postData: { mimeType: "application/json", text: null },
            },
          },
        ],
      },
    },
  });
  expect(requestBodyPayload(mimeOnly)).toEqual({ type: "empty" });
});

test("tag input parsing splits half/full-width commas with dedupe", () => {
  expect(parseTagInput(" 登录，核心 ,登录\t")).toEqual(["登录", "核心"]);
  expect(parseTagInput("，，,")).toEqual([]);
  expect(parseTagInput("single")).toEqual(["single"]);
  expect(tagsEqual(["a", "b"], ["b", "a"])).toBe(true);
  expect(tagsEqual(["a"], ["a", "b"])).toBe(false);
});
