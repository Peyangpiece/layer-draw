/**
 * PSD / PSB を読み込む（ag-psd を使用）。DOM に依存しないので、テストからも呼べる。
 *
 * 対応:
 *  - レイヤー・フォルダの構造、表示/非表示、不透明度、合成モード（対応するもの）、クリッピング、フォルダの開閉
 *  - レイヤーマスク（ユーザーマスク）を画素のアルファに掛けて反映
 * 非対応（警告を出す）:
 *  - 調整レイヤー（読み飛ばす）、レイヤー効果、ベクターマスク、対応しない合成モード（通常にする）
 *  - フォルダの「通過」は、フォルダ内を先に合成する扱い（エディタのフォルダの動き）になる
 *  - 8bit 以外、RGB / グレースケール以外のカラーモードはエラー
 */
import { initializeCanvas, readPsd, type Layer, type LayerMaskData, type Psd } from "ag-psd";
import type { RasterImage } from "../../decompose/types";
import { psdBlend, psdBlendLabel } from "./blend";
import { LayeredImportError, WarningSet, type ImportedNode, type LayeredImport } from "./model";

export { LayeredImportError };

const COLOR_MODE_NAME: Record<number, string> = { 0: "モノクロ 2 階調", 2: "インデックスカラー", 4: "CMYK", 7: "マルチチャンネル", 8: "ダブルトーン", 9: "Lab" };

/**
 * ag-psd が画素の入れ物を作る方法を、DOM を使わない単純な配列にする。
 * 画像は useImageData で配列のまま受け取るので Canvas は不要（Node のテストや Worker でも動く）。
 * Canvas が必要になる機能（サムネイルなど）は使わない。
 */
let canvasInitialized = false;
function ensureNoCanvas() {
  if (canvasInitialized) return;
  initializeCanvas(
    () => {
      throw new Error("この読み込み方では Canvas を使いません");
    },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
  );
  canvasInitialized = true;
}

export function parsePsd(buffer: ArrayBuffer): LayeredImport {
  ensureNoCanvas();
  let psd: Psd;
  try {
    psd = readPsd(buffer, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  } catch (e) {
    throw new LayeredImportError(`PSD を読み込めませんでした（${e instanceof Error ? e.message : String(e)}）。ファイルが壊れているか、対応していない形式の可能性があります。`);
  }
  if (psd.bitsPerChannel !== undefined && psd.bitsPerChannel !== 8) {
    throw new LayeredImportError(`${psd.bitsPerChannel}bit の PSD には対応していません。8bit/チャンネルで書き出してから読み込んでください。`);
  }
  // ColorMode: 1 = グレースケール, 3 = RGB（ag-psd が RGBA に展開する）
  if (psd.colorMode !== undefined && psd.colorMode !== 1 && psd.colorMode !== 3) {
    const name = COLOR_MODE_NAME[psd.colorMode] ?? `カラーモード ${psd.colorMode}`;
    throw new LayeredImportError(`${name} の PSD には対応していません。RGB で書き出してから読み込んでください。`);
  }

  const warnings = new WarningSet();
  // PSD の children は背面→前面の順。エディタは前面が先なので逆にする
  let children = convertChildren(psd.children ?? [], warnings);
  if (children.length === 0 && psd.imageData) {
    // レイヤー情報の無い（統合済みの）PSD は、合成画像を 1 枚のレイヤーとして開く
    children = [
      { kind: "raster", name: "背景", visible: true, opacity: 1, blendMode: "normal", clipping: false, x: 0, y: 0, image: toRaster(psd.imageData) },
    ];
    warnings.add("レイヤー情報が無いため、統合された画像を 1 枚のレイヤーとして開きました");
  }
  return { format: "psd", width: psd.width, height: psd.height, children, warnings: warnings.list() };
}

function convertChildren(layers: Layer[], warnings: WarningSet): ImportedNode[] {
  const out: ImportedNode[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const node = convertLayer(layers[i]!, warnings);
    if (node) out.push(node);
  }
  return out;
}

function convertLayer(layer: Layer, warnings: WarningSet): ImportedNode | null {
  const name = layer.name ?? "レイヤー";
  const base = {
    name,
    visible: !layer.hidden,
    opacity: layer.opacity ?? 1,
    clipping: !!layer.clipping,
  };

  if (layer.children !== undefined) {
    const blend = layer.blendMode === "pass through" ? "normal" : psdBlend(layer.blendMode);
    if (blend === null) warnings.add(`合成モード「${psdBlendLabel(layer.blendMode!)}」には対応していないため「通常」にしました`);
    return {
      kind: "group",
      ...base,
      blendMode: blend ?? "normal",
      expanded: layer.opened ?? true,
      children: convertChildren(layer.children, warnings),
    };
  }

  if (layer.adjustment) {
    warnings.add("調整レイヤーには対応していないため、読み込みませんでした");
    return null;
  }
  if (layer.effects && Object.keys(layer.effects).some((k) => k !== "scale" && k !== "disabled")) {
    warnings.add("レイヤー効果（ドロップシャドウ・境界線など）は反映されません");
  }
  if (layer.vectorMask) warnings.add("ベクターマスクは反映されません");

  const pixels = layer.imageData;
  if (!pixels || pixels.width === 0 || pixels.height === 0) return null; // 空のレイヤー

  let image = toRaster(pixels);
  const x = layer.left ?? 0, y = layer.top ?? 0;
  if (layer.mask && !layer.mask.disabled && layer.mask.imageData !== undefined) {
    image = applyMask(image, x, y, layer.mask);
  } else if (layer.mask && !layer.mask.disabled && layer.mask.defaultColor === 0) {
    // マスクの画像が無く、既定が「隠す」= レイヤー全体が見えない
    image = { ...image, data: new Uint8ClampedArray(image.data.length) };
  }

  const blend = psdBlend(layer.blendMode);
  if (blend === null) warnings.add(`合成モード「${psdBlendLabel(layer.blendMode!)}」には対応していないため「通常」にしました`);
  return { kind: "raster", ...base, blendMode: blend ?? "normal", x, y, image };
}

function toRaster(p: { width: number; height: number; data: ArrayLike<number> }): RasterImage {
  return { width: p.width, height: p.height, data: Uint8ClampedArray.from(p.data as ArrayLike<number>) };
}

/**
 * レイヤーマスクを画素のアルファに掛ける。
 * マスクの画像はドキュメント座標の矩形（left/top/right/bottom）にあり、濃さは R チャンネル（灰色）。
 * 矩形の外はマスクの既定色（0 = 隠す / 255 = 見せる）。
 */
export function applyMask(image: RasterImage, x: number, y: number, mask: LayerMaskData): RasterImage {
  const m = mask.imageData!;
  const ml = mask.left ?? 0, mt = mask.top ?? 0;
  const def = mask.defaultColor ?? 255;
  const out = new Uint8ClampedArray(image.data);
  for (let yy = 0; yy < image.height; yy++) {
    for (let xx = 0; xx < image.width; xx++) {
      const mx = x + xx - ml, my = y + yy - mt;
      const v = mx >= 0 && my >= 0 && mx < m.width && my < m.height ? Number(m.data[(my * m.width + mx) * 4]) : def;
      const i = (yy * image.width + xx) * 4 + 3;
      out[i] = Math.round((out[i]! * v) / 255);
    }
  }
  return { width: image.width, height: image.height, data: out };
}
