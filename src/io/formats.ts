import type { SourceFormat } from "../core/types";

/** 受け付ける入力形式（仕様書 3.1）。拡張子や MIME ではなく、ファイル先頭のバイト列で判定する。 */
export const ACCEPT_ATTR = ".png,.jpg,.jpeg,.svg,.psd,.ora,image/png,image/jpeg,image/svg+xml,image/vnd.adobe.photoshop,image/openraster";

export type DetectResult =
  | { ok: true; format: SourceFormat }
  | { ok: false; reason: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 先頭バイト列から形式を判定する。
 * - PNG : 89 50 4E 47 0D 0A 1A 0A
 * - JPEG: FF D8 FF
 * - SVG : テキストで、XML 宣言・コメント・DOCTYPE・空白を除いた最初の要素が <svg
 * - PSD : 38 42 50 53（"8BPS"）+ バージョン 1（PSD）または 2（PSB, 大きなドキュメント形式）
 * - ORA : ZIP（50 4B 03 04）で、先頭のエントリが "mimetype"、内容が "image/openraster"
 *         （OpenRaster の仕様で、mimetype は無圧縮の最初のエントリと決まっている）
 */
export function detectFormat(head: Uint8Array): DetectResult {
  if (PNG_SIG.every((b, i) => head[i] === b)) return { ok: true, format: "png" };
  if (ascii(head, 0, 4) === "8BPS" && head[4] === 0 && (head[5] === 1 || head[5] === 2)) return { ok: true, format: "psd" };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // ZIP: ローカルファイルヘッダーのファイル名は 30 バイト目から、長さは 26-27 バイト目（リトルエンディアン）
    const nameLen = head[26]! | (head[27]! << 8);
    const extraLen = head[28]! | (head[29]! << 8);
    const name = ascii(head, 30, 30 + nameLen);
    const content = ascii(head, 30 + nameLen + extraLen, 30 + nameLen + extraLen + 24);
    if (name === "mimetype" && content.startsWith("image/openraster")) return { ok: true, format: "ora" };
    if (name === "mimetype" && content.startsWith("application/x-krita")) {
      return { ok: false, reason: "Krita の .kra には対応していません。Krita で OpenRaster（.ora）または PSD として書き出してから読み込んでください。" };
    }
    return { ok: false, reason: "ZIP ファイルには対応していません。レイヤー付きの画像は PSD または OpenRaster（.ora）で読み込んでください。" };
  }
  if (ascii(head, 0, 8) === "CSFCHUNK") {
    return { ok: false, reason: "CLIP STUDIO PAINT の .clip には対応していません。CLIP STUDIO で PSD として書き出してから読み込んでください。" };
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ok: true, format: "jpeg" };
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return { ok: false, reason: "gzip 圧縮された SVG（.svgz）には対応していません。展開した .svg を読み込んでください。" };
  }
  if (looksLikeSvg(head)) return { ok: true, format: "svg" };
  return { ok: false, reason: "対応していない形式です。PNG / JPEG / SVG、またはレイヤー付きの PSD / OpenRaster（.ora）を読み込んでください。" };
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i]!);
  return s;
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
