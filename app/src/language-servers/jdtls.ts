/// <reference lib="es2015" />

declare function require(name: string): any;
declare const process: any;

import fs = require("fs");
import path = require("path");
import type { InitializeParams } from "vscode-languageserver-protocol";
import type { LspClient } from "../lsp-client";
import type { LanguageServer, ServerContext, SpawnSpec } from "../language-server";
import { Deferred } from "../deferred";
import { collectJavaFiles, toFileUri, withTimeout } from "../util";

export interface JdtlsResolvedServer {
  home: string;
  launcherJar: string;
  configDir: string;
}

const LANGUAGE_STATUS_NOTIFICATION = "language/status";

interface LanguageStatusParams {
  type: number;
  message?: string;
}

function findLauncherJar(home: string): string {
  const pluginsDir = path.join(home, "plugins");
  if (!fs.existsSync(pluginsDir)) {
    throw new Error("JDT.LS plugins directory not found at " + pluginsDir);
  }

  const entries = fs.readdirSync(pluginsDir);
  const launcherName = entries.find((entry: string) =>
    /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(entry),
  );
  if (!launcherName) {
    throw new Error("Could not find org.eclipse.equinox.launcher_*.jar in " + pluginsDir);
  }
  return path.join(pluginsDir, launcherName);
}

function resolveConfigDir(home: string): string {
  let configName: string;
  if (process.platform === "win32") {
    configName = "config_win";
  } else if (process.platform === "darwin") {
    configName = "config_mac";
  } else {
    configName = "config_linux";
  }

  const configDir = path.join(home, configName);
  if (!fs.existsSync(configDir)) {
    throw new Error("JDT.LS config directory not found at " + configDir);
  }
  return configDir;
}

export class JdtlsLanguageServer implements LanguageServer {
  public readonly id = "jdtls";
  public readonly displayName = "Eclipse JDT.LS";

  public async resolveServer(ctx: ServerContext): Promise<JdtlsResolvedServer> {
    const home = ctx.jdtlsHome || process.env.JDTLS_HOME;
    if (!home) {
      throw new Error("--jdtls-home or JDTLS_HOME is required for JDT.LS");
    }

    const resolvedHome = path.resolve(home);
    if (!fs.existsSync(resolvedHome)) {
      throw new Error("JDT.LS home directory does not exist: " + resolvedHome);
    }

    const launcherJar = findLauncherJar(resolvedHome);
    const configDir = resolveConfigDir(resolvedHome);
    return { home: resolvedHome, launcherJar, configDir };
  }

  public buildSpawnSpec(
    resolved: unknown,
    workspaceDir: string,
    _repoName: string,
    workspaceDataDir?: string,
  ): SpawnSpec {
    const jdtlsResolved = resolved as JdtlsResolvedServer;
    if (!workspaceDataDir) {
      throw new Error("workspaceDataDir is required for JDT.LS");
    }

    const args = [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dlog.protocol=true",
      "-Dlog.level=ALL",
      "-Xmx1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-jar",
      jdtlsResolved.launcherJar,
      "-configuration",
      jdtlsResolved.configDir,
      "-data",
      workspaceDataDir,
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
        settings: {
          java: {
            configuration: {
              updateBuildConfiguration: "automatic",
            },
          },
        },
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
    client.onRequest("workspace/configuration", () => [
      {
        java: {
          configuration: {
            updateBuildConfiguration: "automatic",
          },
        },
      },
    ]);
  }

  public waitForReady(client: LspClient, _repoName: string, _workspaceDataDir?: string): Promise<void> {
    const readyDeferred = new Deferred<void>();
    const subscription = client.onNotification<LanguageStatusParams>(
      LANGUAGE_STATUS_NOTIFICATION,
      (params: LanguageStatusParams) => {
        if (params && params.type === 2) {
          readyDeferred.resolve(undefined);
        }
      },
    );

    return withTimeout(
      readyDeferred.promise().finally(() => {
        subscription.dispose();
      }),
      900000,
      "Timed out waiting for JDT.LS to become ready",
    );
  }

  public collectFiles(workspaceDir: string): string[] {
    return collectJavaFiles(workspaceDir);
  }

  public languageIdForFile(_filePath: string): string {
    return "java";
  }
}

export const jdtlsLanguageServer = new JdtlsLanguageServer();
