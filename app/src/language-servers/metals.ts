import type {
  InitializeParams,
  LogMessageParams,
  MessageActionItem,
  ShowMessageRequestParams,
} from "vscode-languageserver-protocol";
import { LogMessageNotification, ShowMessageRequest } from "vscode-languageserver-protocol";
import type { LspClient } from "../lsp-client";
import type { LanguageServer, ServerContext, SpawnSpec } from "../language-server";
import { Deferred } from "../deferred";
import {
  collectJavaFiles,
  logProgress,
  logRepoProgress,
  runCommandAndCaptureStdout,
  toFileUri,
  withTimeout,
} from "../util";

const REQUIRED_METALS_ARGS = [
  "-Djol.magicFieldOffset=true",
  "-Djol.tryWithSudo=true",
  "-Djdk.attach.allowAttachSelf",
  "--add-opens=java.base/java.nio=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.comp=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.jvm=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.main=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.model=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.processing=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.resources=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED",
  "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
  "--add-opens=jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED",
  "--add-opens=jdk.compiler/com.sun.tools.javac.comp=ALL-UNNAMED",
  "--add-opens=jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED",
  "--add-opens=jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED",
  "-XX:+DisplayVMOutputToStderr",
  "-Xlog:disable",
  "-Xlog:all=warning,gc=warning:stderr",
];

declare const process: any;

export interface MetalsResolvedServer {
  classpath: string;
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

export class MetalsLanguageServer implements LanguageServer {
  public readonly id = "metals";
  public readonly displayName = "Metals";

  public async resolveServer(ctx: ServerContext): Promise<MetalsResolvedServer> {
    if (!ctx.serverVersion) {
      throw new Error("--server-version is required for Metals");
    }
    const classpath = await resolveMetalsClasspath(ctx.serverVersion);
    return { classpath };
  }

  public buildSpawnSpec(
    resolved: unknown,
    workspaceDir: string,
    _repoName: string,
  ): SpawnSpec {
    const metalsResolved = resolved as MetalsResolvedServer;
    const args = [
      "-Xss4m",
      "-Xms100m",
      "-Xmx8g",
      "-Dmetals.client=repo-tester",
      "-classpath",
      metalsResolved.classpath,
      ...REQUIRED_METALS_ARGS,
      "scala.meta.metals.Main",
    ];
    return {
      command: "java",
      args,
      cwd: workspaceDir,
    };
  }

  public buildInitializeParams(workspaceDir: string): InitializeParams {
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
        "metals.preferredBuildServer": "MBT",
        "isHttpEnabled": true,
        "presentationCompilerDiagnostics": true,
        "didFocusProvider": true,
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

  public registerRequestHandlers(client: LspClient, repoName: string): void {
    client.onRequest<ShowMessageRequestParams, MessageActionItem | undefined>(
      ShowMessageRequest.type,
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
        return undefined;
      },
    );
  }

  public waitForReady(client: LspClient, _repoName: string, _workspaceDataDir?: string): Promise<void> {
    const indexLoadedDeferred = new Deferred<void>(900000);
    const subscription = client.onNotification<LogMessageParams>(
      LogMessageNotification.type,
      (params: LogMessageParams) => {
        const message = params && typeof params.message === "string" ? params.message : "";
        if (/time: indexed workspace in /.test(message)) {
          indexLoadedDeferred.resolve(undefined);
        }
      },
    );

    return indexLoadedDeferred.promise().finally(() => {
      subscription.dispose();
    });
  }

  public collectFiles(workspaceDir: string): string[] {
    return collectJavaFiles(workspaceDir);
  }

  public notifyBeforeOpen(client: LspClient, filePath: string): void {
    client.sendNotification<string>("metals/didFocusTextDocument", toFileUri(filePath));
  }

  public languageIdForFile(_filePath: string): string {
    return "java";
  }
}

export const metalsLanguageServer = new MetalsLanguageServer();
