/// <reference lib="es2015" />

declare function require(name: string): any;
declare const process: any;

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const BufferCtor = require("buffer").Buffer;
const pathToFileURL = require("url").pathToFileURL;

interface RepoEntry {
  name: string;
  uri: string;
}

interface Diagnostic {
  severity?: number;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

type NotificationHandler = (params: any) => void;

class JsonRpcLspClient {
  private readonly child: any;
  private nextId: number = 1;
  private readonly pending: { [id: number]: PendingRequest } = {};
  private readonly handlers: { [method: string]: NotificationHandler[] } = {};
  private readBuffer: any = BufferCtor.alloc(0);
  private readonly stderrPrefix: string;

  public constructor(child: any, stderrPrefix: string) {
    this.child = child;
    this.stderrPrefix = stderrPrefix;

    this.child.stdout.on("data", (chunk: any) => {
      this.onStdoutChunk(chunk);
    });
    this.child.stderr.on("data", (chunk: any) => {
      const text = String(chunk);
      if (text.trim().length > 0) {
        process.stderr.write(this.stderrPrefix + text);
      }
    });
    this.child.on("exit", () => {
      const ids = Object.keys(this.pending);
      for (let i = 0; i < ids.length; i += 1) {
        const idNum = Number(ids[i]);
        const pendingRequest = this.pending[idNum];
        if (pendingRequest) {
          pendingRequest.reject(new Error("Language server process exited"));
          delete this.pending[idNum];
        }
      }
    });
  }

  public onNotification(method: string, handler: NotificationHandler): void {
    if (!this.handlers[method]) {
      this.handlers[method] = [];
    }
    this.handlers[method].push(handler);
  }

  public sendRequest(method: string, params: any): Promise<any> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending[id] = { resolve, reject };
      this.writePayload(payload);
    });
  }

  public sendNotification(method: string, params: any): void {
    const payload = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writePayload(payload);
  }

  public async shutdownAndExit(): Promise<void> {
    try {
      await this.sendRequest("shutdown", null);
    } finally {
      this.sendNotification("exit", null);
    }
  }

  public kill(): void {
    try {
      this.child.kill();
    } catch (_error) {
      // Best effort kill.
    }
  }

  private writePayload(payload: any): void {
    const body = JSON.stringify(payload);
    const header = "Content-Length: " + BufferCtor.byteLength(body, "utf8") + "\r\n\r\n";
    this.child.stdin.write(header + body, "utf8");
  }

  private onStdoutChunk(chunk: any): void {
    this.readBuffer = BufferCtor.concat([this.readBuffer, chunk]);

    while (true) {
      const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const headerText = this.readBuffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!contentLengthMatch) {
        this.readBuffer = this.readBuffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.readBuffer.length < bodyEnd) {
        return;
      }

      const bodyText = this.readBuffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.readBuffer = this.readBuffer.slice(bodyEnd);

      let message: any;
      try {
        message = JSON.parse(bodyText);
      } catch (_error) {
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: any): void {
    if (typeof message.id !== "undefined") {
      const pendingRequest = this.pending[message.id];
      if (!pendingRequest) {
        return;
      }
      delete this.pending[message.id];
      if (message.error) {
        pendingRequest.reject(new Error(String(message.error.message || "LSP request failed")));
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const listeners = this.handlers[message.method] || [];
      for (let i = 0; i < listeners.length; i += 1) {
        listeners[i](message.params);
      }
    }
  }
}

function parseArgs(argv: string[]): { reposPath: string; metalsJarPath: string; outPath: string } {
  let reposPath = "";
  let metalsJarPath = "";
  let outPath = path.resolve(process.cwd(), "out.txt");

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repos" && i + 1 < argv.length) {
      reposPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--metals-jar" && i + 1 < argv.length) {
      metalsJarPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--out" && i + 1 < argv.length) {
      outPath = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  if (!reposPath || !metalsJarPath) {
    throw new Error(
      "Usage: node app/build/index.js --repos <repos.json> --metals-jar <metals.jar> [--out <out.txt>]",
    );
  }

  return { reposPath, metalsJarPath, outPath };
}

function appendLog(outPath: string, message: string): void {
  fs.appendFileSync(outPath, message + "\n", "utf8");
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

async function startMetalsClient(metalsJarPath: string, workspaceDir: string, repoName: string): Promise<JsonRpcLspClient> {
  const args = ["-Xss4m", "-Xms100m", "-Dmetals.client=repo-tester", "-classpath", metalsJarPath, "scala.meta.metals.Main"];
  const child = cp.spawn("java", args, {
    cwd: workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const client = new JsonRpcLspClient(child, "[" + repoName + "] ");

  const rootUri = toFileUri(workspaceDir);
  await withTimeout(
    client.sendRequest("initialize", {
      processId: process.pid,
      clientInfo: {
        name: "metals-repo-tester",
        version: "0.0.0",
      },
      locale: "en",
      rootPath: workspaceDir,
      rootUri,
      initializationOptions: {},
      capabilities: {},
      trace: "off",
      workspaceFolders: [
        {
          uri: rootUri,
          name: path.basename(workspaceDir),
        },
      ],
    }),
    60000,
    "Timed out waiting for Metals initialize response",
  );
  client.sendNotification("initialized", {});
  return client;
}

function waitForIndexLoadedMessage(client: JsonRpcLspClient, timeoutMs: number): Promise<void> {
  const indexRegex = /mbt-v2 loaded index for \d+ files in/;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for Metals index log"));
    }, timeoutMs);

    client.onNotification("window/logMessage", (params: any) => {
      const message = params && typeof params.message === "string" ? params.message : "";
      if (indexRegex.test(message)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function processRepo(repo: RepoEntry, metalsJarPath: string, outPath: string): Promise<void> {
  appendLog(outPath, "starting " + repo.name);

  let tempRootDir = "";
  let repoDir = "";
  let client: JsonRpcLspClient | null = null;

  try {
    const cloned = await cloneRepoToTemp(repo);
    tempRootDir = cloned.rootTempDir;
    repoDir = cloned.repoDir;

    client = await startMetalsClient(metalsJarPath, repoDir, repo.name);
    await waitForIndexLoadedMessage(client, 10 * 60 * 1000);

    const javaFiles = collectJavaFiles(repoDir);

    const diagnosticsWaiters: {
      [uri: string]: Array<(diagnostics: Diagnostic[]) => void>;
    } = {};

    client.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
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

      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: "java",
          version: 1,
          text,
        },
      });

      const diagnostics = await waitForDiagnostics(uri, 10000);
      if (diagnostics === null) {
        appendLog(outPath, "Timeout: " + filePath);
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
        }
      }

      client.sendNotification("textDocument/didClose", {
        textDocument: {
          uri,
        },
      });
    }
  } catch (error: any) {
    appendLog(outPath, "Failure: " + repo.name + " - " + String(error && error.message ? error.message : error));
  } finally {
    if (client) {
      try {
        await withTimeout(client.shutdownAndExit(), 15000, "Shutdown timeout");
      } catch (_error) {
        client.kill();
      }
    }
    if (tempRootDir) {
      try {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
      } catch (_error) {
        // Best effort cleanup.
      }
    }
    appendLog(outPath, "done " + repo.name);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const repos = loadRepos(args.reposPath);
  fs.writeFileSync(args.outPath, "", "utf8");

  if (!fs.existsSync(args.metalsJarPath)) {
    throw new Error("Metals jar path does not exist: " + args.metalsJarPath);
  }

  for (let i = 0; i < repos.length; i += 1) {
    await processRepo(repos[i], args.metalsJarPath, args.outPath);
  }
}

main().catch((error: any) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});
