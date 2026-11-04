/**
 * 便签节点（stickyNote）配置表单（StickyNoteConfig.vue）的纯函数层：正文 /
 * 预设配色 / 卡片尺寸的输入解析、边界收敛与落库分片组装。
 *
 * 形态对齐归档 `sticky-note-palette.ts @ 485fa00`（色板 token / 默认值 /
 * 边界收敛规则逐字移植——该模块自述为「画布渲染、测试、未来配置面板」共用的
 * 单一事实来源，本表单即那个配置面板）。便签不入执行拓扑，配置仅影响画布
 * 展示；落库形状见 Rust 侧 NodeConfig 的 text / color / size 字段。
 */

/** 一个便签预设色的展示面（token 落库 + HEX 展示） */
export interface StickyNoteColorOption {
  /** 色板 token 名（config.color 的落库值） */
  token: string;
  /** 色板项展示名（按钮 title / aria-label） */
  label: string;
  /** HEX（与画布渲染侧同名 token 色一致，便于断言） */
  hex: string;
}

/** 便签预设色板（6 色）：琥珀（默认）为首选项，其余与节点类型 token 同色族 */
export const STICKY_NOTE_COLORS: ReadonlyArray<StickyNoteColorOption> = [
  { token: "amber", label: "琥珀", hex: "#fbbf24" },
  { token: "emerald", label: "翠绿", hex: "#34d399" },
  { token: "sky", label: "天蓝", hex: "#38bdf8" },
  { token: "violet", label: "紫罗兰", hex: "#a78bfa" },
  { token: "rose", label: "玫红", hex: "#fb7185" },
  { token: "slate", label: "石墨", hex: "#94a3b8" },
];

/** 默认配色 token（新建 / config.color 缺失或非法时） */
export const DEFAULT_STICKY_NOTE_COLOR = "amber";

/** 便签默认尺寸（像素） */
export const STICKY_NOTE_DEFAULT_SIZE = { width: 200, height: 120 } as const;

/** 便签最小尺寸（低于此值不再缩小） */
export const STICKY_NOTE_MIN_SIZE = { width: 140, height: 80 } as const;

/** 便签最大尺寸（防止注释卡铺满画布） */
export const STICKY_NOTE_MAX_SIZE = { width: 480, height: 400 } as const;

/** 便签节点 config 分片（NodeConfig 相关字段的宽容子集） */
export interface StickyNoteConfigShard {
  text?: string;
  color?: string;
  size?: unknown;
}

/** 数值收敛到 [min, max] 区间（clamp 通用实现） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 解析便签配色：已知 token 返回原值，否则回退默认琥珀（渲染侧形状防御同口径） */
export function resolveStickyNoteColorToken(color: unknown): string {
  return STICKY_NOTE_COLORS.some((option) => option.token === color)
    ? (color as string)
    : DEFAULT_STICKY_NOTE_COLOR;
}

/** 解析便签尺寸：含有限宽高的对象按边界收敛，否则返回默认尺寸（脏数据防御） */
export function resolveStickyNoteSize(size: unknown): { width: number; height: number } {
  if (typeof size !== "object" || size === null) return { ...STICKY_NOTE_DEFAULT_SIZE };
  const candidate = size as { width?: unknown; height?: unknown };
  if (typeof candidate.width !== "number" || !Number.isFinite(candidate.width)) {
    return { ...STICKY_NOTE_DEFAULT_SIZE };
  }
  if (typeof candidate.height !== "number" || !Number.isFinite(candidate.height)) {
    return { ...STICKY_NOTE_DEFAULT_SIZE };
  }
  return {
    width: clamp(candidate.width, STICKY_NOTE_MIN_SIZE.width, STICKY_NOTE_MAX_SIZE.width),
    height: clamp(candidate.height, STICKY_NOTE_MIN_SIZE.height, STICKY_NOTE_MAX_SIZE.height),
  };
}

/** 尺寸输入解析结果：value 为收敛后的落库值；error 为错误文案 */
export interface ParsedStickySize {
  value?: number;
  error?: string;
}

/** 尺寸输入 → 落库值：留空 = 对应维度缺省值；非负整数且落在允许区间内放行 */
export function parseStickySizeInput(text: string, min: number, max: number, fallback: number): ParsedStickySize {
  const trimmed = text.trim();
  if (trimmed === "") return { value: fallback };
  if (!/^\d+$/.test(trimmed)) return { error: `尺寸需为 ${min}~${max} 的整数（像素）` };
  const value = Number.parseInt(trimmed, 10);
  if (value < min || value > max) return { error: `尺寸需为 ${min}~${max} 的整数（像素）` };
  return { value };
}

/** 便签表单的整体校验（保存门控数据源；正文与配色恒合法，仅尺寸可错） */
export function validateStickyNoteDraft(draft: { widthText: string; heightText: string }): string | null {
  return (
    parseStickySizeInput(
      draft.widthText,
      STICKY_NOTE_MIN_SIZE.width,
      STICKY_NOTE_MAX_SIZE.width,
      STICKY_NOTE_DEFAULT_SIZE.width,
    ).error ??
    parseStickySizeInput(
      draft.heightText,
      STICKY_NOTE_MIN_SIZE.height,
      STICKY_NOTE_MAX_SIZE.height,
      STICKY_NOTE_DEFAULT_SIZE.height,
    ).error ??
    null
  );
}

/**
 * 编辑草稿 → 便签节点 config 落库分片：
 *   - text 非空落键（空白便签不落 text，节点卡按「空便签」回显）；
 *   - color 恒落键（显式落缺省琥珀，画布读取与「缺失回退」同语义）；
 *   - size 两维合法时落键（留空维度取缺省值；非法不落，保存由校验门控）。
 */
export function buildStickyNoteShard(draft: {
  text: string;
  color: string;
  widthText: string;
  heightText: string;
}): StickyNoteConfigShard {
  const text = draft.text;
  const width = parseStickySizeInput(
    draft.widthText,
    STICKY_NOTE_MIN_SIZE.width,
    STICKY_NOTE_MAX_SIZE.width,
    STICKY_NOTE_DEFAULT_SIZE.width,
  );
  const height = parseStickySizeInput(
    draft.heightText,
    STICKY_NOTE_MIN_SIZE.height,
    STICKY_NOTE_MAX_SIZE.height,
    STICKY_NOTE_DEFAULT_SIZE.height,
  );
  return {
    ...(text !== "" ? { text } : {}),
    color: resolveStickyNoteColorToken(draft.color),
    ...(width.value !== undefined && height.value !== undefined
      ? { size: { width: width.value, height: height.value } }
      : {}),
  };
}
