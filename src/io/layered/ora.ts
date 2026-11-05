/**
 * OpenRaster（.ora）を読み込む。ZIP の中の stack.xml がレイヤー構造、各レイヤーは PNG。
 * 仕様: https://www.openraster.org/ （stack.xml の並びは先頭が最前面で、エディタと同じ）
 *
 * PNG の展開は環境に依存するので、呼び出し側から decodePng を渡す（ブラウザでは createImageBitmap + Canvas）。
 */
import { strFromU8, unzipSync } from "fflate";
import type { RasterImage } from "../../decompose/types";
import { oraBlend } from "./blend";
import { LayeredImportError, WarningSet, type ImportedNode, type LayeredImport } from "./model";
import { parseXml, type XmlElement } from "./xml";

export type PngDecoder = (bytes: Uint8Array) => Promise<RasterImage>;

export async function parseOra(bytes: Uint8Array, decodePng: PngDecoder): Promise<LayeredImport> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new LayeredImportError("OpenRaster ファイルを展開できませんでした。ファイルが壊れている可能性があります。");
  }
  if (!files["mimetype"] || !strFromU8(files["mimetype"]).startsWith("image/openraster")) {
    throw new LayeredImportError("OpenRaster ファイルではありません（mimetype がありません）。");
  }
  const stackXml = files["stack.xml"];
  if (!stackXml) throw new LayeredImportError("OpenRaster ファイルにレイヤー構造（stack.xml）がありません。");

  let image: XmlElement;
  try {
    image = parseXml(strFromU8(stackXml));
  } catch (e) {
    throw new LayeredImportError(`stack.xml を読めませんでした（${e instanceof Error ? e.message : String(e)}）。`);
  }
  if (image.name !== "image") throw new LayeredImportError("stack.xml の形式が正しくありません（image 要素がありません）。");
  const width = parseInt(image.attrs["w"] ?? "", 10), height = parseInt(image.attrs["h"] ?? "", 10);
  if (!(width > 0 && height > 0)) throw new LayeredImportError("stack.xml に画像の大きさ（w, h）がありません。");
  const top = image.children.find((c) => c.name === "stack");
  if (!top) throw new LayeredImportError("stack.xml にレイヤーがありません。");

  const warnings = new WarningSet();
  const children = await convertStack(top, files, decodePng, warnings);
  return { format: "ora", width, height, children, warnings: warnings.list() };
}

async function convertStack(stack: XmlElement, files: Record<string, Uint8Array>, decodePng: PngDecoder, warnings: WarningSet): Promise<ImportedNode[]> {
  const out: ImportedNode[] = [];
  for (const el of stack.children) {
    const base = {
      name: el.attrs["name"] ?? (el.name === "stack" ? "フォルダ" : "レイヤー"),
      visible: el.attrs["visibility"] !== "hidden",
      opacity: clamp01(parseFloat(el.attrs["opacity"] ?? "1")),
      clipping: false,
    };
    const op = el.attrs["composite-op"];
    let blend = oraBlend(op);
    if (blend === null) {
      warnings.add(`合成モード「${op}」には対応していないため「通常」にしました`);
      blend = "normal";
    }
    if (el.name === "stack") {
      out.push({ kind: "group", ...base, blendMode: blend, expanded: true, children: await convertStack(el, files, decodePng, warnings) });
    } else if (el.name === "layer") {
      const src = el.attrs["src"];
      const data = src ? files[src] : undefined;
      if (!data) {
        warnings.add("画像ファイルが見つからないレイヤーを読み飛ばしました");
        continue;
      }
      if (!/\.png$/i.test(src!)) {
        warnings.add("PNG 以外の画像のレイヤーを読み飛ばしました");
        continue;
      }
      let img: RasterImage;
      try {
        img = await decodePng(data);
      } catch {
        warnings.add("画像を展開できないレイヤーを読み飛ばしました");
        continue;
      }
      out.push({
        kind: "raster",
        ...base,
        blendMode: blend,
        x: parseInt(el.attrs["x"] ?? "0", 10) || 0,
        y: parseInt(el.attrs["y"] ?? "0", 10) || 0,
        image: img,
      });
    }
    // text など、その他の要素は仕様外なので無視する
  }
  return out;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}
