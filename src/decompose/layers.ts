/**
 * 分割結果からパーツレイヤー用のビットマップを生成する（仕様書 5.6）。
 * 各パーツは外接矩形の範囲だけのビットマップを持つ（メモリ削減, 仕様書 8 章）。
 * 現段階では 1 色ベタ塗り。元画像の画素を切り出すモードは区分 B/C 対応時に追加する。
 */
import { lightness01, toHex } from "./color";
import type { SegmentResult } from "./segment";
import type { DecomposedPart, FillMode, RasterImage } from "./types";

/** 平均色がこの明度以上なら「白い（塗られていない）領域」とみなす */
const WHITE_LIGHTNESS = 0.95;

export function buildParts(seg: SegmentResult, fill: FillMode): { parts: DecomposedPart[]; resolvedFill: Exclude<FillMode, "auto"> } {
  const { width: w, height: h, labels, regionCount: m } = seg;

  const partLabels: number[] = [];
  for (let l = 0; l < m; l++) if (!seg.isBackground[l]) partLabels.push(l);
  partLabels.sort((a, b) => seg.areas[b]! - seg.areas[a]!); // 面積の大きい順

  // auto: すべてのパーツが白っぽい（＝線画のみの入力）なら自動配色、そうでなければ元の色
  let resolvedFill: Exclude<FillMode, "auto">;
  if (fill === "auto") {
    const allWhite = partLabels.every((l) => {
      const [r, g, b] = seg.meanColors[l]!;
      return lightness01(r | 0, g | 0, b | 0) >= WHITE_LIGHTNESS;
    });
    resolvedFill = allWhite ? "palette" : "source";
  } else {
    resolvedFill = fill;
  }

  const colors = assignColors(seg, partLabels, resolvedFill);

  // 外接矩形
  const minX = new Int32Array(m).fill(w), minY = new Int32Array(m).fill(h);
  const maxX = new Int32Array(m).fill(-1), maxY = new Int32Array(m).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x]!;
      if (l < 0) continue;
      if (x < minX[l]!) minX[l] = x;
      if (x > maxX[l]!) maxX[l] = x;
      if (y < minY[l]!) minY[l] = y;
      if (y > maxY[l]!) maxY[l] = y;
    }
  }

  const parts = partLabels.map((l, i): DecomposedPart => {
    const x0 = minX[l]!, y0 = minY[l]!;
    const bw = maxX[l]! - x0 + 1, bh = maxY[l]! - y0 + 1;
    const [r, g, b] = colors.get(l)!;
    const data = new Uint8ClampedArray(bw * bh * 4);
    for (let y = 0; y < bh; y++) {
      const src = (y0 + y) * w + x0;
      for (let x = 0; x < bw; x++) {
        if (labels[src + x] !== l) continue;
        const o = (y * bw + x) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    return {
      label: l,
      name: `パーツ ${i + 1}`,
      fillColor: toHex(r, g, b),
      area: seg.areas[l]!,
      x: x0,
      y: y0,
      image: { width: bw, height: bh, data },
    };
  });

  return { parts, resolvedFill };
}

function assignColors(seg: SegmentResult, partLabels: number[], fill: Exclude<FillMode, "auto">): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  if (fill === "white") {
    for (const l of partLabels) out.set(l, [255, 255, 255]);
  } else if (fill === "source") {
    for (const l of partLabels) {
      const [r, g, b] = seg.meanColors[l]!;
      out.set(l, [Math.round(r), Math.round(g), Math.round(b)]);
    }
  } else {
    // 自動配色: 隣接パーツと色相が離れるよう、貪欲法で候補色相から選ぶ
    const m = seg.regionCount;
    const HUES = 12;
    const hueOf = new Map<number, number>();
    for (const l of partLabels) {
      const used = new Set<number>();
      for (const [k] of seg.adjacency) {
        const a = Math.floor(k / m), b = k % m;
        const nb = a === l ? b : b === l ? a : -1;
        if (nb >= 0 && hueOf.has(nb)) used.add(hueOf.get(nb)!);
      }
      // 黄金角で巡回しつつ、隣接で使われていない色相を選ぶ
      let pick = -1;
      for (let t = 0; t < HUES; t++) {
        const cand = Math.round(((hueOf.size + t) * 137.508) % 360 / (360 / HUES)) % HUES;
        if (!used.has(cand)) { pick = cand; break; }
      }
      if (pick < 0) pick = hueOf.size % HUES;
      hueOf.set(l, pick);
      out.set(l, hslToRgb((pick * 360) / HUES, 0.55, 0.78));
    }
  }
  return out;
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hDeg / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const mm = l - c / 2;
  return [Math.round((r1 + mm) * 255), Math.round((g1 + mm) * 255), Math.round((b1 + mm) * 255)];
}

/** 線と判定された画素とみなす線画アルファ（0..255）。segment の SEED_MAX_ALPHA と同じ約 0.15 */
const LINE_ALPHA = 38;

/**
 * パーツの塗り色を、別の画像（例: レイヤー付きファイルの全レイヤーの合成画像）の色に付け直す。
 * 各パーツの範囲のうち線ではない画素（線画アルファ < 約 0.15）の平均色を使う（白背景に合成した色）。
 * 線画レイヤーだけを分解した場合、パーツの元の色は白（自動配色）になるが、
 * すでに塗られた絵では、今見えている色から始める方が自然なため。
 */
export function recolorPartsFrom(parts: DecomposedPart[], image: RasterImage, lineart: RasterImage): DecomposedPart[] {
  const W = image.width;
  return parts.map((p) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < p.image.height; y++) {
      for (let x = 0; x < p.image.width; x++) {
        if (p.image.data[(y * p.image.width + x) * 4 + 3] === 0) continue;
        const i = ((p.y + y) * W + (p.x + x)) * 4;
        if (lineart.data[i + 3]! >= LINE_ALPHA) continue;
        const a = image.data[i + 3]! / 255;
        r += image.data[i]! * a + 255 * (1 - a);
        g += image.data[i + 1]! * a + 255 * (1 - a);
        b += image.data[i + 2]! * a + 255 * (1 - a);
        n++;
      }
    }
    if (n === 0) return p;
    const c = [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as const;
    const data = new Uint8ClampedArray(p.image.data);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
    return { ...p, fillColor: toHex(c[0], c[1], c[2]), image: { width: p.image.width, height: p.image.height, data } };
  });
}
