/** テスト・ベンチマーク用の合成画像（白背景に黒線） */
import type { RasterImage } from "./types";

export class Sketch {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }
  px(x: number, y: number, rgb: [number, number, number] = [0, 0, 0]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    this.data[o] = rgb[0]; this.data[o + 1] = rgb[1]; this.data[o + 2] = rgb[2]; this.data[o + 3] = 255;
  }
  /** 太さ t の軸平行の矩形（塗りつぶし） */
  fillRect(x: number, y: number, w: number, h: number, rgb: [number, number, number] = [0, 0, 0]) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, rgb);
  }
  /** 線幅 t の矩形の枠 */
  strokeRect(x: number, y: number, w: number, h: number, t: number) {
    this.fillRect(x, y, w, t); this.fillRect(x, y + h - t, w, t);
    this.fillRect(x, y, t, h); this.fillRect(x + w - t, y, t, h);
  }
  /** 中心 (cx,cy)、半径 r、線幅 t の円。gapDeg の角度範囲（0° 付近）を描かない */
  strokeCircle(cx: number, cy: number, r: number, t: number, gapPx = 0) {
    for (let y = Math.floor(cy - r - t); y <= cy + r + t; y++) {
      for (let x = Math.floor(cx - r - t); x <= cx + r + t; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (Math.abs(d - r) > t / 2) continue;
        if (gapPx > 0 && x > cx && Math.abs(y - cy) < gapPx / 2) continue;
        this.px(x, y);
      }
    }
  }
  /**
   * アンチエイリアス付きの塗りつぶし楕円。縁の近くの画素だけ 16×16 の超標本化で被覆率を求め、既存の色と混ぜる。
   * ブラウザの描画と同じく被覆率がほぼ連続的に変わるので、ゆるい角度の縁では
   * 縁に沿って色が少しずつ変わる画素の並びができる（4×4 程度だと段差が粗く、この並びが再現されない）
   */
  fillEllipseAA(cx: number, cy: number, rx: number, ry: number, rgb: [number, number, number]) {
    const N = 16;
    const x0 = Math.max(0, Math.floor(cx - rx - 1)), x1 = Math.min(this.width - 1, Math.ceil(cx + rx + 1));
    const y0 = Math.max(0, Math.floor(cy - ry - 1)), y1 = Math.min(this.height - 1, Math.ceil(cy + ry + 1));
    const band = 2 / Math.min(rx, ry); // 縁からおよそ 2px 以内だけ超標本化する
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const r = Math.sqrt(((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2);
        let a: number;
        if (r < 1 - band) a = 1;
        else if (r > 1 + band) a = 0;
        else {
          let hit = 0;
          for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
            const px = x + (sx + 0.5) / N, py = y + (sy + 0.5) / N;
            if (((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1) hit++;
          }
          a = hit / (N * N);
        }
        if (a === 0) continue;
        const o = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c++) this.data[o + c] = Math.round(this.data[o + c]! * (1 - a) + rgb[c]! * a);
        this.data[o + 3] = 255;
      }
    }
  }

  image(): RasterImage {
    return { width: this.width, height: this.height, data: this.data };
  }
}
