import { describe, expect, it } from "vitest";
import { placeOnCanvas } from "./buildFromLayered";

describe("placeOnCanvas", () => {
  it("レイヤーの位置に置き、外は透明。はみ出す部分は切り捨てる", () => {
    const img = { width: 2, height: 2, data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255]) };
    const out = placeOnCanvas(img, { x: 3, y: 1, w: 2, h: 2 }, 4, 3);
    const px = (x: number, y: number) => Array.from(out.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    expect(px(3, 1)).toEqual([1, 1, 1, 255]);
    expect(px(3, 2)).toEqual([3, 3, 3, 255]);
    expect(px(0, 0)).toEqual([0, 0, 0, 0]);
    expect(out.data.length).toBe(4 * 3 * 4); // x=4 の列は画像の外なので切り捨て
  });
});
