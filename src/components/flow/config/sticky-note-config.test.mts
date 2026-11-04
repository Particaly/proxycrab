import { describe, expect, it } from "vitest";
import {
  DEFAULT_STICKY_NOTE_COLOR,
  STICKY_NOTE_COLORS,
  STICKY_NOTE_DEFAULT_SIZE,
  STICKY_NOTE_MAX_SIZE,
  STICKY_NOTE_MIN_SIZE,
  buildStickyNoteShard,
  parseStickySizeInput,
  resolveStickyNoteColorToken,
  resolveStickyNoteSize,
  validateStickyNoteDraft,
} from "./sticky-note-config";

describe("配色（resolveStickyNoteColorToken）", () => {
  it("已知 token 原样返回；缺失 / 非法回退默认琥珀；色板 6 色含缺省项", () => {
    expect(resolveStickyNoteColorToken("violet")).toBe("violet");
    expect(resolveStickyNoteColorToken(undefined)).toBe(DEFAULT_STICKY_NOTE_COLOR);
    expect(resolveStickyNoteColorToken("neon")).toBe(DEFAULT_STICKY_NOTE_COLOR);
    expect(resolveStickyNoteColorToken(42)).toBe(DEFAULT_STICKY_NOTE_COLOR);
    expect(STICKY_NOTE_COLORS.map((option) => option.token)).toEqual([
      "amber",
      "emerald",
      "sky",
      "violet",
      "rose",
      "slate",
    ]);
    expect(STICKY_NOTE_COLORS[0]!.token).toBe(DEFAULT_STICKY_NOTE_COLOR);
  });
});

describe("尺寸（resolveStickyNoteSize / parseStickySizeInput）", () => {
  it("合法尺寸按边界收敛；缺省 / 脏数据回退默认尺寸", () => {
    expect(resolveStickyNoteSize({ width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
    expect(resolveStickyNoteSize({ width: 1, height: 99999 })).toEqual({
      width: STICKY_NOTE_MIN_SIZE.width,
      height: STICKY_NOTE_MAX_SIZE.height,
    });
    expect(resolveStickyNoteSize(undefined)).toEqual(STICKY_NOTE_DEFAULT_SIZE);
    expect(resolveStickyNoteSize({ width: "x" })).toEqual(STICKY_NOTE_DEFAULT_SIZE);
    expect(resolveStickyNoteSize({ width: 200, height: NaN })).toEqual(STICKY_NOTE_DEFAULT_SIZE);
    expect(resolveStickyNoteSize(42)).toEqual(STICKY_NOTE_DEFAULT_SIZE);
  });

  it("输入解析：留空取缺省；非整数与越界报错；区间端点放行", () => {
    expect(
      parseStickySizeInput("", STICKY_NOTE_MIN_SIZE.width, STICKY_NOTE_MAX_SIZE.width, STICKY_NOTE_DEFAULT_SIZE.width),
    ).toEqual({ value: STICKY_NOTE_DEFAULT_SIZE.width });
    expect(parseStickySizeInput("1", 140, 480, 200)?.error).toBeTruthy();
    expect(parseStickySizeInput("481", 140, 480, 200)?.error).toBeTruthy();
    expect(parseStickySizeInput("12x", 140, 480, 200)?.error).toBeTruthy();
    expect(parseStickySizeInput("480", 140, 480, 200)).toEqual({ value: 480 });
    expect(parseStickySizeInput("140", 140, 480, 200)).toEqual({ value: 140 });
  });
});

describe("validateStickyNoteDraft", () => {
  it("正文与配色恒合法；仅尺寸可错（宽度优先）", () => {
    expect(validateStickyNoteDraft({ widthText: "", heightText: "" })).toBeNull();
    expect(validateStickyNoteDraft({ widthText: "0", heightText: "120" })).toContain("140~480");
    expect(validateStickyNoteDraft({ widthText: "200", heightText: "0" })).toContain("80~400");
  });
});

describe("buildStickyNoteShard 落库分片", () => {
  it("正文非空落键（空白不落）；color 恒落键；size 两维合法时落键", () => {
    expect(
      buildStickyNoteShard({ text: "待确认", color: "sky", widthText: "240", heightText: "160" }),
    ).toEqual({ text: "待确认", color: "sky", size: { width: 240, height: 160 } });
    expect(
      buildStickyNoteShard({ text: "", color: "neon", widthText: "", heightText: "" }),
    ).toEqual({ color: DEFAULT_STICKY_NOTE_COLOR, size: STICKY_NOTE_DEFAULT_SIZE });
  });

  it("尺寸非法不落 size（保存由校验门控）；分片键随内容收敛", () => {
    expect(
      buildStickyNoteShard({ text: "a", color: "rose", widthText: "1", heightText: "x" }),
    ).toEqual({ text: "a", color: "rose" });
    const shard = buildStickyNoteShard({ text: "a", color: "rose", widthText: "200", heightText: "120" });
    expect(Object.keys(shard).sort()).toEqual(["color", "size", "text"]);
  });
});
