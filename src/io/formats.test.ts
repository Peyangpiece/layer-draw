import { describe, expect, it } from "vitest";
import { detectFormat } from "./formats";

const enc = (s: string) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("PNG シグネチャを判定する", () => {
    expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({ ok: true, format: "png" });
  });
  it("JPEG シグネチャを判定する", () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, format: "jpeg" });
  });
  it("素の SVG を判定する", () => {
    expect(detectFormat(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({ ok: true, format: "svg" });
  });
  it("BOM・XML 宣言・コメント・DOCTYPE 付き SVG を判定する", () => {
    const s =
      '﻿<?xml version="1.0"?>\n<!-- Generator: X -->\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [ <!ENTITY a "b"> ]>\n' +
      '<svg width="10" height="10"/>';
    expect(detectFormat(enc(s))).toEqual({ ok: true, format: "svg" });
  });
  it("svg 以外の XML / HTML は拒否する", () => {
    expect(detectFormat(enc("<?xml version='1.0'?><html></html>")).ok).toBe(false);
    expect(detectFormat(enc("<svgfoo></svgfoo>")).ok).toBe(false);
  });
  it("gzip（svgz）は理由付きで拒否する", () => {
    const r = detectFormat(new Uint8Array([0x1f, 0x8b, 0x08]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/svgz/);
  });
  it("GIF などは拒否する", () => {
    expect(detectFormat(enc("GIF89a")).ok).toBe(false);
  });
});
