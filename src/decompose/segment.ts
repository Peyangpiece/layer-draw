/**
 * 領域分割・パーツ統合・線下補完（仕様書 5.3〜5.5）。
 *
 * 手順:
 *   1. 二値マスク: 線画アルファ >= lineThreshold を「線」とする
 *   2. 隙間閉じ: 線からの距離 d を厳密ユークリッド距離変換で求め、d > gapRadius の画素だけを
 *      「種（シード）」とする。これは線を半径 gapRadius で膨張させるのと等価で、
 *      幅 2*gapRadius 以下の線の途切れを閉じる（Trapped-ball 方式の「ボールが通れない隙間は閉じている」と同じ考え方）。
 *      シードにするのは「線の影響を受けていない」画素（線画アルファ < SEED_MAX_ALPHA）のみ。
 *      アンチエイリアスの縁（線のしきい値未満だが少し暗い画素）をシードにすると、
 *      色差で白から切り離されて細い灰色の領域になるため。縁は 4. の成長で埋まる。
 *   3. ラベリング: シード画素を 4 近傍で連結成分ラベリングする。
 *      （4 近傍にすることで、8 近傍でつながった 1px の斜め線を塗りが通り抜けない）
 *      隣接画素の色差が colorTolerance を超える場合はつながない（線の無い色境界で領域を分けるため）。
 *   4. 成長（＝線下補完）: 全シードから同時に幅優先探索で、未割当の画素（膨張帯と線の下）へ広げる。
 *      まず線ではない画素だけに広げ、その後で線の下に広げる（2 段階。理由は実装部のコメント参照）。
 *      各画素は最も近い（測地距離）領域に割り当てられ、線の下は両側の領域で概ね半分ずつ分け合う。
 *      これで膨張で削られた領域形状の復元と、線の下の補完が同時に行われる。
 *   5. 統合:
 *      5a. 断片の統合: 隙間閉じは、幅が 2*gapRadius 前後の細い領域ではシードを途切れ途切れにし、
 *          1 つの細い領域を細切れにしてしまう。そこで「色が近く」「線の上ではない境界を共有し」
 *          「両方とも細い（平均幅 2*面積/境界長 <= 4*gapRadius+2）」隣接領域を統合する。
 *          色が近いのに線で仕切られていない境界は、隙間閉じでしか生じない。
 *          両方が細い場合に限るのは、細い領域のくびれと本物の線の途切れは局所的には区別できないため
 *          （区別には線の端点の解析が必要。仕様書 5.3 の端点接続）。幅の広い領域どうしの境界には手を付けない。
 *          既知の限界: 細い領域どうしが本物の線の途切れでつながっている場合も統合される。
 *      5b. 外周に接する領域を 1 つの背景にまとめる。
 *      5c. 面積が minArea 未満の領域を、境界を最も長く共有する隣接領域に吸収する。
 *      5d. パーツ数が maxParts を超える場合は面積の小さい順に吸収する。
 *
 * 仕様書 5.1 では「統合 → 線下補完」の順だが、ここでは成長後に統合している。
 * 成長後のほうが隣接関係（共有境界長）を正確に測れるため。結果として線の下も統合先に含まれる。
 */
import { squaredEdt } from "./edt";
import type { RasterImage, SegmentParams } from "./types";

export interface SegmentResult {
  width: number;
  height: number;
  /** 画素ごとの最終ラベル（0..regionCount-1）。-1 は未割当（シードが 1 つも無い場合のみ） */
  labels: Int32Array;
  regionCount: number;
  /** ラベルごとの面積 */
  areas: number[];
  /** ラベルが背景（画像の外周に接する領域）か */
  isBackground: boolean[];
  /** ラベルごとのシード画素の元画像平均色（白背景合成後, 0..255） */
  meanColors: [number, number, number][];
  /** ラベル同士の隣接（共有境界長）。キーは小さい方のラベル * regionCount + 大きい方 */
  adjacency: Map<number, number>;
}

/** これ以上の線画アルファを持つ画素はシードにしない（0..255）。約 0.15 */
const SEED_MAX_ALPHA = 38;

export function segment(lineart: RasterImage, source: RasterImage, params: SegmentParams): SegmentResult {
  const { width: w, height: h } = lineart;
  const n = w * h;
  const la = lineart.data;

  // 1. 二値マスク
  const thr = Math.round(params.lineThreshold * 255);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = la[i * 4 + 3]! >= thr ? 1 : 0;

  // 2. 隙間閉じ（シード判定）
  const r2 = params.gapRadius * params.gapRadius;
  const isSeed = new Uint8Array(n);
  const d2 = params.gapRadius > 0 ? squaredEdt(mask, w, h) : null;
  for (let i = 0; i < n; i++) {
    const clean = la[i * 4 + 3]! < SEED_MAX_ALPHA && !mask[i];
    isSeed[i] = clean && (!d2 || d2[i]! > r2) ? 1 : 0;
  }

  // 3. ラベリング（4 近傍、スタックによる塗りつぶし）
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let count = 0;
  const touchesBorder: boolean[] = [];
  const sumR: number[] = [];
  const sumG: number[] = [];
  const sumB: number[] = [];
  const seedCount: number[] = [];
  const sd = source.data;
  // 白背景に合成した元画像の色（色差判定・平均色用）
  const cr = new Uint8ClampedArray(n), cg = new Uint8ClampedArray(n), cb = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p++) {
    const a = sd[p * 4 + 3]! / 255;
    cr[p] = sd[p * 4]! * a + 255 * (1 - a);
    cg[p] = sd[p * 4 + 1]! * a + 255 * (1 - a);
    cb[p] = sd[p * 4 + 2]! * a + 255 * (1 - a);
  }
  const tol2 = params.colorTolerance * params.colorTolerance;
  const similar = (p: number, q: number) => {
    const dr = cr[p]! - cr[q]!, dg = cg[p]! - cg[q]!, db = cb[p]! - cb[q]!;
    return dr * dr + dg * dg + db * db <= tol2;
  };
  const joinable = (p: number, q: number) => isSeed[q] === 1 && labels[q] === -1 && similar(p, q);

  for (let start = 0; start < n; start++) {
    if (!isSeed[start] || labels[start] !== -1) continue;
    const label = count++;
    let border = false;
    let rs = 0, gs = 0, bs = 0, cnt = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      rs += cr[p]!; gs += cg[p]!; bs += cb[p]!;
      cnt++;
      if (x > 0 && joinable(p, p - 1)) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && joinable(p, p + 1)) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && joinable(p, p - w)) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && joinable(p, p + w)) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    touchesBorder.push(border);
    sumR.push(rs); sumG.push(gs); sumB.push(bs); seedCount.push(cnt);
  }

  if (count === 0) {
    return { width: w, height: h, labels, regionCount: 0, areas: [], isBackground: [], meanColors: [], adjacency: new Map() };
  }

  // 4. 成長（線下補完）: 多始点幅優先探索を 2 段階で行う
  //   段階 1: 線ではない画素だけに広げる。各領域はまず線で囲まれた自分の空間を埋める。
  //   段階 2: 残り（線の下と、段階 1 で届かなかった画素）に広げる。
  //   1 段階で一斉に広げると、シードの無い細い部分に、線の向こう側の領域が線を越えて先に侵入してしまう。
  const queue = stack; // 再利用（長さ n で十分）
  const grow = (allowLine: boolean) => {
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (labels[i] !== -1) queue[qt++] = i;
    while (qh < qt) {
      const p = queue[qh++]!;
      const lab = labels[p]!;
      const x = p % w;
      if (x > 0 && labels[p - 1] === -1 && (allowLine || !mask[p - 1])) { labels[p - 1] = lab; queue[qt++] = p - 1; }
      if (x < w - 1 && labels[p + 1] === -1 && (allowLine || !mask[p + 1])) { labels[p + 1] = lab; queue[qt++] = p + 1; }
      if (p >= w && labels[p - w] === -1 && (allowLine || !mask[p - w])) { labels[p - w] = lab; queue[qt++] = p - w; }
      if (p + w < n && labels[p + w] === -1 && (allowLine || !mask[p + w])) { labels[p + w] = lab; queue[qt++] = p + w; }
    }
  };
  grow(false);
  grow(true);

  // 5. 統合
  const uf = new UnionFind(count);
  const areas = new Array<number>(count).fill(0);
  for (let i = 0; i < n; i++) areas[labels[i]!]!++;

  // 隣接グラフ（ラベル → (隣接ラベル → 共有境界長)）
  const adj: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  // 線の上ではない（両側とも線マスク外の）共有境界の長さ。キー: 小さい方 * count + 大きい方
  const openEdges = new Map<number, number>();
  const addEdge = (a: number, b: number, open: boolean) => {
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + 1);
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + 1);
    if (open) {
      const k = a < b ? a * count + b : b * count + a;
      openEdges.set(k, (openEdges.get(k) ?? 0) + 1);
    }
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const a = labels[p]!;
      if (x < w - 1 && labels[p + 1] !== a) addEdge(a, labels[p + 1]!, !mask[p] && !mask[p + 1]);
      if (y < h - 1 && labels[p + w] !== a) addEdge(a, labels[p + w]!, !mask[p] && !mask[p + w]);
    }
  }
  // 統合前の各領域の境界長
  const boundary = adj.map((m) => {
    let t = 0;
    for (const v of m.values()) t += v;
    return t;
  });

  const bg = new Array<boolean>(count).fill(false);
  const merge = (from: number, into: number) => {
    // from を into に吸収（両方ともルート）。隣接マップ・面積・色の累積を引き継ぐ
    uf.parent[from] = into;
    areas[into]! += areas[from]!;
    sumR[into]! += sumR[from]!; sumG[into]! += sumG[from]!; sumB[into]! += sumB[from]!;
    seedCount[into]! += seedCount[from]!;
    bg[into] = bg[into]! || bg[from]!;
    touchesBorder[into] = touchesBorder[into]! || touchesBorder[from]!;
    const fromAdj = adj[from]!;
    const intoAdj = adj[into]!;
    for (const [nb, len] of fromAdj) {
      if (nb === into) continue;
      intoAdj.set(nb, (intoAdj.get(nb) ?? 0) + len);
      const nbAdj = adj[nb]!;
      nbAdj.delete(from);
      nbAdj.set(into, (nbAdj.get(into) ?? 0) + len);
    }
    intoAdj.delete(from);
    fromAdj.clear();
  };

  // 5a. 断片の統合（隙間閉じで細切れになった細い領域をつなぎ直す）
  {
    const meanOf = (l: number): [number, number, number] => {
      const c = Math.max(1, seedCount[l]!);
      return [sumR[l]! / c, sumG[l]! / c, sumB[l]! / c];
    };
    // 細い領域の判定（統合前の値で判定する）
    const thinWidth = 4 * params.gapRadius + 2;
    const isThin = (l: number) => (2 * areas[l]!) / Math.max(1, boundary[l]!) <= thinWidth;
    const pairs = params.gapRadius <= 0 ? [] : [...openEdges.keys()]
      .map((k) => ({ a: Math.floor(k / count), b: k % count }))
      .filter(({ a, b }) => isThin(a) && isThin(b));
    for (const { a, b } of pairs) {
      const ra = uf.find(a), rb = uf.find(b);
      if (ra === rb) continue;
      const [r1, g1, b1] = meanOf(ra), [r2_, g2, b2] = meanOf(rb);
      const dc = (r1 - r2_) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
      if (dc > tol2) continue;
      if (areas[ra]! >= areas[rb]!) merge(rb, ra);
      else merge(ra, rb);
    }
  }

  // 5b. 外周に接する領域を 1 つの背景に統合
  if (params.borderAsBackground) {
    let bgRoot = -1;
    for (let l = 0; l < count; l++) {
      if (uf.parent[l] !== l || !touchesBorder[l]) continue;
      if (bgRoot === -1) { bgRoot = l; bg[l] = true; }
      else merge(l, bgRoot);
    }
  }

  const roots = () => {
    const out: number[] = [];
    for (let l = 0; l < count; l++) if (uf.parent[l] === l) out.push(l);
    return out;
  };
  const bestNeighbour = (l: number): number => {
    let best = -1, bestLen = -1;
    for (const [nb, len] of adj[l]!) if (len > bestLen) { best = nb; bestLen = len; }
    return best;
  };

  // 5c. 微小領域の吸収（小さい順。吸収で隣接が大きくなるので 1 件ずつ評価）
  const minArea = Math.max(1, Math.round(params.minAreaRatio * n));
  const small = roots().filter((l) => areas[l]! < minArea).sort((a, b) => areas[a]! - areas[b]!);
  for (const l of small) {
    if (uf.parent[l] !== l || areas[l]! >= minArea || bg[l]) continue;
    const nb = bestNeighbour(l);
    if (nb >= 0) merge(l, nb);
  }

  // 5d. パーツ数の上限（背景以外のルート数）
  let partRoots = roots().filter((l) => !bg[l]);
  if (partRoots.length > params.maxParts) {
    partRoots.sort((a, b) => areas[a]! - areas[b]!);
    let excess = partRoots.length - params.maxParts;
    for (const l of partRoots) {
      if (excess <= 0) break;
      if (uf.parent[l] !== l) continue;
      const nb = bestNeighbour(l);
      if (nb >= 0) { merge(l, nb); excess--; }
    }
  }

  // ラベルの詰め直し
  const finalRoots = roots();
  const remap = new Int32Array(count).fill(-1);
  finalRoots.forEach((r, i) => (remap[r] = i));
  for (let i = 0; i < n; i++) labels[i] = remap[uf.find(labels[i]!)]!;

  const adjacency = new Map<number, number>();
  const m = finalRoots.length;
  for (const r of finalRoots) {
    for (const [nb, len] of adj[r]!) {
      const a = remap[r]!, b = remap[nb]!;
      if (a < b) adjacency.set(a * m + b, len);
    }
  }

  return {
    width: w,
    height: h,
    labels,
    regionCount: m,
    areas: finalRoots.map((r) => areas[r]!),
    isBackground: finalRoots.map((r) => bg[r]!),
    meanColors: finalRoots.map((r) => {
      const c = Math.max(1, seedCount[r]!);
      return [sumR[r]! / c, sumG[r]! / c, sumB[r]! / c];
    }),
    adjacency,
  };
}

class UnionFind {
  parent: Int32Array;
  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r]!;
    while (this.parent[x] !== r) {
      const next = this.parent[x]!;
      this.parent[x] = r;
      x = next;
    }
    return r;
  }
}
