import type { RequestLibraryEntry, WorkflowNode, WorkflowNodeConfig } from "../../../api/types";

/**
 * 请求重放节点（httpReplay）配置的纯逻辑（计划 Task 14）。
 *
 * 字段级权威是 Rust 侧 `crates/proxy-crab-mitm/src/flow/model.rs` 的
 * `NodeConfig`（camelCase 线格式；前端 `WorkflowNodeConfig` 只是
 * `Record<string, unknown>`），本模块负责形状防御读取、编辑草稿与落库形状
 * 的双向转换以及 refId 短码原语——组件只做状态编排。
 *
 * 落库口径（与模型「可选字段、仅覆盖给出的字段」注释一致）：空白值一律省略，
 * 不把空串持久化进配置；`headerFidelity` 只落 static 项（键缺省 = 回放捕获
 * 值）；`cookieMode` 只在显式选「自定义」且值非空时落。refId 原语对齐
 * `flow-engine/src/ref-id.ts`（引擎载荷侧同语义实现，前端独立副本避免跨根耦合）。
 */

/* ------------------------------------------------------------------ *
 * 配置草稿形状（NodeConfig 相关字段的类型化投影）
 * ------------------------------------------------------------------ */

export type ReplayFailPolicy = "stop" | "continue";
export type HeaderFidelitySource = "fromCapture" | "static";

/** header 保真单项（model.rs `HeaderFidelityItem`）。 */
export interface HeaderFidelityItem {
  source: HeaderFidelitySource;
  /** source = 'static' 时的注入值（支持模板）；fromCapture 时忽略。 */
  value?: string;
}

/** 节点级 header 保真（model.rs `NodeHeaderFidelity`）。 */
export interface ReplayHeaderFidelity {
  origin?: HeaderFidelityItem;
  referer?: HeaderFidelityItem;
  userAgent?: HeaderFidelityItem;
}

/** 重试退避（model.rs `NodeRetryConfig`；multiplier 缺省由执行侧取 2）。 */
export interface ReplayRetry {
  maxAttempts: number;
  backoffMs: number;
  multiplier?: number;
}

/** 固定输出（model.rs `NodePinnedOutput`）。 */
export interface ReplayPinnedOutput {
  value: unknown;
  pinnedAt: number;
  sourceRunId: string;
}

/** 请求覆盖项（model.rs `RequestOverride`）。 */
export interface ReplayOverride {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  removedHeaders?: string[];
  body?: string;
}

/** 手动请求基线（model.rs `ManualRequest`）。 */
export interface ReplayManualRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** httpReplay 节点配置的类型化草稿（本任务涉及字段的并集）。 */
export interface ReplayConfigDraft {
  requestId?: string;
  manualRequest?: ReplayManualRequest;
  override?: ReplayOverride;
  preProcess?: string;
  postProcess?: string;
  timeoutMs?: number;
  failPolicy: ReplayFailPolicy;
  headerFidelity?: ReplayHeaderFidelity;
  /** 非空 = 显式选「自定义」，落 cookieMode:'custom' + cookieValue。 */
  cookieCustom?: string;
  retry?: ReplayRetry;
  pinnedOutput?: ReplayPinnedOutput;
}

/* ------------------------------------------------------------------ *
 * 形状防御读取
 * ------------------------------------------------------------------ */

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Record<string, unknown> → Record<string, string>（仅保留字符串值）。 */
function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 读取 header 保真单项（非法 source 按缺省 fromCapture 归一）。 */
function readFidelityItem(value: unknown): HeaderFidelityItem | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return record["source"] === "static"
    ? { source: "static", value: asString(record["value"]) ?? "" }
    : { source: "fromCapture" };
}

/**
 * 形状防御地读取 httpReplay 节点配置。未知 / 非法形状按缺省语义归一
 * （与存储侧「坏数据不整条不可读」宽容口径一致），failPolicy 恒有值
 * （缺省 stop）。
 */
export function readReplayConfig(config: WorkflowNodeConfig): ReplayConfigDraft {
  const record = asRecord(config) ?? {};
  const manual = asRecord(record["manualRequest"]);
  const override = asRecord(record["override"]);
  const fidelity = asRecord(record["headerFidelity"]);
  const retry = asRecord(record["retry"]);
  const pinned = asRecord(record["pinnedOutput"]);
  const draft: ReplayConfigDraft = {
    failPolicy: record["failPolicy"] === "continue" ? "continue" : "stop",
  };
  if (typeof record["requestId"] === "string") draft.requestId = record["requestId"];
  if (manual) {
    draft.manualRequest = {
      method: asString(manual["method"]) ?? "GET",
      url: asString(manual["url"]) ?? "",
      headers: asStringRecord(manual["headers"]),
      body: asString(manual["body"]),
    };
  }
  if (override) {
    draft.override = {
      method: asString(override["method"]),
      url: asString(override["url"]),
      headers: asStringRecord(override["headers"]),
      removedHeaders: Array.isArray(override["removedHeaders"])
        ? override["removedHeaders"].filter((name): name is string => typeof name === "string")
        : undefined,
      body: asString(override["body"]),
    };
  }
  draft.preProcess = asString(record["preProcess"]);
  draft.postProcess = asString(record["postProcess"]);
  draft.timeoutMs = asPositiveNumber(record["timeoutMs"]);
  if (fidelity) {
    const items: ReplayHeaderFidelity = {};
    const origin = readFidelityItem(fidelity["origin"]);
    const referer = readFidelityItem(fidelity["referer"]);
    const userAgent = readFidelityItem(fidelity["userAgent"]);
    if (origin) items.origin = origin;
    if (referer) items.referer = referer;
    if (userAgent) items.userAgent = userAgent;
    if (Object.keys(items).length > 0) draft.headerFidelity = items;
  }
  // cookieMode 未知值（含历史 'browser'）按缺省快照语义归一，与模型一致。
  if (record["cookieMode"] === "custom") {
    draft.cookieCustom = asString(record["cookieValue"]) ?? "";
  }
  if (retry) {
    const maxAttempts = retry["maxAttempts"];
    const backoffMs = retry["backoffMs"];
    if (typeof maxAttempts === "number" && typeof backoffMs === "number") {
      draft.retry = {
        maxAttempts,
        backoffMs,
        multiplier: typeof retry["multiplier"] === "number" ? retry["multiplier"] : undefined,
      };
    }
  }
  if (
    pinned &&
    typeof pinned["pinnedAt"] === "number" &&
    typeof pinned["sourceRunId"] === "string"
  ) {
    draft.pinnedOutput = {
      value: pinned["value"],
      pinnedAt: pinned["pinnedAt"],
      sourceRunId: pinned["sourceRunId"],
    };
  }
  return draft;
}

/** 头记录键 trim、丢空名键；空记录返回 undefined。 */
function cleanHeaderRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    const key = name.trim();
    if (key !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 草稿 → 落库配置：空白字段一律省略（仅覆盖给出的字段语义）。
 * `override` / `manualRequest` 的取舍由调用方按引用状态组装后传入。
 */
export function buildReplayNodeConfig(draft: ReplayConfigDraft): WorkflowNodeConfig {
  const config: Record<string, unknown> = {};
  if (draft.requestId !== undefined && draft.requestId !== "") config.requestId = draft.requestId;
  if (draft.requestId === undefined || draft.requestId === "") {
    const manual = draft.manualRequest;
    if (manual && (manual.method !== "" || manual.url !== "" || manual.body)) {
      const request: ReplayManualRequest = {
        method: manual.method === "" ? "GET" : manual.method,
        url: manual.url,
      };
      const headers = cleanHeaderRecord(manual.headers);
      if (headers) request.headers = headers;
      if (manual.body !== undefined && manual.body !== "") request.body = manual.body;
      config.manualRequest = request;
    }
  } else if (draft.override) {
    const override: ReplayOverride = {};
    if (draft.override.method) override.method = draft.override.method;
    if (draft.override.url) override.url = draft.override.url;
    const headers = cleanHeaderRecord(draft.override.headers);
    if (headers) override.headers = headers;
    const removed = draft.override.removedHeaders
      ?.map((name) => name.trim())
      .filter((name) => name !== "");
    if (removed && removed.length > 0) override.removedHeaders = removed;
    // body = "" 合法（显式剥离引用快照的 body）。
    if (draft.override.body !== undefined) override.body = draft.override.body;
    if (Object.keys(override).length > 0) config.override = override;
  }
  if (draft.preProcess && draft.preProcess.trim() !== "") config.preProcess = draft.preProcess;
  if (draft.postProcess && draft.postProcess.trim() !== "") config.postProcess = draft.postProcess;
  if (draft.timeoutMs !== undefined) config.timeoutMs = draft.timeoutMs;
  config.failPolicy = draft.failPolicy;
  const fidelity = staticFidelityOnly(draft.headerFidelity);
  if (fidelity !== undefined) config.headerFidelity = fidelity;
  if (draft.cookieCustom !== undefined && draft.cookieCustom.trim() !== "") {
    config.cookieMode = "custom";
    config.cookieValue = draft.cookieCustom.trim();
  }
  if (draft.retry) config.retry = draft.retry;
  if (draft.pinnedOutput) config.pinnedOutput = draft.pinnedOutput;
  return config;
}

/** 只保留 static 且值非空的保真项；全部为空时返回 undefined（不落字段）。 */
export function staticFidelityOnly(
  fidelity: ReplayHeaderFidelity | undefined,
): ReplayHeaderFidelity | undefined {
  if (!fidelity) return undefined;
  const out: ReplayHeaderFidelity = {};
  for (const key of ["origin", "referer", "userAgent"] as const) {
    const item = fidelity[key];
    if (item && item.source === "static" && (item.value ?? "").trim() !== "") {
      out[key] = { source: "static", value: (item.value ?? "").trim() };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ------------------------------------------------------------------ *
 * 引用快照基线与请求头行
 * ------------------------------------------------------------------ */

/** 引用快照的请求基线（抽屉表单回填来源）。 */
export interface CapturedBaseline {
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  /** 快照 body 原文；null = 无 body 或 base64 二进制（不可作文本基线）。 */
  bodyText: string | null;
  /** 快照 body 为 base64 二进制时的字节数（提示用）。 */
  bodyBinaryBytes: number | null;
}

/** 请求标识头与 Cookie 由专门控件渲染，不进请求头行编辑列表。 */
export const SPECIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "origin",
  "referer",
  "user-agent",
  "cookie",
]);

export function isSpecialHeader(name: string): boolean {
  return SPECIAL_HEADER_NAMES.has(name.trim().toLowerCase());
}

/** 从请求库条目的首个 HAR entry 取请求基线（空值安全）。 */
export function baselineFromEntry(entry: RequestLibraryEntry): CapturedBaseline {
  const request = entry.har?.log?.entries?.[0]?.request;
  const headers = (request?.headers ?? []).filter(
    (header) => header.name.trim() !== "" && !isSpecialHeader(header.name),
  );
  const postData = request?.postData;
  const binary = postData?.encoding === "base64" && typeof postData?.text === "string";
  return {
    method: request?.method ?? "GET",
    url: request?.url ?? "",
    headers,
    bodyText: binary ? null : (postData?.text ?? null),
    bodyBinaryBytes: binary ? atobByteLength(postData?.text ?? "") : null,
  };
}

/** base64 文本的解码字节数（非法输入返回 0）。 */
function atobByteLength(text: string): number {
  try {
    return atob(text).length;
  } catch {
    return 0;
  }
}

/** 请求头编辑行：original = 捕获行基线（名字 + 值），缺失 = 用户新增行。 */
export interface HeaderRowDraft {
  name: string;
  value: string;
  original?: { name: string; value: string };
}

/**
 * 打开抽屉时的行回填：基线捕获头 + 既有 override 合并成编辑行——
 *   - 被删除的捕获头（removedHeaders 命中）不生成行；
 *   - 捕获头被 override 覆盖（大小写不敏感）→ 行值取覆盖值、保留基线 original；
 *   - override 中不属于捕获头的新键 → 追加为新增行。
 * 顺序 = 捕获头原顺序 + 新增行顺序。
 */
export function headerRowsFromBaseline(
  baseline: CapturedBaseline,
  override: ReplayOverride | undefined,
): HeaderRowDraft[] {
  const overrideHeaders = override?.headers ?? {};
  const removed = new Set(
    (override?.removedHeaders ?? []).map((name) => name.trim().toLowerCase()),
  );
  const overriddenKeys = new Set<string>();
  const rows: HeaderRowDraft[] = [];
  for (const header of baseline.headers) {
    const lower = header.name.trim().toLowerCase();
    if (removed.has(lower)) continue;
    const found = Object.entries(overrideHeaders).find(
      ([name]) => name.trim().toLowerCase() === lower,
    );
    if (found) overriddenKeys.add(found[0].trim().toLowerCase());
    rows.push({
      name: found ? found[0] : header.name,
      value: found ? found[1] : header.value,
      original: { name: header.name, value: header.value },
    });
  }
  for (const [name, value] of Object.entries(overrideHeaders)) {
    if (overriddenKeys.has(name.trim().toLowerCase())) continue;
    rows.push({ name, value });
  }
  return rows;
}

/** 读取引用快照中某个请求头的捕获值（大小写不敏感；未捕获返回 null）。 */
export function capturedSpecialHeader(entry: RequestLibraryEntry, name: string): string | null {
  const headers = entry.har?.log?.entries?.[0]?.request?.headers ?? [];
  const found = headers.find((header) => header.name.trim().toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 编辑行 → override.headers / override.removedHeaders：
 *   - 捕获行名字或值被改动 → 旧名进 removedHeaders（若改名）、新名进 headers；
 *   - 值与捕获基线一致的捕获行视为未改动（不落 override）；
 *   - 新增行（无 original）直接进 headers；
 *   - 捕获头从行列表消失 → removedHeaders（大小写不敏感）。
 * 名字为空的行跳过。两个键都为空时返回空对象。
 */
export function overrideFromHeaderRows(
  rows: readonly HeaderRowDraft[],
  capturedHeaders: ReadonlyArray<{ name: string; value: string }>,
): { headers?: Record<string, string>; removedHeaders?: string[] } {
  const headers: Record<string, string> = {};
  const removed: string[] = [];
  const presentOriginalNames = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") continue;
    if (row.original) {
      presentOriginalNames.add(row.original.name.trim().toLowerCase());
      if (sameName(name, row.original.name)) {
        if (row.value !== row.original.value) headers[name] = row.value;
      } else {
        removed.push(row.original.name.trim());
        headers[name] = row.value;
      }
    } else {
      headers[name] = row.value;
    }
  }
  for (const header of capturedHeaders) {
    const name = header.name.trim();
    if (name === "" || presentOriginalNames.has(name.toLowerCase())) continue;
    if (!removed.some((existing) => sameName(existing, name))) removed.push(name);
  }
  const result: { headers?: Record<string, string>; removedHeaders?: string[] } = {};
  if (Object.keys(headers).length > 0) result.headers = headers;
  if (removed.length > 0) result.removedHeaders = removed;
  return result;
}

/** 编辑行 → 手动请求 headers（Record；全空行丢弃，全空返回 undefined）。 */
export function manualHeadersFromRows(
  rows: readonly HeaderRowDraft[],
): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") continue;
    record[name] = row.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

/** 校验请求头行（保存链路用）：有值无名 / 重复头名（大小写不敏感）报错。 */
export function validateHeaderRows(rows: readonly HeaderRowDraft[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "" && row.value.trim() === "") continue;
    if (name === "") return "请求头名称不能为空";
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) return `请求头名称重复：${name}`;
    seen.add(lowered);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 输入解析（timeout / retry / url 提示）
 * ------------------------------------------------------------------ */

/** 解析 timeoutMs 输入：空串 = 不限制；须为正整数。 */
export function parseTimeoutMs(raw: string): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  if (!/^\d+$/.test(trimmed)) return { error: "超时需为正整数（毫秒）" };
  const value = Number.parseInt(trimmed, 10);
  if (value <= 0) return { error: "超时需为正整数（毫秒）" };
  return { value };
}

/** 解析重试输入：全空 = 不重试；maxAttempts 与 backoffMs 需同时给出。 */
export function parseRetryInput(
  maxAttempts: string,
  backoffMs: string,
  multiplier: string,
): { retry?: ReplayRetry; error?: string } {
  const attempts = maxAttempts.trim();
  const backoff = backoffMs.trim();
  const mult = multiplier.trim();
  if (attempts === "" && backoff === "" && mult === "") return {};
  if (attempts === "" || backoff === "") {
    return { error: "重试需同时填写尝试次数与退避毫秒" };
  }
  if (!/^\d+$/.test(attempts) || Number.parseInt(attempts, 10) < 1) {
    return { error: "尝试次数需为 ≥1 的整数" };
  }
  if (!/^\d+$/.test(backoff)) {
    return { error: "退避需为 ≥0 的整数毫秒" };
  }
  const retry: ReplayRetry = {
    maxAttempts: Number.parseInt(attempts, 10),
    backoffMs: Number.parseInt(backoff, 10),
  };
  if (mult !== "") {
    const value = Number.parseFloat(mult);
    if (!Number.isFinite(value) || value <= 0) return { error: "退避乘数需为正数" };
    retry.multiplier = value;
  }
  return { retry };
}

/** URL 宽松格式提示（非阻断）：空串或完整 URL 或 / 开头路径合法。 */
export function urlHint(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return null;
  try {
    new URL(trimmed);
    return null;
  } catch {
    return "URL 格式可能不正确（需完整 URL 或以 / 开头的路径）";
  }
}

/* ------------------------------------------------------------------ *
 * refId 短码原语（对齐 flow-engine/src/ref-id.ts）
 * ------------------------------------------------------------------ */

/** 合法短码：恰好 5 位纯字母（大小写均可）。 */
export const REF_ID_PATTERN = /^[A-Za-z]{5}$/;

const REF_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 流程内已被占用的短码键集合：节点 id 与既有 refId 都不可被新短码命中。 */
export function takenRefKeys(nodes: readonly WorkflowNode[]): Set<string> {
  const taken = new Set<string>();
  for (const node of nodes) {
    taken.add(node.id);
    if (typeof node.refId === "string" && node.refId !== "") taken.add(node.refId);
  }
  return taken;
}

/**
 * 校验引用短码草稿：恰好 5 位纯字母、未被其它节点占用（takenKeys 含自身
 * 原值——与原值相等的草稿视作未修改，不算冲突）。空串 = 无短码（读取侧
 * 回退节点 id），合法。返回可读错误文案；合法返回 null。
 */
export function validateRefIdDraft(
  draft: string,
  currentRefId: string | undefined,
  takenKeys: ReadonlySet<string>,
): string | null {
  const value = draft.trim();
  if (value === "") return null;
  if (!REF_ID_PATTERN.test(value)) return "引用短码须为 5 位纯字母（A-Z / a-z）";
  if (value !== currentRefId && takenKeys.has(value)) {
    return `引用短码 ${value} 已被流程内其它节点占用`;
  }
  return null;
}

/** 短码长度（固定 5 位）。 */
const REF_ID_LENGTH = 5;

/** 生成一个不在 exclude 内的随机 5 位字母短码（冲突重摇）。 */
export function generateRefId(exclude: ReadonlySet<string>): string {
  let candidate = "";
  const bytes = new Uint32Array(REF_ID_LENGTH);
  do {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
      candidate = [...bytes].map((byte) => REF_ID_ALPHABET[byte % REF_ID_ALPHABET.length]).join("");
    } else {
      candidate = [...REF_ID_ALPHABET]
        .map(() => REF_ID_ALPHABET[Math.floor(Math.random() * REF_ID_ALPHABET.length)])
        .join("");
    }
  } while (exclude.has(candidate));
  return candidate;
}
