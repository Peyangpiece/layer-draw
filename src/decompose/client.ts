/**
 * メインスレッド側から自動分解を実行するクライアント。
 *
 * 通常は Web Worker で実行し、UI を止めない。キャンセルは Worker を terminate して作り直す
 * （同期的な重い処理の途中ではメッセージを受け取れないため）。
 *
 * Worker を起動できない環境（埋め込み先のセキュリティ設定などで Worker が禁止・読み込み失敗）では、
 * メインスレッドで実行する。この場合、処理中は画面が固まり、キャンセルはステージの区切りでのみ効く。
 */
import { decompose, type CancelToken } from "./pipeline";
import type { DecomposeParams, DecomposeResult, DecomposeStage, RasterImage, WorkerResponse } from "./types";

export interface DecomposeJob {
  promise: Promise<DecomposeResult>;
  cancel(): void;
}

type ProgressFn = (stage: DecomposeStage, ratio: number) => void;

let worker: Worker | null = null;
/** Worker が使えないと分かったら、以降はメインスレッドで実行する */
let workerUnavailable = false;
let nextJobId = 1;

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  try {
    worker ??= new Worker(new URL("./decompose.worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

export function runDecompose(image: RasterImage, params: DecomposeParams, onProgress?: ProgressFn): DecomposeJob {
  const w = getWorker();
  return w ? runInWorker(w, image, params, onProgress) : runOnMainThread(image, params, onProgress);
}

function runInWorker(w: Worker, image: RasterImage, params: DecomposeParams, onProgress?: ProgressFn): DecomposeJob {
  const jobId = nextJobId++;
  let rejectFn: (e: Error) => void = () => {};
  let fallback: DecomposeJob | null = null;

  const promise = new Promise<DecomposeResult>((resolve, reject) => {
    rejectFn = reject;
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.jobId !== jobId) return;
      if (msg.type === "progress") {
        onProgress?.(msg.stage, msg.ratio);
        return;
      }
      cleanup();
      if (msg.type === "done") resolve(msg.result);
      else reject(new Error(msg.message));
    };
    // Worker のスクリプトを読み込めなかった場合（Worker 内の例外は error メッセージで届くので、ここに来るのは起動失敗）
    const onError = (ev: Event) => {
      ev.preventDefault();
      cleanup();
      workerUnavailable = true;
      worker?.terminate();
      worker = null;
      fallback = runOnMainThread(image, params, onProgress);
      fallback.promise.then(resolve, reject);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    // 元画像は呼び出し側でも使い続けるため、転送ではなくコピーで渡す
    w.postMessage({ type: "decompose", jobId, image, params });
  });

  return {
    promise,
    cancel() {
      if (fallback) {
        fallback.cancel();
        return;
      }
      worker?.terminate();
      worker = null;
      rejectFn(new Error("キャンセルしました"));
    },
  };
}

function runOnMainThread(image: RasterImage, params: DecomposeParams, onProgress?: ProgressFn): DecomposeJob {
  const token: { cancelled: boolean } = { cancelled: false };
  const promise = new Promise<DecomposeResult>((resolve, reject) => {
    // 処理中の表示を先に描画させるため、1 フレーム待ってから実行する
    setTimeout(() => {
      try {
        resolve(decompose(image, params, onProgress, token as CancelToken));
      } catch (e) {
        reject(token.cancelled ? new Error("キャンセルしました") : e);
      }
    }, 30);
  });
  return {
    promise,
    cancel() {
      token.cancelled = true;
    },
  };
}
