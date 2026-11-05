import { writePsd, type Psd } from "ag-psd";
import { describe, expect, it } from "vitest";
import type { ImportedGroup, ImportedRaster } from "./model";
import { applyMask, LayeredImportError, parsePsd } from "./psd";

/** w×h の単色（RGBA）画像 */
const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};

/** テスト用の PSD を ag-psd で書き出す（children は背面→前面の順、PSD の並び） */
function makePsd(children: Psd["children"], extra: Partial<Psd> = {}): ArrayBuffer {
  return writePsd({ width: 100, height: 80, imageData: solid(100, 80, [255, 255, 255, 255]) as never, children, ...extra });
}

describe("parsePsd", () => {
  it("並び（前面が先）・名前・位置・表示・不透明度・合成モード・クリッピングを読み込む", () => {
    const buf = makePsd([
      { name: "背景", imageData: solid(100, 80, [255, 255, 255, 255]) as never, left: 0, top: 0 },
      { name: "塗り", imageData: solid(30, 20, [255, 0, 0, 255]) as never, left: 10, top: 5, opacity: 0.5, blendMode: "multiply" },
      { name: "影", imageData: solid(30, 20, [0, 0, 255, 255]) as never, left: 10, top: 5, clipping: true, hidden: true },
    ]);
    const r = parsePsd(buf);
    expect([r.width, r.height]).toEqual([100, 80]);
    expect(r.children.map((n) => n.name)).toEqual(["影", "塗り", "背景"]);
    const [shade, fill] = r.children as ImportedRaster[];
    expect(shade!.clipping).toBe(true);
    expect(shade!.visible).toBe(false);
    expect([fill!.x, fill!.y, fill!.image.width, fill!.image.height]).toEqual([10, 5, 30, 20]);
    expect(fill!.opacity).toBeCloseTo(0.5, 2);
    expect(fill!.blendMode).toBe("multiply");
    expect(Array.from(fill!.image.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(r.warnings).toEqual([]);
  });

  it("フォルダの入れ子と開閉を読み込み、「通過」は通常にする", () => {
    const buf = makePsd([
      {
        name: "キャラ",
        opened: false,
        blendMode: "pass through",
        children: [
          { name: "体", imageData: solid(10, 10, [0, 255, 0, 255]) as never, left: 0, top: 0 },
          { name: "線画", imageData: solid(10, 10, [0, 0, 0, 255]) as never, left: 0, top: 0 },
        ],
      },
    ]);
    const r = parsePsd(buf);
    const g = r.children[0] as ImportedGroup;
    expect(g.kind).toBe("group");
    expect(g.expanded).toBe(false);
    expect(g.blendMode).toBe("normal");
    expect(g.children.map((n) => n.name)).toEqual(["線画", "体"]);
  });

  it("対応しない合成モードは通常にして、警告を 1 つにまとめる", () => {
    const buf = makePsd([
      { name: "a", imageData: solid(4, 4, [9, 9, 9, 255]) as never, blendMode: "linear burn" },
      { name: "b", imageData: solid(4, 4, [9, 9, 9, 255]) as never, blendMode: "linear burn" },
      { name: "c", imageData: solid(4, 4, [9, 9, 9, 255]) as never, blendMode: "linear dodge" },
    ]);
    const r = parsePsd(buf);
    expect((r.children[0] as ImportedRaster).blendMode).toBe("add"); // 覆い焼き（リニア）= 加算
    expect((r.children[1] as ImportedRaster).blendMode).toBe("normal");
    expect(r.warnings).toEqual(["合成モード「焼き込み（リニア）」には対応していないため「通常」にしました（2 件）"]);
  });

  it("レイヤーマスクを画素のアルファに反映する", () => {
    // 左半分を隠すマスク（マスク範囲の外は既定色 255 = 見せる）
    const maskImg = solid(20, 10, [255, 255, 255, 255]);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) maskImg.data.set([0, 0, 0, 255], (y * 20 + x) * 4);
    const buf = makePsd([
      { name: "m", imageData: solid(20, 10, [200, 100, 50, 255]) as never, left: 0, top: 0, mask: { left: 0, top: 0, right: 20, bottom: 10, defaultColor: 255, imageData: maskImg as never } },
    ]);
    const l = parsePsd(buf).children[0] as ImportedRaster;
    expect(l.image.data[(5 * 20 + 3) * 4 + 3]).toBe(0); // 左半分は透明
    expect(l.image.data[(5 * 20 + 15) * 4 + 3]).toBe(255);
  });

  it("空のレイヤーは読み飛ばす", () => {
    const buf = makePsd([{ name: "空" }, { name: "x", imageData: solid(2, 2, [1, 2, 3, 255]) as never }]);
    expect(parsePsd(buf).children.map((n) => n.name)).toEqual(["x"]);
  });

  it("壊れたデータは理由付きのエラー", () => {
    expect(() => parsePsd(new Uint8Array([0x38, 0x42, 0x50, 0x53, 0, 1, 0, 0]).buffer)).toThrow(LayeredImportError);
  });
});

describe("applyMask", () => {
  it("マスクの外は既定色（0 なら隠す）", () => {
    const img = { width: 4, height: 1, data: new Uint8ClampedArray([1, 1, 1, 255, 1, 1, 1, 255, 1, 1, 1, 255, 1, 1, 1, 255]) };
    const mask = { left: 0, top: 0, right: 2, bottom: 1, defaultColor: 0, imageData: { width: 2, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255, 255, 255, 255, 255]) } };
    const out = applyMask(img, 0, 0, mask as never);
    expect([out.data[3], out.data[7], out.data[11], out.data[15]]).toEqual([128, 255, 0, 0]);
  });
});
