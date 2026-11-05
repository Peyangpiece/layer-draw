/**
 * ファイルの読み込みの入口。1 枚の画像（PNG / JPEG / SVG）とレイヤー付きのファイル（PSD / ORA）を振り分ける。
 * ブラウザのメインスレッドで実行する（PNG の展開・縮小に Canvas を使うため）。
 */
import { DETECT_HEAD_BYTES, detectFormat } from "./formats";
import { DEFAULT_IMPORT_OPTIONS, ImportError, importImageFile, type ImportedImage } from "./importImage";
import { countRasters, LayeredImportError, type ImportedNode, type LayeredImport } from "./layered/model";
import { fitLongSide } from "./svgSize";
import type { RasterImage } from "../decompose/types";

export interface ImportedLayered extends LayeredImport {
  fileName: string;
  /** 縮小前の大きさ */
  originalWidth: number;
  originalHeight: number;
}

export type ImportResult = { kind: "image"; image: ImportedImage } | { kind: "layered"; layered: ImportedLayered };

export async function importFile(file: Blob & { name?: string }): Promise<ImportResult> {
  const fileName = file.name ?? "image";
  const head = new Uint8Array(await file.slice(0, DETECT_HEAD_BYTES).arrayBuffer());
  const detected = detectFormat(head);
  if (!detected.ok) throw new ImportError(detected.reason);

  if (detected.format !== "psd" && detected.format !== "ora") {
    return { kind: "image", image: await importImageFile(file) };
  }

  let layered: LayeredImport;
  try {
    // 解析のライブラリ（ag-psd・fflate）は大きいので、使うときに初めて読み込む（起動を軽くするため）
    if (detected.format === "psd") {
      const { parsePsd } = await import("./layered/psd");
      layered = parsePsd(await file.arrayBuffer());
    } else {
      const { parseOra } = await import("./layered/ora");
      layered = await parseOra(new Uint8Array(await file.arrayBuffer()), decodePngInBrowser);
    }
  } catch (e) {
    if (e instanceof LayeredImportError) throw new ImportError(e.message);
    throw e;
  }
  if (countRasters(layered.children) === 0) throw new ImportError("画像のあるレイヤーがありません。");

  const result: ImportedLayered = { ...layered, fileName, originalWidth: layered.width, originalHeight: layered.height };
  const max = DEFAULT_IMPORT_OPTIONS.maxLongSide;
  if (Math.max(layered.width, layered.height) > max) {
    const size = fitLongSide(layered.width, layered.height, max);
    const s = size.width / layered.width;
    result.width = size.width;
    result.height = size.height;
    result.children = scaleNodes(layered.children, s);
    result.warnings = [...layered.warnings, `画像が大きいため ${layered.width}×${layered.height} から ${size.width}×${size.height} に縮小しました`];
  }
  return { kind: "layered", layered: result };
}

/** PNG をブラウザで展開する。色を変えないよう、色空間の変換と事前乗算をしない指定にする */
async function decodePngInBrowser(bytes: Uint8Array): Promise<RasterImage> {
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

/** すべてのレイヤーを同じ倍率で縮小する（位置も合わせる） */
function scaleNodes(nodes: ImportedNode[], s: number): ImportedNode[] {
  return nodes.map((n) => {
    if (n.kind === "group") return { ...n, children: scaleNodes(n.children, s) };
    const w = Math.max(1, Math.round(n.image.width * s)), h = Math.max(1, Math.round(n.image.height * s));
    const src = document.createElement("canvas");
    src.width = n.image.width;
    src.height = n.image.height;
    src.getContext("2d")!.putImageData(new ImageData(n.image.data as Uint8ClampedArray<ArrayBuffer>, n.image.width, n.image.height), 0, 0);
    const dst = document.createElement("canvas");
    dst.width = w;
    dst.height = h;
    const ctx = dst.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    return { ...n, x: Math.round(n.x * s), y: Math.round(n.y * s), image: { width: w, height: h, data: d.data } };
  });
}
