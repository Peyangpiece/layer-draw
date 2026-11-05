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
import type { LayerDocument, LayerGroup, LayerNode } from "../core/types";
import type { DecomposeParams, DecomposeResult, RasterImage } from "../decompose/types";
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
  params: DecomposeParams,
  store: BitmapStore,
): LayerDocument {
  const { width, height } = imported.image;
  const full = { x: 0, y: 0, w: width, h: height };

  const folder = buildDecomposedFolder(result, { width, height }, store);

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
      params,
    },
  };
}

/**
 * 自動分解の結果を「線画（参照レイヤー）+ パーツ（面積の大きい順）」のフォルダにする。
 * 画像全体の分解でも、レイヤー単位の分解でも使う
 */
export function buildDecomposedFolder(result: DecomposeResult, size: { width: number; height: number }, store: BitmapStore, name = "自動分解"): LayerGroup {
  const lineart = createRasterLayer({
    name: "線画",
    role: "lineart",
    bitmapId: store.add(toImageData(result.lineart)),
    bounds: { x: 0, y: 0, w: size.width, h: size.height },
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
  return createGroup(name, [lineart, ...parts]);
}

/**
 * パーツの塗り色を変えた新しいビットマップを作る（コピーオンライト）。
 * アルファ（パーツの形）は保持し、RGB だけを置き換える。
 */
export function recolorBitmap(src: ImageData, hex: string): ImageData {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const out = new Uint8ClampedArray(src.data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return new ImageData(out, src.width, src.height);
}

/** ドキュメント群（取り消し履歴を含む）が参照しているビットマップ ID を集める */
export function collectBitmapIds(docs: Iterable<LayerDocument>): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (n.kind === "raster") ids.add(n.bitmapId);
      else walk(n.children);
    }
  };
  for (const d of docs) {
    walk(d.root.children);
    if (d.source) ids.add(d.source.bitmapId);
  }
  return ids;
}
