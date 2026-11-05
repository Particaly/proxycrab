/**
 * 内置假数据生成器（`{{ fake.<名称> }}` 模板命名空间的数据源）。
 *
 * 重放 / 流程测试经常需要伪造手机号、姓名、地址等业务字段：本模块提供一组
 * 纯 JS 生成器（仅依赖 Math.random / Date.now，QuickJS 与 neutral 打包均可
 * 直接运行，不依赖 Node / 浏览器内建），供 template.ts 的 fake 分支在渲染
 * `{{ fake.xxx }}` 表达式时调用。
 *
 * 生成时机约定（行为语义，渲染层负责缓存与告警）：
 *   - 每次调用独立随机——同一表达式在不同 RenderContext（不同节点执行 / 不同
 *     loop 迭代）下产生不同值，模拟「每次请求换一个新用户」；
 *   - 同一 RenderContext 内同表达式取值一致（template.ts 按 ctx 实例缓存），
 *     URL / headers / body 里写同一个 `{{ fake.phone }}` 得到同一个号码。
 *
 * 参数约定：`generateFake` 的 args 来自模板表达式的括号段（已按逗号切分、
 * trim），如 `{{ fake.number(1,100) }}` → args = ['1','100']。参数不合法时
 * 返回 value 为空串 + warning 原因短语（不抛错，由渲染层拼进告警文案）。
 *
 * 本模块为纯函数、零依赖（不依赖 template.ts / 执行器 / 存储），可独立单测。
 */

/** 生成器元数据（供表达式建议浮层 / 插入菜单展示名称、说明与示例） */
export interface FakeGeneratorDef {
  /** 生成器名：模板里 `{{ fake.<name> }}` 的 name 段（同函数名） */
  name: string;
  /** 展示用一句话说明（中文，面向配置面板用户） */
  description: string;
  /** 展示用输出示例（说明性文本，不参与生成） */
  example: string;
}

/** 单次生成结果：失败时 value 为空串、warning 为原因短语（渲染层负责拼告警） */
export interface FakeGenerateResult {
  /** 生成的假数据字符串（永远是非空字符串，成功时） */
  value: string;
  /** 失败原因短语（如「未知的生成器：foo」）；成功时不存在 */
  warning?: string;
}

/** 生成器实现签名：入参为模板括号段切分后的字符串数组 */
type FakeGenerator = (args: readonly string[]) => FakeGenerateResult;

/* ------------------------------------------------------------------ *
 * 基础随机工具
 * ------------------------------------------------------------------ */

/**
 * 生成 [min, max] 闭区间内的随机整数。
 * 入参假定已校验（min <= max 且在安全整数范围），由调用方保证。
 */
function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 从非空数组随机取一个元素（数组由本模块内的常量池给出，恒非空） */
function pick<T>(list: readonly T[]): T {
  return list[randomInt(0, list.length - 1)];
}

/**
 * 生成指定长度的随机小写十六进制串。
 * @param length 目标长度（正整数；调用方保证 >= 1）
 */
function randomHex(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 数据池（刻意保持小而常见：假数据重在「形态正确」，不在穷举真实数据集）
 * ------------------------------------------------------------------ */

/** 手机号号段池：三大运营商常见公开号段（不含虚拟号段） */
const PHONE_PREFIXES = [
  "133",
  "135",
  "136",
  "137",
  "138",
  "139",
  "147",
  "148",
  "149",
  "150",
  "151",
  "152",
  "155",
  "156",
  "157",
  "158",
  "159",
  "165",
  "166",
  "170",
  "171",
  "172",
  "173",
  "175",
  "176",
  "177",
  "178",
  "180",
  "181",
  "182",
  "183",
  "184",
  "185",
  "186",
  "187",
  "188",
  "189",
  "191",
  "193",
  "195",
  "198",
  "199",
] as const;

/** 中文常见姓氏池 */
const NAME_SURNAMES = [
  "王",
  "李",
  "张",
  "刘",
  "陈",
  "杨",
  "黄",
  "赵",
  "吴",
  "周",
  "徐",
  "孙",
  "马",
  "朱",
  "胡",
  "郭",
  "何",
  "林",
  "罗",
  "高",
  "郑",
  "梁",
  "谢",
  "宋",
  "唐",
  "许",
  "韩",
  "冯",
  "邓",
  "曹",
  "彭",
  "曾",
  "肖",
  "田",
  "董",
  "潘",
  "袁",
  "蒋",
  "蔡",
  "余",
] as const;

/** 中文名字池（单字与双字混排，随机拼接出自然姓名） */
const NAME_GIVENS = [
  "伟",
  "芳",
  "娜",
  "敏",
  "静",
  "磊",
  "军",
  "洋",
  "勇",
  "艳",
  "杰",
  "涛",
  "明",
  "超",
  "霞",
  "平",
  "刚",
  "辉",
  "洁",
  "婷",
  "子涵",
  "雨欣",
  "浩然",
  "欣怡",
  "梓萱",
  "宇轩",
  "思远",
  "梦琪",
  "志强",
  "建国",
  "丽华",
  "晓东",
  "天佑",
  "若曦",
  "俊杰",
  "慧敏",
] as const;

/** 省 / 市 / 区三级地址池（市内区列表成组，保证「省市 → 区」归属一致） */
const ADDRESS_REGIONS = [
  {
    province: "北京市",
    city: "北京市",
    districts: ["朝阳区", "海淀区", "东城区", "西城区", "丰台区"],
  },
  {
    province: "上海市",
    city: "上海市",
    districts: ["浦东新区", "徐汇区", "静安区", "杨浦区", "闵行区"],
  },
  {
    province: "广东省",
    city: "深圳市",
    districts: ["南山区", "福田区", "罗湖区", "宝安区", "龙岗区"],
  },
  {
    province: "广东省",
    city: "广州市",
    districts: ["天河区", "越秀区", "海珠区", "白云区", "黄埔区"],
  },
  {
    province: "浙江省",
    city: "杭州市",
    districts: ["西湖区", "滨江区", "余杭区", "拱墅区", "萧山区"],
  },
  {
    province: "江苏省",
    city: "南京市",
    districts: ["玄武区", "秦淮区", "鼓楼区", "建邺区", "江宁区"],
  },
  {
    province: "四川省",
    city: "成都市",
    districts: ["锦江区", "青羊区", "武侯区", "成华区", "金牛区"],
  },
  {
    province: "湖北省",
    city: "武汉市",
    districts: ["江岸区", "武昌区", "洪山区", "汉阳区", "硚口区"],
  },
  {
    province: "陕西省",
    city: "西安市",
    districts: ["雁塔区", "碑林区", "未央区", "莲湖区", "新城区"],
  },
  {
    province: "山东省",
    city: "青岛市",
    districts: ["市南区", "市北区", "崂山区", "李沧区", "城阳区"],
  },
] as const;

/** 街道名池（与区名拼接为「xx区 + xx路 + 号」的常见地址形态） */
const ADDRESS_STREETS = [
  "人民路",
  "中山路",
  "解放路",
  "建设路",
  "科技园路",
  "和平路",
  "文化路",
  "朝阳路",
  "幸福大道",
  "滨江道",
] as const;

/** 车牌省份简称池（含直辖市），发牌机关字母与序号位随机 */
const PLATE_PROVINCES = [
  "京",
  "津",
  "沪",
  "渝",
  "冀",
  "晋",
  "蒙",
  "辽",
  "吉",
  "黑",
  "苏",
  "浙",
  "皖",
  "闽",
  "赣",
  "鲁",
  "豫",
  "鄂",
  "湘",
  "粤",
  "桂",
  "琼",
  "川",
  "贵",
  "云",
  "藏",
  "陕",
  "甘",
  "青",
  "宁",
  "新",
] as const;

/** 车牌可用字母表（普通车牌不含 I / O，避免与数字 1 / 0 混淆） */
const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ" as const;

/** 身份证地区码池（市辖区级行政区划代码，均为真实格式） */
const IDCARD_AREA_CODES = [
  "110101",
  "110105",
  "310101",
  "310104",
  "440303",
  "440304",
  "330102",
  "330106",
  "320102",
  "510104",
  "420102",
  "610113",
  "370202",
  "350102",
  "430102",
] as const;

/** 邮箱域名池：RFC 2606 保留域，保证假地址不会误投真实邮箱 */
const EMAIL_DOMAINS = ["example.com", "example.org", "example.net"] as const;

/* ------------------------------------------------------------------ *
 * 参数解析工具（生成器内部把字符串参数收敛为数字，失败返回 null）
 * ------------------------------------------------------------------ */

/**
 * 把单个字符串参数解析为安全整数。
 * @returns 非法（非整数 / 越出安全范围）返回 null，由调用方产出参数告警
 */
function parseIntArg(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * 各生成器实现
 * ------------------------------------------------------------------ */

/** 手机号：号段池前缀 + 8 位随机数字，共 11 位 */
function generatePhone(): FakeGenerateResult {
  return { value: pick(PHONE_PREFIXES) + String(randomInt(0, 99999999)).padStart(8, "0") };
}

/** 中文姓名：姓氏池 + 名字池随机组合 */
function generateName(): FakeGenerateResult {
  return { value: pick(NAME_SURNAMES) + pick(NAME_GIVENS) };
}

/** 中文地址：省市区三级池内取一致组合 + 街道 + 门牌号 */
function generateAddress(): FakeGenerateResult {
  const region = pick(ADDRESS_REGIONS);
  const streetNo = String(randomInt(1, 999));
  return {
    value: `${region.province}${region.city}${pick(region.districts)}${pick(ADDRESS_STREETS)}${streetNo}号`,
  };
}

/** 头像占位图外链：picsum.photos 随机种子链接（拉取需外网） */
function generateAvatar(): FakeGenerateResult {
  return { value: `https://picsum.photos/seed/${randomHex(6)}/300/300` };
}

/** 车牌：省份简称 + 发牌机关字母 + 5 位序号（字母数字混合，不含 I / O） */
function generatePlate(): FakeGenerateResult {
  let tail = "";
  for (let i = 0; i < 5; i++) {
    const useLetter = Math.random() < 0.4;
    tail += useLetter
      ? PLATE_LETTERS[randomInt(0, PLATE_LETTERS.length - 1)]
      : String(randomInt(0, 9));
  }
  return {
    value: pick(PLATE_PROVINCES) + PLATE_LETTERS[randomInt(0, PLATE_LETTERS.length - 1)] + tail,
  };
}

/** GB11643 校验位权重与「余数 → 校验字符」映射表（1,0,X,9,8,7,6,5,4,3,2） */
const IDCARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const IDCARD_CHECK_MAP = "10X98765432" as const;

/**
 * 身份证号：地区码 + 出生日期（1970~2005 年、1~28 日保证合法）+ 3 位顺序码
 * + GB11643 加权校验位（第 18 位按前 17 位重算，格式校验可通过的服务端口径）。
 */
function generateIdcard(): FakeGenerateResult {
  const area = pick(IDCARD_AREA_CODES);
  const year = randomInt(1970, 2005);
  const month = String(randomInt(1, 12)).padStart(2, "0");
  const day = String(randomInt(1, 28)).padStart(2, "0");
  const sequence = String(randomInt(1, 999)).padStart(3, "0");
  const body = `${area}${year}${month}${day}${sequence}`;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += Number(body[i]) * IDCARD_WEIGHTS[i];
  }
  return { value: body + IDCARD_CHECK_MAP[sum % 11] };
}

/** 邮箱：随机 hex 局部名 + RFC 2606 保留域名（不会误投真实邮箱） */
function generateEmail(): FakeGenerateResult {
  return { value: `${randomHex(8)}@${pick(EMAIL_DOMAINS)}` };
}

/** IPv4：四段各 1~254（避开 0 段与广播段） */
function generateIp(): FakeGenerateResult {
  return {
    value: `${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}`,
  };
}

/**
 * 随机整数：无参 → 0~9999；两个整数参数 → 闭区间 [min, max]。
 * 参数个数 / 非整数 / min > max / 越出安全整数 → 参数告警。
 */
function generateNumber(args: readonly string[]): FakeGenerateResult {
  if (args.length === 0) {
    return { value: String(randomInt(0, 9999)) };
  }
  if (args.length === 2) {
    const min = parseIntArg(args[0]);
    const max = parseIntArg(args[1]);
    if (min === null || max === null || min > max) {
      return { value: "", warning: "number 需要两个整数参数且 min <= max，如 number(1,100)" };
    }
    return { value: String(randomInt(min, max)) };
  }
  return { value: "", warning: "number 需要零个或两个参数，如 number / number(1,100)" };
}

/** UUID v4：RFC 4122 版本位 4、变体位 89ab（Math.random 源，非密码学安全） */
function generateUuid(): FakeGenerateResult {
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
      continue;
    }
    // 第 13 位（index 14）固定版本号 4；第 18 位（index 19）限定变体 89ab
    if (i === 14) {
      out += "4";
      continue;
    }
    if (i === 19) {
      out += "89ab"[randomInt(0, 3)];
      continue;
    }
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return { value: out };
}

/** 当前毫秒时间戳（QuickJS 宿主提供 Date，真实发送时刻生成） */
function generateTimestamp(): FakeGenerateResult {
  return { value: String(Date.now()) };
}

/**
 * 随机十六进制串：无参默认 32 位，单个整数参数指定长度（1~256）。
 * 参数非整数或越出范围 → 参数告警。
 */
function generateHex(args: readonly string[]): FakeGenerateResult {
  if (args.length === 0) {
    return { value: randomHex(32) };
  }
  if (args.length === 1) {
    const length = parseIntArg(args[0]);
    if (length === null || length < 1 || length > 256) {
      return { value: "", warning: "hex 需要一个 1~256 的整数长度参数，如 hex(16)" };
    }
    return { value: randomHex(length) };
  }
  return { value: "", warning: "hex 需要零个或一个参数，如 hex / hex(16)" };
}

/* ------------------------------------------------------------------ *
 * 生成器注册表与元数据
 * ------------------------------------------------------------------ */

/** 名称 → 实现的注册表；generateFake 由此分发 */
const GENERATOR_IMPLS: Record<string, FakeGenerator> = {
  phone: generatePhone,
  name: generateName,
  address: generateAddress,
  avatar: generateAvatar,
  plate: generatePlate,
  idcard: generateIdcard,
  email: generateEmail,
  number: generateNumber,
  ip: generateIp,
  uuid: generateUuid,
  timestamp: generateTimestamp,
  hex: generateHex,
};

/**
 * 生成器元数据表（顺序即 UI 展示顺序：常用在前）。
 * 表达式建议浮层与「插入假数据」菜单据此渲染名称 / 说明 / 示例。
 */
export const FAKE_GENERATORS: readonly FakeGeneratorDef[] = [
  { name: "phone", description: "11 位手机号", example: "13912345678" },
  { name: "name", description: "中文姓名", example: "张伟" },
  {
    name: "address",
    description: "中文地址（省市区 + 街道门牌）",
    example: "广东省深圳市南山区科技园路48号",
  },
  { name: "email", description: "邮箱（保留域，不会误投）", example: "a3f9c2d1@example.com" },
  { name: "idcard", description: "18 位身份证号（含合法校验位）", example: "110101199003077758" },
  { name: "plate", description: "车牌号", example: "京A12345" },
  {
    name: "avatar",
    description: "头像占位图外链（需外网拉取）",
    example: "https://picsum.photos/seed/a3b2c1/300/300",
  },
  { name: "ip", description: "IPv4 地址", example: "203.0.113.88" },
  {
    name: "number",
    description: "随机整数，可带闭区间参数",
    example: "{{ fake.number(1,100) }} → 87",
  },
  {
    name: "hex",
    description: "随机十六进制串，默认 32 位可指定长度",
    example: "{{ fake.hex(16) }} → a3f9…",
  },
  { name: "uuid", description: "UUID v4", example: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
  { name: "timestamp", description: "当前毫秒时间戳", example: "1730000000000" },
];

/**
 * 生成器名字清单（FAKE_GENERATORS 的 name 投影）。
 * 配置面板的组件透传 `fake-names` prop 时直接用它——假数据是引擎内置能力，
 * 不依赖任何运行期上下文，所有暴露 fake 建议的入口共用同一份清单。
 */
export const FAKE_GENERATOR_NAMES: readonly string[] = FAKE_GENERATORS.map((def) => def.name);

/**
 * 按名称调用假数据生成器（template.ts 的 fake 分支唯一入口）。
 *
 * @param name 生成器名（模板表达式 `{{ fake.<name> }}` 的 name 段）
 * @param args 括号段参数（已切分 trim，如 ['1','100']；无括号时为空数组）
 * @returns 成功 → 非空 value；失败 → 空串 + warning 原因短语（不抛错，
 *          渲染层把 warning 拼进模板告警文案）
 */
export function generateFake(name: string, args: readonly string[]): FakeGenerateResult {
  const generator = GENERATOR_IMPLS[name];
  if (!generator) {
    return { value: "", warning: `未知的生成器：${name}` };
  }
  return generator(args);
}
