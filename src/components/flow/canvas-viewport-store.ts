/**
 * 画布视口持久化（Task 13 Step 2）：按流程 id 把上次的缩放 / 平移存入
 * localStorage，再次打开同一流程时恢复视口（而不是每次重新 fit-view 全览）。
 *
 *   - 键 `proxycrab:flow-viewport:<workflowId>`，值 JSON { x, y, zoom }；
 *   - 数值合法性校验（有限数、zoom 落在画布 minZoom..maxZoom 内），
 *     非法 / 损坏 / 存储不可用一律返回 null，调用方按「无留存」处理（fit-view）；
 *   - 写入失败（配额 / 隐私模式）静默忽略。
 *
 * 消费：Canvas.vue 挂载时读取（有留存则作为 defaultViewport 并关闭
 * fit-view-on-init），@move-end 时写回。移植自归档 canvas-viewport-store。
 */

/** 视口的最小结构（x / y 平移 + zoom 缩放）。 */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 视口存储键前缀。 */
export const CANVAS_VIEWPORT_KEY_PREFIX = "proxycrab:flow-viewport:";

/** 合法 zoom 区间（与 Canvas 的 min-zoom / max-zoom 一致，越界视为损坏）。 */
export const CANVAS_VIEWPORT_MIN_ZOOM = 0.2;
export const CANVAS_VIEWPORT_MAX_ZOOM = 2;

/** 安全读取 localStorage（不可用时返回 null）。 */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 单个数值是否合法（有限数）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 读取某流程的已存视口。
 *
 * @param workflowId 流程 id
 * @returns 合法视口；无留存 / 值损坏 / 存储不可用时返回 null
 */
export function readCanvasViewport(workflowId: string): CanvasViewport | null {
  const storage = safeStorage();
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(`${CANVAS_VIEWPORT_KEY_PREFIX}${workflowId}`);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as { x?: unknown; y?: unknown; zoom?: unknown };
    if (
      !isFiniteNumber(candidate.x) ||
      !isFiniteNumber(candidate.y) ||
      !isFiniteNumber(candidate.zoom)
    ) {
      return null;
    }
    if (candidate.zoom < CANVAS_VIEWPORT_MIN_ZOOM || candidate.zoom > CANVAS_VIEWPORT_MAX_ZOOM) {
      return null;
    }
    return { x: candidate.x, y: candidate.y, zoom: candidate.zoom };
  } catch {
    return null;
  }
}

/**
 * 记录某流程的视口（存储不可用 / 数值非法时静默忽略）。
 *
 * @param workflowId 流程 id
 * @param viewport 当前视口（Vue Flow @move-end 的 flowTransform）
 */
export function writeCanvasViewport(workflowId: string, viewport: CanvasViewport): void {
  if (
    !isFiniteNumber(viewport.x) ||
    !isFiniteNumber(viewport.y) ||
    !isFiniteNumber(viewport.zoom)
  ) {
    return;
  }
  const storage = safeStorage();
  if (storage === null) return;
  try {
    storage.setItem(
      `${CANVAS_VIEWPORT_KEY_PREFIX}${workflowId}`,
      JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
    );
  } catch {
    // 忽略持久化失败
  }
}
