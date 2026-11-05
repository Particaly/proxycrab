<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { Io5Add, Io5Close, Io5Copy, Io5Save } from "vue-icons-plus/io5";
import { HTTP_API_CHANGE_EVENT } from "../../stores/http-api-sync";
import {
  ENV_SECRET_MASK,
  VAR_REFERENCE_HINT,
  onEnvSetsHttpApiChange,
  useEnvSetsStore,
} from "../../stores/env-sets";

/**
 * 环境变量主区视图（原浮窗 ev-main 区块）：集合名 / 激活切换工具栏 +
 * 普通 / secret 两张 kv 编辑表。`env_sets` 资源变更经 HTTP 变更广播对账。
 */
const {
  selection,
  currentSet,
  draftName,
  draftValues,
  draftSecretValues,
  isActive,
  dirty,
  saving,
  externalChanged,
  toggleActive,
  copySet,
  save,
  addRow,
  removeRow,
  refresh,
} = useEnvSetsStore();

onMounted(() => {
  void refresh();
  window.addEventListener(HTTP_API_CHANGE_EVENT, onEnvSetsHttpApiChange);
});

onBeforeUnmount(() => {
  window.removeEventListener(HTTP_API_CHANGE_EVENT, onEnvSetsHttpApiChange);
});
</script>

<template>
  <div class="ev-view">
    <template v-if="selection.kind === 'set' && currentSet">
      <div class="ev-toolbar">
        <input v-model="draftName" class="input ev-name" aria-label="集合名称" maxlength="128" />
        <span v-if="isActive" class="ev-active-label">激活中</span>
        <span v-if="dirty" class="ev-dirty">未保存</span>
        <span class="ev-spacer" />
        <button class="btn" :disabled="saving" @click="toggleActive">
          {{ isActive ? "取消激活" : "设为激活" }}
        </button>
        <button class="btn icon" title="复制集合" @click="copySet">
          <Io5Copy :size="14" />
        </button>
        <button class="btn primary" :disabled="saving || !dirty" @click="save">
          <Io5Save :size="14" /> 保存
        </button>
      </div>
    </template>
    <template v-else>
      <div class="ev-toolbar">
        <span class="ev-title">全局变量</span>
        <span class="text-faint"
          >跨项目共享的最低优先级变量，模板以 <code>{{ VAR_REFERENCE_HINT }}</code> 引用</span
        >
        <span v-if="dirty" class="ev-dirty">未保存</span>
        <span class="ev-spacer" />
        <button class="btn primary" :disabled="saving || !dirty" @click="save">
          <Io5Save :size="14" /> 保存
        </button>
      </div>
    </template>

    <div v-if="externalChanged" class="ev-external">
      <span>环境变量已被其他操作修改，保存将覆盖当前内容。</span>
      <button class="btn" @click="refresh()">重新加载</button>
    </div>

    <div class="ev-tables">
      <div class="ev-group">
        <div class="ev-group-head">
          <span class="section-title">普通变量</span>
          <button class="btn icon" title="添加变量" @click="addRow(false)">
            <Io5Add :size="14" />
          </button>
        </div>
        <div v-if="draftValues.length === 0" class="empty-hint ev-group-empty">暂无变量</div>
        <div v-for="(row, index) in draftValues" :key="`v-${index}`" class="ev-kv">
          <input
            v-model="row.key"
            class="input ev-key mono"
            placeholder="变量名"
            spellcheck="false"
          />
          <input
            v-model="row.value"
            class="input ev-value mono"
            placeholder="值"
            spellcheck="false"
          />
          <button class="btn icon ev-remove" title="删除该变量" @click="removeRow(false, index)">
            <Io5Close :size="13" />
          </button>
        </div>
      </div>

      <div class="ev-group">
        <div class="ev-group-head">
          <span class="section-title">Secret 变量</span>
          <button class="btn icon" title="添加 secret 变量" @click="addRow(true)">
            <Io5Add :size="14" />
          </button>
        </div>
        <div class="ev-hint">
          以 {{ ENV_SECRET_MASK }} 显示；保持不变保存即保留原值，输入新值则覆盖。记录与导出会脱敏/剔除。
        </div>
        <div v-if="draftSecretValues.length === 0" class="empty-hint ev-group-empty">
          暂无 secret 变量
        </div>
        <div v-for="(row, index) in draftSecretValues" :key="`s-${index}`" class="ev-kv">
          <input
            v-model="row.key"
            class="input ev-key mono"
            placeholder="变量名"
            spellcheck="false"
          />
          <input
            v-model="row.value"
            class="input ev-value mono ev-secret"
            placeholder="值"
            spellcheck="false"
          />
          <button class="btn icon ev-remove" title="删除该变量" @click="removeRow(true, index)">
            <Io5Close :size="13" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ev-view {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ev-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex: none;
}

.ev-name {
  width: 220px;
}

.ev-title {
  font-weight: 600;
}

.ev-active-label {
  color: var(--success);
  font-weight: 600;
}

.ev-dirty {
  font-size: 12px;
  color: var(--warning);
  font-weight: 600;
}

.ev-spacer {
  flex: 1;
}

.ev-external {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: var(--bg-selected);
  font-size: 12px;
  flex: none;
}

.ev-tables {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ev-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.ev-group-head .section-title {
  margin: 0;
  flex: 1;
}

.ev-group-empty {
  text-align: left;
  padding: var(--space-2);
}

.ev-hint {
  font-size: 12px;
  color: var(--text-faint);
  margin-bottom: var(--space-1);
}

.ev-kv {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-1);
}

.ev-key {
  width: 200px;
  flex: none;
}

.ev-value {
  flex: 1;
  min-width: 0;
}

.ev-secret {
  color: var(--text-secondary);
}

.ev-remove {
  flex: none;
}
</style>
