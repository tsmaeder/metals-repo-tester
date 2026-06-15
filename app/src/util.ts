/// <reference lib="es2015" />

declare function require(name: string): any;
declare const process: any;

import fs = require("fs");
import path = require("path");
import os = require("os");
import cp = require("child_process");
import { pathToFileURL } from "url";
import type { RepoEntry } from "./language-server";

export function appendLog(outPath: string, message: string): void {
  fs.appendFileSync(outPath, message + "\n", "utf8");
}

export function timestampNow(): string {
  return new Date().toISOString();
}

export function logProgress(message: string): void {
  process.stdout.write("[progress " + timestampNow() + "] " + message + "\n");
}

export function logRepoProgress(repoName: string, message: string): void {
  logProgress("[" + repoName + "] " + message);
}

export function getLogMessageTypeLabel(type: number | undefined): string {
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

export function loadRepos(reposPath: string): RepoEntry[] {
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

export function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
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

export function runCommandAndCaptureStdout(command: string, args: string[], cwd?: string): Promise<string> {
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

export async function cloneRepoToTemp(repo: RepoEntry): Promise<{ rootTempDir: string; repoDir: string }> {
  const rootTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metals-repo-"));
  const repoDir = path.join(rootTempDir, sanitizeRepoName(repo.name));
  await runCommand("git", ["clone", "--depth", "1", repo.uri, repoDir]);
  return { rootTempDir, repoDir };
}

export function sanitizeRepoName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function collectJavaFiles(rootDir: string): string[] {
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

export function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
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
