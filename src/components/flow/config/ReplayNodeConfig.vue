<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Io5ChevronDown, Io5Close, Io5Pin, Io5Search } from "vue-icons-plus/io5";
import { useBackend } from "../../../api";
import type {
  AssetMetadata,
  RequestLibraryEntry,
  WorkflowNode,
  WorkflowNodeConfig,
} from "../../../api/types";
import { reportError } from "../../../stores/app";
import { confirmDialog } from "../../../stores/dialog";
import CustomSelect from "../../CustomSelect.vue";
import AssetTreePicker from "../../AssetTreePicker.vue";
import ExpressionInput from "../../expression-input/ExpressionInput.vue";
import type { SuggestNodeOption } from "../../expression-input/expression-suggest";
import { buildDropInsertPlan } from "../../expression-input/expression-suggest";
import { hasIoPathPayload, readIoPathPayload } from "../template-dnd";
import { formatBytes, formatDateTime } from "../../../utils/format";
import { REPLAY_METHODS } from "../../../utils/replay";
import ScriptEditor from "./ScriptEditor.vue";
import HeaderRows from "./HeaderRows.vue";
import RequestPicker from "./RequestPicker.vue";
import FidelityModeControl from "./FidelityModeControl.vue";
import CookieModeControl from "./CookieModeControl.vue";
import RetryFields from "./RetryFields.vue";
import RefIdField from "./RefIdField.vue";
import {
  baselineFromEntry,
  buildReplayNodeConfig,
  capturedSpecialHeader,
  headerRowsFromBaseline,
  manualHeadersFromRows,
  overrideFromHeaderRows,
  parseTimeoutMs,
  readReplayConfig,
  urlHint,
  validateHeaderRows,
  type CapturedBaseline,
  type HeaderFidelitySource,
  type HeaderRowDraft,
  type ReplayConfigDraft,
  type ReplayOverride,
  type ReplayRetry,
} from "./node-config";

/**
 * 请求重放节点（httpReplay）配置面（计划 Task 14）：引用短码 + ① 请求引用
 * （请求库挑选 / 手工请求）→ ② 请求内容（method / url，引用态仅覆盖改动
 * 字段）→ ③ 请求头（行编辑 + 删除即移除，落 removedHeaders）→ ④ 请求体
 * （无 / 文本 / 请求库 body / 工作区资产；后两者编辑期解析为文本落库）→
 * ⑤ 请求标识与 Cookie（headerFidelity 三头「捕获值 / 自定义」二态 + cookieMode）
 * → ⑥ 高级（超时 / 失败策略 / 重试退避 / 固定输出清除）+ 前置 / 后置脚本
 * （Task 18 的 ScriptEditor 落位）。
 *
 * 交互：全部编辑即改即生效（上抛 update:config 重建配置，空白值省略），由
 * 窗口统一保存；字段级校验就地提示，非法值不落库。组件按节点 id 由父级
 * 重新挂载，草稿态不跨节点保留。
 */
const props = defineProps<{
  node: WorkflowNode;
  /** 流程内已占用短码键集合（节点 id + 既有短码，含自身）。 */
  takenKeys: ReadonlySet<string>;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
  /** 上游可引用节点候选（模板引用键 refId ?? id + 展示名；透传表达式输入）。 */
  availableNodeIds?: ReadonlyArray<SuggestNodeOption>;
  /** 可引用变量名清单（流程级普通变量；透传表达式输入）。 */
  variableNames?: ReadonlyArray<string>;
  /** 激活环境集合 + 全局的键名清单（透传表达式输入）。 */
  envKeys?: ReadonlyArray<string>;
}>();

const emit = defineEmits<{
  "update:config": [config: WorkflowNodeConfig];
  "update:refId": [refId: string | null];
}>();

const backend = useBackend();

/* ------------------------------ 表单草稿状态 ------------------------------ */

const CUSTOM_METHOD = "__custom";
const initial = readReplayConfig(props.node.config);
/** 打开抽屉时节点引用的条目（首次基线加载时据此合并既有 override）。 */
const mountedRequestId = initial.requestId;

const requestId = ref<string | null>(initial.requestId ?? null);
const methodChoice = ref<string>("GET");
const customMethod = ref("");
const url = ref("");
const headerRows = ref<HeaderRowDraft[]>([{ name: "", value: "" }]);
type BodyMode = "none" | "text" | "library" | "asset";
const bodyMode = ref<BodyMode>("none");
const body = ref("");
/** body 来源说明（请求库 / 资产加载后展示，不入库）。 */
const bodySourceNote = ref<string | null>(null);
/** 引用快照的 body 为 base64 二进制（不能作文本基线）。 */
const capturedBinaryBody = ref(false);
const timeoutInput = ref(initial.timeoutMs === undefined ? "" : String(initial.timeoutMs));
const failPolicy = ref<"stop" | "continue">(initial.failPolicy);
const retry = ref<ReplayRetry | null>(initial.retry ?? null);
const preProcess = ref(initial.preProcess ?? "");
const postProcess = ref(initial.postProcess ?? "");
const pinnedOutput = ref(initial.pinnedOutput ?? null);

interface FidelityDraft {
  source: HeaderFidelitySource;
  value: string;
}
const fidelity = ref<Record<"origin" | "referer" | "userAgent", FidelityDraft>>({
  origin: { source: "fromCapture", value: "" },
  referer: { source: "fromCapture", value: "" },
  userAgent: { source: "fromCapture", value: "" },
});
const cookieMode = ref<"snapshot" | "custom">("snapshot");
const cookieValue = ref("");

const method = computed(() =>
  methodChoice.value === CUSTOM_METHOD
    ? customMethod.value.trim().toUpperCase()
    : methodChoice.value,
);
const methodDisplay = computed(() =>
  methodChoice.value === CUSTOM_METHOD ? customMethod.value || "自定义…" : undefined,
);
const methodOptions = REPLAY_METHODS.map((value) => ({ value, label: value }));

const headerError = computed(() => validateHeaderRows(headerRows.value));
const timeoutResult = computed(() => parseTimeoutMs(timeoutInput.value));
const urlWarning = computed(() => urlHint(url.value));

/* --------------------- 模板字段拖放承接（IO 字段 chip） --------------------- */

/** 表达式输入组件实例（URL 字段；拖放插入出口） */
type ExpressionInputInstance = InstanceType<typeof ExpressionInput>;
const urlInput = ref<ExpressionInputInstance | null>(null);
const bodyInput = ref<HTMLTextAreaElement | null>(null);

/** dragover 接管判定：仅接管携带 IO 字段载荷的拖拽（协议见 template-dnd.ts；
 * 其余拖拽——如原生文本拖入 textarea——保持浏览器默认行为）。 */
function ioDragOver(event: DragEvent): void {
  if (props.disabled || !event.dataTransfer) return;
  if (!hasIoPathPayload(event.dataTransfer.types)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

/** 读取 IO 字段拖放载荷（drop 阶段；命中时阻止浏览器默认放入）。 */
function ioDropSnippet(event: DragEvent): string | null {
  const snippet = event.dataTransfer ? readIoPathPayload(event.dataTransfer) : null;
  if (snippet !== null) event.preventDefault();
  return snippet;
}

/** URL drop：经组件 ref 插入完整模板引用（url 由 v-model 回流，persist 走 watch）。 */
async function onUrlDrop(event: DragEvent): Promise<void> {
  const snippet = ioDropSnippet(event);
  if (snippet === null) return;
  await urlInput.value?.insertSnippet(snippet);
}

/** body drop：多行字段不接表达式输入（15C 克制裁剪），原生 textarea 光标处
 * 插入引用（写入计划与拖放落点单一口径，见 buildDropInsertPlan）。 */
function onBodyDrop(event: DragEvent): void {
  const snippet = ioDropSnippet(event);
  if (snippet === null) return;
  const caret = bodyInput.value?.selectionStart ?? body.value.length;
  const plan = buildDropInsertPlan(body.value, caret, snippet);
  body.value = plan.text;
  void nextTick(() => {
    bodyInput.value?.focus();
    bodyInput.value?.setSelectionRange(plan.caret, plan.caret);
  });
}

/* ------------------------------ 引用快照基线 ------------------------------ */

const referenced = ref<RequestLibraryEntry | null>(null);
const refMissing = ref(false);
let refLoadGeneration = 0;
/**
 * 水合期旗标：抽屉打开 / 切换节点期间的基线回填不落库（emit），避免
 * 「打开即标脏」；首个用户编辑起才恢复上抛。结束时机推迟到 nextTick——
 * 让基线回填触发的表单 watcher 先在本轮 flush 中跳过 persist。
 */
let hydrating = true;

function endHydration(): void {
  if (!hydrating) return;
  void nextTick(() => {
    hydrating = false;
  });
}

const baseline = computed<CapturedBaseline | null>(() =>
  referenced.value ? baselineFromEntry(referenced.value) : null,
);

const capturedOrigin = computed(() =>
  referenced.value ? capturedSpecialHeader(referenced.value, "origin") : null,
);
const capturedReferer = computed(() =>
  referenced.value ? capturedSpecialHeader(referenced.value, "referer") : null,
);
const capturedUserAgent = computed(() =>
  referenced.value ? capturedSpecialHeader(referenced.value, "user-agent") : null,
);
const capturedCookie = computed(() =>
  referenced.value ? capturedSpecialHeader(referenced.value, "cookie") : null,
);

/** 被删除的捕获头（行列表里消失的基线头），展示为可还原 chip。 */
const removedCapturedHeaders = computed(() => {
  if (requestId.value === null || baseline.value === null) return [];
  const present = new Set(
    headerRows.value.map((row) => (row.original ?? row).name.trim().toLowerCase()),
  );
  return baseline.value.headers
    .filter((header) => !present.has(header.name.trim().toLowerCase()))
    .map((header) => header.name);
});

function restoreRemovedHeader(name: string): void {
  const header = baseline.value?.headers.find(
    (item) => item.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!header || props.disabled) return;
  headerRows.value = [
    ...headerRows.value.filter((row) => row.name.trim() !== "" || row.value !== ""),
    {
      name: header.name,
      value: header.value,
      original: { name: header.name, value: header.value },
    },
  ];
}

/** 按引用快照基线重置请求内容（mergeOverride = 首次加载时合并既有覆盖项）。 */
function applyBaseline(mergeOverride: boolean): void {
  const base = baseline.value;
  if (!base) return;
  const override = mergeOverride ? initial.override : undefined;
  methodChoice.value = (REPLAY_METHODS as readonly string[]).includes(
    override?.method ?? base.method,
  )
    ? (override?.method ?? base.method)
    : CUSTOM_METHOD;
  if (methodChoice.value === CUSTOM_METHOD) customMethod.value = override?.method ?? base.method;
  url.value = override?.url ?? base.url;
  headerRows.value = headerRowsFromBaseline(base, override);
  capturedBinaryBody.value = override?.body === undefined && base.bodyBinaryBytes !== null;
  if (override?.body !== undefined) {
    body.value = override.body;
    bodyMode.value = "text";
  } else if (base.bodyText !== null && base.bodyText !== "") {
    body.value = base.bodyText;
    bodyMode.value = "text";
  } else if (base.bodyBinaryBytes !== null) {
    body.value = "";
    bodyMode.value = "text";
    bodySourceNote.value = `快照 body 为二进制（${formatBytes(base.bodyBinaryBytes)}），重放未编辑 body 时按快照发送`;
  } else {
    body.value = "";
    bodyMode.value = "none";
  }
}

watch(
  requestId,
  (id) => {
    if (id === null) {
      refLoadGeneration += 1;
      referenced.value = null;
      refMissing.value = false;
      capturedBinaryBody.value = false;
      // 移除引用：当前有效请求（含覆盖值）转为独立的手动请求基线。
      headerRows.value = headerRows.value.map((row) => ({ name: row.name, value: row.value }));
      void persist();
      return;
    }
    const requestLibrary = backend.requestLibrary;
    if (!requestLibrary) return;
    const generation = ++refLoadGeneration;
    void requestLibrary
      .get(id)
      .then((entry) => {
        if (generation !== refLoadGeneration || requestId.value !== id) return;
        referenced.value = entry;
        refMissing.value = false;
        // 与归档语义一致：重新选中打开时的原引用 = 合并既有覆盖项；
        // 更换为其它条目 = 新快照即新基线，丢弃旧覆盖。
        applyBaseline(id === mountedRequestId);
        endHydration();
        void persist();
      })
      .catch((error) => {
        if (generation !== refLoadGeneration || requestId.value !== id) return;
        referenced.value = null;
        refMissing.value = true;
        reportError(error, "加载引用请求失败");
        endHydration();
      });
  },
  { immediate: true },
);

/* ------------------------------ 表单初始化 ------------------------------ */

function rowsFromRecord(record: Record<string, string> | undefined): HeaderRowDraft[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

{
  if (initial.requestId === undefined) {
    const manual = initial.manualRequest;
    const methodValue = manual?.method ?? "GET";
    if ((REPLAY_METHODS as readonly string[]).includes(methodValue)) {
      methodChoice.value = methodValue;
    } else {
      methodChoice.value = CUSTOM_METHOD;
      customMethod.value = methodValue;
    }
    url.value = manual?.url ?? "";
    headerRows.value = rowsFromRecord(manual?.headers);
    body.value = manual?.body ?? "";
    bodyMode.value = body.value !== "" ? "text" : "none";
    endHydration();
  }
  for (const key of ["origin", "referer", "userAgent"] as const) {
    const item = initial.headerFidelity?.[key];
    if (item) fidelity.value[key] = { source: item.source, value: item.value ?? "" };
  }
  if (initial.cookieCustom !== undefined) {
    cookieMode.value = "custom";
    cookieValue.value = initial.cookieCustom;
  }
}

/* ------------------------------ 请求库挑选 ------------------------------ */

/** 弹窗用途：null 关闭；reference = 节点请求引用；body = body 来源加载。 */
const pickerFor = ref<"reference" | "body" | null>(null);

async function onPicked(entry: RequestLibraryEntry): Promise<void> {
  const purpose = pickerFor.value;
  pickerFor.value = null;
  if (purpose === "reference") {
    requestId.value = entry.id;
    return;
  }
  if (purpose === "body") {
    const requestLibrary = backend.requestLibrary;
    if (!requestLibrary) return;
    try {
      const loaded = await requestLibrary.getBody(entry.id);
      body.value = new TextDecoder().decode(loaded.bytes);
      bodyMode.value = "library";
      bodySourceNote.value = `已引用请求库 body：${entry.name}（${formatBytes(loaded.decodedSize)}）`;
    } catch (error) {
      reportError(error, "加载请求库 body 失败");
    }
  }
}

/* ------------------------------ 工作区资产 body ------------------------------ */

const assets = ref<AssetMetadata[]>([]);
const assetsError = ref<string | null>(null);
let assetsLoaded = false;
const selectedAsset = ref<string | null>(null);

async function ensureAssets(): Promise<void> {
  if (assetsLoaded) return;
  assetsLoaded = true;
  try {
    assets.value = await backend.listAssets();
  } catch (error) {
    assetsError.value = error instanceof Error ? error.message : String(error);
  }
}

async function onAssetSelected(id: string | null): Promise<void> {
  if (id === null || !backend.readAsset) return;
  try {
    const bytes = await backend.readAsset(id);
    body.value = new TextDecoder().decode(bytes);
    bodyMode.value = "asset";
    bodySourceNote.value = `已引用资产：${id}（${formatBytes(bytes.byteLength)}）`;
  } catch (error) {
    reportError(error, "读取资产失败");
  }
}

function selectBodyMode(mode: BodyMode): void {
  if (props.disabled) return;
  bodyMode.value = mode;
  if (mode === "none") {
    body.value = "";
    bodySourceNote.value = null;
  }
  if (mode === "asset") void ensureAssets();
}

/* ------------------------------ 落库 ------------------------------ */

function persist(): void {
  if (hydrating || props.disabled) return;
  const draft: ReplayConfigDraft = {
    failPolicy: failPolicy.value,
    preProcess: preProcess.value,
    postProcess: postProcess.value,
    timeoutMs: timeoutResult.value.value,
    retry: retry.value ?? undefined,
    pinnedOutput: pinnedOutput.value ?? undefined,
  };
  if (requestId.value !== null) {
    draft.requestId = requestId.value;
    const override: ReplayOverride = {};
    const base = baseline.value;
    const capturedHeaders = base?.headers ?? [];
    const { headers, removedHeaders } = overrideFromHeaderRows(headerRows.value, capturedHeaders);
    if (headers) override.headers = headers;
    if (removedHeaders) override.removedHeaders = removedHeaders;
    const methodValue = method.value;
    if (methodValue !== "" && methodValue.toUpperCase() !== (base?.method ?? "").toUpperCase()) {
      override.method = methodValue;
    }
    const urlValue = url.value.trim();
    if (urlValue !== "" && urlValue !== (base?.url ?? "")) override.url = urlValue;
    const capturedBody = base?.bodyText ?? null;
    if (bodyMode.value === "none") {
      if ((capturedBody !== null && capturedBody !== "") || capturedBinaryBody.value) {
        override.body = "";
      }
    } else if (body.value !== "" && body.value !== capturedBody) {
      override.body = body.value;
    }
    if (Object.keys(override).length > 0) draft.override = override;
  } else {
    draft.manualRequest = {
      method: method.value === "" ? "GET" : method.value,
      url: url.value.trim(),
      headers: manualHeadersFromRows(headerRows.value),
      body: bodyMode.value === "none" ? undefined : body.value !== "" ? body.value : undefined,
    };
  }
  draft.headerFidelity = {
    origin: { ...fidelity.value.origin },
    referer: { ...fidelity.value.referer },
    userAgent: { ...fidelity.value.userAgent },
  };
  if (cookieMode.value === "custom") draft.cookieCustom = cookieValue.value;
  emit("update:config", buildReplayNodeConfig(draft));
}

watch(
  [
    methodChoice,
    customMethod,
    url,
    bodyMode,
    body,
    timeoutInput,
    failPolicy,
    preProcess,
    postProcess,
  ],
  () => {
    if (props.disabled) return;
    void persist();
  },
);
watch(headerRows, () => void persist(), { deep: true });

function onFidelity(key: "origin" | "referer" | "userAgent", patch: Partial<FidelityDraft>): void {
  if (props.disabled) return;
  fidelity.value[key] = { ...fidelity.value[key], ...patch };
  void persist();
}

function onCookieMode(mode: "snapshot" | "custom"): void {
  if (props.disabled) return;
  cookieMode.value = mode;
  void persist();
}

function onCookieValue(value: string): void {
  if (props.disabled) return;
  cookieValue.value = value;
  void persist();
}

function onRetry(next: ReplayRetry | null): void {
  if (props.disabled) return;
  retry.value = next;
  void persist();
}

async function clearPinnedOutput(): Promise<void> {
  if (props.disabled || !pinnedOutput.value) return;
  const ok = await confirmDialog({
    title: "清除固定输出",
    message: "清除后该节点将恢复正常执行。确定清除固定输出吗？",
    confirmText: "清除",
    danger: true,
  });
  if (!ok) return;
  pinnedOutput.value = null;
  void persist();
}

const pinnedValuePreview = computed(() => {
  const value = pinnedOutput.value?.value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
});

/* ------------------------------ 脚本折叠区 ------------------------------ */

const scriptSections = ref<{ pre: boolean; post: boolean }>({ pre: false, post: false });
watch(
  [preProcess, postProcess],
  () => {
    if (preProcess.value.trim() !== "" && !scriptSections.value.pre)
      scriptSections.value.pre = true;
    if (postProcess.value.trim() !== "" && !scriptSections.value.post) {
      scriptSections.value.post = true;
    }
  },
  { immediate: true },
);

function toggleScript(section: "pre" | "post"): void {
  scriptSections.value[section] = !scriptSections.value[section];
}
</script>

<template>
  <div class="rnc-root">
    <RequestPicker v-if="pickerFor !== null" @pick="onPicked" @close="pickerFor = null" />

    <!-- 引用短码 -->
    <div class="rnc-section">
      <div class="rnc-field">
        <span class="rnc-label">引用短码</span>
        <RefIdField
          :ref-id="node.refId ?? null"
          :taken-keys="takenKeys"
          :disabled="disabled"
          @update:ref-id="emit('update:refId', $event)"
        />
      </div>
    </div>

    <!-- ① 请求引用 -->
    <div class="rnc-section">
      <div class="rnc-title">① 请求引用</div>
      <div v-if="requestId !== null" class="rnc-ref-card">
        <template v-if="referenced">
          <span class="rnc-ref-name" :title="referenced.name">{{ referenced.name }}</span>
          <span class="mono text-secondary rnc-ref-url" :title="baseline?.url ?? ''">{{
            baseline?.url
          }}</span>
        </template>
        <span v-else-if="refMissing" class="rnc-ref-missing">
          引用请求不存在或已删除（{{ requestId }}）
        </span>
        <span v-else class="text-faint">正在加载引用…</span>
        <span class="rnc-spacer" />
        <button class="btn compact" :disabled="disabled" @click="pickerFor = 'reference'">
          <Io5Search :size="12" /> 更换
        </button>
        <button
          class="btn icon"
          title="移除引用，转为手动请求基线"
          :disabled="disabled"
          @click="requestId = null"
        >
          <Io5Close :size="13" />
        </button>
      </div>
      <template v-else>
        <button
          class="btn compact rnc-pick-btn"
          :disabled="disabled"
          @click="pickerFor = 'reference'"
        >
          <Io5Search :size="12" /> 从请求库选择请求
        </button>
        <div class="rnc-hint text-faint">未引用时下方内容保存为独立请求基线</div>
      </template>
    </div>

    <!-- ② 请求内容 -->
    <div class="rnc-section">
      <div class="rnc-title">
        ② 请求内容
        <span class="rnc-title-hint text-faint">{{
          requestId !== null ? "仅覆盖改动字段" : "手动请求基线"
        }}</span>
      </div>
      <div class="rnc-field">
        <span class="rnc-label">方法</span>
        <CustomSelect
          class="rnc-method"
          :model-value="methodChoice"
          :options="methodOptions"
          :display-value="methodDisplay"
          aria-label="请求方法"
          :disabled="disabled"
          @update:model-value="methodChoice = $event"
        >
          <template #footer="{ close }">
            <input
              v-model="customMethod"
              class="input mono rnc-method-custom"
              placeholder="自定义 Method"
              aria-label="自定义请求方法"
              spellcheck="false"
              :disabled="disabled"
              @focus="methodChoice = CUSTOM_METHOD"
              @input="methodChoice = CUSTOM_METHOD"
              @keydown.enter.prevent="close(true)"
            />
          </template>
        </CustomSelect>
      </div>
      <div class="rnc-field">
        <span class="rnc-label">URL</span>
        <!-- inert 包裹层：置灰 + IO 字段 chip 拖放承接（dragover 按 MIME 标记接管，
             drop 经组件 ref 插入引用） -->
        <div
          class="rnc-url-host"
          :inert="disabled || undefined"
          @dragover="ioDragOver"
          @drop="onUrlDrop"
        >
          <ExpressionInput
            ref="urlInput"
            v-model="url"
            placeholder="https://"
            :available-node-ids="availableNodeIds"
            :variable-names="variableNames"
            :env-keys="envKeys"
          />
        </div>
        <div v-if="urlWarning" class="rnc-warning">{{ urlWarning }}</div>
      </div>
    </div>

    <!-- ③ 请求头 -->
    <div class="rnc-section">
      <div class="rnc-title">
        ③ 请求头
        <span class="rnc-title-hint text-faint">{{
          requestId !== null ? "改动落覆盖项，删除捕获头落移除列表" : "作为请求基线请求头"
        }}</span>
      </div>
      <HeaderRows
        v-model="headerRows"
        :disabled="disabled"
        :available-node-ids="availableNodeIds"
        :variable-names="variableNames"
        :env-keys="envKeys"
      />
      <div v-if="headerError" class="rnc-warning">{{ headerError }}</div>
      <div v-if="removedCapturedHeaders.length > 0" class="rnc-removed">
        <span class="text-faint">已删除：</span>
        <button
          v-for="name in removedCapturedHeaders"
          :key="name"
          class="rnc-removed-chip mono"
          :title="`点击还原请求头 ${name}`"
          :disabled="disabled"
          @click="restoreRemovedHeader(name)"
        >
          {{ name }} ×
        </button>
      </div>
    </div>

    <!-- ④ 请求体 -->
    <div class="rnc-section">
      <div class="rnc-title">
        ④ 请求体
        <span v-if="bodySourceNote" class="rnc-title-hint">{{ bodySourceNote }}</span>
      </div>
      <div class="rnc-tabs" role="tablist" aria-label="请求体来源">
        <button
          v-for="mode in ['none', 'text', 'library', 'asset'] as const"
          :key="mode"
          class="rnc-tab"
          :class="{ active: bodyMode === mode }"
          role="tab"
          :aria-selected="bodyMode === mode"
          :disabled="disabled"
          @click="selectBodyMode(mode)"
        >
          {{ { none: "无", text: "文本", library: "请求库", asset: "资产" }[mode] }}
        </button>
      </div>
      <div v-if="bodyMode === 'none'" class="rnc-hint text-faint">无 Body</div>
      <template v-else>
        <div v-if="bodyMode === 'library'" class="rnc-body-source">
          <button class="btn compact" :disabled="disabled" @click="pickerFor = 'body'">
            <Io5Search :size="12" /> 从请求库引用 body
          </button>
        </div>
        <div v-else-if="bodyMode === 'asset'" class="rnc-body-source">
          <div v-if="assetsError" class="rnc-warning">资源加载失败：{{ assetsError }}</div>
          <AssetTreePicker
            v-else
            v-model:selected="selectedAsset"
            :assets="assets"
            class="rnc-asset-picker"
            @update:selected="onAssetSelected"
          />
        </div>
        <textarea
          ref="bodyInput"
          v-model="body"
          class="input mono rnc-body-text"
          rows="4"
          placeholder="请求体原文（支持模板）"
          spellcheck="false"
          :disabled="disabled"
          aria-label="请求体内容"
          @dragover="ioDragOver"
          @drop="onBodyDrop"
        />
      </template>
    </div>

    <!-- ⑤ 请求标识与 Cookie -->
    <div class="rnc-section">
      <div class="rnc-title">⑤ 请求标识与 Cookie</div>
      <FidelityModeControl
        label="Origin"
        :source="fidelity.origin.source"
        :value="fidelity.origin.value"
        :captured-value="capturedOrigin"
        :disabled="disabled"
        @update:source="onFidelity('origin', { source: $event })"
        @update:value="onFidelity('origin', { value: $event })"
      />
      <FidelityModeControl
        label="Referer"
        :source="fidelity.referer.source"
        :value="fidelity.referer.value"
        :captured-value="capturedReferer"
        :disabled="disabled"
        @update:source="onFidelity('referer', { source: $event })"
        @update:value="onFidelity('referer', { value: $event })"
      />
      <FidelityModeControl
        label="User-Agent"
        :source="fidelity.userAgent.source"
        :value="fidelity.userAgent.value"
        :captured-value="capturedUserAgent"
        :disabled="disabled"
        @update:source="onFidelity('userAgent', { source: $event })"
        @update:value="onFidelity('userAgent', { value: $event })"
      />
      <CookieModeControl
        :mode="cookieMode"
        :value="cookieValue"
        :captured-value="capturedCookie"
        :disabled="disabled"
        @update:mode="onCookieMode"
        @update:value="onCookieValue"
      />
      <div class="rnc-hint text-faint">
        {{
          requestId !== null ? "「捕获值」回放引用快照捕获的值" : "未引用快照时「捕获值」无注入值"
        }}
      </div>
    </div>

    <!-- ⑥ 高级 -->
    <div class="rnc-section">
      <div class="rnc-title">⑥ 高级</div>
      <div class="rnc-field">
        <span class="rnc-label">超时（毫秒）</span>
        <input
          v-model="timeoutInput"
          class="input mono"
          inputmode="numeric"
          placeholder="留空不限制（缺省 30000）"
          spellcheck="false"
          :disabled="disabled"
          aria-label="重放超时毫秒"
        />
        <div v-if="timeoutResult.error" class="rnc-warning">{{ timeoutResult.error }}</div>
      </div>
      <div class="rnc-field">
        <span class="rnc-label">失败策略</span>
        <span class="rnc-radio-row" role="radiogroup" aria-label="失败策略">
          <label class="rnc-radio">
            <input v-model="failPolicy" type="radio" value="stop" :disabled="disabled" />
            失败即停
          </label>
          <label class="rnc-radio">
            <input v-model="failPolicy" type="radio" value="continue" :disabled="disabled" />
            失败继续
          </label>
        </span>
      </div>
      <RetryFields :retry="retry" :disabled="disabled" @update:retry="onRetry" />
      <div v-if="pinnedOutput" class="rnc-pinned">
        <div class="rnc-pinned-head">
          <Io5Pin :size="12" />
          <span
            >已固定输出（{{ formatDateTime(pinnedOutput.pinnedAt) }} · 运行
            {{ pinnedOutput.sourceRunId }}）</span
          >
          <span class="rnc-spacer" />
          <button class="btn compact danger" :disabled="disabled" @click="clearPinnedOutput">
            清除固定
          </button>
        </div>
        <pre class="rnc-pinned-value mono" :title="pinnedValuePreview">{{
          pinnedValuePreview
        }}</pre>
      </div>
    </div>

    <!-- 前置 / 后置脚本 -->
    <div class="rnc-section">
      <button
        v-for="side in ['pre', 'post'] as const"
        :key="side"
        class="rnc-script-toggle"
        :aria-expanded="scriptSections[side]"
        @click="toggleScript(side)"
      >
        <Io5ChevronDown
          class="rnc-script-caret"
          :class="{ open: scriptSections[side] }"
          :size="12"
        />
        {{ side === "pre" ? "前置脚本" : "后置脚本" }}
        <span
          v-if="(side === 'pre' ? preProcess : postProcess).trim() !== ''"
          class="rnc-script-dot"
          title="已配置脚本"
        />
      </button>
      <template v-for="side in ['pre', 'post'] as const" :key="side">
        <div v-if="scriptSections[side]" class="rnc-script-body">
          <ScriptEditor
            :side="side"
            :model-value="side === 'pre' ? preProcess : postProcess"
            :disabled="disabled"
            editor-height="12em"
            @update:model-value="side === 'pre' ? (preProcess = $event) : (postProcess = $event)"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rnc-root {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.rnc-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.rnc-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  min-width: 0;
}

.rnc-title-hint {
  font-size: 10px;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rnc-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.rnc-label {
  font-size: 11px;
  color: var(--text-faint);
}

.rnc-hint {
  font-size: 11px;
}

.rnc-warning {
  font-size: 11px;
  color: var(--warning);
}

.rnc-spacer {
  flex: 1;
}

/* 引用卡片 */
.rnc-ref-card {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}

.rnc-ref-name {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 12px;
}

.rnc-ref-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}

.rnc-ref-missing {
  flex: 1;
  min-width: 0;
  color: var(--danger);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.rnc-pick-btn {
  align-self: flex-start;
}

/* 方法行 */
.rnc-method {
  align-self: flex-start;
}

/* URL 表达式输入：与既有 .input 同框感（描边盒），置灰由 inert 包裹层降透明 */
.rnc-url-host {
  min-width: 0;
}

.rnc-url-host:inert {
  opacity: 0.5;
}

.rnc-method :deep(.select-trigger) {
  min-height: 0;
  padding: 3px 8px;
  font-size: 11px;
}

.rnc-method-custom {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 4px 7px;
  font-size: 11px;
}

/* 已删除捕获头 chips */
.rnc-removed {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 11px;
}

.rnc-removed-chip {
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 16px;
  cursor: pointer;
}
.rnc-removed-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* body tabs */
.rnc-tabs {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  align-self: flex-start;
}

.rnc-tab {
  padding: 1px 8px;
  border: none;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
}
.rnc-tab + .rnc-tab {
  border-left: 1px solid var(--border);
}
.rnc-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
}
.rnc-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rnc-body-source {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.rnc-asset-picker {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.rnc-body-text {
  width: 100%;
  min-height: 0;
  padding: 4px 6px;
  font-size: 11px;
  resize: vertical;
}

/* 失败策略 */
.rnc-radio-row {
  display: flex;
  gap: var(--space-3);
}

.rnc-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}
.rnc-radio input {
  accent-color: var(--accent);
}

/* 固定输出 */
.rnc-pinned {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}

.rnc-pinned-head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--warning);
  min-width: 0;
}

.rnc-pinned-value {
  margin: 0;
  max-height: 8em;
  overflow: auto;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
}

/* 脚本折叠区 */
.rnc-script-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.rnc-script-toggle:hover {
  color: var(--text);
}

.rnc-script-caret {
  transition: transform 0.12s;
}
.rnc-script-caret.open {
  transform: rotate(0deg);
}
.rnc-script-caret:not(.open) {
  transform: rotate(-90deg);
}

.rnc-script-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.rnc-script-body {
  min-width: 0;
}
</style>
