import { describe, expect, it } from "vitest";
import { createDocument, createGroup, createRasterLayer, findNode, insertNode, listRasterLayers, moveNode, removeNode, updateNode } from "./document";
import { canUndo, commit, createHistory, push, redo, replace, undo } from "./history";

const layer = (name: string) => createRasterLayer({ name, bitmapId: name, bounds: { x: 0, y: 0, w: 1, h: 1 } });

describe("document ops", () => {
  const a = layer("a"), b = layer("b"), c = layer("c");
  const doc = createDocument("t", 10, 10, createGroup("root", [a, createGroup("g", [b]), c]));

  it("updateNode はネストしたノードも更新し、元を変更しない", () => {
    const next = updateNode(doc, b.id, { opacity: 0.5 });
    expect(findNode(next.root, b.id)?.opacity).toBe(0.5);
    expect(findNode(doc.root, b.id)?.opacity).toBe(1);
  });
  it("moveNode / removeNode / insertNode", () => {
    expect(moveNode(doc, a.id, 2).root.children.map((n) => n.name)).toEqual(["g", "c", "a"]);
    expect(listRasterLayers(removeNode(doc, b.id).root).map((l) => l.name)).toEqual(["a", "c"]);
    const d = layer("d");
    expect(listRasterLayers(insertNode(doc, d, 0, doc.root.children[1]!.id).root).map((l) => l.name)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("history", () => {
  it("push / undo / redo", () => {
    let h = createHistory(0);
    h = push(h, 1);
    h = push(h, 2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
  });
  it("replace の連続は commit で 1 ステップになる", () => {
    let h = createHistory(0);
    h = replace(h, 1);
    h = replace(h, 2);
    h = replace(h, 3);
    expect(canUndo(h)).toBe(true);
    h = commit(h);
    expect(h.past).toEqual([0]);
    expect(undo(h).present).toBe(0);
  });
  it("commit 前の undo も開始前に戻る", () => {
    let h = createHistory(0);
    h = push(h, 1);
    h = replace(h, 5);
    expect(undo(h).present).toBe(1);
  });
  it("上限を超えたら古いものから捨てる", () => {
    let h = createHistory(0, 3);
    for (let i = 1; i <= 5; i++) h = push(h, i);
    expect(h.past).toEqual([2, 3, 4]);
  });
});
