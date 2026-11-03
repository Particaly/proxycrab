/**
 * CSV 解析（M10-T6 数据处理节点：loop 节点的 CSV 数据源）。
 *
 * 纯逻辑、零环境依赖，node 环境可单测。RFC 4180 常用子集：
 *   - 首行为表头，后续每行按表头解析为对象（键 = 表头单元格，值 = 数据单元格）；
 *   - 支持引号包裹的单元格（内部可含分隔符 / 换行 / 转义双引号 ""）；
 *   - 换行兼容 \r\n 与 \n；末尾空行忽略；
 *   - 分隔符可配置（',' / ';' / '\t'），缺省 ','。
 *
 * 列数不齐的行：缺失列补空串、多余列忽略（宽松解析——脏数据行不阻断整批循环，
 * 与「环境 / 变量是旁路增强」的降级哲学一致）。全部为字符串值（不做类型推断，
 * 模板消费方可自行比较 / 转换）。
 */

/** CSV 解析结果的一行：表头单元格 → 数据单元格（值一律字符串） */
export type CsvRow = Record<string, string>;

/** 合法的 CSV 分隔符集合 */
const VALID_DELIMITERS = [",", ";", "\t"] as const;

/**
 * 解析分隔符配置：非法值回退 ','（宽容处理，配置错误不应阻断循环编排）。
 *
 * @param raw config.csvDelimiter 的原值（undefined / 非法值回退缺省）
 * @returns 单字符分隔符
 */
export function resolveCsvDelimiter(raw: unknown): string {
  return (VALID_DELIMITERS as readonly string[]).includes(raw as string) && typeof raw === "string"
    ? raw
    : ",";
}

/**
 * 把 CSV 文本按引号感知切分为单元格矩阵（内部辅助，先于表头映射）：
 * 引号内的分隔符 / 换行不切分，"" 转义为 "；未闭合引号按已读内容收尾（宽松）。
 */
function splitCells(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const textLength = text.length;

  const pushCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const pushRow = (): void => {
    // 全空行（无任何非空单元格）跳过：末尾换行 / 连续空行不产生空记录
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < textLength; index++) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        // "" → 字面引号；单个 " → 结束引号态
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      pushCell();
      continue;
    }
    if (char === "\n") {
      pushCell();
      pushRow();
      continue;
    }
    if (char === "\r") {
      // \r\n 视为一个换行；孤立 \r 同样按换行（老 Mac 风格宽容）
      if (text[index + 1] === "\n") index++;
      pushCell();
      pushRow();
      continue;
    }
    cell += char;
  }
  // 收尾：末尾无换行的最后一行
  if (cell !== "" || row.length > 0) {
    pushCell();
    pushRow();
  }
  return rows;
}

/**
 * 解析 CSV 文本为行对象数组（首行为表头）。
 *
 * @param text CSV 文本（含表头；空文本 / 仅表头返回 []）
 * @param delimiter 分隔符（resolveCsvDelimiter 的产物）
 * @returns 行对象列表（键 = 表头单元格原样；重复表头后者覆盖前者）
 */
export function parseCsv(text: string, delimiter: string): CsvRow[] {
  const matrix = splitCells(text, delimiter);
  if (matrix.length === 0) return [];
  const header = matrix[0] as string[];
  const rows: CsvRow[] = [];
  for (let index = 1; index < matrix.length; index++) {
    const cells = matrix[index] as string[];
    const row: CsvRow = {};
    for (let column = 0; column < header.length; column++) {
      row[header[column] as string] = cells[column] ?? "";
    }
    rows.push(row);
  }
  return rows;
}
