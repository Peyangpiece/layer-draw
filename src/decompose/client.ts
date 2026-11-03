/**
 * メインスレッド側から Worker で自動分解を実行するクライアント。
 * キャンセルは Worker を terminate して作り直すことで実現する
 * （同期的な重い処理の途中ではメッセージを受け取れないため）。
 */
import type { DecomposeParams, DecomposeResult, DecomposeStage, RasterImage, WorkerResponse } from "./types";

export interface DecomposeJob {
  promise: Promise<DecomposeResult>;
  cancel(): void;
}

let worker: Worker | null = null;
let nextJobId = 1;

function getWorker(): Worker {
  worker ??= new Worker(new URL("./decompose.worker.ts", import.meta.url), { type: "module" });
  return worker;
}

export function runDecompose(
  image: RasterImage,
  params: DecomposeParams,
  onProgress?: (stage: DecomposeStage, ratio: number) => void,
): DecomposeJob {
  const w = getWorker();
  const jobId = nextJobId++;
  let rejectFn: (e: Error) => void = () => {};

  const promise = new Promise<DecomposeResult>((resolve, reject) => {
    rejectFn = reject;
    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.jobId !== jobId) return;
      if (msg.type === "progress") {
        onProgress?.(msg.stage, msg.ratio);
        return;
      }
      w.removeEventListener("message", onMessage);
      if (msg.type === "done") resolve(msg.result);
      else reject(new Error(msg.message));
    };
    w.addEventListener("message", onMessage);
    // 元画像は呼び出し側でも使い続けるため、転送ではなくコピーで渡す
    w.postMessage({ type: "decompose", jobId, image, params });
  });

  return {
    promise,
    cancel() {
      worker?.terminate();
      worker = null;
      rejectFn(new Error("キャンセルしました"));
    },
  };
}
