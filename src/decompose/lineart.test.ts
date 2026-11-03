import { describe, expect, it } from "vitest";
import { lightness01 } from "./color";
import { extractLineart } from "./lineart";
import { decompose } from "./pipeline";
import { DEFAULT_DECOMPOSE_PARAMS } from "./types";

const P = DEFAULT_DECOMPOSE_PARAMS.lineart;
const img = (...px: number[][]) => ({ width: px.length, height: 1, data: new Uint8ClampedArray(px.flat()) });

describe("lightness01", () => {
  it("黒=0, 白=1, 中間グレー(118)は約0.5", () => {
    expect(lightness01(0, 0, 0)).toBe(0);
    expect(lightness01(255, 255, 255)).toBeCloseTo(1, 4);
    // sRGB 118 は L*≈50 になることが知られている
    expect(lightness01(118, 118, 118)).toBeCloseTo(0.5, 1);
  });
});

describe("extractLineart", () => {
  it("黒は不透明、白は透明、中間は中間アルファ（二値化しない）", () => {
    const out = extractLineart(img([0, 0, 0, 255], [255, 255, 255, 255], [160, 160, 160, 255]), P);
    expect(out.data[3]).toBe(255);
    expect(out.data[7]).toBe(0);
    expect(out.data[11]).toBeGreaterThan(0);
    expect(out.data[11]).toBeLessThan(255);
  });
  it("透明画素は白背景扱いで透明になる", () => {
    const out = extractLineart(img([0, 0, 0, 0]), P);
    expect(out.data[3]).toBe(0);
  });
  it("lineColor=original: 白背景に合成し直すと元の色に戻る", () => {
    const src = [200, 0, 0, 255];
    const out = extractLineart(img(src), { ...P, lineColor: "original" });
    const a = out.data[3]! / 255;
    expect(a).toBe(1); // G=B=0 の純色は完全不透明でないと表現できない
    for (let c = 0; c < 3; c++) {
      expect(out.data[c]! * a + 255 * (1 - a)).toBeCloseTo(src[c]!, -0.5); // 8bit 丸め誤差 ±1.6 以内
    }
  });
  it("lineColor=original: 灰色のアンチエイリアス画素は中間アルファで黒に近い線色になる", () => {
    const src = [160, 160, 160, 255];
    const out = extractLineart(img(src), { ...P, lineColor: "original" });
    const a = out.data[3]! / 255;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(out.data[0]! * a + 255 * (1 - a)).toBeCloseTo(160, -0.5);
  });
  it("lineColor=black は RGB を 0 にする", () => {
    const out = extractLineart(img([200, 0, 0, 255]), P);
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([0, 0, 0]);
  });
});

describe("decompose pipeline", () => {
  it("線画とタイミングを返し、キャンセルで中断する", () => {
    const src = img([0, 0, 0, 255], [255, 255, 255, 255]);
    const r = decompose(src, DEFAULT_DECOMPOSE_PARAMS);
    expect(r.lineart.width).toBe(2);
    expect(Object.keys(r.timings)).toContain("lineart");
    expect(() => decompose(src, DEFAULT_DECOMPOSE_PARAMS, undefined, { cancelled: true })).toThrow("cancelled");
  });
});
