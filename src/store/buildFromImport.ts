/**
 * 取り込み画像と自動分解結果からドキュメント（レイヤー構成）を組み立てる（仕様書 5.6）。
 *
 * 生成順（上から）:
 *   [自動分解] フォルダ
 *     ├ 線画（参照レイヤー）
 *     └ パーツ 1..N（面積の大きい順）
 *   元画像（非表示・比較用）
 *   背景（白）
 */
import type { BitmapStore } from "../core/bitmapStore";
import { createDocument, createGroup, createRasterLayer } from "../core/document";
import type { LayerDocument, LayerNode } from "../core/types";
import type { DecomposeResult, RasterImage } from "../decompose/types";
import type { ImportedImage } from "../io/importImage";

/** RasterImage を ImageData に変換（バッファはコピーせず共有） */
export function toImageData(img: RasterImage): ImageData {
  return new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height);
}

export function solidImage(width: number, height: number, rgba: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

export function buildDocumentFromImport(
  imported: ImportedImage,
  result: DecomposeResult,
  store: BitmapStore,
): LayerDocument {
  const { width, height } = imported.image;
  const full = { x: 0, y: 0, w: width, h: height };

  const lineartId = store.add(toImageData(result.lineart));
  const lineart = createRasterLayer({
    name: "線画",
    role: "lineart",
    bitmapId: lineartId,
    bounds: full,
    isReference: true,
  });

  const parts: LayerNode[] = result.parts.map((p) =>
    createRasterLayer({
      name: p.name,
      role: "part",
      bitmapId: store.add(toImageData(p.image)),
      bounds: { x: p.x, y: p.y, w: p.image.width, h: p.image.height },
      part: { fillColor: p.fillColor, sourceLabel: p.label },
    }),
  );

  const sourceId = store.add(imported.image);
  const source = createRasterLayer({
    name: `元画像 (${imported.format.toUpperCase()})`,
    role: "source",
    bitmapId: sourceId,
    bounds: full,
    visible: false,
    locked: true,
  });

  const bg = createRasterLayer({
    name: "背景",
    role: "background",
    bitmapId: store.add(toImageData(solidImage(width, height, [255, 255, 255, 255]))),
    bounds: full,
  });

  const folder = createGroup("自動分解", [lineart, ...parts]);
  const root = createGroup("root", [folder, source, bg]);
  const name = imported.fileName.replace(/\.[^.]+$/, "") || "無題";
  const doc = createDocument(name, width, height, root);
  return {
    ...doc,
    source: {
      bitmapId: sourceId,
      format: imported.format,
      fileName: imported.fileName,
      originalWidth: imported.originalWidth,
      originalHeight: imported.originalHeight,
    },
  };
}
