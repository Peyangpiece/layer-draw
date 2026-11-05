/**
 * レイヤーツリーの合成（Canvas 2D 実装）。
 *
 * 仕様書 10 章では WebGL2 での合成を想定しているが、フレームワーク段階では
 * 実装が単純な Canvas 2D で `Compositor` インターフェースを満たし、後で差し替える。
 *
 * 合成規則:
 *  - children は先頭が最前面なので、末尾（最背面）から順に描く
 *  - フォルダは一旦オフスクリーンに合成してから、フォルダの合成モード・不透明度で親に重ねる
 *  - クリッピング: 基底レイヤー＋直後（前面側）に連続する clipping=true のレイヤー群を
 *    「クリッピンググループ」として扱う。各クリッピングレイヤーは基底のアルファで切り抜いた後、
 *    自身の合成モードで基底の上に重ねる。グループ全体は基底の合成モード・不透明度で親に重ねる。
 */
import type { BitmapStore } from "../core/bitmapStore";
import { createCanvas } from "../core/bitmapStore";
import type { BlendMode, LayerDocument, LayerGroup, LayerNode } from "../core/types";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** 描画中のレイヤーなど、ビットマップの代わりに表示するキャンバス（ドキュメント座標の (x, y) に置く） */
export interface LayerOverride {
  canvas: AnyCanvas;
  x: number;
  y: number;
}

export interface Compositor {
  render(doc: LayerDocument, target: HTMLCanvasElement, overrides?: Map<string, LayerOverride>): void;
}

const BLEND_TO_COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  add: "lighter",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export class Canvas2DCompositor implements Compositor {
  constructor(private store: BitmapStore) {}

  private overrides: Map<string, LayerOverride> | undefined;

  /** overrides: レイヤー ID → 代わりに描くキャンバス（ペン・消しゴムで描いている途中の表示用） */
  render(doc: LayerDocument, target: HTMLCanvasElement, overrides?: Map<string, LayerOverride>): void {
    this.overrides = overrides;
    if (target.width !== doc.width || target.height !== doc.height) {
      target.width = doc.width;
      target.height = doc.height;
    }
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, doc.width, doc.height);
    this.drawChildren(ctx, doc.root, doc.width, doc.height);
  }

  private drawChildren(ctx: Ctx2D, group: LayerGroup, w: number, h: number): void {
    const nodes = group.children;
    // 末尾（最背面）から前面へ。clipping=true のノードは基底側で処理するため読み飛ばす。
    for (let i = nodes.length - 1; i >= 0; i--) {
      const base = nodes[i]!;
      // 最背面にある clipping レイヤーは基底が無いため通常レイヤーとして扱う
      if (base.clipping && i < nodes.length - 1) continue;

      // base の前面側に連続する clipping レイヤーを集める（index が小さい方が前面）
      const clips: LayerNode[] = [];
      for (let j = i - 1; j >= 0 && nodes[j]!.clipping; j--) clips.push(nodes[j]!);

      if (!base.visible) continue; // 基底が非表示ならクリッピング群も表示されない
      if (clips.length === 0) {
        this.drawNode(ctx, base, w, h, base.blendMode, base.opacity);
        continue;
      }
      const tmp = createCanvas(w, h);
      const tctx = get2d(tmp);
      this.drawNode(tctx, base, w, h, "normal", 1);
      for (const clip of clips) {
        if (!clip.visible) continue;
        const layerCanvas = createCanvas(w, h);
        const lctx = get2d(layerCanvas);
        this.drawNode(lctx, clip, w, h, "normal", 1);
        // 基底のアルファで切り抜く
        lctx.globalCompositeOperation = "destination-in";
        lctx.drawImage(tmp, 0, 0);
        tctx.globalCompositeOperation = BLEND_TO_COMPOSITE[clip.blendMode];
        tctx.globalAlpha = clip.opacity;
        // 切り抜き済みのレイヤーを、自身の合成モードで基底の上に重ねる
        tctx.drawImage(layerCanvas, 0, 0);
        tctx.globalAlpha = 1;
        tctx.globalCompositeOperation = "source-over";
      }
      blit(ctx, tmp, base.blendMode, base.opacity);
    }
  }

  private drawNode(ctx: Ctx2D, node: LayerNode, w: number, h: number, blend: BlendMode, opacity: number): void {
    if (!node.visible) return;
    if (node.kind === "raster") {
      const ov = this.overrides?.get(node.id);
      const src = ov ? ov.canvas : this.store.getCanvas(node.bitmapId);
      if (!src) return;
      ctx.globalCompositeOperation = BLEND_TO_COMPOSITE[blend];
      ctx.globalAlpha = opacity;
      ctx.drawImage(src, ov ? ov.x : node.bounds.x, ov ? ov.y : node.bounds.y);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    const tmp = createCanvas(w, h);
    this.drawChildren(get2d(tmp), node, w, h);
    blit(ctx, tmp, blend, opacity);
  }
}

function blit(ctx: Ctx2D, src: AnyCanvas, blend: BlendMode, opacity: number): void {
  ctx.globalCompositeOperation = BLEND_TO_COMPOSITE[blend];
  ctx.globalAlpha = opacity;
  ctx.drawImage(src, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function get2d(c: AnyCanvas): Ctx2D {
  const ctx = c.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("2D コンテキストを取得できません");
  return ctx;
}
