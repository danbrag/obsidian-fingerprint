const fs = require("node:fs"), vm = require("node:vm"), assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const sourceRoot = path.join(__dirname, "..", "src");
const { transformSync } = require("esbuild");
let now = 0, focused = true, nextTimer = 1;
const timers = /* @__PURE__ */ new Map();
const window = { setTimeout(fn, delay) {
  const id = nextTimer++;
  timers.set(id, { fn, at: now + delay });
  return id;
}, clearTimeout(id) {
  timers.delete(id);
}, setInterval() {
  throw Error("Unexpected polling");
}, clearInterval() {
} };
function advance(ms) {
  now += ms;
  for (const [id, t] of [...timers]) if (t.at <= now) {
    timers.delete(id);
    t.fn();
  }
}
class Element {
  constructor(parent = null) {
    this.parent = parent;
    this.children = [];
    this.dataset = {};
    this.connected = true;
    this.listeners = {};
	this.classes = new Set();
  }
  get isConnected() {
    return this.connected && (!this.parent || this.parent.isConnected);
  }
  createDiv(opts) {
    const e = new Element(this);
    Object.assign(e, opts);
    this.children.push(e);
    return e;
  }
  createEl(tag, opts) {
    return this.createDiv({ tag, ...opts });
  }
  addClass(name) {
	this.classes.add(name);
  }
  removeClass(name) {
	this.classes.delete(name);
  }
  toggleClass(name, enabled) {
	if (enabled) this.addClass(name); else this.removeClass(name);
  }
  setText() {
  }
  focus() {
    this.focusCount = (this.focusCount ?? 0) + 1;
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  remove() {
    this.connected = false;
  }
  appendChild(el) {
    this.children.push(el);
  }
  querySelector(selector) {
    const match = (e) => selector === "button.mod-cta" ? e.tag === "button" && e.cls?.split(" ").includes("mod-cta") : e.cls?.split(" ").includes(selector.slice(1));
    for (const e of this.children) {
      if (match(e)) return e;
      const found = e.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
class MarkdownView {
  constructor(file) {
    this.file = file;
    this.containerEl = new Element();
  }
}
const document = { hasFocus: () => focused, body: new Element(), addEventListener() {
}, removeEventListener() {
} };
const native = { isBiometricPlatformSupported: () => true, getBiometricMethodName: () => "Touch ID", getBiometricPlatform: () => "touchid", getNativeHelperPath: () => null, getNativeDir: () => null };
const modules = {};
function load(name) {
  if (modules[name]) return modules[name].exports;
  const module = { exports: {} };
  modules[name] = module;
  const code = transformSync(fs.readFileSync(path.join(sourceRoot, `${name}.ts`), "utf8"), { loader: "ts", format: "cjs" }).code;
  vm.runInNewContext(code, { module, exports: module.exports, require: (dep) => dep === "obsidian" ? { MarkdownView, Plugin: class {
  }, PluginSettingTab: class {
  }, Notice: class {
  } } : dep === "./nativeAuth" ? native : ["./crypto", "./webauthn", "./setupModal"].includes(dep) ? {} : load(dep.slice(2)), window, document, Date: { now: () => now }, createDiv: (opts) => Object.assign(new Element(), opts), console });
  return module.exports;
}
const { DEFAULT_SETTINGS } = load("settings"), Plugin = load("main").default, { NoteGuard } = load("noteGuard"), { LockScreen } = load("lockScreen");
const a = { path: "A.md", basename: "A" }, b = { path: "B.md", basename: "B" }, normal = { path: "Normal.md", basename: "Normal" };
let active = a;
const view = new MarkdownView(a);
function makePlugin() {
  const p = new Plugin();
  p.settings = { ...DEFAULT_SETTINGS, perNoteLockEnabled: true };
  p.app = { workspace: { getActiveFile: () => active, getActiveViewOfType: () => view, getLeavesOfType: () => [{ view }] }, metadataCache: { getFileCache: (file) => ({ frontmatter: { "fingerprint-lock": file !== normal } }) } };
  p.noteGuard = new NoteGuard(p);
  p.lockScreen = new LockScreen(p);
  p.noteGuard.onActiveNoteChange();
  return p;
}
function switchTo(p, file) {
  active = file;
  view.file = file;
  p.noteGuard.onActiveNoteChange();
}
function authenticateNote(p) {
  p.noteGuard.unlockNote(active, p.noteGuard.overlays.get(view.containerEl).querySelector(".fingerprint-note-status"));
}
function fixture() {
  now = 0;
  focused = true;
  timers.clear();
  document.body = new Element();
  active = a;
  view.file = a;
  view.containerEl = new Element();
  const p = makePlugin();
  p.settings.globalAutoLockEnabled = false;
  return p;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => resolve = r);
  return { promise, resolve };
}
function noteAttempt(p) {
  return p.noteGuard.attemptBiometric(active, p.noteGuard.overlays.get(view.containerEl).querySelector(".fingerprint-note-status"), {});
}
test("away timeout respects active reading, early return, and app-away expiry", () => {
  const p = fixture();
  p.settings.relockNotesAfterAway = true;
  p.settings.relockNotesAwayMinutes = 1;
  authenticateNote(p);
  advance(12e4);
  assert(p.noteGuard.isUnlocked(a));
  switchTo(p, normal);
  advance(3e4);
  switchTo(p, a);
  advance(6e4);
  assert(p.noteGuard.isUnlocked(a));
  switchTo(p, normal);
  advance(6e4);
  assert(!p.noteGuard.isUnlocked(a));
  assert(!p.isLocked);
  switchTo(p, a);
  authenticateNote(p);
  focused = false;
  p.onWindowBlur();
  advance(6e4);
  assert(!p.noteGuard.isUnlocked(a));
  p.noteGuard.clear();
  assert.equal(timers.size, 0);
});
test("background locking is quiet; return prompts once, cancellation does not loop", async () => {
  const p = fixture();
  p.settings.globalAutoLockEnabled = true;
  let calls = 0;
  const auth = deferred();
  p.runBiometricAuth = () => {
    calls++;
    return auth.promise;
  };
  focused = false;
  p.onWindowBlur();
  advance(3e4);
  assert(p.isLocked);
  assert.equal(calls, 0);
  focused = true;
  p.onWindowFocus();
  assert.equal(calls, 1);
  focused = false;
  p.onWindowBlur();
  focused = true;
  p.onWindowFocus();
  assert.equal(calls, 1);
  auth.resolve({ status: "failed", message: "cancelled" });
  await new Promise(setImmediate);
  p.onWindowFocus();
  assert.equal(calls, 1);
  assert(p.isLocked);
});
test("native-dialog blur does not relock previously unlocked notes", async () => {
  const p = fixture();
  authenticateNote(p);
  switchTo(p, b);
  p.settings.relockNotesOnBlur = true;
  const auth = deferred();
  p.runBiometricAuth = () => auth.promise;
  const pending = noteAttempt(p);
  focused = false;
  p.onWindowBlur();
  assert(p.noteGuard.isUnlocked(a));
  assert.equal(p.blurTimeoutId, null);
  focused = true;
  p.onWindowFocus();
  auth.resolve({ status: "success" });
  await pending;
  assert(p.noteGuard.isUnlocked(a));
  assert(p.noteGuard.isUnlocked(b));
});
test("a result arriving after relock cannot unlock the same surviving overlay", async () => {
  const p = fixture(), auth = deferred();
  p.runBiometricAuth = () => auth.promise;
  const pending = noteAttempt(p);
  p.noteGuard.relock(a);
  auth.resolve({ status: "success" });
  await pending;
  assert(!p.noteGuard.isUnlocked(a));
});
test("vault and note unlock attempts cannot overlap", async () => {
  const p = fixture(), auth = deferred();
  let calls = 0;
  p.runBiometricAuth = () => {
    calls++;
    return auth.promise;
  };
  const pending = noteAttempt(p);
  p.lock();
  const vaultPending = p.lockScreen.attemptBiometric();
  assert.equal(calls, 1);
  auth.resolve({ status: "success" });
  await Promise.all([pending, vaultPending]);
  assert(p.isLocked);
  assert(!p.noteGuard.isUnlocked(a));
});
test("old vault result cannot unlock a replacement lock screen", async () => {
  const p = fixture(), auth = deferred();
  p.runBiometricAuth = () => auth.promise;
  p.lock();
  const pending = p.lockScreen.attemptBiometric();
  p.unlock();
  p.lock();
  auth.resolve({ status: "success" });
  await pending;
  assert(p.isLocked);
});
test("authentication errors release both guards and permit retry", async () => {
  const p = fixture();
  p.runBiometricAuth = async () => {
    throw Error("provider failed");
  };
  await noteAttempt(p);
  assert(!p.isAuthenticating);
  assert(!p.noteGuard.busy);
  p.runBiometricAuth = async () => ({ status: "success" });
  await noteAttempt(p);
  assert(p.noteGuard.isUnlocked(a));
  p.lock();
  p.runBiometricAuth = async () => {
    throw Error("provider failed");
  };
  await p.lockScreen.attemptBiometric();
  assert(!p.isAuthenticating);
  assert(!p.lockScreen.busy);
  assert(p.isLocked);
  p.runBiometricAuth = async () => ({ status: "success" });
  await p.lockScreen.attemptBiometric();
  assert(!p.isLocked);
});
test("combined unlock affects only the active note; separate unlock keeps it covered", () => {
  const p = fixture();
  p.lock();
  p.unlock();
  assert(!p.noteGuard.isUnlocked(a));
  p.lock();
  p.settings.unlockActiveNoteWithVault = true;
  p.unlock();
  assert(p.noteGuard.isUnlocked(a));
  assert(!p.noteGuard.isUnlocked(b));
  p.settings.relockOnNoteLeave = true;
  switchTo(p, b);
  assert(!p.noteGuard.isUnlocked(a));
});
test("disabling per-note locking or unloading revokes pending results", async () => {
  const p = fixture(), auth = deferred();
  p.runBiometricAuth = () => auth.promise;
  const pending = noteAttempt(p);
  p.settings.perNoteLockEnabled = false;
  p.refreshNoteGuard();
  p.settings.perNoteLockEnabled = true;
  p.refreshNoteGuard();
  auth.resolve({ status: "success" });
  await pending;
  assert(!p.noteGuard.isUnlocked(a));
  const next = deferred();
  p.runBiometricAuth = () => next.promise;
  p.lock();
  const vaultPending = p.lockScreen.attemptBiometric();
  p.onunload();
  next.resolve({ status: "success" });
  await vaultPending;
  assert(!p.lockScreen.isVisible);
  p.lock();
  assert(!p.lockScreen.isVisible);
});
test("delayed native focus restoration keeps a note unlocked without another prompt", async () => {
  const p = fixture();
  p.settings.relockNotesOnBlur = true;
  const auth = deferred();
  let calls = 0;
  p.runBiometricAuth = () => {
    calls++;
    return auth.promise;
  };
  const pending = noteAttempt(p);
  focused = false;
  p.onWindowBlur();
  auth.resolve({ status: "success" });
  await pending;
  advance(250);
  assert(p.noteGuard.isUnlocked(a));
  p.onWindowBlur(); // A late blur event from the closing native dialog.
  advance(250);
  assert(p.noteGuard.isUnlocked(a));
  focused = true;
  p.onWindowFocus();
  advance(1000);
  assert.equal(calls, 1);
  assert(p.noteGuard.isUnlocked(a));
  p.noteGuard.lockAll();
  const cancelled = deferred();
  p.runBiometricAuth = () => {
    calls++;
    return cancelled.promise;
  };
  const retry = noteAttempt(p);
  focused = false;
  p.onWindowBlur();
  cancelled.resolve({ status: "failed", message: "cancelled" });
  await retry;
  advance(1000);
  focused = true;
  p.onWindowFocus();
  assert.equal(calls, 2);
  assert(!p.noteGuard.isUnlocked(a));
});

test("late dialog blur after helper completion does not immediately relock the vault", async () => {
  const p = fixture();
  p.settings.globalAutoLockEnabled = true;
  p.settings.lockOnBlurDelaySeconds = 0;
  p.lock();
  p.runBiometricAuth = async () => ({ status: "success" });
  await p.lockScreen.attemptBiometric();
  focused = false;
  p.onWindowBlur();
  advance(300);
  assert(!p.isLocked);
  focused = true;
  p.onWindowFocus();
  advance(1000);
  assert(!p.isLocked);
  // A later genuine app switch must still apply normal lock policy.
  focused = false;
  p.onWindowBlur();
  advance(0);
  assert(p.isLocked);
});

test("remaining in the background after authentication still relocks notes and vault", async () => {
  const p = fixture(), auth = deferred();
  p.settings.relockNotesOnBlur = true;
  p.settings.globalAutoLockEnabled = true;
  p.settings.lockOnBlurDelaySeconds = 0;
  let calls = 0;
  p.runBiometricAuth = () => { calls++; return auth.promise; };
  const pending = noteAttempt(p);
  focused = false;
  p.onWindowBlur();
  auth.resolve({ status: "success" });
  await pending;
  advance(999);
  assert(p.noteGuard.isUnlocked(a));
  assert(!p.isLocked);
  advance(1);
  assert(!p.noteGuard.isUnlocked(a));
  advance(0);
  assert(p.isLocked);
  focused = true;
  p.onWindowFocus();
  assert.equal(calls, 1);
});

test("new authentication cancels previous focus reconciliation and unload clears it", async () => {
  const p = fixture();
  p.settings.relockNotesOnBlur = true;
  p.runBiometricAuth = async () => ({ status: "failed", message: "cancelled" });
  focused = false;
  await noteAttempt(p);
  advance(500);
  const auth = deferred();
  p.runBiometricAuth = () => auth.promise;
  const pending = noteAttempt(p);
  advance(500);
  auth.resolve({ status: "success" });
  await pending;
  assert(p.noteGuard.isUnlocked(a));
  assert.equal(timers.size, 1);
  p.onunload();
  assert.equal(timers.size, 0);
});


test("password preference uses saved password and never launches biometrics on return", async () => {
  const p = fixture();
  p.settings.passwordHash = "saved-verifier";
  let biometricCalls = 0;
  p.runBiometricAuth = async () => { biometricCalls++; return {status: "success"}; };
  p.verifyFallbackPassword = async password => password === "correct";
  p.refreshNoteGuard(true);
  const input = p.noteGuard.overlays.get(view.containerEl).querySelector(".fingerprint-note-password-input");
  assert(input);
  assert.equal(p.noteGuard.overlays.get(view.containerEl).querySelector("button.mod-cta"), null);
  focused = false; p.onWindowBlur(); focused = true; p.onWindowFocus();
  assert(input.focusCount > 0);
  assert.equal(biometricCalls, 0);
  input.value = "incorrect";
  await p.noteGuard.attemptPassword(a, p.noteGuard.overlays.get(view.containerEl).querySelector(".fingerprint-note-status"), input);
  assert(!p.noteGuard.isUnlocked(a));
  input.value = "correct";
  await p.noteGuard.attemptPassword(a, p.noteGuard.overlays.get(view.containerEl).querySelector(".fingerprint-note-status"), input);
  assert(p.noteGuard.isUnlocked(a));
  p.settings.unlockActiveNoteWithVault = true;
  focused = false; p.lock(); focused = true; p.onWindowFocus();
  assert(p.lockScreen.passwordInputEl.focusCount > 0);
  assert.equal(p.lockScreen.biometricButtonEl, null);
  assert.equal(biometricCalls, 0);
  await p.lockScreen.attemptPassword("incorrect"); assert(p.isLocked);
  await p.lockScreen.attemptPassword("correct"); assert(!p.isLocked); assert(p.noteGuard.isUnlocked(a));
});

test("fingerprint preference restores return prompting and selection needs a saved password", async () => {
  const p = fixture();
  const Tab = load("settings").TouchIDLockSettingTab;
  const tab = new Tab(p.app, p); tab.update = () => {}; p.saveSettings = async () => {};
  p.settings.preferredUnlockMethod = "biometric";
  await tab.setControlValue("preferredUnlockMethod", "password");
  assert.equal(p.settings.preferredUnlockMethod, "biometric");
  p.settings.passwordHash = "saved-verifier";
  await tab.setControlValue("preferredUnlockMethod", "password"); assert(p.usesPasswordUnlock);
  await tab.setControlValue("preferredUnlockMethod", "biometric"); assert(!p.usesPasswordUnlock);
  let calls = 0; p.runBiometricAuth = async () => { calls++; return {status: "failed", message: "cancelled"}; };
  focused = false; p.onWindowBlur(); focused = true; p.onWindowFocus();
  await new Promise(setImmediate); assert.equal(calls, 1);
});

test("restored note stays concealed while metadata loads, then requires authentication", async () => {
  const p = fixture();
  let cache = null;
  p.app.metadataCache.getFileCache = () => cache;
  p.noteGuard.refresh();
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  const pendingCover = p.noteGuard.overlays.get(view.containerEl);
  assert.equal(pendingCover.dataset.pending, "true");
  assert.equal(pendingCover.querySelector("button.mod-cta"), null);
  cache = { frontmatter: { "fingerprint-lock": true } };
  p.noteGuard.refresh();
  assert(!pendingCover.isConnected);
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  assert(p.noteGuard.overlays.get(view.containerEl).querySelector("button.mod-cta"));
  p.runBiometricAuth = async () => ({ status: "success" });
  await noteAttempt(p);
  assert(view.containerEl.classes.has("fingerprint-note-visible"));
  p.noteGuard.relock(a);
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
});

test("unknown ordinary note appears only after metadata confirms it is unprotected", () => {
  const p = fixture();
  let cache = null;
  p.app.metadataCache.getFileCache = () => cache;
  p.noteGuard.refresh();
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  cache = {}; // Known metadata without frontmatter is an ordinary note.
  p.noteGuard.refresh();
  assert(view.containerEl.classes.has("fingerprint-note-visible"));
  assert.equal(p.noteGuard.overlays.size, 0);
  p.settings.perNoteLockEnabled = false;
  p.refreshNoteGuard();
  assert(document.body.classes.has("fingerprint-note-lock-disabled"));
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  p.settings.perNoteLockEnabled = true;
  cache = { frontmatter: { "fingerprint-lock": true } };
  p.refreshNoteGuard();
  assert(!document.body.classes.has("fingerprint-note-lock-disabled"));
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  p.onunload();
  assert(document.body.classes.has("fingerprint-note-lock-disabled"));
});

test("startup guards restored panes before layout ready and refreshes on metadata resolution", async () => {
  const p = fixture(), settings = deferred();
  document.body.addClass("fingerprint-note-lock-disabled");
  p.manifest = {};
  p.loadSettings = () => settings.promise;
  p.addSettingTab = p.addRibbonIcon = p.addCommand = p.registerEvent = p.registerDomEvent = () => {};
  const listeners = {};
  p.app.workspace.on = (name, callback) => { listeners[name] = callback; };
  let layoutCallback;
  p.app.workspace.onLayoutReady = callback => { layoutCallback = callback; };
  p.app.metadataCache.on = (name, callback) => { listeners[name] = callback; };
  let cache = null;
  p.app.metadataCache.getFileCache = () => cache;
  const loading = p.onload();
  assert(!document.body.classes.has("fingerprint-note-lock-disabled"));
  settings.resolve();
  await loading;
  assert(layoutCallback); // Not invoked: workspace restoration is still pending.
  assert.equal(p.noteGuard.overlays.get(view.containerEl).dataset.pending, "true");
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  cache = { frontmatter: { "fingerprint-lock": true } };
  listeners.resolved();
  assert.equal(p.noteGuard.overlays.get(view.containerEl).dataset.pending, "false");
  assert(!view.containerEl.classes.has("fingerprint-note-visible"));
  p.onunload();
});

test("settings-load failure releases the provisional startup concealment", async () => {
  const p = fixture();
  p.loadSettings = async () => { throw Error("settings read failed"); };
  await assert.rejects(p.onload(), /settings read failed/);
  assert(document.body.classes.has("fingerprint-note-lock-disabled"));
});
