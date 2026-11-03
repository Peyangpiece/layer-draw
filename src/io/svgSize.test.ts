import { describe, expect, it } from "vitest";
import { fitLongSide, parseLength, parseViewBox, resolveSvgSize } from "./svgSize";

describe("parseLength", () => {
  it.each([
    ["100", 100],
    ["100px", 100],
    ["1in", 96],
    ["2.54cm", 96],
    ["25.4mm", 96],
    ["72pt", 96],
    ["6pc", 96],
    ["1e2", 100],
  ])("%s → %d px", (v, px) => {
    expect(parseLength(v)).toBeCloseTo(px, 9);
  });
  it.each(["100%", "2em", "auto", "", "-5", "0"])("%s は解決不能", (v) => {
    expect(parseLength(v)).toBeNull();
  });
});

describe("parseViewBox", () => {
  it("空白・カンマ区切りを解釈する", () => {
    expect(parseViewBox("0,0 200, 100")).toEqual({ minX: 0, minY: 0, width: 200, height: 100 });
  });
  it("幅・高さが 0 以下なら null", () => {
    expect(parseViewBox("0 0 0 10")).toBeNull();
  });
});

describe("resolveSvgSize", () => {
  it("width/height 優先", () => {
    expect(resolveSvgSize({ width: "40", height: "30", viewBox: "0 0 400 300" })).toMatchObject({ width: 40, height: 30, from: "attributes" });
  });
  it("width のみ＋viewBox は縦横比から height を求める", () => {
    expect(resolveSvgSize({ width: "200", viewBox: "0 0 400 300" })).toMatchObject({ width: 200, height: 150, from: "mixed" });
  });
  it("% 指定は viewBox にフォールバック", () => {
    expect(resolveSvgSize({ width: "100%", height: "100%", viewBox: "0 0 400 300" })).toMatchObject({ width: 400, height: 300, from: "viewBox" });
  });
  it("情報が無ければ既定値", () => {
    expect(resolveSvgSize({})).toMatchObject({ width: 300, height: 150, from: "default" });
  });
});

describe("fitLongSide", () => {
  it("縦横比を保って長辺を合わせる", () => {
    expect(fitLongSide(400, 300, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitLongSide(300, 6000, 4096)).toEqual({ width: 205, height: 4096 });
  });
});
