/**
 * 線画抽出（仕様書 5.2）。二値化せず線の濃淡をアルファとして保持するため、アンチエイリアスが残る。
 *
 * - L-1 lightness: 「線らしさ」= 1 - 明度
 * - L-3 tophat   : 「線らしさ」= (クロージング(明度) - 明度) / クロージング(明度)
 *     クロージングは一辺 2r+1 の正方形より細い暗い構造を周囲の明るさで埋めるので、
 *     差を取ると「周囲より暗い細い構造（＝線）」だけが残る。太い塗り（色面・黒ベタ）は差が 0 になり線にならない。
 *     局所背景の明るさで割って「相対的な暗さ」にするのは、紙や塗りの反射率に照明が掛け算で効くため
 *     （例: 赤い塗りの上の黒線も、暗く写った紙の上の線も、背景に対して真っ黒なら完全な線とみなす）。
 *     ただし明度 L* は非線形なので、この比は近似である。
 *     白い紙の上ではクロージングが 1（白）になるため L-1 と同じ結果になる。
 *
 * 「線らしさ」s を blackLevel/whiteLevel で正規化してアルファにする:
 *   alpha = clamp((s - (1 - whiteLevel)) / (whiteLevel - blackLevel))
 *
 * lineColor="original":
 *   - lightness: 白背景に合成し直すと元の色に戻るよう分離する（color-to-alpha）。
 *     そのため線と判定された画素のアルファは、彩度に応じて引き上げられる。
 *   - tophat   : 背景が白とは限らないため分離せず、元画素の色をそのまま線色にする。
 *
 * 入力に透明画素がある場合（PNG/SVG）は、白背景に合成した色として扱う。
 */
import { lightness01 } from "./color";
import { closing } from "./morph";
import type { LineartParams, RasterImage } from "./types";

export function extractLineart(src: RasterImage, params: LineartParams): RasterImage {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const black = params.blackLevel;
  const white = Math.max(params.whiteLevel, black + 1e-6);
  const range = white - black;

  // 白背景に合成した色と明度
  const comp = new Float32Array(n * 3);
  const light = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const a = data[i + 3]! / 255;
    const r = data[i]! * a + 255 * (1 - a);
    const g = data[i + 1]! * a + 255 * (1 - a);
    const b = data[i + 2]! * a + 255 * (1 - a);
    comp[p * 3] = r; comp[p * 3 + 1] = g; comp[p * 3 + 2] = b;
    light[p] = lightness01(r | 0, g | 0, b | 0);
  }

  let base: Float32Array | null = null; // tophat の局所背景明度
  if (params.method === "tophat") {
    const rad = Math.max(1, Math.ceil(params.maxLineWidth / 2));
    base = closing(light, w, h, rad);
  }

  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const l = light[p]!;
    // 線らしさ s（0..1）。lightness では 1-l、tophat では (base-l)/base
    // 局所背景がほぼ黒（base < 0.05）の場合は比が不安定になるため線なしとする
    let s: number;
    if (base) {
      const bl = base[p]!;
      s = bl < 0.05 ? 0 : Math.max(0, bl - l) / bl;
    } else {
      s = 1 - l;
    }
    let alpha = Math.min(1, Math.max(0, (s - (1 - white)) / range));
    const r = comp[p * 3]!, g = comp[p * 3 + 1]!, b = comp[p * 3 + 2]!;

    if (params.lineColor === "original" && alpha > 0) {
      if (base) {
        out[i] = r; out[i + 1] = g; out[i + 2] = b;
      } else {
        // 白背景からの分離で線色を 0..255 に収めるには alpha >= max_c (255 - C_c)/255 が必要。
        // これを下回ると彩度の高い線色（例: 純赤）が表現できず、合成結果が元画像と一致しない。
        alpha = Math.max(alpha, (255 - Math.min(r, g, b)) / 255);
        //   合成色 C = alpha*L + (1-alpha)*255  →  L = (C - (1-alpha)*255) / alpha
        out[i] = (r - (1 - alpha) * 255) / alpha;
        out[i + 1] = (g - (1 - alpha) * 255) / alpha;
        out[i + 2] = (b - (1 - alpha) * 255) / alpha;
      }
    }
    out[i + 3] = Math.round(alpha * 255);
  }
  return { width: w, height: h, data: out };
}
