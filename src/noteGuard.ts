import { MarkdownView, TFile } from "obsidian";
import type TouchIDLockPlugin from "./main";
import { isBiometricPlatformSupported } from "./nativeAuth";

/** Frontmatter values that count as "lock this note". */
function isTruthyFlag(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === "number") return value === 1;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		return v === "true" || v === "yes" || v === "1";
	}
	return false;
}

/**
 * Covers individual notes with an unlock gate, for notes flagged with a
 * frontmatter property. This is a UI gate, not encryption: the note stays
 * readable on disk and to other plugins — see the README.
 */
export class NoteGuard {
	private readonly plugin: TouchIDLockPlugin;
	/** Note paths unlocked for this session; cleared whenever the vault locks. */
	private readonly unlockedPaths = new Set<string>();
	private activePath: string | null = null;
	private focused = document.hasFocus();
	private readonly awaySince = new Map<string, number>();
	private awayTimeoutId: number | null = null;
	/** Overlay currently covering each guarded view container. */
	private readonly overlays = new Map<HTMLElement, HTMLElement>();
	private busy = false;

	constructor(plugin: TouchIDLockPlugin) {
		this.plugin = plugin;
	}

	get isAuthenticating(): boolean {
		return this.busy;
	}

	promptActiveNoteBiometric(): void {
		if (!document.hasFocus() || !isBiometricPlatformSupported()) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		const overlay = this.overlays.get(view.containerEl);
		const status = overlay?.querySelector<HTMLElement>(".fingerprint-note-status");
		const button = overlay?.querySelector<HTMLButtonElement>("button.mod-cta");
		if (status && button) void this.attemptBiometric(view.file, status, button);
	}

	/** Reuse successful vault authentication for only the active protected note. */
	unlockActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file || !this.isProtected(file)) return;
		this.unlockedPaths.add(file.path);
		this.updateAwayTimer();
		this.refresh();
	}

	private get app() {
		return this.plugin.app;
	}

	private get propertyName(): string {
		return this.plugin.settings.lockedNoteProperty.trim();
	}

	/** Whether this note is flagged to be locked. */
	isProtected(file: TFile | null): boolean {
		if (!file || !this.plugin.settings.perNoteLockEnabled) return false;
		const property = this.propertyName;
		if (!property) return false;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return isTruthyFlag(frontmatter?.[property]);
	}

	isUnlocked(file: TFile): boolean {
		return this.unlockedPaths.has(file.path);
	}

	/** Re-locks every note. Called when the vault itself locks. */
	lockAll(): void {
		this.unlockedPaths.clear();
		this.awaySince.clear();
		this.cancelAwayTimer();
		this.refresh();
	}

	relock(file: TFile): void {
		this.unlockedPaths.delete(file.path);
		this.awaySince.delete(file.path);
		this.updateAwayTimer();
		this.refresh();
	}

	/** Active-note changes revoke only the note being left, never the vault. */
	onActiveNoteChange(): void {
		this.expireAwayNotes();
		const path = this.app.workspace.getActiveFile()?.path ?? null;
		if (path !== this.activePath && this.plugin.settings.relockOnNoteLeave && this.activePath) {
			this.unlockedPaths.delete(this.activePath);
		}
		this.activePath = path;
		this.updateAwayTimer();
		this.refresh();
	}

	onFocusChange(focused: boolean): void {
		// Check elapsed time before cancelling the returning note's timer.
		this.expireAwayNotes();
		this.focused = focused;
		if (!focused && this.plugin.settings.perNoteLockEnabled && this.plugin.settings.relockNotesOnBlur) {
			this.lockAll();
		}
		this.updateAwayTimer();
		this.refresh();
	}

	private cancelAwayTimer(): void {
		if (this.awayTimeoutId !== null) window.clearTimeout(this.awayTimeoutId);
		this.awayTimeoutId = null;
	}

	private expireAwayNotes(): void {
		if (!this.plugin.settings.perNoteLockEnabled || !this.plugin.settings.relockNotesAfterAway) return;
		const delay = this.plugin.settings.relockNotesAwayMinutes * 60_000;
		for (const [path, since] of this.awaySince) {
			if (Date.now() - since >= delay) {
				this.unlockedPaths.delete(path);
				this.awaySince.delete(path);
			}
		}
	}

	/** One timer for the nearest note deadline; no polling or activity listeners. */
	private updateAwayTimer(): void {
		this.cancelAwayTimer();
		if (!this.plugin.settings.perNoteLockEnabled || !this.plugin.settings.relockNotesAfterAway) {
			this.awaySince.clear();
			return;
		}
		this.expireAwayNotes();
		const now = Date.now();
		for (const path of this.awaySince.keys()) {
			if (!this.unlockedPaths.has(path)) this.awaySince.delete(path);
		}
		for (const path of this.unlockedPaths) {
			if (path === this.activePath && this.focused) {
				this.awaySince.delete(path);
			} else if (!this.awaySince.has(path)) {
				this.awaySince.set(path, now);
			}
		}
		if (this.awaySince.size === 0) return;
		const deadline = Math.min(...this.awaySince.values()) + this.plugin.settings.relockNotesAwayMinutes * 60_000;
		this.awayTimeoutId = window.setTimeout(() => {
			this.updateAwayTimer();
			this.refresh();
		}, Math.max(0, deadline - now));
	}

	/** Adds or removes an overlay on every open markdown view, as needed. */
	refresh(): void {
		const seen = new Set<HTMLElement>();

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;

			const container = view.containerEl;
			const file = view.file;
			const shouldGuard = this.isProtected(file) && file !== null && !this.isUnlocked(file);
			if (!shouldGuard || !file) continue;

			seen.add(container);
			// A leaf can switch directly between two locked notes. Its unlock
			// buttons must refer to the new file, not the previous overlay's file.
			const existing = this.overlays.get(container);
			if (existing && existing.dataset.notePath !== file.path) {
				existing.remove();
				this.overlays.delete(container);
			}
			if (!this.overlays.has(container)) {
				this.overlays.set(container, this.createOverlay(container, file));
			}
		}

		// Drop overlays whose note was unlocked, closed, or replaced.
		for (const [container, overlay] of this.overlays) {
			if (seen.has(container)) continue;
			overlay.remove();
			container.removeClass("fingerprint-note-guarded");
			this.overlays.delete(container);
		}
	}

	/** Removes every overlay, e.g. when the feature is turned off or on unload. */
	clear(): void {
		this.cancelAwayTimer();
		this.awaySince.clear();
		for (const [container, overlay] of this.overlays) {
			overlay.remove();
			container.removeClass("fingerprint-note-guarded");
		}
		this.overlays.clear();
	}

	private createOverlay(container: HTMLElement, file: TFile): HTMLElement {
		container.addClass("fingerprint-note-guarded");
		const overlay = container.createDiv({ cls: "fingerprint-note-overlay" });
		overlay.dataset.notePath = file.path;
		const card = overlay.createDiv({ cls: "fingerprint-note-card" });
		card.createDiv({ cls: "fingerprint-note-icon", text: "\u{1F512}" });
		card.createDiv({ cls: "fingerprint-note-title", text: "This note is locked" });
		card.createDiv({ cls: "fingerprint-note-name", text: file.basename });

		const status = card.createDiv({ cls: "fingerprint-note-status" });
		const method = this.plugin.biometricMethodName;

		const buttons = card.createDiv({ cls: "fingerprint-note-buttons" });
		if (isBiometricPlatformSupported()) {
			const btn = buttons.createEl("button", {
				cls: "mod-cta",
				text: `Unlock with ${method}`,
			});
			btn.addEventListener("click", () => void this.attemptBiometric(file, status, btn));
		}
		if (this.plugin.settings.securityKeyEnabled && this.plugin.settings.securityKeys.length > 0) {
			const btn = buttons.createEl("button", { text: "Use security key" });
			btn.addEventListener("click", () => void this.attemptSecurityKey(file, status, btn));
		}

		if (this.plugin.settings.passwordFallbackEnabled && this.plugin.hasFallbackPassword) {
			const row = card.createDiv({ cls: "fingerprint-note-password-row" });
			const input = row.createEl("input", { type: "password", placeholder: "Password" });
			const submit = row.createEl("button", { text: "Unlock" });
			const attempt = () => void this.attemptPassword(file, status, input);
			submit.addEventListener("click", attempt);
			input.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					attempt();
				}
			});
		}

		return overlay;
	}

	private async attemptBiometric(file: TFile, status: HTMLElement, btn: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		const method = this.plugin.biometricMethodName;
		status.setText(`Waiting for ${method}…`);

		const result = await this.plugin.runBiometricAuth();
		this.busy = false;
		btn.disabled = false;

		if (result.status === "success") {
			this.unlockNote(file, status);
			return;
		}
		status.setText(
			result.status === "not-installed"
				? `The ${method} helper isn't installed. Rebuild it in this plugin's settings.`
				: `${method} ${result.status === "unavailable" ? "unavailable" : "failed"}: ${result.message}`
		);
	}

	private async attemptSecurityKey(file: TFile, status: HTMLElement, btn: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		status.setText("Waiting for security key… Insert and touch your key.");

		const result = await this.plugin.runSecurityKeyAuth();
		this.busy = false;
		btn.disabled = false;

		if (result.status === "success") {
			this.unlockNote(file, status);
			return;
		}
		status.setText(`Security key failed: ${result.message}`);
	}

	private async attemptPassword(file: TFile, status: HTMLElement, input: HTMLInputElement): Promise<void> {
		const password = input.value;
		if (this.busy || !password) return;
		this.busy = true;
		const ok = await this.plugin.verifyFallbackPassword(password);
		this.busy = false;

		if (ok) {
			this.unlockNote(file, status);
			return;
		}
		input.value = "";
		input.focus();
		status.setText("Wrong password.");
	}

	private unlockNote(file: TFile, status: HTMLElement): void {
		// Ignore authentication completed after the note was replaced or the
		// vault locked. A departed note must not become unlocked in the background.
		if (!status.isConnected || this.plugin.isLocked) return;
		if (this.plugin.settings.relockOnNoteLeave && this.app.workspace.getActiveFile()?.path !== file.path) return;
		if (this.plugin.settings.relockNotesOnBlur && !document.hasFocus()) return;
		this.unlockedPaths.add(file.path);
		this.updateAwayTimer();
		this.refresh();
	}
}
