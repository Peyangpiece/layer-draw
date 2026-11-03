/**
 * エディタ状態（ドキュメント・選択レイヤー・取り消し履歴）。
 * 外部ライブラリを増やさないため useReducer + Context で実装する。
 */
import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import { BitmapStore } from "../core/bitmapStore";
import { findNode, moveNode, removeNode, updateNode } from "../core/document";
import { commit, createHistory, push, redo, replace, undo, type History } from "../core/history";
import type { LayerDocument, LayerNode } from "../core/types";

export interface EditorState {
  history: History<LayerDocument> | null;
  selectedId: string | null;
}

export type NodePatch = Partial<Pick<LayerNode, "name" | "visible" | "opacity" | "blendMode" | "clipping" | "locked">>;

export type EditorAction =
  | { type: "open"; doc: LayerDocument }
  | { type: "select"; id: string | null }
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
    return { history: createHistory(action.doc), selectedId: null };
  }
  const h = state.history;
  if (!h) return state;
  switch (action.type) {
    case "select":
      return { ...state, selectedId: action.id };
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
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
    case "move":
      return { ...state, history: push(h, moveNode(h.present, action.id, action.delta)) };
    case "undo":
      return { ...state, history: undo(h) };
    case "redo":
      return { ...state, history: redo(h) };
  }
}

interface EditorContextValue {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  bitmaps: BitmapStore;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { history: null, selectedId: null });
  const bitmaps = useMemo(() => new BitmapStore(), []);
  const value = useMemo(() => ({ state, dispatch, bitmaps }), [state, bitmaps]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const v = useContext(EditorContext);
  if (!v) throw new Error("useEditor は EditorProvider の内側で使用してください");
  return v;
}
