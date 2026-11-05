/**
 * ファイルへの保存（ブラウザ）。保存先が利用者に分かるように、どの方法で保存したかを返す。
 *
 *  - 保存先を選べるブラウザ（Chrome / Edge。File System Access API）: 保存ダイアログでフォルダと名前を選ぶ。
 *    選んだファイルには、同じ画面を開いている間「上書き保存」できる
 *  - それ以外（Safari / Firefox）: ブラウザのダウンロード先（ふつうは「ダウンロード」フォルダ）に保存される
 *
 * ブラウザは保存したファイルのフォルダのパスをページに教えないため、「選んだフォルダ」「ダウンロード」としか言えない。
 */
export type SaveFormat = "psd" | "png";

export const FORMAT_INFO: Record<SaveFormat, { ext: string; mime: string; description: string }> = {
  psd: { ext: ".psd", mime: "image/vnd.adobe.photoshop", description: "PSD（レイヤー付き）" },
  png: { ext: ".png", mime: "image/png", description: "PNG 画像" },
};

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption?: boolean;
  id?: string;
}
type PickerWindow = Window & { showSaveFilePicker?: (o: SaveFilePickerOptions) => Promise<FileSystemFileHandle> };

/** iframe の中（claude.ai のプレビューなど）で動いているか */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // 別オリジンの親を参照できない = 埋め込まれている
  }
}

/** 保存先のフォルダを選べるか（iframe の中では使えない） */
export function canPickLocation(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === "function" && !isEmbedded();
}

/** 拡張子を付け、ファイル名に使えない文字を置き換える */
export function fileNameFor(base: string, format: SaveFormat): string {
  const ext = FORMAT_INFO[format].ext;
  const cleaned = base.trim().replace(/\.(psd|png)$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "無題";
  return cleaned + ext;
}

/** 保存ダイアログを開く。キャンセルされたら null */
export async function pickSaveFile(name: string, format: SaveFormat): Promise<FileSystemFileHandle | null> {
  const info = FORMAT_INFO[format];
  try {
    return await (window as PickerWindow).showSaveFilePicker!({
      suggestedName: name,
      types: [{ description: info.description, accept: { [info.mime]: [info.ext] } }],
      id: "layer-draw-save", // 前回選んだフォルダから始まる
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export async function writeToHandle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const w = await handle.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
}

/** ブラウザのダウンロードとして保存する */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ダウンロードが始まる前に解放しないよう、少し待つ
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
