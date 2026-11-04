import { describe, expect, it } from "vitest";
import type { RasterImage } from "../decompose/types";
import { cropToContent, mergeParts, movePixels, opaqueArea, rasterizeStroke, splitPart } from "./partOps";

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

describe("rasterizeStroke（大きな半径）", () => {
  it("間隔を広げても、線分から radius-1 以内の画素はすべて塗られる", () => {
    const r = 50;
    const rect = { x: 0, y: 0, w: 400, h: 200 };
    const m = rasterizeStroke([{ x: 60, y: 100 }, { x: 340, y: 100 }], rect, r);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) {
      const dx = x < 60 ? 60 - x : x > 340 ? x - 340 : 0;
      const d = Math.hypot(dx, y - 100);
      if (d <= r - 1) expect(m[y * 400 + x]).toBe(1);
      if (d > r + 1) expect(m[y * 400 + x]).toBe(0);
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

describe("movePixels", () => {
  const BLUE: [number, number, number] = [30, 30, 200];
  const a = () => ({ x: 0, y: 0, image: bitmap(10, 10, () => RED) }); // 移動先: x 0..9
  const b = () => ({ x: 10, y: 0, image: bitmap(10, 10, () => BLUE) }); // 移動元: x 10..19
  const maskCols = (x0: number, x1: number) => {
    const rect = { x: 0, y: 0, w: 20, h: 10 };
    const m = new Uint8Array(200);
    for (let y = 0; y < 10; y++) for (let x = x0; x <= x1; x++) m[y * 20 + x] = 1;
    return { m, rect };
  };

  it("なぞった範囲の移動元の画素が移動先に移り、面積は保存される", () => {
    const { m, rect } = maskCols(8, 13);
    const r = movePixels(a(), [b()], m, rect, "#ff0000");
    expect(r.moved).toBe(4 * 10); // x 10..13
    expect([r.target.x, r.target.image.width]).toEqual([0, 14]);
    const src = r.sources[0]!;
    expect(src).not.toBeNull();
    expect([src!.x, src!.image.width]).toEqual([14, 6]); // 残りに切り詰め
    expect(opaqueArea(r.target.image) + opaqueArea(src!.image)).toBe(200);
    // 移した画素は移動先の色
    expect(Array.from(r.target.image.data.subarray((5 * 14 + 12) * 4, (5 * 14 + 12) * 4 + 4))).toEqual([255, 0, 0, 255]);
  });

  it("移動元がすべて移ったら null（レイヤー削除の合図）", () => {
    const { m, rect } = maskCols(0, 19);
    const r = movePixels(a(), [b()], m, rect);
    expect(r.sources[0]).toBeNull();
    expect(opaqueArea(r.target.image)).toBe(200);
    // fill 省略時は移動元の色のまま
    expect(Array.from(r.target.image.data.subarray((0 * 20 + 15) * 4, (0 * 20 + 15) * 4 + 3))).toEqual(BLUE);
  });

  it("移動元に触れていなければ何も変わらない", () => {
    const { m, rect } = maskCols(2, 6);
    const r = movePixels(a(), [b()], m, rect);
    expect(r.moved).toBe(0);
    expect(r.sources[0]).toBeUndefined();
  });

  it("離れた位置の画素も移せる（移動先の外接矩形が広がる）", () => {
    const far = { x: 30, y: 5, image: bitmap(4, 4, () => BLUE) };
    const rect = { x: 30, y: 5, w: 4, h: 4 };
    const r = movePixels(a(), [far], new Uint8Array(16).fill(1), rect);
    expect([r.target.x, r.target.y, r.target.image.width, r.target.image.height]).toEqual([0, 0, 34, 10]);
    expect(r.sources[0]).toBeNull();
  });
});

describe("cropToContent", () => {
  it("不透明画素の外接矩形に切り詰め、空なら null", () => {
    const img = bitmap(10, 10, (x, y) => (x >= 3 && x < 5 && y === 7 ? RED : null));
    const c = cropToContent({ x: 100, y: 200, image: img })!;
    expect([c.x, c.y, c.image.width, c.image.height]).toEqual([103, 207, 2, 1]);
    expect(cropToContent({ x: 0, y: 0, image: bitmap(3, 3, () => null) })).toBeNull();
  });
});
