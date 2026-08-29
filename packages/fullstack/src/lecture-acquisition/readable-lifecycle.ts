import { Readable } from "node:stream";

export type OwnedReadable = {
  iterable: AsyncIterable<Uint8Array>;
  dispose: () => Promise<void>;
};

/**
 * Own one Readable for its complete lifetime, including the period before the
 * consumer starts iterating. A Readable carrying an AbortSignal can emit an
 * AbortError as soon as the signal fires, so installing this owner lazily from
 * an async-generator body leaves an observable listener-free window.
 */
export function ownReadable(source: Readable, prematureCloseMessage: string): OwnedReadable {
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let disposePromise: Promise<void> | undefined;

  const onError = (error: Error): void => {
    failure = error;
    wake?.();
  };
  source.on("error", onError);

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = new Promise<void>((resolve) => {
      let settled = false;
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        source.removeListener("close", onClose);
        resolve();
      };
      if (source.closed) {
        onClose();
        return;
      }
      source.once("close", onClose);
      if (!source.destroyed) source.destroy();
      if (source.closed) onClose();
    }).then(() => {
      source.removeListener("error", onError);
      wake = undefined;
    });
    return disposePromise;
  };

  const iterable = (async function* (): AsyncGenerator<Uint8Array> {
    const waitForEvent = (): Promise<"readable" | "end"> => new Promise<"readable" | "end">((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        source.removeListener("readable", onReadable);
        source.removeListener("end", onEnd);
        source.removeListener("close", onClose);
      };
      const finish = (value: "readable" | "end", error?: Error): void => {
        if (settled) return;
        settled = true;
        wake = undefined;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onReadable = (): void => finish("readable");
      const onEnd = (): void => finish("end");
      const onClose = (): void => {
        const error = failure ?? source.errored;
        if (error) {
          failure = error;
          finish("end", error);
        } else if (source.readableEnded) {
          finish("end");
        } else {
          finish("end", new Error(prematureCloseMessage));
        }
      };
      wake = () => finish("end", failure);
      source.once("readable", onReadable);
      source.once("end", onEnd);
      source.once("close", onClose);
      if (source.readableEnded) onEnd();
    });

    try {
      while (true) {
        if (!failure && source.errored) failure = source.errored;
        if (failure) throw failure;
        const chunk = source.read();
        if (chunk !== null) {
          yield chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk));
          continue;
        }
        if (source.readableEnded) return;
        if (source.destroyed && source.closed) throw failure ?? new Error(prematureCloseMessage);
        if ((await waitForEvent()) === "end") {
          if (failure) throw failure;
          return;
        }
      }
    } finally {
      await dispose();
    }
  })();

  return { iterable, dispose };
}
