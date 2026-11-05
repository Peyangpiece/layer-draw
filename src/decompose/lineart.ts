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
import { squaredEdt } from "./edt";
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

/** 線の太さの推定で「暗い」とみなす明度（0..1）。L-1 で線のしきい値 0.5 に相当する明るさ */
const DARK_LIGHTNESS = 0.55;
/** 推定した太さに掛ける余裕（線の太さのばらつきを許す） */
const AUTO_WIDTH_MARGIN = 1.5;
/** 自動で決める「線とみなす最大の太さ」の範囲（px） */
export const AUTO_LINE_WIDTH_MIN = 16;
export const AUTO_LINE_WIDTH_MAX = 160;

export interface LineWidthEstimate {
  /** 推定した線の太さ（px） */
  width: number;
  /** それに余裕を掛けて範囲内に収めた「線とみなす最大の太さ」（px） */
  maxLineWidth: number;
}

/**
 * 画像の中で最も多い線の太さを推定する。
 *
 * 暗い画素について、暗くない画素までの距離（距離変換）を求め、その距離が上下左右より小さくない画素
 * （＝暗い部分の芯）を数える。線は芯の距離がほぼ一定（太さの半分）で長く続くので、距離の分布に山ができる。
 * 塗りつぶした暗い面の芯は距離がばらばらなので山を作らない。山の位置 × 2 を線の太さとする。
 *
 * 拡大してラスタライズした SVG や高解像度のスキャンでは線が太くなり、固定の上限（16px）だと
 * 輪郭線が「塗り」と判定されて線画に入らないため、上限をこの推定値から決める。
 * 暗い画素がほとんど無い（0.1% 未満）場合は推定できないので null。
 */
export function estimateLineWidth(src: RasterImage): LineWidthEstimate | null {
  // 大きな画像は縮小して推定し、倍率を掛けて戻す（太さの比率は縮小しても変わらない。処理時間を抑えるため）。
  // 縮小で消えるほど細い線しかなければ推定できず null になるが、その場合は既定の上限（16px）で足りる
  const f = Math.ceil(Math.max(src.width, src.height) / ESTIMATE_MAX_SIDE);
  if (f > 1) {
    const e = estimateAtScale(downsample(src, f));
    if (!e) return null;
    const widthPx = Math.max(1, e.width * f);
    return { width: widthPx, maxLineWidth: clampMaxLineWidth(widthPx) };
  }
  return estimateAtScale(src);
}

/** 推定に使う画像の長辺の上限（px） */
const ESTIMATE_MAX_SIDE = 1024;

function clampMaxLineWidth(widthPx: number): number {
  return Math.min(AUTO_LINE_WIDTH_MAX, Math.max(AUTO_LINE_WIDTH_MIN, Math.ceil(widthPx * AUTO_WIDTH_MARGIN)));
}

/** f×f 画素の平均で縮小する（白背景に合成してから平均し、不透明として返す） */
function downsample(src: RasterImage, f: number): RasterImage {
  const w = Math.ceil(src.width / f), h = Math.ceil(src.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let yy = y * f; yy < Math.min(src.height, (y + 1) * f); yy++) {
        for (let xx = x * f; xx < Math.min(src.width, (x + 1) * f); xx++) {
          const i = (yy * src.width + xx) * 4, a = src.data[i + 3]! / 255;
          r += src.data[i]! * a + 255 * (1 - a);
          g += src.data[i + 1]! * a + 255 * (1 - a);
          b += src.data[i + 2]! * a + 255 * (1 - a);
          cnt++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function estimateAtScale(src: RasterImage): LineWidthEstimate | null {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const notDark = new Uint8Array(n);
  let dark = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const a = data[i + 3]! / 255;
    const r = data[i]! * a + 255 * (1 - a), g = data[i + 1]! * a + 255 * (1 - a), b = data[i + 2]! * a + 255 * (1 - a);
    if (lightness01(r | 0, g | 0, b | 0) < DARK_LIGHTNESS) dark++;
    else notDark[p] = 1;
  }
  if (dark < n * 0.001) return null;

  const d2 = squaredEdt(notDark, w, h);
  const hist = new Uint32Array(AUTO_LINE_WIDTH_MAX + 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (notDark[p]) continue;
      const v = d2[p]!;
      // 芯: 上下左右のどれよりも小さくない（画像の外は 0 とみなす）
      if ((x > 0 && d2[p - 1]! > v) || (x < w - 1 && d2[p + 1]! > v) || (y > 0 && d2[p - w]! > v) || (y < h - 1 && d2[p + w]! > v)) continue;
      const half = Math.round(Math.sqrt(v));
      if (half >= 1 && half < hist.length) hist[half]!++;
    }
  }
  let best = 0;
  for (let i = 1; i < hist.length; i++) if (hist[i]! > hist[best]!) best = i;
  if (best === 0 || hist[best] === 0) return null;
  // 芯の画素の中心から暗くない画素の中心までの距離は、太さ W の線でおよそ (W + 1) / 2
  const widthPx = Math.max(1, 2 * best - 1);
  return { width: widthPx, maxLineWidth: clampMaxLineWidth(widthPx) };
}
