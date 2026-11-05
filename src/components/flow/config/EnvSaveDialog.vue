<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Io5Save } from "vue-icons-plus/io5";
import { useBackend } from "../../../api";
import type { EnvVariableSet } from "../../../api/types";
import { appStore, reportError } from "../../../stores/app";
import { useFlowEditorStore } from "../../../stores/flow-editor";
import CustomSelect from "../../CustomSelect.vue";

/**
 * 「添加到环境变量」弹窗（请求头行菜单入口）：把一个名值对写入所选环境
 * 变量集——目标集合下拉（激活集合置顶标注）、变量名 / 变量值可改（由调用
 * 方预填当前请求头的名 / 值）。写入走既有 `envSets.writeBack` 合并语义
 * （同名覆盖、已存在的 secret 键保持 secret 标记、空键被服务端丢弃）。
 * 成功后刷新编辑器的 env 键候选表（环境变量区块自身经 HttpApiChange 对账，
 * 此处不直呼其 store 的 refresh 以免覆盖未保存草稿）。
 */
const props = defineProps<{
  /** 预填变量名（请求头行菜单入口为该行名）。 */
  initialName: string;
  /** 预填变量值（请求头行菜单入口为该行当前值）。 */
  initialValue: string;
}>();

const emit = defineEmits<{ close: [] }>();

const backend = useBackend();

const sets = ref<EnvVariableSet[]>([]);
const setId = ref<string | null>(null);
const name = ref(props.initialName);
const value = ref(props.initialValue);
const loading = ref(true);
const saving = ref(false);

const nameError = computed(() =>
  name.value.trim() === "" ? "请输入变量名" : null,
);

/** 下拉选项：激活集合置顶并标注，其余按返回顺序。 */
const setOptions = computed(() =>
  sets.value.map((set) => ({ value: set.id, label: set.name })),
);
const activeSet = computed(() => sets.value.find((set) => set.id === setId.value) ?? null);
const displayValue = computed(
  () => (activeSet.value ? `${activeSet.value.name}（激活）` : undefined),
);

onMounted(async () => {
  const envSets = backend.envSets;
  if (!envSets) {
    loading.value = false;
    return;
  }
  try {
    const payload = await envSets.get();
    const sorted = [...payload.sets].sort((left, right) => {
      const leftActive = left.id === payload.activeSetId;
      const rightActive = right.id === payload.activeSetId;
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
    sets.value = sorted;
    setId.value = payload.activeSetId ?? sorted[0]?.id ?? null;
  } catch (error) {
    reportError(error, "加载环境变量失败");
  } finally {
    loading.value = false;
  }
});

async function save(): Promise<void> {
  const envSets = backend.envSets;
  const target = setId.value;
  const key = name.value.trim();
  if (!envSets || target === null || nameError.value !== null || saving.value) return;
  saving.value = true;
  try {
    await envSets.writeBack({ setId: target, writes: { [key]: value.value } });
    appStore.toast(`已写入环境变量集「${activeSet.value?.name ?? target}」`, "success");
    void useFlowEditorStore().loadActiveEnv();
    emit("close");
  } catch (error) {
    reportError(error, "写入环境变量失败");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="esd-mask" @keydown.esc="emit('close')">
      <div class="esd-dialog" role="dialog" aria-modal="true" aria-labelledby="esd-title">
        <header>
          <Io5Save :size="16" />
          <strong id="esd-title">添加到环境变量</strong>
        </header>
        <label class="esd-field">
          <span>目标环境集</span>
          <CustomSelect
            :model-value="setId"
            :options="setOptions"
            :display-value="displayValue"
            aria-label="目标环境集"
            :disabled="loading || saving || sets.length === 0"
            @update:model-value="setId = $event"
          />
          <span v-if="!loading && sets.length === 0" class="esd-hint">
            暂无环境变量集，请先在「环境变量」区块创建
          </span>
        </label>
        <label class="esd-field">
          <span>变量名</span>
          <input
            v-model="name"
            class="input mono"
            placeholder="变量名（同名覆盖）"
            spellcheck="false"
            :disabled="saving"
            @keyup.enter="save"
          />
          <span v-if="nameError" class="esd-error">{{ nameError }}</span>
        </label>
        <label class="esd-field">
          <span>变量值</span>
          <textarea
            v-model="value"
            class="input mono"
            rows="3"
            placeholder="变量值"
            spellcheck="false"
            :disabled="saving"
          />
        </label>
        <footer>
          <button class="btn" :disabled="saving" @click="emit('close')">取消</button>
          <button
            class="btn primary"
            :disabled="Boolean(nameError) || saving || setId === null"
            @click="save"
          >
            {{ saving ? "写入中…" : "写入" }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.esd-mask {
  position: fixed;
  inset: 0;
  z-index: 100007;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, #000 45%, transparent);
}

.esd-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: min(380px, calc(100vw - 48px));
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-window);
}

.esd-dialog header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text);
}

.esd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.esd-field > span:first-child {
  font-size: 11px;
  color: var(--text-faint);
}

.esd-dialog textarea {
  resize: vertical;
}

.esd-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.esd-error {
  font-size: 11px;
  color: var(--danger);
}

.esd-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
