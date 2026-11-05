import { describe, expect, it } from "vitest";
import { FAKE_GENERATORS, generateFake } from "./fake";

/**
 * 内置假数据生成器测试：逐生成器的输出形态（格式 / 池归属 / 校验位重算 / 参数
 * 收敛）、参数不合法告警、随机性抽样。只断言形态与约定，不锁定具体随机值。
 */

/** 手机号前缀池（与 fake.ts 保持一致，校验生成值归属合法号段） */
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
];

/** 车牌省份简称池（与 fake.ts 一致） */
const PLATE_PROVINCES = "京津沪渝冀晋蒙辽吉黑苏浙皖闽赣鲁豫鄂湘粤桂琼川贵云藏陕甘青宁新";

/** GB11643 校验位重算（独立实现，交叉验证生成器输出） */
function idcardChecksum(body17: string): string {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(body17[i]) * weights[i];
  return "10X98765432"[sum % 11];
}

describe("generateFake：逐生成器输出形态", () => {
  it("phone：11 位数字且号段在池内", () => {
    for (let i = 0; i < 20; i++) {
      const result = generateFake("phone", []);
      expect(result.warning).toBeUndefined();
      expect(result.value).toMatch(/^\d{11}$/);
      expect(PHONE_PREFIXES).toContain(result.value.slice(0, 3));
    }
  });

  it("name：非空且首字符为姓氏池内汉字", () => {
    const surnames =
      "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蒋蔡余";
    for (let i = 0; i < 20; i++) {
      const result = generateFake("name", []);
      expect(result.warning).toBeUndefined();
      expect(result.value.length).toBeGreaterThanOrEqual(2);
      expect(surnames).toContain(result.value[0]);
    }
  });

  it("address：省市区 + 街道 + 门牌号形态", () => {
    const result = generateFake("address", []);
    expect(result.warning).toBeUndefined();
    expect(result.value).toMatch(
      /^(北京市|上海市|广东省|浙江省|江苏省|四川省|湖北省|陕西省|山东省).+区.+\d+号$/,
    );
    expect(result.value).toMatch(
      /(人民路|中山路|解放路|建设路|科技园路|和平路|文化路|朝阳路|幸福大道|滨江道)/,
    );
  });

  it("avatar：picsum.photos 随机种子外链", () => {
    const result = generateFake("avatar", []);
    expect(result.warning).toBeUndefined();
    expect(result.value).toMatch(/^https:\/\/picsum\.photos\/seed\/[0-9a-f]{6}\/300\/300$/);
  });

  it("plate：省份简称 + 发牌机关字母 + 5 位序号（不含 I / O）", () => {
    for (let i = 0; i < 20; i++) {
      const result = generateFake("plate", []);
      expect(result.warning).toBeUndefined();
      expect(result.value).toMatch(
        new RegExp(`^[${PLATE_PROVINCES}][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5}$`),
      );
    }
  });

  it("idcard：18 位、地区码池内、出生日期合法、校验位重算一致", () => {
    const areaCodes = [
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
    ];
    for (let i = 0; i < 20; i++) {
      const result = generateFake("idcard", []);
      expect(result.warning).toBeUndefined();
      expect(result.value).toMatch(/^\d{17}[\dX]$/);
      expect(areaCodes).toContain(result.value.slice(0, 6));
      const year = Number(result.value.slice(6, 10));
      const month = Number(result.value.slice(10, 12));
      const day = Number(result.value.slice(12, 14));
      expect(year).toBeGreaterThanOrEqual(1970);
      expect(year).toBeLessThanOrEqual(2005);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(28);
      expect(result.value[17]).toBe(idcardChecksum(result.value.slice(0, 17)));
    }
  });

  it("email：hex 局部名 + RFC 2606 保留域", () => {
    const result = generateFake("email", []);
    expect(result.warning).toBeUndefined();
    expect(result.value).toMatch(/^[0-9a-f]{8}@(example\.com|example\.org|example\.net)$/);
  });

  it("ip：四段 1~254", () => {
    for (let i = 0; i < 20; i++) {
      const result = generateFake("ip", []);
      expect(result.warning).toBeUndefined();
      const octets = result.value.split(".");
      expect(octets).toHaveLength(4);
      for (const octet of octets) {
        const value = Number(octet);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(254);
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it("uuid：v4 形态（版本位 4、变体位 89ab）", () => {
    const result = generateFake("uuid", []);
    expect(result.warning).toBeUndefined();
    expect(result.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("timestamp：与当前时间毫秒级吻合", () => {
    const before = Date.now();
    const result = generateFake("timestamp", []);
    const after = Date.now();
    expect(result.warning).toBeUndefined();
    const value = Number(result.value);
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it("hex：默认 32 位；单参指定长度", () => {
    expect(generateFake("hex", []).value).toMatch(/^[0-9a-f]{32}$/);
    expect(generateFake("hex", ["16"]).value).toMatch(/^[0-9a-f]{16}$/);
    expect(generateFake("hex", ["1"]).value).toMatch(/^[0-9a-f]$/);
  });

  it("number：无参 0~9999；双参闭区间（含边界与负数）", () => {
    for (let i = 0; i < 30; i++) {
      const value = Number(generateFake("number", []).value);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(9999);
      expect(Number.isInteger(value)).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      const value = Number(generateFake("number", ["1", "100"]).value);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(generateFake("number", ["5", "5"]).value).toBe("5");
    const negative = Number(generateFake("number", ["-3", "3"]).value);
    expect(negative).toBeGreaterThanOrEqual(-3);
    expect(negative).toBeLessThanOrEqual(3);
  });
});

describe("generateFake：参数不合法与未知生成器告警", () => {
  it("未知生成器 → 空串 + 原因短语", () => {
    const result = generateFake("nope", []);
    expect(result.value).toBe("");
    expect(result.warning).toBe("未知的生成器：nope");
  });

  it("number 参数个数 / 非整数 / min>max → 各自告警", () => {
    expect(generateFake("number", ["1"]).warning).toContain("number");
    expect(generateFake("number", ["a", "1"]).warning).toContain("number");
    expect(generateFake("number", ["5", "1"]).warning).toContain("min <= max");
  });

  it("hex 参数越界 / 非整数 → 告警", () => {
    expect(generateFake("hex", ["0"]).warning).toContain("1~256");
    expect(generateFake("hex", ["300"]).warning).toContain("1~256");
    expect(generateFake("hex", ["x"]).warning).toContain("1~256");
    expect(generateFake("hex", ["1", "2"]).warning).toContain("hex");
  });
});

describe("generateFake：随机性", () => {
  it("多次独立调用产出不同值（同表达式跨上下文重随机）", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 8; i++) {
      samples.add(generateFake("phone", []).value);
    }
    // 8 个 8 位随机尾号全部撞车的概率 ~1e-64，工程上视作必然互异
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("FAKE_GENERATORS 元数据表", () => {
  it("覆盖全部注册生成器（name / description / example 齐备）", () => {
    const names = FAKE_GENERATORS.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of FAKE_GENERATORS) {
      expect(def.description).not.toBe("");
      expect(def.example).not.toBe("");
      // 元数据里的生成器必须真实可调用（无 warning 即注册在案）
      expect(generateFake(def.name, []).warning).toBeUndefined();
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "phone",
        "name",
        "address",
        "email",
        "idcard",
        "plate",
        "avatar",
        "ip",
        "number",
        "hex",
        "uuid",
        "timestamp",
      ]),
    );
  });
});
