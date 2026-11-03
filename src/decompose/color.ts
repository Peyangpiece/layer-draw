/**
 * 色変換ユーティリティ。
 * sRGB(8bit) → CIE L*（知覚的明度, 0..100）。D65 白色点、IEC 61966-2-1 の sRGB 伝達関数を使用。
 */

/** 0..255 の sRGB 値 → リニア値（0..1）のルックアップテーブル */
const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

export function srgbToLinear(v8: number): number {
  return SRGB_TO_LINEAR[v8 & 0xff]!;
}

/** 相対輝度 Y（0..1）。係数は sRGB 原色（Rec.709）の Y 行。 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** Y（0..1, 白=1）→ L*（0..100） */
export function luminanceToLstar(y: number): number {
  const e = 216 / 24389; // (6/29)^3
  const k = 24389 / 27;
  return y > e ? 116 * Math.cbrt(y) - 16 : k * y;
}

export function lightness01(r: number, g: number, b: number): number {
  return luminanceToLstar(relativeLuminance(r, g, b)) / 100;
}

export function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
