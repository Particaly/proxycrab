import { describe, expect, it } from "vitest";
import { ALIGNMENT_SNAP_THRESHOLD, snapPosition } from "./alignment";
import { FLOW_NODE_SIZE } from "./graph-model";

/**
 * 对齐辅助线纯函数测试：左 / 中 / 右与上 / 中 / 下候选线吸附、阈值外不吸附、
 * x / y 两轴独立、辅助线跨度合并、多候选取最近。
 */

const W = FLOW_NODE_SIZE.width;
const H = FLOW_NODE_SIZE.height;

/** 其他节点夹具（默认画布节点卡尺寸） */
function other(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

describe("snapPosition", () => {
  it("左边缘接近其他节点右边缘时吸附（axis = x 垂直线）", () => {
    const result = snapPosition({ x: W + 3, y: 200 }, [other(0, 100)]);
    expect(result.x).toBe(W);
    expect(result.guides).toEqual([
      { axis: "x", value: W, from: Math.min(100, 200), to: Math.max(100 + H, 200 + H) },
    ]);
  });

  it("中线与中线对齐（拖动节点水平中线吸附高个节点的垂直中线）", () => {
    // 高个节点（高 2H）中线在 y=H；拖动节点 y = H/2+5 时仅自身中线差 5 → 吸附
    const tall = { x: 300, y: 0, height: 2 * H };
    const result = snapPosition({ x: 500, y: H / 2 + 5 }, [tall]);
    expect(result.y).toBe(H / 2);
    expect(result.guides).toEqual([{ axis: "y", value: H, from: 300, to: 500 + W }]);
  });

  it("阈值外不吸附，返回原坐标与空辅助线", () => {
    const result = snapPosition({ x: W + ALIGNMENT_SNAP_THRESHOLD + 1, y: 500 }, [other(0, 100)]);
    expect(result.x).toBe(W + ALIGNMENT_SNAP_THRESHOLD + 1);
    expect(result.guides).toEqual([]);
  });

  it("x / y 两轴独立吸附，可同时各出一条辅助线", () => {
    const result = snapPosition({ x: W + 2, y: H + 2 }, [other(0, 0)]);
    expect(result.x).toBe(W);
    expect(result.y).toBe(H);
    expect(result.guides.map((guide) => guide.axis).sort()).toEqual(["x", "y"]);
  });

  it("多条候选命中时取差值最近的一条", () => {
    // 左缘距候选 W 差 2，右缘距候选 2W+1 差 1 → 取差值更小的后者
    const result = snapPosition({ x: W + 2 }, [other(0, 0), other(2 * W + 1, 50)]);
    expect(result.x).toBe(W + 1);
  });

  it("右边缘吸附其他节点左边缘：origin = 候选 − 节点宽度", () => {
    const result = snapPosition({ x: 2 * W - 2 }, [other(W, 0)]);
    // 拖动节点右边缘 2W-2 距候选 W（其他节点左缘）差 W-2，超过阈值；
    // 自身左缘 x=2W-2 距候选 2W（其他节点右缘）差 2 → 吸附后 x=2W（贴右侧并排）
    expect(result.x).toBe(2 * W);
  });

  it("空其他节点集合：原坐标返回", () => {
    const result = snapPosition({ x: 12, y: 34 }, []);
    expect(result).toEqual({ x: 12, y: 34, guides: [] });
  });
});
