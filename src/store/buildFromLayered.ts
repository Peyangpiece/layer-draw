/**
 * レイヤー付きのファイル（PSD / ORA）の読み込み結果から、ドキュメントを組み立てる。
 * レイヤーの構成はそのまま。全体を合成した画像を元画像（doc.source）として持つ（レイヤーとしては追加しない）。
 */
import type { BitmapStore } from "../core/bitmapStore";
import { createDocument, createGroup, createRasterLayer } from "../core/document";
import type { LayerDocument, LayerNode, Rect } from "../core/types";
import { DEFAULT_DECOMPOSE_PARAMS, type RasterImage } from "../decompose/types";
import type { ImportedLayered } from "../io/importFile";
import type { ImportedNode } from "../io/layered/model";
import { Canvas2DCompositor } from "../render/compositor";
import { toImageData } from "./buildFromImport";

function toNodes(nodes: ImportedNode[], store: BitmapStore): LayerNode[] {
  return nodes.map((n): LayerNode => {
    const common = { name: n.name, visible: n.visible, opacity: n.opacity, blendMode: n.blendMode, clipping: n.clipping };
    if (n.kind === "group") return { ...createGroup(n.name, toNodes(n.children, store)), ...common, expanded: n.expanded };
    return createRasterLayer({
      ...common,
      bitmapId: store.add(toImageData(n.image)),
      bounds: { x: n.x, y: n.y, w: n.image.width, h: n.image.height },
    });
  });
}

export function buildDocumentFromLayered(imp: ImportedLayered, store: BitmapStore): LayerDocument {
  const root = createGroup("root", toNodes(imp.children, store));
  const name = imp.fileName.replace(/\.[^.]+$/, "") || "無題";
  const doc = createDocument(name, imp.width, imp.height, root);

  // 全レイヤーの合成画像（画面の表示と同じ合成処理で作る）
  const canvas = document.createElement("canvas");
  new Canvas2DCompositor(store).render(doc, canvas);
  const composite = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, imp.width, imp.height);
  return {
    ...doc,
    source: {
      bitmapId: store.add(composite),
      format: imp.format,
      fileName: imp.fileName,
      originalWidth: imp.originalWidth,
      originalHeight: imp.originalHeight,
      params: DEFAULT_DECOMPOSE_PARAMS,
      layered: true,
    },
  };
}

/**
 * レイヤーの画像を、ドキュメント全体の大きさの透明な画像の上に置く（レイヤー単位の自動分解の入力）。
 * 分解結果の座標がそのままドキュメント座標になる。ドキュメントからはみ出す部分は切り捨てる
 */
export function placeOnCanvas(img: RasterImage, bounds: Rect, width: number, height: number): RasterImage {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < img.height; y++) {
    const dy = bounds.y + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < img.width; x++) {
      const dx = bounds.x + x;
      if (dx < 0 || dx >= width) continue;
      const s = (y * img.width + x) * 4;
      out.set(img.data.subarray(s, s + 4), (dy * width + dx) * 4);
    }
  }
  return { width, height, data: out };
}
