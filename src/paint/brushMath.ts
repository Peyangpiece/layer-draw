/**
 * ペン・消しゴムの計算（DOM 非依存）。
 */
export interface BrushPoint {
  x: number;
  y: number;
  /** 筆圧 0..1 */
  p: number;
}

/** 筆圧を使うときの最小の太さの割合（筆圧 0 でも消えないように） */
export const MIN_PRESSURE_SCALE = 0.15;

/** その点でのブラシの直径。筆圧を使わない場合はそのまま */
export function diameterAt(size: number, pressure: number, usePressure: boolean): number {
  if (!usePressure) return size;
  const p = Math.min(1, Math.max(0, pressure));
  return size * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * p);
}

/**
 * 手ブレ補正: 前の補正後の位置を、新しい位置へ (1 - k) だけ寄せる（指数移動平均）。
 * smoothing 0 で補正なし、10 で最大（k = 0.85）。補正するほど線がなめらかになり、ペン先から遅れる
 */
export function smooth(prev: BrushPoint | null, next: BrushPoint, smoothing: number): BrushPoint {
  if (!prev) return next;
  const k = (Math.min(10, Math.max(0, smoothing)) / 10) * 0.85;
  return { x: prev.x + (next.x - prev.x) * (1 - k), y: prev.y + (next.y - prev.y) * (1 - k), p: prev.p + (next.p - prev.p) * (1 - k) };
}

/**
 * a から b までの線分上に、ブラシを打つ位置を並べる（a 自身は含めず、b は含む）。
 * 間隔は、その位置の直径の 15%（最小 0.5px）。carry は前の線分で余った距離で、
 * 線分の継ぎ目でも間隔が一定になるように引き継ぐ。
 */
export function stampsBetween(
  a: BrushPoint,
  b: BrushPoint,
  size: number,
  usePressure: boolean,
  carry: number,
): { stamps: BrushPoint[]; carry: number } {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const stamps: BrushPoint[] = [];
  let t = carry;
  // 打つ位置 t（a からの距離）を進める
  for (;;) {
    const f = len === 0 ? 1 : t / len;
    const p = a.p + (b.p - a.p) * Math.min(1, f);
    const spacing = Math.max(0.5, diameterAt(size, p, usePressure) * 0.15);
    if (t === 0) {
      t = spacing; // a 自身は前の線分で打っている
      continue;
    }
    if (t > len) return { stamps, carry: t - len };
    stamps.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, p });
    t += spacing;
  }
}
