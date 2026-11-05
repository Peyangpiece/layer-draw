/**
 * ペン・消しゴムの 1 ストローク（押してから離すまで）。ブラウザの Canvas を使う。
 *
 * - 作業範囲はドキュメントとレイヤーの範囲を合わせた矩形（PSD などでキャンバス外にある画素を失わないため）
 * - ストロークはまず「下書き」キャンバスに不透明で描き、表示・確定の時に不透明度を掛けて元の画像に重ねる。
 *   こうすると 1 本の線の中で重なった所が濃くならない（ペイントアプリの一般的な描き方）
 * - ペン: 通常は上に重ねる。透明度保護では、元の画像の不透明な所だけに描く（source-atop）
 * - 消しゴム: 下書きの形で元の画像を消す（destination-out）
 */
import { createCanvas } from "../core/bitmapStore";
import { cropToContent } from "../core/partOps";
import type { Rect } from "../core/types";
import type { LayerOverride } from "../render/compositor";
import { diameterAt, smooth, stampsBetween, type BrushPoint } from "./brushMath";

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface BrushSettings {
  /** 直径（ドキュメント px） */
  size: number;
  /** 0..1 */
  opacity: number;
  usePressure: boolean;
  /** 手ブレ補正 0..10 */
  smoothing: number;
}

export interface StrokeOptions extends BrushSettings {
  mode: "pen" | "eraser";
  /** ペンの色 #rrggbb */
  color: string;
  /** 透明度保護（ペンのみ） */
  alphaLocked: boolean;
}

export interface StrokeResult {
  /** 描いた後のレイヤーの画像（不透明な画素の外接矩形）。すべて透明になった場合は 1×1 の透明画像 */
  image: ImageData;
  bounds: Rect;
}

const ctx2d = (c: AnyCanvas) => c.getContext("2d") as Ctx2D;

export class StrokeSession {
  readonly rect: Rect;
  private base: AnyCanvas;
  private buffer: AnyCanvas;
  private preview: AnyCanvas;
  private last: BrushPoint | null = null;
  private smoothed: BrushPoint | null = null;
  private carry = 0;
  private dirty = false;
  /** 1 回でも描いたか */
  touched = false;

  constructor(
    source: ImageData | undefined,
    bounds: Rect,
    docWidth: number,
    docHeight: number,
    private opts: StrokeOptions,
  ) {
    const x0 = Math.min(0, bounds.x), y0 = Math.min(0, bounds.y);
    const x1 = Math.max(docWidth, bounds.x + bounds.w), y1 = Math.max(docHeight, bounds.y + bounds.h);
    this.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this.base = createCanvas(this.rect.w, this.rect.h);
    if (source) ctx2d(this.base).putImageData(source, bounds.x - x0, bounds.y - y0);
    this.buffer = createCanvas(this.rect.w, this.rect.h);
    this.preview = createCanvas(this.rect.w, this.rect.h);
    this.updatePreview();
  }

  /** 新しい点を加える（ドキュメント座標、筆圧 0..1） */
  add(x: number, y: number, pressure: number): void {
    const raw = { x, y, p: pressure };
    const pt = smooth(this.smoothed, raw, this.opts.smoothing);
    this.smoothed = pt;
    if (!this.last) {
      this.stamp(pt);
      this.last = pt;
      return;
    }
    const { stamps, carry } = stampsBetween(this.last, pt, this.opts.size, this.opts.usePressure, this.carry);
    this.carry = carry;
    for (const s of stamps) this.stamp(s);
    this.last = pt;
  }

  private stamp(pt: BrushPoint): void {
    const c = ctx2d(this.buffer);
    const r = Math.max(0.5, diameterAt(this.opts.size, pt.p, this.opts.usePressure) / 2);
    c.fillStyle = this.opts.mode === "pen" ? this.opts.color : "#000";
    c.beginPath();
    c.arc(pt.x - this.rect.x, pt.y - this.rect.y, r, 0, Math.PI * 2);
    c.fill();
    this.dirty = true;
    this.touched = true;
  }

  private composeInto(target: AnyCanvas): void {
    const c = ctx2d(target);
    c.globalCompositeOperation = "copy";
    c.globalAlpha = 1;
    c.drawImage(this.base, 0, 0);
    c.globalCompositeOperation = this.opts.mode === "eraser" ? "destination-out" : this.opts.alphaLocked ? "source-atop" : "source-over";
    c.globalAlpha = this.opts.opacity;
    c.drawImage(this.buffer, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
  }

  /** 表示用の画像を更新する（描いた後に呼ぶ） */
  updatePreview(): void {
    if (!this.dirty && this.touched) return;
    this.composeInto(this.preview);
    this.dirty = false;
  }

  /** 合成処理でレイヤーの代わりに表示するもの */
  get override(): LayerOverride {
    return { canvas: this.preview, x: this.rect.x, y: this.rect.y };
  }

  /** ストロークを確定し、描いた後のレイヤーの画像を返す */
  finish(): StrokeResult {
    this.updatePreview();
    const d = ctx2d(this.preview).getImageData(0, 0, this.rect.w, this.rect.h);
    const cropped = cropToContent({ x: this.rect.x, y: this.rect.y, image: { width: d.width, height: d.height, data: d.data } });
    if (!cropped) return { image: new ImageData(1, 1), bounds: { x: 0, y: 0, w: 1, h: 1 } };
    const img = new ImageData(cropped.image.data as Uint8ClampedArray<ArrayBuffer>, cropped.image.width, cropped.image.height);
    return { image: img, bounds: { x: cropped.x, y: cropped.y, w: img.width, h: img.height } };
  }
}
