import { newId } from "./id";

/**
 * レイヤーのピクセルデータ置き場。
 * 現段階はメモリ上の Map。仕様書 9 章の IndexedDB/OPFS 永続化は後続で差し替える。
 *
 * 各ビットマップは ImageData（CPU 側の真実の値）と、描画用にキャッシュした canvas を持つ。
 */
export class BitmapStore {
  private data = new Map<string, ImageData>();
  private canvasCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

  add(image: ImageData, id = newId("bmp")): string {
    this.data.set(id, image);
    this.canvasCache.delete(id);
    return id;
  }

  get(id: string): ImageData | undefined {
    return this.data.get(id);
  }

  /** 描画用 canvas を返す（初回のみ ImageData から生成） */
  getCanvas(id: string): HTMLCanvasElement | OffscreenCanvas | undefined {
    const cached = this.canvasCache.get(id);
    if (cached) return cached;
    const img = this.data.get(id);
    if (!img) return undefined;
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error("2D コンテキストを取得できません");
    ctx.putImageData(img, 0, 0);
    this.canvasCache.set(id, canvas);
    return canvas;
  }

  delete(id: string): void {
    this.data.delete(id);
    this.canvasCache.delete(id);
  }

  /** 参照されていない ID を解放する（取り消し履歴が保持する ID も live に含めること） */
  gc(liveIds: Set<string>): void {
    for (const id of [...this.data.keys()]) {
      if (!liveIds.has(id)) this.delete(id);
    }
  }

  clear(): void {
    this.data.clear();
    this.canvasCache.clear();
  }
}

export function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}
