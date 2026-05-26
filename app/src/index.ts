/// <reference lib="es2015" />

import type {
  Diagnostic,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  InitializeResult,
  InitializeParams,
  InitializedParams,
  LogMessageParams,
  MessageActionItem,
  PublishDiagnosticsParams,
  ShowMessageRequestParams,
} from "vscode-languageserver-protocol";
import type { Disposable, ProtocolConnection } from "vscode-languageserver-protocol/node";

declare function require(name: string): any;
declare const process: any;

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const pathToFileURL = require("url").pathToFileURL;
const lspNode = require("vscode-languageserver-protocol/node");

interface RepoEntry {
  name: string;
  uri: string;
}

class MetalsLspClient {
  private readonly child: any;
  private readonly connection: ProtocolConnection;
  private readonly stderrPrefix: string;

  public constructor(child: any, stderrPrefix: string) {
    this.child = child;
    this.stderrPrefix = stderrPrefix;
    this.connection = lspNode.createProtocolConnection(
      new lspNode.StreamMessageReader(this.child.stdout),
      new lspNode.StreamMessageWriter(this.child.stdin),
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
      await this.sendRequest<void, void>(lspNode.ShutdownRequest.type, undefined);
    } finally {
      this.sendNotification(lspNode.ExitNotification.type);
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

function parseArgs(argv: string[]): { reposPath: string; serverVersion: string; outPath: string } {
  let reposPath = "";
  let serverVersion = "";
  let outPath = path.resolve(process.cwd(), "out.txt");

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repos" && i + 1 < argv.length) {
      reposPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--server-version" && i + 1 < argv.length) {
      serverVersion = String(argv[i + 1]).trim();
      i += 1;
    } else if (arg === "--out" && i + 1 < argv.length) {
      outPath = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  if (!reposPath || !serverVersion) {
    throw new Error(
      "Usage: node app/build/index.js --repos <repos.json> --server-version <metals-version> [--out <out.txt>]",
    );
  }

  return { reposPath, serverVersion, outPath };
}

function appendLog(outPath: string, message: string): void {
  fs.appendFileSync(outPath, message + "\n", "utf8");
}

function timestampNow(): string {
  return new Date().toISOString();
}

function logProgress(message: string): void {
  process.stdout.write("[progress " + timestampNow() + "] " + message + "\n");
}

function logRepoProgress(repoName: string, message: string): void {
  logProgress("[" + repoName + "] " + message);
}

function getLogMessageTypeLabel(type: number | undefined): string {
  if (type === 1) {
    return "error";
  }
  if (type === 2) {
    return "warning";
  }
  if (type === 3) {
    return "info";
  }
  if (type === 4) {
    return "log";
  }
  return "unknown";
}

function loadRepos(reposPath: string): RepoEntry[] {
  const raw = fs.readFileSync(reposPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Repo file must contain an array");
  }

  const repos: RepoEntry[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item.name !== "string" || typeof item.uri !== "string") {
      throw new Error("Repo entry at index " + i + " must have string fields name and uri");
    }
    repos.push({ name: item.name, uri: item.uri });
  }
  return repos;
}

function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stderrText = "";
    child.stderr.on("data", (chunk: any) => {
      stderrText += String(chunk);
    });
    child.on("error", (error: any) => {
      reject(error);
    });
    child.on("close", (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(command + " exited with code " + code + (stderrText ? ": " + stderrText : "")));
      }
    });
  });
}

function runCommandAndCaptureStdout(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk: any) => {
      stdoutText += String(chunk);
    });
    child.stderr.on("data", (chunk: any) => {
      stderrText += String(chunk);
    });
    child.on("error", (error: any) => {
      reject(
        new Error("Failed to run " + command + " " + args.join(" ") + ": " + String(error && error.message ? error.message : error)),
      );
    });
    child.on("close", (code: number) => {
      if (code === 0) {
        resolve(stdoutText.trim());
      } else {
        reject(new Error(command + " " + args.join(" ") + " exited with code " + code + (stderrText ? ": " + stderrText : "")));
      }
    });
  });
}

async function resolveMetalsClasspath(serverVersion: string): Promise<string> {
  const artifact = "org.scalameta:metals_2.13:" + serverVersion;
  logProgress("Resolving Metals classpath for " + artifact);
  const classpath =
    process.platform === "win32"
      ? await runCommandAndCaptureStdout("cmd.exe", ["/d", "/s", "/c", "cs fetch -p " + artifact])
      : await runCommandAndCaptureStdout("cs", ["fetch", "-p", artifact]);
  if (!classpath) {
    throw new Error("cs fetch returned an empty classpath for " + artifact);
  }
  logProgress("Resolved Metals classpath for " + artifact);
  return classpath;
}

async function cloneRepoToTemp(repo: RepoEntry): Promise<{ rootTempDir: string; repoDir: string }> {
  const rootTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metals-repo-"));
  const repoDir = path.join(rootTempDir, sanitizeRepoName(repo.name));
  await runCommand("git", ["clone", "--depth", "1", repo.uri, repoDir]);
  return { rootTempDir, repoDir };
}

function sanitizeRepoName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function collectJavaFiles(rootDir: string): string[] {
  const ignoredDirs: { [dirName: string]: boolean } = {
    ".git": true,
    "target": true,
    ".metals": true,
    ".bloop": true,
    "node_modules": true,
  };

  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: any[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_error) {
      return;
    }

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs[entry.name]) {
          walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".java")) {
        results.push(path.resolve(fullPath));
      }
    }
  }

  walk(rootDir);
  results.sort();
  return results;
}

function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startMetalsClient(metalsClasspath: string, workspaceDir: string, repoName: string): Promise<MetalsLspClient> {
  const args = ["-Xss4m", "-Xms100m", "-Dmetals.client=repo-tester", "-classpath", metalsClasspath, "scala.meta.metals.Main"];
  const child = cp.spawn("java", args, {
    cwd: workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const client = new MetalsLspClient(child, "[" + repoName + "] ");
  client.onRequest<ShowMessageRequestParams, MessageActionItem | null>(
    lspNode.ShowMessageRequest.type,
    (params: ShowMessageRequestParams) => {
      const message = params && typeof params.message === "string" ? params.message : "";
      const actions = params && Array.isArray(params.actions) ? params.actions : [];
      for (let i = 0; i < actions.length; i += 1) {
        const action = actions[i];
        const title = action && typeof action.title === "string" ? action.title : "";
        if (/MBT/i.test(title)) {
          logRepoProgress(repoName, "Auto-selected MBT for Metals prompt: " + message);
          return action;
        }
      }

      logRepoProgress(repoName, "Metals prompt had no MBT action: " + message);
      return null;
    },
  );

  const rootUri = toFileUri(workspaceDir);
  const initializeParams: InitializeParams = {
    processId: process.pid,
    clientInfo: {
      name: "metals-repo-tester",
      version: "0.0.0",
    },
    locale: "en",
    rootPath: workspaceDir,
    rootUri,
    initializationOptions: {
      "metals.preferredBuildServer": "MBT",
      "isHttpEnabled": true
    },
    capabilities: {},
    trace: "off",
    workspaceFolders: [
      {
        uri: rootUri,
        name: path.basename(workspaceDir),
      },
    ],
  };
  await withTimeout(
    client.sendRequest<InitializeParams, InitializeResult<any>>(lspNode.InitializeRequest.type, initializeParams),
    60000,
    "Timed out waiting for Metals initialize response",
  );
  const initializedParams: InitializedParams = {};
  client.sendNotification(lspNode.InitializedNotification.type, initializedParams);
  return client;
}

function waitForIndexLoadedMessage(client: MetalsLspClient, timeoutMs: number): Promise<void> {
  const indexRegex = /mbt-v2 loaded index for \d+ files in/;

  return new Promise((resolve, reject) => {
    let subscription: Disposable;
    const timer = setTimeout(() => {
      if (subscription) {
        subscription.dispose();
      }
      reject(new Error("Timed out waiting for Metals index log"));
    }, timeoutMs);

    subscription = client.onNotification<LogMessageParams>(lspNode.LogMessageNotification.type, (params: LogMessageParams) => {
      const message = params && typeof params.message === "string" ? params.message : "";
      if (indexRegex.test(message)) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
}

async function processRepo(repo: RepoEntry, metalsClasspath: string, outPath: string): Promise<void> {
  appendLog(outPath, "starting " + repo.name);
  logRepoProgress(repo.name, "Starting repository run");

  let tempRootDir = "";
  let repoDir = "";
  let client: MetalsLspClient | null = null;
  let mirroredLogSubscription: Disposable | null = null;

  try {
    logRepoProgress(repo.name, "Cloning repository from " + repo.uri);
    const cloned = await cloneRepoToTemp(repo);
    tempRootDir = cloned.rootTempDir;
    repoDir = cloned.repoDir;
    logRepoProgress(repo.name, "Clone completed at " + repoDir);

    logRepoProgress(repo.name, "Starting Metals language server");
    client = await startMetalsClient(metalsClasspath, repoDir, repo.name);
    logRepoProgress(repo.name, "Metals initialized");

    mirroredLogSubscription = client.onNotification<LogMessageParams>(
      lspNode.LogMessageNotification.type,
      (params: LogMessageParams) => {
        const level = getLogMessageTypeLabel(params && params.type);
        const message = params && typeof params.message === "string" ? params.message : "";
        if (message.length > 0) {
          logProgress("[lsp][" + repo.name + "][" + level + "] " + message);
        }
      },
    );

    logRepoProgress(repo.name, "Waiting for Metals index to load");
    await waitForIndexLoadedMessage(client, 10 * 60 * 1000);
    logRepoProgress(repo.name, "Metals index loaded");

    const javaFiles = collectJavaFiles(repoDir);
    logRepoProgress(repo.name, "Collected " + javaFiles.length + " Java files");

    const diagnosticsWaiters: {
      [uri: string]: Array<(diagnostics: Diagnostic[]) => void>;
    } = {};

    client.onNotification<PublishDiagnosticsParams>(lspNode.PublishDiagnosticsNotification.type, (params: PublishDiagnosticsParams) => {
      const waiters = diagnosticsWaiters[params.uri];
      if (waiters && waiters.length > 0) {
        const copy = waiters.slice(0);
        diagnosticsWaiters[params.uri] = [];
        for (let i = 0; i < copy.length; i += 1) {
          copy[i](params.diagnostics || []);
        }
      }
    });

    const waitForDiagnostics = (uri: string, timeoutMs: number): Promise<Diagnostic[] | null> =>
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          const queue = diagnosticsWaiters[uri] || [];
          diagnosticsWaiters[uri] = queue.filter((callback) => callback !== onDiagnostics);
          resolve(null);
        }, timeoutMs);

        const onDiagnostics = (diagnostics: Diagnostic[]) => {
          clearTimeout(timeout);
          resolve(diagnostics);
        };

        if (!diagnosticsWaiters[uri]) {
          diagnosticsWaiters[uri] = [];
        }
        diagnosticsWaiters[uri].push(onDiagnostics);
      });

    for (let i = 0; i < javaFiles.length; i += 1) {
      const filePath = javaFiles[i];
      const uri = toFileUri(filePath);
      const text = fs.readFileSync(filePath, "utf8");
      logRepoProgress(repo.name, "Processing file " + (i + 1) + "/" + javaFiles.length + ": " + filePath);

      const didOpenParams: DidOpenTextDocumentParams = {
        textDocument: {
          uri,
          languageId: "java",
          version: 1,
          text,
        },
      };
      client.sendNotification<DidOpenTextDocumentParams>(lspNode.DidOpenTextDocumentNotification.type, didOpenParams);

      const diagnostics = await waitForDiagnostics(uri, 10000);
      if (diagnostics === null) {
        appendLog(outPath, "Timeout: " + filePath);
        logRepoProgress(repo.name, "Timed out waiting for diagnostics: " + filePath);
      } else {
        let hasError = false;
        for (let j = 0; j < diagnostics.length; j += 1) {
          if (diagnostics[j].severity === 1) {
            hasError = true;
            break;
          }
        }
        if (hasError) {
          appendLog(outPath, "Error: " + filePath);
          logRepoProgress(repo.name, "Error diagnostics reported: " + filePath);
        }
      }

      const didCloseParams: DidCloseTextDocumentParams = {
        textDocument: {
          uri,
        },
      };
      client.sendNotification<DidCloseTextDocumentParams>(lspNode.DidCloseTextDocumentNotification.type, didCloseParams);
    }
    logRepoProgress(repo.name, "Finished processing Java files");
  } catch (error: any) {
    const failureMessage = String(error && error.message ? error.message : error);
    appendLog(outPath, "Failure: " + repo.name + " - " + failureMessage);
    logRepoProgress(repo.name, "Failure: " + failureMessage);
  } finally {
    if (mirroredLogSubscription) {
      mirroredLogSubscription.dispose();
      mirroredLogSubscription = null;
    }
    if (client) {
      try {
        logRepoProgress(repo.name, "Shutting down Metals");
        await withTimeout(client.shutdownAndExit(), 15000, "Shutdown timeout");
        logRepoProgress(repo.name, "Metals shutdown complete");
      } catch (_error) {
        logRepoProgress(repo.name, "Metals shutdown timed out; killing process");
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
  logProgress("Loading repositories from " + args.reposPath);
  const repos = loadRepos(args.reposPath);
  logProgress("Loaded " + repos.length + " repositories");
  const metalsClasspath = await resolveMetalsClasspath(args.serverVersion);
  fs.writeFileSync(args.outPath, "", "utf8");
  logProgress("Output file initialized at " + args.outPath);

  for (let i = 0; i < repos.length; i += 1) {
    logProgress("Running repository " + (i + 1) + "/" + repos.length + ": " + repos[i].name);
    await processRepo(repos[i], metalsClasspath, args.outPath);
  }
  logProgress("All repositories processed");
}

main().catch((error: any) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});
