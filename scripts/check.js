import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const roots = ["bin", "src", "scripts", "test"];
const files = [];

async function collect(relative) {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await collect(child);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(child);
    }
  }
}

for (const directory of roots) await collect(directory);
files.sort();

const failures = [];
for (const relative of files) {
  const result = spawnSync(process.execPath, ["--check", relative], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failures.push(`${relative}:\n${result.stderr || result.stdout}`);
  }

  if (relative.startsWith(`src${path.sep}`)) {
    const source = await readFile(path.join(root, relative), "utf8");
    const forbidden = [
      ["dangerously", "bypass", "approvals"].join("-"),
      ["dangerously", "skip", "permissions"].join("-"),
    ];
    for (const token of forbidden) {
      if (source.includes(token)) {
        failures.push(`${relative}: forbidden provider bypass flag ${token}`);
      }
    }
    if (/\b(exec|execSync)\s*\(/u.test(source)) {
      failures.push(`${relative}: shell-style child_process execution is forbidden; use spawn`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} JavaScript files: syntax and safety checks passed.`);
}
