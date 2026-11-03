import { describe, expect, it } from "vitest";
import type { RasterImage } from "../decompose/types";
import { mergeParts, opaqueArea, rasterizeStroke, splitPart } from "./partOps";

/** w×h のビットマップ。fill(x, y) が色を返した画素だけ不透明 */
function bitmap(w: number, h: number, fill: (x: number, y: number) => [number, number, number] | null): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fill(x, y);
    if (c) data.set([...c, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const RED: [number, number, number] = [200, 30, 30];
const at = (img: RasterImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]!;

describe("rasterizeStroke", () => {
  it("半径 1 で幅 3px の線になり、矩形の外は切り捨てる", () => {
    const m = rasterizeStroke([{ x: -5, y: 5 }, { x: 15, y: 5 }], { x: 0, y: 0, w: 10, h: 10 }, 1);
    for (let x = 0; x < 10; x++) {
      expect([m[4 * 10 + x], m[5 * 10 + x], m[6 * 10 + x]]).toEqual([1, 1, 1]);
      expect(m[3 * 10 + x]).toBe(0);
      expect(m[7 * 10 + x]).toBe(0);
    }
  });
  it("斜めの線も途切れない（4 近傍で連結を断てる）", () => {
    const m = rasterizeStroke([{ x: 0, y: 0 }, { x: 19, y: 19 }], { x: 0, y: 0, w: 20, h: 20 }, 1);
    for (let i = 0; i < 19; i++) {
      // 対角の両隣が両方とも線でないと、4 近傍で斜めにすり抜けられる
      expect(m[i * 20 + i + 1] === 1 || m[(i + 1) * 20 + i] === 1).toBe(true);
    }
  });
});

describe("splitPart", () => {
  const rect = { x: 100, y: 50, image: bitmap(40, 20, () => RED) };

  it("横切る線で 2 つに分かれ、切断線の画素も含めて面積が保存される", () => {
    const cut = rasterizeStroke([{ x: 120, y: 40 }, { x: 120, y: 80 }], { x: 100, y: 50, w: 40, h: 20 }, 1);
    const r = splitPart(rect, cut);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pieces.length).toBe(2);
    expect(r.pieces.reduce((a, p) => a + opaqueArea(p.image), 0)).toBe(40 * 20);
    // ドキュメント座標で左右に分かれる
    const xs = r.pieces.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(100);
    expect(xs[1]).toBeGreaterThanOrEqual(119);
    // 元の色を保持
    expect(Array.from(r.pieces[0]!.image.data.subarray(0, 4))).toEqual([...RED, 255]);
  });

  it("横切っていない線では分割しない", () => {
    const cut = rasterizeStroke([{ x: 120, y: 40 }, { x: 120, y: 60 }], { x: 100, y: 50, w: 40, h: 20 }, 1);
    const r = splitPart(rect, cut);
    expect(r.ok).toBe(false);
  });

  it("角をかすめて小さな欠片ができるだけなら分割しない", () => {
    const cut = rasterizeStroke([{ x: 98, y: 53 }, { x: 103, y: 48 }], { x: 100, y: 50, w: 40, h: 20 }, 1);
    expect(splitPart(rect, cut).ok).toBe(false);
  });

  it("もともと離れている島は、切断線が触れていなければ最大のピースに残る", () => {
    // 左に 30x20 の島 A、右に 6x6 の島 B
    const img = bitmap(50, 20, (x, y) => (x < 30 || (x >= 40 && x < 46 && y < 6) ? RED : null));
    const cut = rasterizeStroke([{ x: 10, y: -2 }, { x: 10, y: 22 }], { x: 0, y: 0, w: 50, h: 20 }, 1);
    const r = splitPart({ x: 0, y: 0, image: img }, cut);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pieces.length).toBe(2);
    const big = r.pieces[0]!; // 面積順で先頭
    // 島 B（x=40..45）は最大のピースに含まれる
    expect(big.x + big.image.width).toBeGreaterThanOrEqual(46);
    expect(at(big.image, 42 - big.x, 2 - big.y)).toBe(255);
    expect(r.pieces.reduce((a, p) => a + opaqueArea(p.image), 0)).toBe(opaqueArea(img));
  });

  it("2 本の線で 3 つに分割できる", () => {
    const area = { x: 100, y: 50, w: 40, h: 20 };
    const a = rasterizeStroke([{ x: 112, y: 40 }, { x: 112, y: 80 }], area, 1);
    const b = rasterizeStroke([{ x: 127, y: 40 }, { x: 127, y: 80 }], area, 1);
    const cut = a.map((v, i) => v | b[i]!);
    const r = splitPart(rect, cut);
    expect(r.ok && r.pieces.length).toBe(3);
  });
});

describe("mergeParts", () => {
  it("外接矩形を合わせ、重なりは前面を採用し、指定色に揃える", () => {
    const front = { x: 10, y: 10, image: bitmap(4, 4, () => [0, 0, 255]) };
    const back = { x: 12, y: 12, image: bitmap(4, 4, () => [0, 255, 0]) };
    const m = mergeParts([front, back]);
    expect([m.x, m.y, m.image.width, m.image.height]).toEqual([10, 10, 6, 6]);
    const px = (x: number, y: number) => Array.from(m.image.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
    expect(px(3, 3)).toEqual([0, 0, 255, 255]); // 重なり → 前面（青）
    expect(px(5, 5)).toEqual([0, 255, 0, 255]); // 背面のみ
    expect(px(5, 0)).toEqual([0, 0, 0, 0]); // どちらにも含まれない
    const filled = mergeParts([front, back], "#ff8000");
    expect(Array.from(filled.image.data.subarray((5 * 6 + 5) * 4, (5 * 6 + 5) * 4 + 4))).toEqual([255, 128, 0, 255]);
    expect(opaqueArea(filled.image)).toBe(16 + 16 - 4);
  });
});
