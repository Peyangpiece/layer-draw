import type { SourceFormat } from "../core/types";

/** 受け付ける入力形式（仕様書 3.1）。拡張子や MIME ではなく、ファイル先頭のバイト列で判定する。 */
export const ACCEPT_ATTR = ".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml";

export type DetectResult =
  | { ok: true; format: SourceFormat }
  | { ok: false; reason: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 先頭バイト列から形式を判定する。
 * - PNG : 89 50 4E 47 0D 0A 1A 0A
 * - JPEG: FF D8 FF
 * - SVG : テキストで、XML 宣言・コメント・DOCTYPE・空白を除いた最初の要素が <svg
 */
export function detectFormat(head: Uint8Array): DetectResult {
  if (PNG_SIG.every((b, i) => head[i] === b)) return { ok: true, format: "png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ok: true, format: "jpeg" };
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return { ok: false, reason: "gzip 圧縮された SVG（.svgz）には対応していません。展開した .svg を読み込んでください。" };
  }
  if (looksLikeSvg(head)) return { ok: true, format: "svg" };
  return { ok: false, reason: "対応していない形式です。PNG / JPEG / SVG を読み込んでください。" };
}

function looksLikeSvg(head: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  } catch {
    return false;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  let s = text;
  // 先頭の空白・XML 宣言・処理命令・コメント・DOCTYPE を読み飛ばす
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("<?")) {
      const end = s.indexOf("?>");
      if (end < 0) return false;
      s = s.slice(end + 2);
    } else if (s.startsWith("<!--")) {
      const end = s.indexOf("-->");
      if (end < 0) return false;
      s = s.slice(end + 3);
    } else if (/^<!DOCTYPE/i.test(s)) {
      // 内部サブセット [ ... ] を含む場合も考慮
      const m = /^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i.exec(s);
      if (!m) return false;
      s = s.slice(m[0].length);
    } else {
      break;
    }
  }
  return /^<svg[\s>/]/.test(s);
}

/** 判定に必要な先頭バイト数。SVG は先頭にコメント等が入り得るため多めに読む。 */
export const DETECT_HEAD_BYTES = 4096;
