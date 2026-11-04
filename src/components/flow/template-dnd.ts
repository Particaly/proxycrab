/**
 * IO 字段 chip ↔ 表达式输入框的拖放载荷协议（ReqFlow 复刻计划 Task 15 薄片 B Step 3）。
 *
 * 自归档 `_archive/reqflow/src/components/expression-input/template-dnd.ts
 * @ 485fa00` 移植（上游放 expression-input 侧；本仓 expression-input 只读复用、
 * 不再新增文件，故收敛到 flow 侧与 NodeIoDrawer 同居）。NodeIoDrawer 的字段
 * chip 拖动时把模板引用（与点击复制完全同一形状的 `{{ ... }}` 文本）写入
 * dataTransfer；表达式输入框后续接线时在 dragover / drop 按本模块的标记识别
 * 并接管插入——drop 读出的载荷直接交给 `ExpressionInput.insertSnippet`
 * （内部走 expression-suggest 的 buildDropInsertPlan 写入计划），插入路径
 * 单一出口。生产者（抽屉 chip）与消费者（输入框落点）分处不同文件，标记与
 * 读写口径收敛在本模块，避免两处各自硬编码字符串。
 *
 * 采用自定义 MIME 做数据传输类型隔离：画布节点类型拖放（application/
 * x-reqflow-node-type，见 Canvas）与本标记互不串台；同时兜底写一份
 * text/plain（同片段文本），拖到普通文本框等非接管落点时退化为浏览器
 * 默认的纯文本放入。
 *
 * dragover 阶段受浏览器「保护模式」限制（getData 恒返回空串），只能靠
 * types 判断是否本协议的拖拽；types 不含本标记的拖拽（如原生文本拖拽）
 * 不接管，保持浏览器默认行为。
 *
 * 范围说明：IO 抽屉与表达式输入同页同文档（同一 DOM 树），HTML5 Drag and
 * Drop 原生可用，不涉及跨窗口 / 跨文档场景。纯函数（types / 字符串级）
 * node 可直接单测；DataTransfer 读写按结构类型收窄（`{ getData }` /
 * `{ setData }`），测试用同形桩对象即可。
 */

/** IO 字段拖放时写入 dataTransfer 的自定义 MIME 标记（与上游 @ 485fa00 同值） */
export const IO_PATH_MIME = "application/x-reqflow-io-path";

/**
 * 格式化 IO 字段的模板引用片段（chip 点击复制与拖拽载荷共用的同一形状）。
 *
 * 语义与 flow-engine 模板四命名空间对齐：`{{ node.<refId>.<path> }}`；
 * path 为空串（引用整个输出，如样本是原始值场景经调用方裁剪）时退化为
 * `{{ node.<refId> }}`。path 上的前导点（防御调用方拼装误差）剥掉。
 *
 * @param refId 节点引用 id（模板引用 `node.<refId>` 段；画布节点真实 id）
 * @param path 字段点分路径（collectJsonPaths 产出口径，如 `json.data.token`）
 */
export function buildNodeFieldSnippet(refId: string, path: string): string {
  const cleanPath = path.replace(/^\.+/, "");
  return cleanPath === "" ? `{{ node.${refId} }}` : `{{ node.${refId}.${cleanPath} }}`;
}

/**
 * 格式化入参字段的裸路径简写片段（入参分组 chip 复制 / 拖拽载荷）。
 *
 * 与 flow-engine 模板「裸路径 = input.<path> 简写」语义对齐（15A 提示浮层
 * 的入参简写同款）：当前节点配置内的引用取当前节点入参，裸形态更短。出参
 * 引用（给下游节点用）走 buildNodeFieldSnippet 的带前缀形态——多上游聚合
 * 时入参是 `{ 引用键: 输出 }` 对象，裸路径会有歧义。空路径（防御调用方
 * 传入）退化为 `{{ input }}`——引用整个聚合入参（裸简写只在有路径时省前缀）。
 *
 * @param path 字段点分路径（collectJsonPaths 产出口径）
 */
export function buildInputFieldSnippet(path: string): string {
  const cleanPath = path.replace(/^\.+/, "");
  return cleanPath === "" ? "{{ input }}" : `{{ ${cleanPath} }}`;
}

/**
 * 判断拖拽是否携带 IO 字段载荷（dragover 阶段按 types 判定，详见模块头）。
 *
 * @param types dataTransfer.types（只读字符串列表；测试传普通数组同形）
 */
export function hasIoPathPayload(types: ReadonlyArray<string>): boolean {
  return Array.from(types).includes(IO_PATH_MIME);
}

/**
 * 读取拖放载荷中的模板引用文本（仅在 drop 阶段可读）。
 *
 * @param dataTransfer drop 事件的数据传输对象（按 getData 结构收窄，便于桩测）
 * @returns 载荷文本（trim 后非空即视为有效引用）；未携带 / 空载荷返回 null
 */
export function readIoPathPayload(dataTransfer: { getData(type: string): string }): string | null {
  const text = dataTransfer.getData(IO_PATH_MIME).trim();
  return text === "" ? null : text;
}

/**
 * 起拖装配：把片段写入 dataTransfer（MIME 标记 + text/plain 兜底，详见模块头）。
 *
 * @param dataTransfer dragstart 事件的数据传输对象（按 setData 结构收窄）
 * @param snippet 完整模板引用片段（buildNodeFieldSnippet 产出）
 */
export function writeIoPathPayload(
  dataTransfer: { setData(type: string, data: string): void },
  snippet: string,
): void {
  dataTransfer.setData(IO_PATH_MIME, snippet);
  dataTransfer.setData("text/plain", snippet);
}
