# Metals Repo Diagnostics Runner

CLI tool that clones repositories from a JSON list, starts Metals, waits for indexing, opens each Java file, and logs diagnostics timeouts/errors to `out.txt`.

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
- `java` available on PATH
- Metals server jar path (passed via `--metals-jar`)

## Build

```bash
npm install
npm run build
```

## Run

```bash
node app/build/index.js --repos repos.json --metals-jar /path/to/metals.jar --out out.txt
```

### Flags

- `--repos <path>`: required JSON file with repository entries
- `--metals-jar <path>`: required Metals jar/classpath
- `--out <path>`: optional output log path (default: `out.txt` in current working directory)

## Output

For each repo, the runner writes:

- `starting <repo-name>`
- `Error: <absolute-java-file-path>` when error diagnostics are reported
- `Timeout: <absolute-java-file-path>` when no diagnostics arrive within 10s
- `done <repo-name>`

If a repo-level step fails, it logs:

- `Failure: <repo-name> - <error-message>`