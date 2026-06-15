# Metals Repo Diagnostics Runner

CLI tool that clones repositories from a JSON list, starts a language server, waits for indexing, opens each Java file, and logs diagnostics timeouts/errors to an output file.

Supported language servers: **Metals** (default), **Eclipse JDT.LS**, and **IntelliJ Language Server**.

## Input format

Use a JSON file containing entries like:

```json
[
  { "name": "google-guava", "uri": "https://github.com/google/guava" },
  { "name": "spring-boot", "uri": "https://github.com/spring-projects/spring-boot" }
]
```

A ready-to-edit sample file is included as `repos.json`.

## Requirements

- Node.js + npm
- `git` available on PATH
- `java` available on PATH (Metals and JDT.LS)
- Coursier `cs` available on PATH (Metals only)
- IntelliJ Language Server executable (IntelliJ only; see below)

## Build

```bash
npm install
npm run build
```

## Run

### Metals (default)

```bash
node app/build/index.js --repos repos.json --server-version 2.0.0-SNAPSHOT --out out.txt
```

### Eclipse JDT.LS

```bash
node app/build/index.js --server jdtls --repos repos.json --jdtls-home /path/to/jdtls --out out.txt
```

### IntelliJ Language Server

```bash
node app/build/index.js --server intellij --repos tiny-repo.json --out out-tiny-repo.txt
```

The IntelliJ server is auto-discovered from `~/.vscode/extensions/jetbrains.intellij-*/server/bin/` when not specified explicitly. Readiness is detected from `<system-path>/system/log/intellij-server.log` when the log contains `Workspace model cache saved`.

```bash
node app/build/index.js --server intellij --intellij-server "C:/path/to/intellij-server.exe" --repos one-repo.json --out out-one-repo.txt
```

### Flags

- `--repos <path>`: required JSON file with repository entries
- `--server <metals|jdtls|intellij>`: language server to use (default: `metals`)
- `--server-version <version>`: required for Metals (resolved via `cs fetch -p`)
- `--jdtls-home <path>`: JDT.LS install directory (or set `JDTLS_HOME`)
- `--intellij-server <path>`: IntelliJ server executable (or set `INTELLIJ_SERVER`; auto-discovered from VS Code extension if unset)
- `--out <path>`: optional output log path (default: `out.txt` in current working directory)

## Output

For each repo, the runner writes:

- `starting <repo-name>`
- `[lsp][<repo-name>][error] <uri>: <message>` when error diagnostics are reported
- `Timeout: <absolute-java-file-path>` when no diagnostics arrive within the timeout (10s for Metals/JDT.LS, 30s for IntelliJ)
- `done <repo-name>`

If a repo-level step fails, it logs:

- `Failure: <repo-name> - <error-message>`
