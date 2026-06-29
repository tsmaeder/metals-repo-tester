/// <reference lib="es2015" />

declare function require(name: string): any;
declare const process: any;

import fs = require("fs");
import path = require("path");
import crypto = require("crypto");
import type { InitializeParams } from "vscode-languageserver-protocol";
import type { LspClient } from "../lsp-client";
import type { LanguageServer, PullDiagnosticsOptions, ServerContext, SpawnSpec } from "../language-server";
import { collectJavaFiles, logRepoProgress, toFileUri, withTimeout } from "../util";

export interface IntelliJResolvedServer {
  exePath: string;
  eulaHash: string;
}

// Logged by WsmPersistenceKt after workspace import/indexing completes.
const READY_LOG_PATTERN = /RocksDB flush took /;
const READY_LOG_POLL_MS = 500;
const READY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

function resolveDefaultIntellijServerPath(): string | undefined {
  const envPath = process.env.INTELLIJ_SERVER;
  if (envPath && fs.existsSync(envPath)) {
    return path.resolve(envPath);
  }

  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    return undefined;
  }

  const extensionsDir = path.join(home, ".vscode", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return undefined;
  }

  const entries = fs.readdirSync(extensionsDir);
  const extensionDirs = entries
    .filter((entry: string) => entry.startsWith("jetbrains.intellij-"))
    .sort()
    .reverse();

  for (let i = 0; i < extensionDirs.length; i += 1) {
    const exeName = process.platform === "win32" ? "intellij-server.exe" : "intellij-server";
    const candidate = path.join(extensionsDir, extensionDirs[i], "server", "bin", exeName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function computeEulaHash(eulaPath: string): string {
  const text = fs.readFileSync(eulaPath, "utf8");
  return crypto.createHash("sha256").update(text).digest("hex").substring(0, 16);
}

function resolveEulaPath(exePath: string): string {
  const eulaPath = path.resolve(path.dirname(exePath), "..", "EULA.txt");
  if (!fs.existsSync(eulaPath)) {
    throw new Error("IntelliJ EULA file not found at " + eulaPath);
  }
  return eulaPath;
}

function findIntellijLogPath(systemPath: string): string | undefined {
  const primary = path.join(systemPath, "system", "log", "intellij-server.log");
  if (fs.existsSync(primary)) {
    return primary;
  }

  const legacyLogDir = path.join(systemPath, "log");
  if (!fs.existsSync(legacyLogDir)) {
    return undefined;
  }

  const ideaLog = path.join(legacyLogDir, "idea.log");
  if (fs.existsSync(ideaLog)) {
    return ideaLog;
  }

  const entries = fs.readdirSync(legacyLogDir);
  const logFiles = entries.filter((entry: string) => entry.endsWith(".log"));
  if (logFiles.length === 0) {
    return undefined;
  }

  logFiles.sort();
  return path.join(legacyLogDir, logFiles[logFiles.length - 1]);
}

function logContainsReadyMarker(content: string): boolean {
  return READY_LOG_PATTERN.test(content);
}

function waitForLogReady(systemPath: string, repoName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let logPath: string | undefined;
    let lastSize = 0;
    let buffer = "";

    const timer = setInterval(() => {
      try {
        if (!logPath) {
          logPath = findIntellijLogPath(systemPath);
          if (!logPath) {
            return;
          }
          logRepoProgress(repoName, "Watching IntelliJ log at " + logPath);
        }

        const stat = fs.statSync(logPath);
        if (stat.size < lastSize) {
          lastSize = 0;
          buffer = "";
        }

        if (stat.size > lastSize) {
          const fd = fs.openSync(logPath, "r");
          const length = stat.size - lastSize;
          const chunk = Buffer.alloc(length);
          fs.readSync(fd, chunk, 0, length, lastSize);
          fs.closeSync(fd);
          lastSize = stat.size;
          buffer += chunk.toString("utf8");

          if (logContainsReadyMarker(buffer)) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve();
          }
        }
      } catch (error: any) {
        clearInterval(timer);
        clearTimeout(timeout);
        reject(error);
      }
    }, READY_LOG_POLL_MS);

    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error("Timed out waiting for IntelliJ language server to become ready"));
    }, READY_TIMEOUT_MS);
  });
}

export class IntelliJLanguageServer implements LanguageServer {
  public readonly id = "intellij";
  public readonly displayName = "IntelliJ Language Server";
  public readonly usePullDiagnostics = true;
  public readonly pullDiagnosticsOptions: PullDiagnosticsOptions = {
    pollIntervalMs:300,
    settleMs: 2400,
    requestTimeoutMs: 30000,
  };

  private resolvedServer?: IntelliJResolvedServer;

  public async resolveServer(ctx: ServerContext): Promise<IntelliJResolvedServer> {
    const exePath = ctx.intellijServerPath || resolveDefaultIntellijServerPath();
    if (!exePath) {
      throw new Error("--intellij-server or INTELLIJ_SERVER is required for IntelliJ");
    }

    const resolvedExe = path.resolve(exePath);
    if (!fs.existsSync(resolvedExe)) {
      throw new Error("IntelliJ server executable does not exist: " + resolvedExe);
    }

    const eulaPath = resolveEulaPath(resolvedExe);
    const eulaHash = computeEulaHash(eulaPath);
    this.resolvedServer = { exePath: resolvedExe, eulaHash };
    return this.resolvedServer;
  }

  public buildSpawnSpec(
    resolved: unknown,
    workspaceDir: string,
    _repoName: string,
    workspaceDataDir?: string,
  ): SpawnSpec {
    const intellijResolved = resolved as IntelliJResolvedServer;
    if (!workspaceDataDir) {
      throw new Error("workspaceDataDir is required for IntelliJ");
    }

    fs.mkdirSync(workspaceDataDir, { recursive: true });

    return {
      command: intellijResolved.exePath,
      args: ["--stdio", "--system-path", workspaceDataDir],
      cwd: workspaceDir,
    };
  }

  public buildInitializeParams(workspaceDir: string): InitializeParams {
    if (!this.resolvedServer) {
      throw new Error("IntelliJ server must be resolved before building initialize params");
    }

    const rootUri = toFileUri(workspaceDir);
    return {
      processId: process.pid,
      clientInfo: {
        name: "metals-repo-tester",
        version: "0.0.0",
      },
      locale: "en",
      rootPath: workspaceDir,
      rootUri,
      initializationOptions: {
        eulaHash: this.resolvedServer.eulaHash,
      },
      capabilities: {},
      trace: "off",
      workspaceFolders: [
        {
          uri: rootUri,
          name: workspaceDir.split(/[/\\]/).pop() || workspaceDir,
        },
      ],
    };
  }

  public registerRequestHandlers(client: LspClient, _repoName: string): void {
    client.onRequest("workspace/configuration", () => [{}]);
  }

  public waitForReady(_client: LspClient, repoName: string, workspaceDataDir?: string): Promise<void> {
    if (!workspaceDataDir) {
      throw new Error("workspaceDataDir is required for IntelliJ waitForReady");
    }

    return withTimeout(
      waitForLogReady(workspaceDataDir, repoName),
      READY_TIMEOUT_MS,
      "Timed out waiting for IntelliJ language server to become ready",
    );
  }

  public collectFiles(workspaceDir: string): string[] {
    return collectJavaFiles(workspaceDir);
  }

  public languageIdForFile(_filePath: string): string {
    return "java";
  }
}

export const intellijLanguageServer = new IntelliJLanguageServer();
