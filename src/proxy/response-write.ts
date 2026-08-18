import type { Response } from "express";

/**
 * Write one response chunk and wait until Node accepts more data.
 *
 * `ServerResponse.write()` returning false still accepts the current chunk;
 * it only asks the producer to pause before producing another one. A client
 * can disappear while that pause is in progress, so the wait must settle on
 * every delivery-ending signal and remove all of its listeners afterwards.
 * The caller owns the upstream reader and cancels it when this returns false.
 */
export async function writeResponseChunk(
  res: Response,
  chunk: string | Buffer,
  signal?: AbortSignal,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded || signal?.aborted) return false;
  if (res.write(chunk)) return true;

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onTerminated);
      res.removeListener("aborted", onTerminated);
      res.removeListener("error", onError);
      signal?.removeEventListener("abort", onTerminated);
    };
    const settle = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(accepted);
    };
    const onDrain = (): void => settle(!(res.destroyed || res.writableEnded || signal?.aborted));
    const onTerminated = (): void => settle(false);
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    res.once("drain", onDrain);
    res.once("close", onTerminated);
    res.once("aborted", onTerminated);
    res.once("error", onError);
    signal?.addEventListener("abort", onTerminated, { once: true });

    // A close/abort can land between the pre-write check and listener setup.
    if (res.destroyed || res.writableEnded || signal?.aborted) onTerminated();
  });
}
