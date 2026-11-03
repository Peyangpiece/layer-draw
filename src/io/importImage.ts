/**
 * 画像ファイル（PNG / JPEG / SVG）を読み込み、sRGB の ImageData にデコードする。
 * ブラウザのメインスレッドで実行する（SVG のラスタライズに HTMLImageElement と DOMParser を使うため）。
 */
import type { SourceFormat } from "../core/types";
import { DETECT_HEAD_BYTES, detectFormat } from "./formats";
import { fitLongSide, resolveSvgSize } from "./svgSize";

export interface ImportOptions {
  /** ラスタ画像の長辺上限。超える場合は縮小する（仕様書 9 章: 最大 4096px） */
  maxLongSide: number;
  /** SVG をラスタライズするときの長辺サイズ */
  svgLongSide: number;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  maxLongSide: 4096,
  svgLongSide: 2048,
};

export interface ImportedImage {
  format: SourceFormat;
  fileName: string;
  image: ImageData;
  originalWidth: number;
  originalHeight: number;
  warnings: string[];
}

export class ImportError extends Error {}

export async function importImageFile(
  file: Blob & { name?: string },
  options: Partial<ImportOptions> = {},
): Promise<ImportedImage> {
  const opts = { ...DEFAULT_IMPORT_OPTIONS, ...options };
  if (opts.svgLongSide > opts.maxLongSide) opts.svgLongSide = opts.maxLongSide;
  const fileName = file.name ?? "image";

  const head = new Uint8Array(await file.slice(0, DETECT_HEAD_BYTES).arrayBuffer());
  const detected = detectFormat(head);
  if (!detected.ok) throw new ImportError(detected.reason);

  if (detected.format === "svg") return importSvg(file, fileName, opts);
  return importRaster(file, fileName, detected.format, opts);
}

async function importRaster(
  file: Blob,
  fileName: string,
  format: SourceFormat,
  opts: ImportOptions,
): Promise<ImportedImage> {
  const warnings: string[] = [];
  // HTMLImageElement 経由で描画すると、JPEG の EXIF Orientation は
  // CSS の image-orientation: from-image（既定値）に従って適用される。
  const img = await loadImage(file);
  const ow = img.naturalWidth;
  const oh = img.naturalHeight;
  if (ow === 0 || oh === 0) throw new ImportError("画像のサイズを取得できませんでした。");

  let { width, height } = { width: ow, height: oh };
  if (Math.max(ow, oh) > opts.maxLongSide) {
    ({ width, height } = fitLongSide(ow, oh, opts.maxLongSide));
    warnings.push(`画像が大きいため ${ow}×${oh} から ${width}×${height} に縮小しました。`);
  }
  const image = rasterize(img, width, height);
  return { format, fileName, image, originalWidth: ow, originalHeight: oh, warnings };
}

async function importSvg(file: Blob, fileName: string, opts: ImportOptions): Promise<ImportedImage> {
  const warnings: string[] = [];
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") {
    throw new ImportError("SVG の解析に失敗しました。ファイルが壊れている可能性があります。");
  }

  const size = resolveSvgSize({
    width: root.getAttribute("width"),
    height: root.getAttribute("height"),
    viewBox: root.getAttribute("viewBox"),
  });
  if (size.from === "default") {
    warnings.push("SVG にサイズ情報（width/height/viewBox）が無いため、300×150 として扱いました。");
  }

  // 拡大縮小を正しく効かせるため、viewBox が無ければ論理サイズで補う。
  // viewBox 無しで width/height だけ変えると、拡大ではなく切り抜きになるため。
  if (!root.hasAttribute("viewBox")) {
    root.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  }
  const target = fitLongSide(size.width, size.height, opts.svgLongSide);
  root.setAttribute("width", String(target.width));
  root.setAttribute("height", String(target.height));

  const serialized = new XMLSerializer().serializeToString(doc);
  // <img> として読み込むことで、SVG 内のスクリプト実行と外部リソース読み込みは
  // ブラウザにより無効化される（画像としての SVG の制限）。
  const blob = new Blob([serialized], { type: "image/svg+xml" });
  const img = await loadImage(blob);
  const image = rasterize(img, target.width, target.height);
  return {
    format: "svg",
    fileName,
    image,
    originalWidth: size.width,
    originalHeight: size.height,
    warnings,
  };
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  return img
    .decode()
    .then(() => img)
    .catch(() => {
      throw new ImportError("画像をデコードできませんでした。ファイルが壊れている可能性があります。");
    })
    .finally(() => URL.revokeObjectURL(url));
}

function rasterize(img: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new ImportError("Canvas を初期化できませんでした。");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
