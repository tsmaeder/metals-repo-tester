import { readFileSync, writeFileSync } from "node:fs";

const stdoutFiles = [
  "stdout-bazel-repos.txt",
  "stdout-repos-done.txt",
  "stdout-repos.txt",
];

const output = process.argv[2] ?? "java-files-summary.tsv";

const runningRe = /Running repository \d+\/\d+: (.+)$/;
const cloningRe = /Cloning repository from (\S+)/;
const collectedRe = /Collected (\d+) Java files/;
const processingRe = /Processing file (\d+)\/\d+/;

/** @type {{name: string, uri: string, collected: number, processed: number}[]} */
const repos = [];

for (const input of stdoutFiles) {
  const lines = readFileSync(input, "utf8").split(/\r?\n/);
  /** @type {{name: string, uri: string, collected: number, processed: number} | undefined} */
  let cur;

  for (const line of lines) {
    const running = line.match(runningRe);
    if (running) {
      cur = { name: running[1].trim(), uri: "", collected: 0, processed: 0 };
      repos.push(cur);
      continue;
    }
    if (!cur) continue;

    const clone = line.match(cloningRe);
    if (clone) {
      cur.uri = clone[1];
    }

    const collected = line.match(collectedRe);
    if (collected) {
      cur.collected = Number(collected[1]);
    }

    const processing = line.match(processingRe);
    if (processing) {
      cur.processed = Math.max(cur.processed, Number(processing[1]));
    }
  }
}

const rows = ["repo_uri\tcollected_java_files\tprocessed_java_files"];
for (const r of repos) {
  rows.push(`${r.uri || r.name}\t${r.collected}\t${r.processed}`);
}
writeFileSync(output, rows.join("\n") + "\n", "utf8");
console.log(`Parsed ${repos.length} repositories -> ${output}`);
