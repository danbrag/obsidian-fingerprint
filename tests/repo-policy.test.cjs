const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, dirname } = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const checker = resolve(__dirname, "../scripts/check-repo.mjs");
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "fingerprint-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const put = (file, value) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), value);
  };
  git("init", "-q");
  for (const [file, value] of Object.entries({
    "main.js": "/* production bundle */",
    "manifest.json": '{"id":"fingerprint-lock"}',
    "styles.css": ".lock {}",
  })) {
    put(file, value);
    put(`plugins/fingerprint-lock/${file}`, value);
  }
  git("add", ".");
  const check = (...args) => spawnSync(process.execPath, [checker, ...args],
    { cwd, encoding: "utf8" });
  return { git, put, check };
}

test("repository policy accepts distribution files and synthetic source", (t) => {
  const { put, check } = fixture(t);
  put("src/example.ts", 'export const example = "placeholder";');
  put(".env.example", "SERVICE_TOKEN=replace-me");
  assert.equal(check().status, 0);
});

test("repository policy catches tracked private settings even if ignored", (t) => {
  const { git, put, check } = fixture(t);
  put(".gitignore", "data.json\n");
  put("data.json", "{}");
  git("add", "-f", "data.json");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /data\.json: local\/private/);
});

test("staged policy reads secrets from the index and redacts their values", (t) => {
  const { git, put, check } = fixture(t);
  const secret = "gh" + "p_" + "A".repeat(36);
  put("src/example.ts", `export const token = "${secret}";`);
  git("add", "src/example.ts");
  put("src/example.ts", 'export const token = "placeholder";');
  assert.equal(check().status, 0);
  const result = check("--staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /possible GitHub token/);
  assert.ok(!result.stderr.includes(secret));
});

test("repository policy rejects mismatched package copies and development maps", (t) => {
  const { put, check } = fixture(t);
  put("main.js", "//# sourceMappingURL=data:application/json;base64,example");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from main\.js/);
  assert.match(result.stderr, /development source map/);
});

test("repository policy rejects native binaries and extra plugin payloads", (t) => {
  const { put, check } = fixture(t);
  put("native/Obsidian", Buffer.from([0, 1, 2]));
  put("plugins/fingerprint-lock/native/helper", "local helper");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /native\/Obsidian: local\/private/);
  assert.match(result.stderr, /plugins\/fingerprint-lock\/native\/helper: local\/private/);
});

test("staged policy ignores unrelated unstaged files but requires complete artifacts", (t) => {
  const { git, put, check } = fixture(t);
  put("data.json", "{}");
  assert.equal(check("--staged").status, 0);
  git("rm", "--cached", "plugins/fingerprint-lock/styles.css");
  assert.equal(check("--staged").status, 1);
});
