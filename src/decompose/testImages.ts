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
  image(): RasterImage {
    return { width: this.width, height: this.height, data: this.data };
  }
}
