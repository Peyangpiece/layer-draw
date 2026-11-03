/**
 * 厳密ユークリッド距離変換（Felzenszwalb & Huttenlocher, "Distance Transforms of Sampled Functions", 2012）。
 * 各画素から最も近い「特徴画素（mask=1）」までの距離の二乗を O(画素数) で求める。
 */

const INF = 1e20;

/** 1 次元の下側包絡線による距離変換。f: 入力（特徴=0, それ以外=INF）、d: 出力 */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const vk = v[k]!;
      s = (f[q]! + q * q - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
      if (s <= z[k]! && k > 0) k--;
      else break;
    }
    // k=0 で s <= z[0](-INF) にはならないため、ここで k は正しい位置
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const vk = v[k]!;
    d[q] = (q - vk) * (q - vk) + f[vk]!;
  }
}

/**
 * @param mask 1=特徴画素（線）、0=それ以外。長さ width*height
 * @returns 各画素の、最も近い特徴画素までのユークリッド距離の二乗（特徴画素が無ければ非常に大きい値）
 */
export function squaredEdt(mask: Uint8Array, width: number, height: number): Float32Array {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const tmp = new Float64Array(width * height);
  const out = new Float32Array(width * height);

  // 列方向
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = mask[y * width + x] ? 0 : INF;
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) tmp[y * width + x] = d[y]!;
  }
  // 行方向
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = tmp[row + x]!;
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[row + x] = d[x]!;
  }
  return out;
}
