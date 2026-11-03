/**
 * ドキュメント操作の純粋関数群。すべてイミュータブルに新しいオブジェクトを返す
 * （取り消し/やり直しをスナップショットで実装するため）。
 */
import { newId } from "./id";
import type { LayerDocument, LayerGroup, LayerNode, RasterLayer } from "./types";

export function createGroup(name: string, children: LayerNode[] = []): LayerGroup {
  return {
    id: newId("grp"),
    kind: "group",
    name,
    visible: true,
    opacity: 1,
    blendMode: "normal",
    clipping: false,
    locked: false,
    expanded: true,
    children,
  };
}

export function createRasterLayer(
  init: Pick<RasterLayer, "name" | "bitmapId" | "bounds"> & Partial<RasterLayer>,
): RasterLayer {
  return {
    id: newId("lyr"),
    kind: "raster",
    role: "normal",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    clipping: false,
    locked: false,
    alphaLocked: false,
    isReference: false,
    ...init,
  };
}

export function createDocument(name: string, width: number, height: number, root?: LayerGroup): LayerDocument {
  const now = new Date().toISOString();
  return {
    id: newId("doc"),
    name,
    width,
    height,
    dpi: 350,
    root: root ?? createGroup("root"),
    createdAt: now,
    updatedAt: now,
  };
}

/** 深さ優先でノードを探す */
export function findNode(group: LayerGroup, id: string): LayerNode | undefined {
  for (const child of group.children) {
    if (child.id === id) return child;
    if (child.kind === "group") {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** 指定 ID のノードを親から見つける */
export function findParent(group: LayerGroup, id: string): LayerGroup | undefined {
  for (const child of group.children) {
    if (child.id === id) return group;
    if (child.kind === "group") {
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

function mapTree(group: LayerGroup, fn: (node: LayerNode) => LayerNode | null): LayerGroup {
  const children: LayerNode[] = [];
  for (const child of group.children) {
    const mapped = fn(child);
    if (mapped === null) continue;
    children.push(mapped.kind === "group" ? mapTree(mapped, fn) : mapped);
  }
  return { ...group, children };
}

function touch(doc: LayerDocument, root: LayerGroup): LayerDocument {
  return { ...doc, root, updatedAt: new Date().toISOString() };
}

/** ノードのプロパティを更新（kind/id/children は変更不可） */
export function updateNode(
  doc: LayerDocument,
  id: string,
  patch: Partial<Omit<RasterLayer, "kind" | "id">> & Partial<Omit<LayerGroup, "kind" | "id" | "children">>,
): LayerDocument {
  return touch(
    doc,
    mapTree(doc.root, (n) => (n.id === id ? ({ ...n, ...patch } as LayerNode) : n)),
  );
}

export function removeNode(doc: LayerDocument, id: string): LayerDocument {
  return touch(
    doc,
    mapTree(doc.root, (n) => (n.id === id ? null : n)),
  );
}

/**
 * ノードを指定グループの index 位置に挿入する（先頭 = 最前面）。
 * parentId 省略時はルート。
 */
export function insertNode(doc: LayerDocument, node: LayerNode, index = 0, parentId?: string): LayerDocument {
  const insertInto = (g: LayerGroup): LayerGroup => {
    const children = g.children.slice();
    const i = Math.max(0, Math.min(index, children.length));
    children.splice(i, 0, node);
    return { ...g, children };
  };
  if (!parentId || parentId === doc.root.id) return touch(doc, insertInto(doc.root));
  return touch(
    doc,
    mapTree(doc.root, (n) => (n.id === parentId && n.kind === "group" ? insertInto(n) : n)),
  );
}

/** 同じ親の中で順序を delta だけ移動する（負 = 前面へ） */
export function moveNode(doc: LayerDocument, id: string, delta: number): LayerDocument {
  const parent = findParent(doc.root, id);
  if (!parent) return doc;
  const from = parent.children.findIndex((c) => c.id === id);
  const to = Math.max(0, Math.min(parent.children.length - 1, from + delta));
  if (from === to) return doc;
  const children = parent.children.slice();
  const [node] = children.splice(from, 1);
  children.splice(to, 0, node!);
  const newParent: LayerGroup = { ...parent, children };
  if (parent.id === doc.root.id) return touch(doc, newParent);
  return touch(
    doc,
    mapTree(doc.root, (n) => (n.id === parent.id ? newParent : n)),
  );
}

/** ツリー内のすべてのラスタレイヤーを列挙する */
export function listRasterLayers(group: LayerGroup): RasterLayer[] {
  const out: RasterLayer[] = [];
  for (const child of group.children) {
    if (child.kind === "raster") out.push(child);
    else out.push(...listRasterLayers(child));
  }
  return out;
}
