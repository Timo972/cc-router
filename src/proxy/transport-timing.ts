/** Small provider-neutral abort helpers.  They intentionally model a header
 * deadline and a reset-on-progress idle deadline separately: neither is an
 * absolute generation deadline. */
export interface HeaderDeadline {
  signal?: AbortSignal;
  dispose(): void;
}

export function createHeaderDeadline(timeoutMs: number | undefined, parent?: AbortSignal): HeaderDeadline {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: parent, dispose() {} };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    controller.abort(new DOMException("upstream headers timed out", "TimeoutError"));
  }, timeoutMs);
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) {
    onParentAbort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Wrap a body with a timeout for each upstream read.
 *
 * The zero high-water mark is deliberate. A positive high-water mark lets the
 * Web Streams implementation prefetch the next chunk as soon as the previous
 * one is delivered. When the HTTP response is waiting for downstream drain,
 * that prefetched read would run the upstream idle timer and could time out an
 * otherwise healthy stream solely because its client was slow.
 */
export function withStreamIdleTimeout(
  body: ReadableStream<Uint8Array> | null,
  idleMs: number | undefined,
  parent?: AbortSignal,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const timeoutEnabled = idleMs !== undefined && idleMs > 0;
  if (!timeoutEnabled && !parent) return body;

  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const clearIdleTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const releaseReader = () => {
    try {
      reader.releaseLock();
    } catch {
      // A cancellation can briefly leave read() pending. reader.cancel()
      // settles it before trying this again in its finally callback.
    }
  };

  const finish = (release = true) => {
    if (closed) return;
    closed = true;
    clearIdleTimer();
    parent?.removeEventListener("abort", onAbort);
    if (release) releaseReader();
  };

  const fail = (error: unknown) => {
    if (closed) return;
    finish(false);
    controllerRef?.error(error);
    void reader.cancel(error).catch(() => {}).finally(releaseReader);
  };

  const onAbort = () => {
    fail(parent?.reason ?? new DOMException("aborted", "AbortError"));
  };

  const startIdleTimer = () => {
    if (!timeoutEnabled) return;
    clearIdleTimer();
    timer = setTimeout(() => {
      fail(new DOMException("upstream stream idle timeout", "TimeoutError"));
    }, idleMs!);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (parent?.aborted) onAbort();
      else parent?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (closed) return;
      startIdleTimer();
      try {
        const next = await reader.read();
        clearIdleTimer();
        if (closed) return;
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (closed) return;
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      finish(false);
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  }, { highWaterMark: 0 });
}

/** Resolve only when an HTTP response can accept another write. Every losing
 * listener is removed, including the error/close path. */
export function waitForWritable(res: {
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  destroyed?: boolean;
}): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      res.removeListener("drain", drain);
      res.removeListener("close", closed);
      res.removeListener("error", errored);
      resolve(value);
    };
    const drain = () => finish(true);
    const closed = () => finish(false);
    const errored = () => finish(false);
    res.once("drain", drain);
    res.once("close", closed);
    res.once("error", errored);
  });
}
