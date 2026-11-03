/**
 * グレースケールのモルフォロジー演算（正方形の構造要素）。
 * 1 次元のスライディング最大/最小を単調キューで O(n) に求め、行→列の順に分離して適用する。
 */

// 最大用と最小用を別関数にしているのは、比較関数を引数で渡すと 1 要素ごとの関数呼び出しで大幅に遅くなるため
function slideMax(src: Float32Array, dst: Float32Array, len: number, stride: number, offset: number, r: number, idx: Int32Array): void {
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < len; i++) {
    const hi = i + r < len ? i + r : len - 1;
    while (next <= hi) {
      const v = src[offset + next * stride]!;
      while (tail > head && v >= src[offset + idx[tail - 1]! * stride]!) tail--;
      idx[tail++] = next++;
    }
    while (idx[head]! < i - r) head++;
    dst[offset + i * stride] = src[offset + idx[head]! * stride]!;
  }
}

function slideMin(src: Float32Array, dst: Float32Array, len: number, stride: number, offset: number, r: number, idx: Int32Array): void {
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < len; i++) {
    const hi = i + r < len ? i + r : len - 1;
    while (next <= hi) {
      const v = src[offset + next * stride]!;
      while (tail > head && v <= src[offset + idx[tail - 1]! * stride]!) tail--;
      idx[tail++] = next++;
    }
    while (idx[head]! < i - r) head++;
    dst[offset + i * stride] = src[offset + idx[head]! * stride]!;
  }
}

function filter2d(img: Float32Array, w: number, h: number, r: number, isMax: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const idx = new Int32Array(Math.max(w, h));
  const slide = isMax ? slideMax : slideMin;
  for (let y = 0; y < h; y++) slide(img, tmp, w, 1, y * w, r, idx);
  for (let x = 0; x < w; x++) slide(tmp, out, h, w, x, r, idx);
  return out;
}

export function dilate(img: Float32Array, w: number, h: number, r: number): Float32Array {
  return filter2d(img, w, h, r, true);
}

export function erode(img: Float32Array, w: number, h: number, r: number): Float32Array {
  return filter2d(img, w, h, r, false);
}

/** クロージング（膨張→収縮）: 一辺 2r+1 より細い暗い構造を周囲の明るさで埋める */
export function closing(img: Float32Array, w: number, h: number, r: number): Float32Array {
  return erode(dilate(img, w, h, r), w, h, r);
}
