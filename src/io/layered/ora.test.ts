import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ImportedGroup, ImportedRaster } from "./model";
import { parseOra } from "./ora";
import { LayeredImportError } from "./psd";
import { parseXml } from "./xml";

/** テスト用: 「PNG」の代わりに [幅, 高さ, R, G, B, A] だけを入れたファイルと、その展開関数 */
const fakePng = (w: number, h: number, rgba: number[]) => new Uint8Array([w, h, ...rgba]);
const decode = async (b: Uint8Array) => {
  const w = b[0]!, h = b[1]!, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(b.subarray(2, 6), i * 4);
  return { width: w, height: h, data };
};

function makeOra(stack: string, extra: Record<string, Uint8Array> = {}, mimetype = "image/openraster") {
  return zipSync({ mimetype: [strToU8(mimetype), { level: 0 }], "stack.xml": strToU8(stack), ...extra });
}

describe("parseXml", () => {
  it("要素・属性・入れ子・自己終了タグ・文字参照を読む", () => {
    const x = parseXml(`<?xml version="1.0"?><!-- c --><image w="10" h='20'><stack><layer name="a &amp; b" src="x.png"/></stack></image>`);
    expect(x.name).toBe("image");
    expect(x.attrs).toEqual({ w: "10", h: "20" });
    expect(x.children[0]!.children[0]!.attrs["name"]).toBe("a & b");
  });
  it("閉じタグが合わなければエラー", () => {
    expect(() => parseXml("<a><b></a>")).toThrow();
  });
});

describe("parseOra", () => {
  it("並び（先頭が最前面）・位置・不透明度・表示・合成モード・入れ子を読み込む", async () => {
    const stack = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.5" w="64" h="48">
  <stack>
    <layer name="線画" src="data/line.png" x="3" y="4" opacity="0.8" composite-op="svg:multiply"/>
    <stack name="塗り" visibility="hidden" opacity="0.5">
      <layer name="肌" src="data/skin.png"/>
    </stack>
    <layer name="背景" src="data/bg.png" composite-op="svg:plus"/>
  </stack>
</image>`;
    const ora = makeOra(stack, {
      "data/line.png": fakePng(2, 2, [0, 0, 0, 255]),
      "data/skin.png": fakePng(3, 1, [250, 200, 180, 255]),
      "data/bg.png": fakePng(64, 48, [255, 255, 255, 255]),
    });
    const r = await parseOra(ora, decode);
    expect([r.format, r.width, r.height]).toEqual(["ora", 64, 48]);
    expect(r.children.map((n) => n.name)).toEqual(["線画", "塗り", "背景"]);
    const line = r.children[0] as ImportedRaster;
    expect([line.x, line.y, line.opacity, line.blendMode]).toEqual([3, 4, 0.8, "multiply"]);
    const fills = r.children[1] as ImportedGroup;
    expect([fills.kind, fills.visible, fills.opacity]).toEqual(["group", false, 0.5]);
    expect(fills.children.map((n) => n.name)).toEqual(["肌"]);
    expect((r.children[2] as ImportedRaster).blendMode).toBe("add");
    expect(r.warnings).toEqual([]);
  });

  it("対応しない合成モード・画像の無いレイヤーは警告する", async () => {
    const ora = makeOra(`<image w="4" h="4"><stack><layer name="a" src="a.png" composite-op="krita:burn"/><layer name="b" src="missing.png"/></stack></image>`, {
      "a.png": fakePng(1, 1, [1, 2, 3, 255]),
    });
    const r = await parseOra(ora, decode);
    expect(r.children.map((n) => n.name)).toEqual(["a"]);
    expect(r.warnings).toEqual(["合成モード「krita:burn」には対応していないため「通常」にしました", "画像ファイルが見つからないレイヤーを読み飛ばしました"]);
  });

  it("OpenRaster でなければ理由付きのエラー", async () => {
    await expect(parseOra(makeOra("<image/>", {}, "application/x-krita"), decode)).rejects.toThrow(LayeredImportError);
    await expect(parseOra(new Uint8Array([1, 2, 3]), decode)).rejects.toThrow(LayeredImportError);
  });
});
