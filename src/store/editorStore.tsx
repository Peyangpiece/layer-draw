/**
 * エディタ状態（ドキュメント・選択レイヤー・取り消し履歴）。
 * 外部ライブラリを増やさないため useReducer + Context で実装する。
 */
import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import { BitmapStore } from "../core/bitmapStore";
import { findNode, moveNode, removeNode, replaceNode, updateNode } from "../core/document";
import { commit, createHistory, push, redo, replace, undo, type History } from "../core/history";
import type { LayerDocument, LayerNode } from "../core/types";

export interface EditorState {
  history: History<LayerDocument> | null;
  /** 選択中のノード。末尾が主選択（プロパティ表示の対象） */
  selectedIds: string[];
}

export type NodePatch = Partial<Pick<LayerNode, "name" | "visible" | "opacity" | "blendMode" | "clipping" | "locked">>;

export type EditorAction =
  | { type: "open"; doc: LayerDocument }
  /** mode: replace=置き換え, toggle=追加/解除 */
  | { type: "select"; id: string | null; mode?: "replace" | "toggle" }
  /** 1 つのノードを複数ノードに置き換える（パーツ分割）。select で置き換え後の選択を指定 */
  | { type: "replaceNode"; id: string; nodes: LayerNode[]; select?: string[] }
  /** 複数ノードを削除し、merged を insertAt の位置に置く（パーツ結合） */
  | { type: "mergeNodes"; ids: string[]; merged: LayerNode; insertAt: string }
  /** commit=false のときは履歴に積まない（スライダーのドラッグ中など） */
  | { type: "patch"; id: string; patch: NodePatch; commit?: boolean }
  | { type: "commit" }
  /** パーツの塗り色を変更（新しい bitmapId に差し替え）。commit=false で履歴に積まない */
  | { type: "setPartFill"; id: string; bitmapId: string; fillColor: string; commit?: boolean }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; delta: number }
  | { type: "undo" }
  | { type: "redo" };

function reducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "open") {
    return { history: createHistory(action.doc), selectedIds: [] };
  }
  const h = state.history;
  if (!h) return state;
  switch (action.type) {
    case "select": {
      if (action.id === null) return { ...state, selectedIds: [] };
      if (action.mode === "toggle") {
        const has = state.selectedIds.includes(action.id);
        return { ...state, selectedIds: has ? state.selectedIds.filter((i) => i !== action.id) : [...state.selectedIds, action.id] };
      }
      return { ...state, selectedIds: [action.id] };
    }
    case "replaceNode":
      return {
        history: push(h, replaceNode(h.present, action.id, action.nodes)),
        selectedIds: action.select ?? state.selectedIds.filter((i) => i !== action.id),
      };
    case "mergeNodes": {
      // insertAt の位置を merged で置き換え、残りを削除する
      let doc = replaceNode(h.present, action.insertAt, [action.merged]);
      for (const id of action.ids) if (id !== action.insertAt) doc = removeNode(doc, id);
      return { history: push(h, doc), selectedIds: [action.merged.id] };
    }
    case "patch": {
      const next = updateNode(h.present, action.id, action.patch);
      return { ...state, history: action.commit === false ? replace(h, next) : push(h, next) };
    }
    case "commit":
      return { ...state, history: commit(h) };
    case "setPartFill": {
      const node = findNode(h.present.root, action.id);
      if (!node || node.kind !== "raster") return state;
      const next = updateNode(h.present, action.id, {
        bitmapId: action.bitmapId,
        part: { ...node.part, fillColor: action.fillColor },
      });
      return { ...state, history: action.commit === false ? replace(h, next) : push(h, next) };
    }
    case "remove":
      return {
        history: push(h, removeNode(h.present, action.id)),
        selectedIds: state.selectedIds.filter((i) => i !== action.id),
      };
    case "move":
      return { ...state, history: push(h, moveNode(h.present, action.id, action.delta)) };
    case "undo": {
      const next = undo(h);
      return { history: next, selectedIds: keepExisting(next.present, state.selectedIds) };
    }
    case "redo": {
      const next = redo(h);
      return { history: next, selectedIds: keepExisting(next.present, state.selectedIds) };
    }
  }
}

/** 取り消し等で存在しなくなったノードを選択から外す */
function keepExisting(doc: LayerDocument, ids: string[]): string[] {
  return ids.filter((id) => findNode(doc.root, id) !== undefined);
}

interface EditorContextValue {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  bitmaps: BitmapStore;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { history: null, selectedIds: [] });
  const bitmaps = useMemo(() => new BitmapStore(), []);
  const value = useMemo(() => ({ state, dispatch, bitmaps }), [state, bitmaps]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const v = useContext(EditorContext);
  if (!v) throw new Error("useEditor は EditorProvider の内側で使用してください");
  return v;
}
