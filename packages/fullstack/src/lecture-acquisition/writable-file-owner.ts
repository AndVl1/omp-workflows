import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";

export class WritableFileOwner {
  private streamError: unknown;
  private readonly onStreamError = (error: unknown): void => {
    this.streamError = error;
  };
  private readonly stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: "wx", autoClose: true, mode: 0o600 });
    this.stream.on("error", this.onStreamError);
  }

  async open(): Promise<void> {
    await once(this.stream, "open");
    this.throwIfStreamFailed();
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.throwIfStreamFailed();
    await new Promise<void>((resolve, reject) => {
      this.stream.write(bytes, (error) => error ? reject(error) : resolve());
    });
    this.throwIfStreamFailed();
  }

  async finish(): Promise<void> {
    const closed = this.waitForClose();
    this.stream.end();
    await closed;
    this.removeErrorListener();
    this.throwIfStreamFailed();
  }

  async dispose(): Promise<void> {
    if (!this.stream.closed) {
      const closed = this.waitForClose();
      this.stream.destroy();
      await closed;
    }
    this.removeErrorListener();
  }

  private waitForClose(): Promise<void> {
    if (this.stream.closed) return Promise.resolve();
    return new Promise<void>((resolve) => this.stream.once("close", resolve));
  }

  private removeErrorListener(): void {
    this.stream.removeListener("error", this.onStreamError);
  }

  private throwIfStreamFailed(): void {
    if (this.streamError !== undefined) throw this.streamError;
  }
}
