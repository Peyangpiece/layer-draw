/**
 * パーツの分割・結合（仕様書 6.2）のピクセル処理。DOM 非依存。
 */
import type { RasterImage } from "../decompose/types";

export interface PlacedImage {
  /** ドキュメント座標での左上 */
  x: number;
  y: number;
  image: RasterImage;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * 折れ線を、指定した矩形（ドキュメント座標）内のマスクとしてラスタライズする。
 * 各線分上を 0.5px 間隔でサンプリングし、半径 radius の円を打つ。
 */
export function rasterizeStroke(points: Point[], rect: { x: number; y: number; w: number; h: number }, radius: number): Uint8Array {
  const mask = new Uint8Array(rect.w * rect.h);
  const r = Math.max(0, radius);
  const ri = Math.ceil(r);
  const stamp = (cx: number, cy: number) => {
    const px = Math.round(cx) - rect.x;
    const py = Math.round(cy) - rect.y;
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy > r * r + 0.5) continue;
        const x = px + dx, y = py + dy;
        if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) continue;
        mask[y * rect.w + x] = 1;
      }
    }
  };
  if (points.length === 1) stamp(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let s = 0; s <= steps; s++) stamp(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
  }
  return mask;
}

/** 4 近傍の連結成分ラベリング。include[p] が真の画素だけを対象にする。対象外は -1 */
function label4(include: (p: number) => boolean, w: number, h: number): { labels: Int32Array; areas: number[] } {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const areas: number[] = [];
  for (let s = 0; s < n; s++) {
    if (labels[s] !== -1 || !include(s)) continue;
    const l = areas.length;
    let area = 0, sp = 0;
    stack[sp++] = s;
    labels[s] = l;
    while (sp > 0) {
      const p = stack[--sp]!;
      area++;
      const x = p % w;
      if (x > 0 && labels[p - 1] === -1 && include(p - 1)) { labels[p - 1] = l; stack[sp++] = p - 1; }
      if (x < w - 1 && labels[p + 1] === -1 && include(p + 1)) { labels[p + 1] = l; stack[sp++] = p + 1; }
      if (p >= w && labels[p - w] === -1 && include(p - w)) { labels[p - w] = l; stack[sp++] = p - w; }
      if (p + w < n && labels[p + w] === -1 && include(p + w)) { labels[p + w] = l; stack[sp++] = p + w; }
    }
    areas.push(area);
  }
  return { labels, areas };
}

export type SplitResult =
  | { ok: true; pieces: PlacedImage[] }
  | { ok: false; reason: string };

/**
 * パーツを切断線で分割する。
 *
 * @param part  パーツのビットマップ（ドキュメント座標 (x, y) に配置）
 * @param cut   part と同じサイズの切断マスク（1 = 切断線）
 * @returns 分割後のピース（面積の大きい順）。先頭が元のレイヤーを引き継ぐ想定
 *
 * 手順:
 *  1. パーツ内の画素（アルファ > 0）を、切断前の連結成分（元の成分）に分ける
 *  2. 切断線を除いた画素を連結成分ラベリングし、十分大きい成分（面積 >= minPiece）を「主要な断片」とする
 *  3. 主要な断片を 2 つ以上含む元の成分だけが分割対象。各断片が 1 つのピースになる
 *     切断線に触れていない元の成分（もともと離れていた島）は、最大のピースにまとめて残す
 *  4. 切断線上の画素と小さな断片は、同じ元の成分内で幅優先探索により最寄りのピースに割り当てる
 *     （切断線の幅だけパーツが欠けないようにするため）
 */
export function splitPart(part: PlacedImage, cut: Uint8Array): SplitResult {
  const { width: w, height: h, data } = part.image;
  const n = w * h;
  const inside = (p: number) => data[p * 4 + 3]! > 0;
  const total = (() => {
    let t = 0;
    for (let p = 0; p < n; p++) if (inside(p)) t++;
    return t;
  })();
  if (total === 0) return { ok: false, reason: "パーツが空です。" };

  const orig = label4(inside, w, h);
  const free = label4((p) => inside(p) && !cut[p], w, h);
  const minPiece = Math.max(16, Math.round(total * 0.002));

  // 元の成分ごとの主要な断片
  const majorsOf = new Map<number, number[]>();
  const freeToOrig = new Int32Array(free.areas.length).fill(-1);
  for (let p = 0; p < n; p++) {
    const f = free.labels[p]!;
    if (f >= 0 && freeToOrig[f] === -1) freeToOrig[f] = orig.labels[p]!;
  }
  free.areas.forEach((a, f) => {
    if (a < minPiece) return;
    const o = freeToOrig[f]!;
    if (!majorsOf.has(o)) majorsOf.set(o, []);
    majorsOf.get(o)!.push(f);
  });

  const splitOrigs = [...majorsOf].filter(([, fs]) => fs.length >= 2);
  if (splitOrigs.length === 0) {
    return { ok: false, reason: "線がパーツを横切っていないため分割できませんでした。パーツの端から端まで線を引いてください。" };
  }

  // ピース番号の割り当て
  const pieceOfFree = new Int32Array(free.areas.length).fill(-1);
  const pieceAreas: number[] = [];
  for (const [, fs] of splitOrigs) for (const f of fs) { pieceOfFree[f] = pieceAreas.length; pieceAreas.push(free.areas[f]!); }
  const largest = pieceAreas.indexOf(Math.max(...pieceAreas));
  const splitOrigSet = new Set(splitOrigs.map(([o]) => o));

  const piece = new Int32Array(n).fill(-1);
  for (let p = 0; p < n; p++) {
    if (!inside(p)) continue;
    const o = orig.labels[p]!;
    if (!splitOrigSet.has(o)) { piece[p] = largest; continue; } // 切断されていない島
    const f = free.labels[p]!;
    if (f >= 0 && pieceOfFree[f]! >= 0) piece[p] = pieceOfFree[f]!;
  }

  // 残り（切断線上・小さな断片）を幅優先探索で最寄りのピースへ
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let p = 0; p < n; p++) if (piece[p]! >= 0) queue[qt++] = p;
  while (qh < qt) {
    const p = queue[qh++]!;
    const k = piece[p]!;
    const x = p % w;
    const visit = (q: number) => { if (piece[q] === -1 && inside(q)) { piece[q] = k; queue[qt++] = q; } };
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p + w < n) visit(p + w);
  }

  // ピースごとに外接矩形で切り出す（色は元の画素をそのまま使う）
  const count = pieceAreas.length;
  const minX = new Int32Array(count).fill(w), minY = new Int32Array(count).fill(h);
  const maxX = new Int32Array(count).fill(-1), maxY = new Int32Array(count).fill(-1);
  const areas = new Array<number>(count).fill(0);
  for (let p = 0; p < n; p++) {
    const k = piece[p]!;
    if (k < 0) continue;
    const x = p % w, y = (p - x) / w;
    areas[k]!++;
    if (x < minX[k]!) minX[k] = x;
    if (x > maxX[k]!) maxX[k] = x;
    if (y < minY[k]!) minY[k] = y;
    if (y > maxY[k]!) maxY[k] = y;
  }
  const pieces: (PlacedImage & { area: number })[] = [];
  for (let k = 0; k < count; k++) {
    if (areas[k] === 0) continue;
    const bw = maxX[k]! - minX[k]! + 1, bh = maxY[k]! - minY[k]! + 1;
    const out = new Uint8ClampedArray(bw * bh * 4);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const p = (minY[k]! + y) * w + minX[k]! + x;
        if (piece[p] !== k) continue;
        out.set(data.subarray(p * 4, p * 4 + 4), (y * bw + x) * 4);
      }
    }
    pieces.push({ x: part.x + minX[k]!, y: part.y + minY[k]!, image: { width: bw, height: bh, data: out }, area: areas[k]! });
  }
  if (pieces.length < 2) return { ok: false, reason: "分割後のピースが 1 つしかありません。" };
  pieces.sort((a, b) => b.area - a.area);
  return { ok: true, pieces: pieces.map(({ x, y, image }) => ({ x, y, image })) };
}

/** 不透明画素数 */
export function opaqueArea(img: RasterImage): number {
  let t = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) t++;
  return t;
}

/**
 * 複数のパーツを 1 つのビットマップに結合する。
 * @param partsFrontToBack 前面から背面の順。重なった画素は前面のものを採用する
 * @param fill 指定すると、結合後の不透明画素の RGB をこの色に揃える（#rrggbb）
 */
export function mergeParts(partsFrontToBack: PlacedImage[], fill?: string): PlacedImage {
  if (partsFrontToBack.length === 0) throw new Error("結合するパーツがありません");
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of partsFrontToBack) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.image.width); y1 = Math.max(y1, p.y + p.image.height);
  }
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  // 背面から前面へ上書き（前面が優先）
  for (let i = partsFrontToBack.length - 1; i >= 0; i--) {
    const { x, y, image } = partsFrontToBack[i]!;
    for (let yy = 0; yy < image.height; yy++) {
      for (let xx = 0; xx < image.width; xx++) {
        const s = (yy * image.width + xx) * 4;
        if (image.data[s + 3] === 0) continue;
        out.set(image.data.subarray(s, s + 4), ((y - y0 + yy) * w + (x - x0 + xx)) * 4);
      }
    }
  }
  if (fill) {
    const r = parseInt(fill.slice(1, 3), 16), g = parseInt(fill.slice(3, 5), 16), b = parseInt(fill.slice(5, 7), 16);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] === 0) continue;
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }
  }
  return { x: x0, y: y0, image: { width: w, height: h, data: out } };
}
