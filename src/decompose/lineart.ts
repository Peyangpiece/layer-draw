/**
 * 線画抽出 L-1（仕様書 5.2）: 明度 → アルファ変換。
 * 二値化せず線の濃淡をアルファとして保持するため、アンチエイリアスが残る。
 *
 * lineColor="original" のときは「白背景に合成し直すと元の色に戻る」ことを保証する
 * （いわゆる color-to-alpha）。そのため線と判定された画素のアルファは、明度だけでなく
 * 彩度に応じて引き上げられる。
 *
 * 入力に透明画素がある場合（PNG/SVG）は、白背景に合成した色として明度を計算する。
 * これにより「透明背景に黒線」の画像も「白背景に黒線」と同じ結果になる。
 */
import { lightness01 } from "./color";
import type { LineartParams, RasterImage } from "./types";

export function extractLineart(src: RasterImage, params: LineartParams): RasterImage {
  const { width, height, data } = src;
  const out = new Uint8ClampedArray(width * height * 4);
  const black = params.blackLevel;
  const white = Math.max(params.whiteLevel, black + 1e-6);
  const range = white - black;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    // 白背景への合成（非乗算アルファ → 合成色）
    const r = data[i]! * a + 255 * (1 - a);
    const g = data[i + 1]! * a + 255 * (1 - a);
    const b = data[i + 2]! * a + 255 * (1 - a);

    const l = lightness01(r | 0, g | 0, b | 0);
    let alpha = Math.min(1, Math.max(0, (white - l) / range));

    if (params.lineColor === "original" && alpha > 0) {
      // 白背景からの分離で線色を 0..255 に収めるには alpha >= max_c (255 - C_c)/255 が必要。
      // これを下回ると彩度の高い線色（例: 純赤）が表現できず、合成結果が元画像と一致しない。
      alpha = Math.max(alpha, (255 - Math.min(r, g, b)) / 255);
      // 元の色から白背景の寄与を除いた色を線色として復元する:
      //   合成色 C = alpha*L + (1-alpha)*255  →  L = (C - (1-alpha)*255) / alpha
      out[i] = (r - (1 - alpha) * 255) / alpha;
      out[i + 1] = (g - (1 - alpha) * 255) / alpha;
      out[i + 2] = (b - (1 - alpha) * 255) / alpha;
    } else {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
    }
    out[i + 3] = Math.round(alpha * 255);
  }
  return { width, height, data: out };
}
