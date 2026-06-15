import type { Disposable, ProtocolConnection } from "vscode-languageserver-protocol/node";
import {
  createProtocolConnection,
  ExitNotification,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";

declare const process: any;

export class LspClient {
  private readonly child: any;
  private readonly connection: ProtocolConnection;
  private readonly stderrPrefix: string;

  public constructor(child: any, stderrPrefix: string) {
    this.child = child;
    this.stderrPrefix = stderrPrefix;
    this.connection = createProtocolConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    this.connection.listen();

    this.child.stderr.on("data", (chunk: any) => {
      const text = String(chunk);
      if (text.trim().length > 0) {
        process.stderr.write(this.stderrPrefix + text);
      }
    });
    this.child.on("exit", () => {
      this.connection.end();
    });
  }

  public onNotification<P>(type: any, handler: (params: P) => void): Disposable {
    return this.connection.onNotification(type, handler);
  }

  public onRequest<P, R>(type: any, handler: (params: P) => R | Promise<R>): Disposable {
    return this.connection.onRequest(type, handler);
  }

  public sendRequest<P, R>(type: any, params: P): Promise<R> {
    return this.connection.sendRequest(type, params);
  }

  public sendNotification<P>(type: any, params?: P): void {
    void this.connection.sendNotification(type, params);
  }

  public async shutdownAndExit(): Promise<void> {
    try {
      await this.sendRequest<void, void>(ShutdownRequest.type, undefined);
    } finally {
      this.sendNotification(ExitNotification.type);
    }
  }

  public kill(): void {
    try {
      this.child.kill();
    } catch (_error) {
      // Best effort kill.
    }
  }
}
