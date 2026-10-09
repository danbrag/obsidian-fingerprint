import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";

// Never print matched credentials: report only filenames and rule names.
const staged = process.argv.includes("--staged");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
process.chdir(git("rev-parse", "--show-toplevel").trim());
const files = [...new Set(git("ls-files", "-z", "--cached",
  ...(staged ? [] : ["--others", "--exclude-standard"]))
  .split("\0").filter(Boolean))];
const errors = [];
const contents = new Map();
const allowedPackage = /^plugins\/fingerprint-lock\/(main\.js|manifest\.json|styles\.css)$/;
const forbiddenPaths = [
  /(^|\/)(node_modules|\.obsidian|\.aws|\.ssh|\.idea|\.vscode|\.codex|\.agents|\.artifacts|\.worktrees|coverage|dist|build|scratch|tmp)(\/|$)/,
  /(^|\/)(data\.json|\.DS_Store|\.env(?:\..*)?)$/,
  /\.(pem|key|p12|pfx|mobileprovision|log|swp|swo|tsbuildinfo|map)$/i,
  /~$/,
  /^native\/(Obsidian|touchid-auth)(\/|$)/,
];
const credentials = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["credential in URL", /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
  ["personal absolute path", /\/(?:Users|Volumes)\/[^\s"'`<>]+/],
];

for (const file of files) {
  const envExample = /(^|\/)\.env\.example$/.test(file);
  if ((!envExample && forbiddenPaths.some((rule) => rule.test(file))) ||
      (file.startsWith("plugins/") && !allowedPackage.test(file))) {
    errors.push(`${file}: local/private or unsupported generated file`);
    continue;
  }
  let buffer;
  if (staged) {
    // Read the index, so an unstaged cleanup cannot conceal staged secrets.
    const mode = git("ls-files", "--stage", "--", file).split(" ")[0];
    if (mode === "120000" || mode === "160000") {
      errors.push(`${file}: symlinks and submodules need an explicit policy review`);
      continue;
    }
    buffer = execFileSync("git", ["show", `:${file}`], { maxBuffer: 16 * 1024 * 1024 });
  } else {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue; // Working-tree deletion; the staged check uses the index.
    if (!stat.isFile()) {
      errors.push(`${file}: only regular files are allowed`);
      continue;
    }
    buffer = readFileSync(file);
  }
  if (buffer.includes(0)) {
    errors.push(`${file}: binary file needs an explicit distribution policy review`);
    continue;
  }
  const value = buffer.toString("utf8");
  contents.set(file, value);
  for (const [name, rule] of credentials) {
    if (rule.test(value)) errors.push(`${file}: possible ${name}`);
  }
}

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const copy = `plugins/fingerprint-lock/${file}`;
  if (!contents.has(file) || !contents.has(copy)) {
    errors.push(`${file}: required distribution file or package copy is missing`);
  } else if (contents.get(file) !== contents.get(copy)) {
    errors.push(`${copy}: differs from ${file}; run npm run build and stage both`);
  }
}
for (const file of ["main.js", "plugins/fingerprint-lock/main.js"]) {
  if (/sourceMappingURL\s*=/.test(contents.get(file) ?? "")) {
    errors.push(`${file}: development source map; run npm run build`);
  }
}

if (errors.length) {
  console.error(`Repository policy failed (${staged ? "staged index" : "working tree"}):\n` +
    errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Repository policy passed (${staged ? "staged index" : "working tree"}; ${files.length} files).`);
}
