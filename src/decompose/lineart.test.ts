import { describe, expect, it } from "vitest";
import { lightness01 } from "./color";
import { extractLineart } from "./lineart";
import { decompose } from "./pipeline";
import { Sketch } from "./testImages";
import { DEFAULT_DECOMPOSE_PARAMS } from "./types";

const P = { ...DEFAULT_DECOMPOSE_PARAMS.lineart, method: "lightness" as const };
const T = { ...DEFAULT_DECOMPOSE_PARAMS.lineart, method: "tophat" as const, maxLineWidth: 8 };
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

describe("extractLineart（tophat / L-3）", () => {
  const alphaAt = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]!;

  it("白背景では lightness と同じ結果", () => {
    const s = new Sketch(40, 40);
    s.fillRect(10, 0, 3, 40);
    s.fillRect(25, 0, 1, 40, [160, 160, 160]);
    const a = extractLineart(s.image(), P), b = extractLineart(s.image(), T);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it("細い線は線、maxLineWidth より太い塗りは線にならない", () => {
    const s = new Sketch(60, 30);
    s.fillRect(5, 0, 3, 30); // 細線 3px
    s.fillRect(20, 0, 30, 30, [200, 40, 40]); // 太い赤の塗り
    const out = extractLineart(s.image(), T);
    expect(alphaAt(out, 6, 15)).toBe(255);
    expect(alphaAt(out, 35, 15)).toBe(0);
  });

  it("色の塗りの上の黒線は線として抽出される", () => {
    const s = new Sketch(60, 30);
    s.fillRect(0, 0, 60, 30, [200, 40, 40]);
    s.fillRect(29, 0, 3, 30);
    const out = extractLineart(s.image(), T);
    expect(alphaAt(out, 30, 15)).toBeGreaterThan(200);
    expect(alphaAt(out, 10, 15)).toBe(0);
  });

  it("照明ムラ（左が暗い紙）でも紙は透明、線は不透明", () => {
    const s = new Sketch(100, 20);
    for (let x = 0; x < 100; x++) {
      const v = Math.round(130 + x * 1.25); // 紙の明るさ 130→254
      s.fillRect(x, 0, 1, 20, [v, v, v]);
    }
    s.fillRect(10, 0, 2, 20); // 暗い側の線
    s.fillRect(90, 0, 2, 20); // 明るい側の線
    const l1 = extractLineart(s.image(), P), l3 = extractLineart(s.image(), T);
    expect(alphaAt(l1, 3, 10)).toBeGreaterThan(100); // L-1 は暗い紙を線とみなしてしまう
    expect(alphaAt(l3, 3, 10)).toBe(0);
    expect(alphaAt(l3, 50, 10)).toBe(0);
    expect(alphaAt(l3, 10, 10)).toBeGreaterThan(100);
    expect(alphaAt(l3, 90, 10)).toBe(255);
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
