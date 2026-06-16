import type { InitializeParams } from "vscode-languageserver-protocol";
import type { LspClient } from "./lsp-client";

export interface RepoEntry {
  name: string;
  uri: string;
}

export interface ServerContext {
  serverVersion?: string;
  jdtlsHome?: string;
  intellijServerPath?: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: { [key: string]: string };
}

export interface PullDiagnosticsOptions {
  // Interval between successive textDocument/diagnostic polls.
  pollIntervalMs: number;
  // How long to keep polling for diagnostics to appear before concluding the
  // file is clean (the server may return empty reports while still analyzing).
  settleMs: number;
  // Hard timeout for a single textDocument/diagnostic request.
  requestTimeoutMs: number;
}

export interface LanguageServer {
  readonly id: string;
  readonly displayName: string;

  // When true, the driver requests diagnostics via textDocument/diagnostic
  // (pull) instead of waiting for textDocument/publishDiagnostics (push).
  // Needed for servers (e.g. IntelliJ) that do not push diagnostics for
  // files without problems.
  readonly usePullDiagnostics?: boolean;

  // Per-server timing for pull diagnostics. When omitted, the driver uses its
  // defaults. Only relevant when usePullDiagnostics is true.
  readonly pullDiagnosticsOptions?: PullDiagnosticsOptions;

  resolveServer(ctx: ServerContext): Promise<unknown>;

  buildSpawnSpec(
    resolved: unknown,
    workspaceDir: string,
    repoName: string,
    workspaceDataDir?: string,
  ): SpawnSpec;

  buildInitializeParams(workspaceDir: string): InitializeParams;

  registerRequestHandlers(client: LspClient, repoName: string): void;

  waitForReady(client: LspClient, repoName: string, workspaceDataDir?: string): Promise<void>;

  collectFiles(workspaceDir: string): string[];

  notifyBeforeOpen?(client: LspClient, filePath: string): void;

  languageIdForFile(filePath: string): string;
}
