/// <reference lib="es2015" />

import type {
  Diagnostic,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  DocumentDiagnosticReport,
  InitializeResult,
  InitializedParams,
  LogMessageParams,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";
import type { Disposable } from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

declare function require(name: string): any;
declare const process: any;

import fs = require("fs");
import path = require("path");
import cp = require("child_process");
import {
  DiagnosticSeverity,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  InitializedNotification,
  InitializeRequest,
  LogMessageNotification,
  PublishDiagnosticsNotification,
} from "vscode-languageserver-protocol/node";
import type { LanguageServer, PullDiagnosticsOptions, RepoEntry, ServerContext } from "./language-server";
import { getLanguageServer, listLanguageServerIds } from "./language-servers";
import { LspClient } from "./lsp-client";
import {
  appendLog,
  cloneRepoToTemp,
  getLogMessageTypeLabel,
  loadRepos,
  logProgress,
  logRepoProgress,
  toFileUri,
  withTimeout,
} from "./util";

interface CliArgs {
  reposPath: string;
  outPath: string;
  serverId: string;
  serverVersion?: string;
  jdtlsHome?: string;
  intellijServerPath?: string;
  openFiles: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let reposPath = "";
  let outPath = path.resolve(process.cwd(), "out.txt");
  let serverId = "metals";
  let serverVersion: string | undefined;
  let jdtlsHome: string | undefined;
  let intellijServerPath: string | undefined;
  let openFiles = true;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repos" && i + 1 < argv.length) {
      reposPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--out" && i + 1 < argv.length) {
      outPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--server" && i + 1 < argv.length) {
      serverId = String(argv[i + 1]).trim();
      i += 1;
    } else if (arg === "--server-version" && i + 1 < argv.length) {
      serverVersion = String(argv[i + 1]).trim();
      i += 1;
    } else if (arg === "--jdtls-home" && i + 1 < argv.length) {
      jdtlsHome = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--intellij-server" && i + 1 < argv.length) {
      intellijServerPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--no-open-files") {
      openFiles = false;
    }
  }

  if (!reposPath) {
    throw new Error(
      "Usage: node app/build/index.js --repos <repos.json> [--server <"
        + listLanguageServerIds().join("|")
        + ">] [--server-version <metals-version>] [--jdtls-home <path>] [--intellij-server <path>] [--no-open-files] [--out <out.txt>]",
    );
  }

  return { reposPath, outPath, serverId, serverVersion, jdtlsHome, intellijServerPath, openFiles };
}

function validateArgs(args: CliArgs): void {
  const supported = listLanguageServerIds();
  if (supported.indexOf(args.serverId) === -1) {
    throw new Error("Unknown language server: " + args.serverId + ". Supported: " + supported.join(", "));
  }

  if (args.serverId === "metals" && !args.serverVersion) {
    throw new Error("--server-version is required when --server metals");
  }

  if (args.serverId === "jdtls" && !args.jdtlsHome && !process.env.JDTLS_HOME) {
    throw new Error("--jdtls-home or JDTLS_HOME is required when --server jdtls");
  }
}

function buildServerContext(args: CliArgs): ServerContext {
  return {
    serverVersion: args.serverVersion,
    jdtlsHome: args.jdtlsHome,
    intellijServerPath: args.intellijServerPath,
  };
}

function diagnosticsTimeoutMs(serverId: string): number {
  if (serverId === "intellij") {
    return 30000;
  }
  return 10000;
}

const DEFAULT_PULL_DIAGNOSTICS_OPTIONS: PullDiagnosticsOptions = {
  pollIntervalMs: 750,
  settleMs: 4000,
  requestTimeoutMs: 30000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Requests diagnostics via textDocument/diagnostic. The server may return an
// empty "full" report before analysis finishes, so we poll: return as soon as
// any items appear, and otherwise treat a settled empty report as "clean".
async function pullDiagnostics(
  client: LspClient,
  uri: string,
  options: PullDiagnosticsOptions,
): Promise<Diagnostic[]> {
  const start = Date.now();
  for (;;) {
    let report: DocumentDiagnosticReport;
    try {
      report = await withTimeout(
        client.sendRequest(DocumentDiagnosticRequest.type, { textDocument: { uri } }) as Promise<DocumentDiagnosticReport>,
        options.requestTimeoutMs,
        "Timed out waiting for pull diagnostics",
      );
    } catch (_error) {
      return [];
    }

    const items = report && report.kind === "full" ? report.items : [];
    if (items.length > 0) {
      return items;
    }
    if (Date.now() - start >= options.settleMs) {
      return [];
    }
    await delay(options.pollIntervalMs);
  }
}

async function startLspClient(
  server: LanguageServer,
  resolved: unknown,
  workspaceDir: string,
  repoName: string,
  workspaceDataDir: string,
): Promise<LspClient> {
  const spawnSpec = server.buildSpawnSpec(resolved, workspaceDir, repoName, workspaceDataDir);
  const child = cp.spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: spawnSpec.env ? { ...process.env, ...spawnSpec.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const client = new LspClient(child, "[" + repoName + "] ");
  server.registerRequestHandlers(client, repoName);

  const initializeParams = server.buildInitializeParams(workspaceDir);
  await withTimeout(
    client.sendRequest(InitializeRequest.type, initializeParams) as Promise<InitializeResult>,
    60000,
    "Timed out waiting for " + server.displayName + " initialize response",
  );

  const initializedParams: InitializedParams = {};
  client.sendNotification(InitializedNotification.type, initializedParams);
  return client;
}

async function processRepo(
  repo: RepoEntry,
  server: LanguageServer,
  resolved: unknown,
  outPath: string,
  serverId: string,
  openFiles: boolean,
): Promise<void> {
  appendLog(outPath, "starting " + repo.name);
  logRepoProgress(repo.name, "Starting repository run");

  let tempRootDir = "";
  let repoDir = "";
  let client: LspClient | undefined;
  let mirroredLogSubscription: Disposable | undefined;

  try {
    logRepoProgress(repo.name, "Cloning repository from " + repo.uri);
    const cloned = await cloneRepoToTemp(repo);
    tempRootDir = cloned.rootTempDir;
    repoDir = cloned.repoDir;
    logRepoProgress(repo.name, "Clone completed at " + repoDir);

    const workspaceDataDir = path.join(tempRootDir, "workspace-data");
    fs.mkdirSync(workspaceDataDir, { recursive: true });

    logRepoProgress(repo.name, "Starting " + server.displayName + " language server");
    const startupStart = Date.now();
    client = await startLspClient(server, resolved, repoDir, repo.name, workspaceDataDir);
    logRepoProgress(repo.name, server.displayName + " initialized");

    mirroredLogSubscription = client.onNotification<LogMessageParams>(
      LogMessageNotification.type,
      (params: LogMessageParams) => {
        const level = getLogMessageTypeLabel(params && params.type);
        const message = params && typeof params.message === "string" ? params.message : "";
        if (message.length > 0) {
          logProgress("[lsp][" + repo.name + "][" + level + "] " + message);
        }
      },
    );

    logRepoProgress(repo.name, "Waiting for " + server.displayName + " to become ready");
    await server.waitForReady(client, repo.name, workspaceDataDir);
    const readyMs = Date.now() - startupStart;
    appendLog(outPath, "ready " + repo.name + " in " + readyMs + "ms");
    logRepoProgress(repo.name, server.displayName + " ready in " + readyMs + "ms");

    if (!openFiles) {
      logRepoProgress(repo.name, "Skipping Java file diagnostics (--no-open-files)");
      return;
    }

    const files = server.collectFiles(repoDir);
    logRepoProgress(repo.name, "Collected " + files.length + " Java files");

    const usePull = server.usePullDiagnostics === true;
    const pullOptions = server.pullDiagnosticsOptions || DEFAULT_PULL_DIAGNOSTICS_OPTIONS;
    const diagnosticsWaiters: [string, () => void][] = [];
    const fileTimeoutMs = diagnosticsTimeoutMs(serverId);

    const logErrorDiagnostics = (uri: string, diagnostics: Diagnostic[]): boolean => {
      const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
      for (let j = 0; j < errors.length; j += 1) {
        appendLog(outPath, "[lsp][" + repo.name + "][error] " + uri + ": " + errors[j].message);
      }
      return errors.length > 0;
    };

    if (!usePull) {
      client.onNotification<PublishDiagnosticsParams>(PublishDiagnosticsNotification.type, (params: PublishDiagnosticsParams) => {
        logErrorDiagnostics(params.uri, params.diagnostics);
        const fsPath = path.resolve(URI.parse(params.uri).fsPath.toLowerCase());
        const index = diagnosticsWaiters.findIndex((entry) => entry[0] === fsPath);
        if (index !== -1) {
          const callback = diagnosticsWaiters[index][1];
          callback();
          diagnosticsWaiters.splice(index, 1);
        }
      });
    }

    const waitForDiagnostics = (filePath: string, timeoutMs: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for diagnostics"));
        }, timeoutMs);

        diagnosticsWaiters.push([filePath, () => {
          clearTimeout(timeout);
          resolve();
        }]);
      });

    for (let i = 0; i < files.length; i += 1) {
      const filePath = files[i];
      const uri = toFileUri(filePath);
      const text = fs.readFileSync(filePath, "utf8");
      logRepoProgress(repo.name, "Processing file " + (i + 1) + "/" + files.length);

      const didOpenParams: DidOpenTextDocumentParams = {
        textDocument: {
          uri,
          languageId: server.languageIdForFile(filePath),
          version: 1,
          text,
        },
      };

      if (server.notifyBeforeOpen) {
        server.notifyBeforeOpen(client, filePath);
      }
      client.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams);

      try {
        if (usePull) {
          const diagnostics = await pullDiagnostics(client, uri, pullOptions);
          if (logErrorDiagnostics(uri, diagnostics)) {
            logRepoProgress(repo.name, "Error diagnostics for " + filePath);
          } else {
            logRepoProgress(repo.name, "No error diagnostics for " + filePath);
          }
        } else {
          await waitForDiagnostics(filePath.toLowerCase(), fileTimeoutMs);
          logRepoProgress(repo.name, "Diagnostics received for " + filePath);
        }
      } catch (_error) {
        appendLog(outPath, "Timeout: " + filePath);
        logRepoProgress(repo.name, "Timed out waiting for diagnostics: " + filePath);
      } finally {
        const didCloseParams: DidCloseTextDocumentParams = {
          textDocument: {
            uri,
          },
        };
        client.sendNotification(DidCloseTextDocumentNotification.type, didCloseParams);
      }
    }

    logRepoProgress(repo.name, "Finished processing Java files");
  } catch (error: any) {
    console.error(error);
    const failureMessage = String(error && error.message ? error.message : error);
    appendLog(outPath, "Failure: " + repo.name + " - " + failureMessage);
    logRepoProgress(repo.name, "Failure: " + failureMessage);
  } finally {
    if (mirroredLogSubscription) {
      mirroredLogSubscription.dispose();
      mirroredLogSubscription = undefined;
    }
    if (client) {
      try {
        logRepoProgress(repo.name, "Shutting down " + server.displayName);
        await withTimeout(client.shutdownAndExit(), 15000, "Shutdown timeout");
        logRepoProgress(repo.name, server.displayName + " shutdown complete");
      } catch (_error) {
        logRepoProgress(repo.name, server.displayName + " shutdown timed out; killing process");
        client.kill();
      }
    }
    if (tempRootDir) {
      try {
        logRepoProgress(repo.name, "Cleaning temporary workspace");
        fs.rmSync(tempRootDir, { recursive: true, force: true });
        logRepoProgress(repo.name, "Temporary workspace removed");
      } catch (_error) {
        // Best effort cleanup.
      }
    }
    appendLog(outPath, "done " + repo.name);
    logRepoProgress(repo.name, "Repository run complete");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  validateArgs(args);

  const server = getLanguageServer(args.serverId);
  const ctx = buildServerContext(args);

  logProgress("Loading repositories from " + args.reposPath);
  const repos = loadRepos(args.reposPath);
  logProgress("Loaded " + repos.length + " repositories");

  logProgress("Resolving " + server.displayName + " server");
  const resolved = await server.resolveServer(ctx);
  logProgress(server.displayName + " server resolved");

  fs.writeFileSync(args.outPath, "", "utf8");
  logProgress("Output file initialized at " + args.outPath);

  for (let i = 0; i < repos.length; i += 1) {
    logRepoProgress(repos[i].name, "Running repository " + (i + 1) + "/" + repos.length);
    await processRepo(repos[i], server, resolved, args.outPath, args.serverId, args.openFiles);
  }
  logProgress("All repositories processed");
}

main().catch((error: any) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});
