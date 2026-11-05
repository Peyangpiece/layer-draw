/**
 * OpenRaster の stack.xml を読むための小さな XML パーサー（要素と属性だけ。テキスト・名前空間は扱わない）。
 * DOMParser は Worker や Node に無いので、DOM に依存しないこの実装を使う。
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(text: string): XmlElement {
  // 宣言・コメント・処理命令・DOCTYPE を除く
  const src = text.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src))) {
    const [, closing, name, attrText, selfClosing] = m;
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`XML の閉じタグが対応していません: </${name}>`);
      continue;
    }
    const el: XmlElement = { name: name!, attrs: {}, children: [] };
    let a: RegExpExecArray | null;
    attr.lastIndex = 0;
    while ((a = attr.exec(attrText!))) el.attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length !== 1) throw new Error("XML の要素が閉じられていません");
  const first = root.children[0];
  if (!first) throw new Error("XML に要素がありません");
  return first;
}
