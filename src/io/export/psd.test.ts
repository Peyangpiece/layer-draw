import { describe, expect, it } from "vitest";
import { createDocument, createGroup, createRasterLayer } from "../../core/document";
import type { RasterImage } from "../../decompose/types";
import type { ImportedGroup, ImportedRaster } from "../layered/model";
import { parsePsd } from "../layered/psd";
import { writeDocumentPsd } from "./psd";

const solid = (w: number, h: number, rgba: [number, number, number, number]): RasterImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};

describe("writeDocumentPsd", () => {
  it("書き出した PSD を読み込むと、構造・属性・画素・位置が元に戻る", () => {
    const images = new Map<string, RasterImage>([
      ["bg", solid(100, 80, [255, 255, 255, 255])],
      ["fill", solid(30, 20, [255, 0, 0, 128])],
      ["line", solid(40, 10, [0, 0, 0, 255])],
      ["out", solid(20, 20, [0, 128, 0, 255])],
    ]);
    const line = createRasterLayer({ name: "線画", bitmapId: "line", bounds: { x: 5, y: 6, w: 40, h: 10 }, blendMode: "multiply", opacity: 0.5 });
    const fill = createRasterLayer({ name: "パーツ 1", bitmapId: "fill", bounds: { x: 10, y: 5, w: 30, h: 20 }, clipping: true, alphaLocked: true, visible: false });
    const outside = createRasterLayer({ name: "はみ出し", bitmapId: "out", bounds: { x: -10, y: 70, w: 20, h: 20 }, blendMode: "add" });
    const folder = { ...createGroup("自動分解", [line, fill]), expanded: false, blendMode: "screen" as const };
    const bg = createRasterLayer({ name: "背景", bitmapId: "bg", bounds: { x: 0, y: 0, w: 100, h: 80 } });
    const doc = createDocument("テスト", 100, 80, createGroup("root", [outside, folder, bg]));

    const bytes = writeDocumentPsd(doc, (id) => images.get(id), solid(100, 80, [200, 200, 200, 255]));
    const r = parsePsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

    expect([r.width, r.height]).toEqual([100, 80]);
    expect(r.children.map((n) => n.name)).toEqual(["はみ出し", "自動分解", "背景"]);
    const [o, g, b] = r.children as [ImportedRaster, ImportedGroup, ImportedRaster];
    expect([o.x, o.y, o.image.width, o.image.height, o.blendMode]).toEqual([-10, 70, 20, 20, "add"]);
    expect(g.kind).toBe("group");
    expect([g.expanded, g.blendMode]).toEqual([false, "screen"]);
    const [l, f] = g.children as ImportedRaster[];
    expect([l!.name, l!.blendMode, l!.x, l!.y]).toEqual(["線画", "multiply", 5, 6]);
    expect(l!.opacity).toBeCloseTo(0.5, 2);
    expect([f!.name, f!.clipping, f!.visible, f!.alphaLocked]).toEqual(["パーツ 1", true, false, true]);
    expect(Array.from(f!.image.data.slice(0, 4))).toEqual([255, 0, 0, 128]);
    expect([b.x, b.y, b.image.width]).toEqual([0, 0, 100]);
    expect(r.warnings).toEqual([]);
  });

  it("空のレイヤー（新規レイヤーのまま）も書き出せる", () => {
    const empty = createRasterLayer({ name: "レイヤー 1", bitmapId: "e", bounds: { x: 0, y: 0, w: 1, h: 1 } });
    const doc = createDocument("空", 10, 10, createGroup("root", [empty]));
    const bytes = writeDocumentPsd(doc, () => solid(1, 1, [0, 0, 0, 0]), solid(10, 10, [255, 255, 255, 255]));
    expect(bytes.byteLength).toBeGreaterThan(0);
    const r = parsePsd(bytes.slice().buffer as ArrayBuffer);
    // 完全に透明なレイヤーは読み込み時に空として読み飛ばされる（読み込み側の仕様）
    expect(r.children.length).toBeLessThanOrEqual(1);
  });
});
