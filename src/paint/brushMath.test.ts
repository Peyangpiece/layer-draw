import { describe, expect, it } from "vitest";
import { diameterAt, smooth, stampsBetween } from "./brushMath";

describe("diameterAt", () => {
  it("筆圧なしはそのまま、筆圧ありは 15%〜100%", () => {
    expect(diameterAt(20, 0.3, false)).toBe(20);
    expect(diameterAt(20, 0, true)).toBeCloseTo(3, 6);
    expect(diameterAt(20, 1, true)).toBe(20);
  });
});

describe("smooth", () => {
  it("補正 0 は新しい位置そのまま、補正を強くすると前の位置に近く残る", () => {
    const a = { x: 0, y: 0, p: 1 }, b = { x: 10, y: 0, p: 1 };
    expect(smooth(a, b, 0).x).toBe(10);
    expect(smooth(a, b, 10).x).toBeCloseTo(1.5, 6);
    expect(smooth(null, b, 10)).toEqual(b);
  });
});

describe("stampsBetween", () => {
  it("直径の 15% 間隔で並べ、終点を越えない", () => {
    const { stamps } = stampsBetween({ x: 0, y: 0, p: 1 }, { x: 30, y: 0, p: 1 }, 20, false, 0);
    expect(stamps.length).toBe(10); // 3px 間隔で 3, 6, …, 30
    expect(stamps[0]!.x).toBeCloseTo(3, 6);
    expect(stamps.at(-1)!.x).toBeCloseTo(30, 6);
  });
  it("線分の継ぎ目でも間隔が一定（余りを引き継ぐ）", () => {
    const r1 = stampsBetween({ x: 0, y: 0, p: 1 }, { x: 4, y: 0, p: 1 }, 20, false, 0);
    const r2 = stampsBetween({ x: 4, y: 0, p: 1 }, { x: 10, y: 0, p: 1 }, 20, false, r1.carry);
    const xs = [...r1.stamps, ...r2.stamps].map((s) => +s.x.toFixed(6));
    expect(xs).toEqual([3, 6, 9]);
  });
  it("細いブラシでも最小 0.5px 間隔で途切れない", () => {
    const { stamps } = stampsBetween({ x: 0, y: 0, p: 1 }, { x: 5, y: 0, p: 1 }, 1, false, 0);
    expect(stamps.length).toBe(10);
  });
});
