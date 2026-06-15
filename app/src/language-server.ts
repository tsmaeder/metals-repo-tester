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

export interface LanguageServer {
  readonly id: string;
  readonly displayName: string;

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
