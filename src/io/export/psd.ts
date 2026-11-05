/**
 * ドキュメントを PSD に書き出す（ag-psd を使用）。DOM に依存しないので、テストからも呼べる。
 *
 * 保つもの: レイヤー・フォルダの構造、名前、表示/非表示、不透明度、合成モード、クリッピング、
 *          透明度保護、フォルダの開閉、レイヤーの位置（キャンバスからはみ出した部分も含む）
 * 保たないもの: パーツの塗り色などエディタ独自の情報（開き直すと通常のレイヤーになる）
 */
import { initializeCanvas, writePsd, type BlendMode as PsdBlendMode, type Layer } from "ag-psd";
import type { BlendMode, LayerDocument, LayerNode } from "../../core/types";
import type { RasterImage } from "../../decompose/types";

const TO_PSD_BLEND: Record<BlendMode, PsdBlendMode> = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  add: "linear dodge",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color dodge",
  "color-burn": "color burn",
  "hard-light": "hard light",
  "soft-light": "soft light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

let canvasInitialized = false;
/** 画素は ImageData 相当の配列で渡すので Canvas は不要（読み込み側と同じ設定） */
function ensureNoCanvas() {
  if (canvasInitialized) return;
  initializeCanvas(
    () => {
      throw new Error("この書き出し方では Canvas を使いません");
    },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
  );
  canvasInitialized = true;
}

/**
 * @param getImage ビットマップ ID → 画素
 * @param composite 全体を合成した画像（ドキュメントと同じ寸法）。PSD を読むアプリの多くがプレビューに使う
 */
export function writeDocumentPsd(doc: LayerDocument, getImage: (bitmapId: string) => RasterImage | undefined, composite: RasterImage): Uint8Array<ArrayBuffer> {
  ensureNoCanvas();
  const toLayers = (nodes: LayerNode[]): Layer[] => {
    // エディタは先頭が最前面、PSD は先頭が最背面
    const out: Layer[] = [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      const base: Layer = {
        name: n.name,
        hidden: !n.visible,
        opacity: n.opacity,
        blendMode: TO_PSD_BLEND[n.blendMode],
        clipping: n.clipping,
      };
      if (n.kind === "group") {
        out.push({ ...base, opened: n.expanded, children: toLayers(n.children) });
        continue;
      }
      const img = getImage(n.bitmapId);
      const layer: Layer = { ...base, left: n.bounds.x, top: n.bounds.y, transparencyProtected: n.alphaLocked };
      if (img && img.width > 0 && img.height > 0) {
        layer.imageData = { width: img.width, height: img.height, data: img.data } as ImageData;
      }
      out.push(layer);
    }
    return out;
  };
  const buf = writePsd(
    {
      width: doc.width,
      height: doc.height,
      children: toLayers(doc.root.children),
      imageData: { width: composite.width, height: composite.height, data: composite.data } as ImageData,
    },
    // 最背面のレイヤーを「背景」扱いにしない（透明度・位置を保つ）
    { noBackground: true, generateThumbnail: false },
  );
  return new Uint8Array(buf);
}
