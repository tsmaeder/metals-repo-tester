import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2] ?? "stdout-repos.txt";
const output = process.argv[3] ?? "repo-summary.tsv";

const lines = readFileSync(input, "utf8").split(/\r?\n/);

const progressRe = /^\[progress (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;
const runningRe = /Running repository \d+\/\d+: (.+)$/;
const cloningRe = /Cloning repository from (\S+)/;

/** @type {{name:string, uri:string, start?:number, end?:number, errors:number}[]} */
const repos = [];
let cur;

for (const line of lines) {
  const running = line.match(runningRe);
  if (running) {
    cur = { name: running[1].trim(), uri: "", errors: 0 };
    repos.push(cur);
    continue;
  }
  if (!cur) continue;

  const clone = line.match(cloningRe);
  if (clone) cur.uri = clone[1];

  const ts = line.match(progressRe);
  const tsMs = ts ? Date.parse(ts[1]) : undefined;

  if (line.includes("Starting Metals language server") && tsMs !== undefined) {
    cur.start = tsMs;
  }
  if (line.includes("Metals index loaded") && tsMs !== undefined) {
    cur.end = tsMs;
  }

  if (
    line.includes("no build target for") ||
    line.includes("compiler crashed due to an error")
  ) {
    cur.errors++;
  }
}

const rows = ["repo_uri\tindex_load_seconds\terror_count"];
for (const r of repos) {
  const seconds =
    r.start !== undefined && r.end !== undefined
      ? ((r.end - r.start) / 1000).toFixed(3)
      : "";
  rows.push(`${r.uri || r.name}\t${seconds}\t${r.errors}`);
}

writeFileSync(output, rows.join("\n") + "\n", "utf8");
console.log(`Parsed ${repos.length} repositories -> ${output}`);
