import {
	App,
	Notice,
	PluginSettingTab,
	type Setting,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from "obsidian";
import type TouchIDLockPlugin from "./main";
import { createEncryptedVerifier, generateSalt, hashPassword } from "./crypto";
import { getBiometricMethodName, getBiometricPlatform, isBiometricPlatformSupported } from "./nativeAuth";
import { isWebAuthnAvailable, registerSecurityKey, type SecurityKeyInfo } from "./webauthn";

export interface TouchIDLockSettings {
	globalAutoLockEnabled: boolean;
	unlockActiveNoteWithVault: boolean;
	lockOnStartup: boolean;
	lockOnBlur: boolean;
	lockOnBlurDelaySeconds: number;
	lockOnIdle: boolean;
	lockOnIdleDelaySeconds: number;
	/** Prompt text shown in the biometric dialog (Touch ID and Windows Hello alike). */
	touchIdReason: string;
	passwordFallbackEnabled: boolean;
	passwordSalt: string;
	passwordHash: string;
	/** When true, new passwords are stored as an AES-GCM encrypted verifier instead of a hash. */
	passwordEncrypted: boolean;
	/** iv+ciphertext (hex) of the encrypted verifier; set instead of passwordHash in encrypted mode. */
	passwordVerifier: string;
	securityKeyEnabled: boolean;
	securityKeys: SecurityKeyInfo[];
	/** Cover individual notes flagged with the frontmatter property below. */
	perNoteLockEnabled: boolean;
	relockOnNoteLeave: boolean;
	relockNotesOnBlur: boolean;
	relockNotesAfterAway: boolean;
	relockNotesAwayMinutes: number;
	/** Frontmatter property that marks a note as locked. */
	lockedNoteProperty: string;
}

export const DEFAULT_SETTINGS: TouchIDLockSettings = {
	globalAutoLockEnabled: true,
	unlockActiveNoteWithVault: false,
	lockOnStartup: true,
	lockOnBlur: true,
	lockOnBlurDelaySeconds: 30,
	lockOnIdle: false,
	lockOnIdleDelaySeconds: 300,
	touchIdReason: "unlock your Obsidian vault",
	passwordFallbackEnabled: false,
	passwordSalt: "",
	passwordHash: "",
	passwordEncrypted: false,
	passwordVerifier: "",
	securityKeyEnabled: false,
	securityKeys: [],
	perNoteLockEnabled: false,
	relockOnNoteLeave: false,
	relockNotesOnBlur: false,
	relockNotesAfterAway: false,
	relockNotesAwayMinutes: 5,
	lockedNoteProperty: "fingerprint-lock",
};

/** True when a fallback password is configured in either storage format. */
export function hasFallbackPassword(settings: TouchIDLockSettings): boolean {
	return Boolean(settings.passwordHash || settings.passwordVerifier);
}

/**
 * Stores `password` into `settings` (fresh salt each time), honoring the
 * passwordEncrypted option: either a PBKDF2 hash or an AES-GCM encrypted
 * verifier — never both. Caller is responsible for persisting the settings.
 */
export async function storeFallbackPassword(
	settings: TouchIDLockSettings,
	password: string
): Promise<void> {
	const salt = generateSalt();
	settings.passwordSalt = salt;
	if (settings.passwordEncrypted) {
		settings.passwordVerifier = await createEncryptedVerifier(password, salt);
		settings.passwordHash = "";
	} else {
		settings.passwordHash = await hashPassword(password, salt);
		settings.passwordVerifier = "";
	}
}

function clampSeconds(value: unknown): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(n, 24 * 60 * 60);
}


const SECURITY_KEY_INTRO =
	"Unlock with a hardware security key (YubiKey or similar) over WebAuthn. Register a key " +
	'here, then a "Use security key" button appears on the lock screen. Only keys registered ' +
	"here can unlock the vault.";

const PASSWORD_FALLBACK_INTRO =
	"Strongly recommended. Without a fallback, a Touch ID failure (sensor covered, hand injury, " +
	"external display, helper not built) leaves you unable to unlock the vault from within Obsidian.";

const PASSWORD_ENCRYPTION_DESC =
	"Store an AES-256-GCM encrypted verifier instead of a password hash. The encryption key " +
	"is derived from your password on this device and is never written anywhere, so " +
	"data.json holds only ciphertext. Works the same on macOS and Windows.";

const PER_NOTE_INTRO =
	"Cover individual notes with an unlock prompt. Add the property below to a note's " +
	"frontmatter (or use the \"Toggle fingerprint lock for this note\" command) and it stays " +
	"covered until you authenticate. Choose when notes relock below. Returning to the app prompts for the active locked note when the vault is unlocked.";

const PER_NOTE_CAVEAT =
	"This hides notes in Obsidian's interface — it does not encrypt them. The text remains " +
	"readable on disk, to other plugins, and to sync clients, and note titles still appear in " +
	"search and Quick Switcher. Use it to keep notes from being read over your shoulder, not to " +
	"protect them from someone with access to the files.";

const TOUCH_ID_HELPER_INFO =
	"This plugin shells out to a small, signed helper binary at native/Obsidian inside the " +
	"plugin folder, which calls macOS's LocalAuthentication framework. The plugin builds and " +
	"signs it for you on first load. Your fingerprint data never leaves the Secure Enclave and " +
	"is never seen by this plugin or Obsidian.";

const WINDOWS_HELLO_HELPER_INFO =
	"This plugin runs a small PowerShell script at native/WindowsHelloAuth.ps1 inside the " +
	"plugin folder, which asks Windows Hello (fingerprint, face, or PIN) to verify you. " +
	"The plugin installs it for you on first load — there is nothing to build. Your biometric " +
	"data never leaves Windows and is never seen by this plugin or Obsidian.";

export class TouchIDLockSettingTab extends PluginSettingTab {
	plugin: TouchIDLockPlugin;
	private pendingPassword = "";

	constructor(app: App, plugin: TouchIDLockPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof TouchIDLockSettings];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key) {
			case "globalAutoLockEnabled":
			case "unlockActiveNoteWithVault":
			case "lockOnStartup":
			case "lockOnBlur":
			case "lockOnIdle":
				settings[key] = value === true;
				break;
			case "lockOnBlurDelaySeconds":
			case "lockOnIdleDelaySeconds":
				settings[key] = clampSeconds(value);
				break;
			case "touchIdReason":
				settings.touchIdReason = String(value ?? "").trim() || DEFAULT_SETTINGS.touchIdReason;
				break;
			case "passwordFallbackEnabled":
				if (value === true && !hasFallbackPassword(settings)) {
					new Notice("Set a password below before turning this on.");
					this.update();
					return;
				}
				settings.passwordFallbackEnabled = value === true;
				break;
			case "passwordEncrypted":
				settings.passwordEncrypted = value === true;
				if (hasFallbackPassword(settings)) {
					// An existing password can't be converted without knowing it.
					new Notice("Re-enter and save your password below to apply the new storage mode.");
				}
				break;
			case "perNoteLockEnabled":
			case "relockOnNoteLeave":
			case "relockNotesOnBlur":
			case "relockNotesAfterAway":
				settings[key] = value === true;
				break;
			case "relockNotesAwayMinutes": {
				const minutes = Number(value);
				settings.relockNotesAwayMinutes = Number.isFinite(minutes) ? Math.min(1440, Math.max(1, minutes)) : 5;
				break;
			}
			case "lockedNoteProperty":
				settings.lockedNoteProperty =
					String(value ?? "").trim() || DEFAULT_SETTINGS.lockedNoteProperty;
				break;
			case "securityKeyEnabled":
				if (value === true && settings.securityKeys.length === 0) {
					new Notice("Register a security key below before turning this on.");
					this.update();
					return;
				}
				settings.securityKeyEnabled = value === true;
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (["perNoteLockEnabled", "lockedNoteProperty", "relockOnNoteLeave", "relockNotesAfterAway", "relockNotesAwayMinutes"].includes(key)) {
			this.plugin.refreshNoteGuard();
		}
		if (key === "lockOnBlur" || key === "globalAutoLockEnabled") this.plugin.resetBlurWatcher();
		if (["lockOnIdle", "lockOnIdleDelaySeconds", "globalAutoLockEnabled"].includes(key)) this.plugin.resetIdleWatcher();
		if (["globalAutoLockEnabled", "lockOnBlur", "lockOnIdle", "perNoteLockEnabled", "relockNotesAfterAway"].includes(key)) this.update();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const method = getBiometricMethodName();
		const globalItems: SettingGroupItem[] = [
			{
				name: "",
				desc:
					"This is a screen lock, not encryption — your notes are never modified or encrypted on " +
					"disk. Global locking covers the whole vault and relocks protected notes. Locks quietly in the background. Touch ID / Windows Hello starts when you return or click Unlock.",
				searchable: false,
			},
			{
				name: "Enable global vault lock",
				desc: "Enable the global triggers below. Turn off to use per-note locking only. Lock vault now remains available.",
				control: { type: "toggle", key: "globalAutoLockEnabled", defaultValue: true },
			},
			{
				name: "Lock on startup",
				visible: () => this.plugin.settings.globalAutoLockEnabled,
				desc: "Show the lock screen immediately whenever Obsidian opens this vault.",
				control: { type: "toggle", key: "lockOnStartup", defaultValue: DEFAULT_SETTINGS.lockOnStartup },
			},
			{
				name: "Lock when Obsidian loses focus",
				visible: () => this.plugin.settings.globalAutoLockEnabled,
				desc: "Lock after the app has been in the background for the delay below.",
				control: { type: "toggle", key: "lockOnBlur", defaultValue: DEFAULT_SETTINGS.lockOnBlur },
			},
			{
				name: "Time away before locking (seconds)",
				desc: "How long Obsidian can sit unfocused before it locks. 0 locks instantly.",
				visible: () => this.plugin.settings.globalAutoLockEnabled && this.plugin.settings.lockOnBlur,
				control: {
					type: "number",
					key: "lockOnBlurDelaySeconds",
					min: 0,
					max: 24 * 60 * 60,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.lockOnBlurDelaySeconds,
				},
			},
			{
				name: "Lock after inactivity",
				visible: () => this.plugin.settings.globalAutoLockEnabled,
				desc: "Lock automatically if there's no mouse or keyboard activity for a while.",
				control: { type: "toggle", key: "lockOnIdle", defaultValue: DEFAULT_SETTINGS.lockOnIdle },
			},
			{
				name: "Time inactive before locking (seconds)",
				desc: "How long the vault can sit idle before it locks.",
				visible: () => this.plugin.settings.globalAutoLockEnabled && this.plugin.settings.lockOnIdle,
				control: {
					type: "number",
					key: "lockOnIdleDelaySeconds",
					min: 0,
					max: 24 * 60 * 60,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.lockOnIdleDelaySeconds,
				},
			},
		];

		const items: SettingDefinitionItem[] = [
			{ type: "group", heading: "Global vault lock", items: globalItems },
			this.perNoteGroup(),
		];
		const biometricItems: SettingGroupItem[] = [];

		if (isBiometricPlatformSupported()) {
			biometricItems.push(
				{
					name: `${method} prompt reason`,
					desc: `Shown inside the ${method} dialog, e.g. "unlock your Obsidian vault".`,
					control: { type: "text", key: "touchIdReason", placeholder: DEFAULT_SETTINGS.touchIdReason },
				},
				{
					name: `Install ${method} helper`,
					desc: this.helperSetupDescription(),
					render: (setting: Setting) => this.renderHelperSetup(setting, method),
				},
				{
					name: `Test ${method}`,
					desc: `Trigger the ${method} prompt right now, without locking the vault, to confirm setup works.`,
					render: (setting: Setting) => this.renderBiometricTest(setting, method),
				}
			);
		}

		items.push(
			{ type: "group", heading: "Unlock methods (vault and notes)", items: biometricItems },
			...this.securityKeyItems(),
			this.passwordGroup(),
			...this.helperInfoItems()
		);
		return items;
	}

	private helperSetupDescription(): string {
		return getBiometricPlatform() === "touchid"
			? "The helper is built automatically when the plugin first loads. Rebuild it here if Touch ID stops working, or after installing the Xcode Command Line Tools."
			: "The helper script is installed automatically when the plugin first loads. Reinstall it here if Windows Hello stops working.";
	}

	private renderHelperSetup(setting: Setting, method: string): void {
		const isMac = getBiometricPlatform() === "touchid";
		const label = isMac ? "Rebuild helper" : "Reinstall helper";
		setting.addButton((b) =>
			b.setButtonText(label).onClick(async () => {
				b.setDisabled(true);
				b.setButtonText(isMac ? "Building…" : "Installing…");
				const result = await this.plugin.setUpNativeHelper({ force: true });
				b.setDisabled(false);
				b.setButtonText(label);
				if (result.status === "ready") {
					new Notice(`${method} helper is ready.`);
				} else {
					new Notice(result.message, 10000);
				}
				this.update();
			})
		);
	}

	private renderBiometricTest(setting: Setting, method: string): void {
		setting.addButton((b) =>
			b.setButtonText("Run test").onClick(async () => {
				b.setDisabled(true);
				b.setButtonText(`Waiting for ${method}…`);
				let result;
				try {
					result = await this.plugin.authenticate(() => this.plugin.runBiometricAuth());
				} catch (error) {
					new Notice(`Authentication failed: ${String(error)}`, 8000);
					return;
				} finally {
					b.setDisabled(false);
					b.setButtonText("Run test");
				}
				if (!result) return;
				if (result.status === "success") {
					new Notice(`${method} succeeded.`);
				} else if (result.status === "not-installed") {
					new Notice(
						getBiometricPlatform() === "windows-hello"
							? "Helper script native/WindowsHelloAuth.ps1 not found — reinstall the plugin."
							: "Native helper not found. Build it with native/build.sh — see the plugin README.",
						8000
					);
				} else if (result.status === "unavailable") {
					new Notice(`${method} unavailable: ${result.message}`, 8000);
				} else {
					new Notice(`${method} failed: ${result.message}`, 8000);
				}
			})
		);
	}

	private perNoteGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Per-note lock",
			items: [
				{ name: "", desc: PER_NOTE_INTRO, searchable: false },
				{ name: "", desc: PER_NOTE_CAVEAT, searchable: false },
				{
					name: "Enable per-note lock",
					aliases: ["Lock individual notes"],
					desc: "Cover flagged notes until you authenticate.",
					control: { type: "toggle", key: "perNoteLockEnabled", defaultValue: false },
				},
				{
					name: "Lock when notes change",
					aliases: ["Relock when leaving note"],
					desc: "Relock a protected note when you switch to a different note. The vault stays unlocked.",
					visible: () => this.plugin.settings.perNoteLockEnabled,
					control: { type: "toggle", key: "relockOnNoteLeave", defaultValue: false },
				},
				{
					name: "Lock notes when switching apps",
					aliases: ["Relock protected notes when Obsidian loses focus"],
					desc: "Immediately relock all protected notes when Obsidian loses focus. Overrides the time-away grace period; does not lock the vault.",
					visible: () => this.plugin.settings.perNoteLockEnabled,
					control: { type: "toggle", key: "relockNotesOnBlur", defaultValue: false },
				},
				{
					name: "Lock after time away from a note",
					desc: "Give unlocked notes a grace period when you leave them or switch apps. Lock when notes change takes priority.",
					visible: () => this.plugin.settings.perNoteLockEnabled,
					control: { type: "toggle", key: "relockNotesAfterAway", defaultValue: false },
				},
				{
					name: "Time away before locking (minutes)",
					desc: "Return before this time to keep the note unlocked. Time spent in another app counts; reading the active note does not.",
					visible: () => this.plugin.settings.perNoteLockEnabled && this.plugin.settings.relockNotesAfterAway,
					control: { type: "number", key: "relockNotesAwayMinutes", min: 1, max: 1440, step: 1, defaultValue: 5 },
				},
				{
					name: "Unlock the active protected note with the vault",
					desc: "One successful vault unlock also unlocks the protected note you are viewing. Turn off to require a separate note unlock. Other protected notes stay locked.",
					visible: () => this.plugin.settings.perNoteLockEnabled,
					control: { type: "toggle", key: "unlockActiveNoteWithVault", defaultValue: false },
				},
				{
					name: "Frontmatter property",
					desc: 'The property that marks a note as locked, e.g. "fingerprint-lock: true".',
					visible: () => this.plugin.settings.perNoteLockEnabled,
					control: {
						type: "text",
						key: "lockedNoteProperty",
						placeholder: DEFAULT_SETTINGS.lockedNoteProperty,
					},
				},
			],
		};
	}

	private passwordGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Password fallback",
			items: [
				{
					name: "",
					desc: PASSWORD_FALLBACK_INTRO,
					searchable: false,
				},
				{
					name: "Enable password fallback",
					desc: "Show a password field on the lock screen alongside the Touch ID button.",
					control: { type: "toggle", key: "passwordFallbackEnabled", defaultValue: false },
				},
				{
					name: "Encrypt password data (end-to-end)",
					desc: PASSWORD_ENCRYPTION_DESC,
					control: { type: "toggle", key: "passwordEncrypted", defaultValue: false },
				},
				{
					name: "Set password",
					desc: "Stored as a salted PBKDF2 hash — or only as ciphertext with encryption enabled above. Never in plain text.",
					aliases: ["Change password"],
					render: (setting: Setting) => this.renderSetPassword(setting),
				},
				{
					name: "Clear password",
					desc: "Removes the saved password and disables the fallback.",
					visible: () => hasFallbackPassword(this.plugin.settings),
					render: (setting: Setting) => this.renderClearPassword(setting),
				},
			],
		};
	}

	private renderSetPassword(setting: Setting): void {
		if (hasFallbackPassword(this.plugin.settings)) {
			setting.setName("Change password");
		}
		setting
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("New password (min. 4 characters)");
				t.onChange((v) => (this.pendingPassword = v));
			})
			.addButton((b) =>
				b.setButtonText("Save").onClick(async () => {
					if (this.pendingPassword.length < 4) {
						new Notice("Password must be at least 4 characters.");
						return;
					}
					await storeFallbackPassword(this.plugin.settings, this.pendingPassword);
					this.pendingPassword = "";
					await this.plugin.saveSettings();
					new Notice("Password saved.");
					this.update();
				})
			);
	}

	private renderClearPassword(setting: Setting): void {
		setting.addButton((b) =>
			b
				.setDestructive()
				.setButtonText("Clear")
				.onClick(async () => {
					const settings = this.plugin.settings;
					settings.passwordSalt = "";
					settings.passwordHash = "";
					settings.passwordVerifier = "";
					settings.passwordFallbackEnabled = false;
					await this.plugin.saveSettings();
					new Notice("Password cleared.");
					this.update();
				})
		);
	}

	private securityKeyItems(): SettingDefinitionItem[] {
		const intro: SettingDefinitionItem = {
			name: "",
			desc:
				"Unlock with a hardware security key (YubiKey or similar) over WebAuthn. Register a key " +
				'here, then a "Use security key" button appears on the lock screen. Only keys registered ' +
				"here can unlock the vault.",
			searchable: false,
		};

		if (!isWebAuthnAvailable()) {
			return [
				{
					type: "group",
					heading: "Security keys",
					items: [
						intro,
						{
							name: "",
							desc: "WebAuthn is not available in this Obsidian build, so security keys can't be used here.",
							searchable: false,
						},
					],
				},
			];
		}

		return [
			{
				type: "group",
				heading: "Security keys",
				items: [
					intro,
					{
						name: "Unlock with a security key",
						desc: "Show a security key button on the lock screen.",
						control: { type: "toggle", key: "securityKeyEnabled", defaultValue: false },
					},
					{
						name: "Register a security key",
						desc: "Insert your key, click Register, then touch the key when prompted.",
						render: (setting: Setting) => this.renderRegisterKey(setting),
					},
				],
			},
			{
				type: "list",
				emptyState: "No security keys registered yet.",
				items: this.plugin.settings.securityKeys.map(
					(key): SettingGroupItem => ({
						name: key.label,
						desc: `Registered ${new Date(key.createdAt).toLocaleDateString()}`,
					})
				),
				onDelete: (index: number) => void this.removeSecurityKey(index),
			},
		];
	}

	private renderRegisterKey(setting: Setting): void {
		setting.addButton((b) =>
			b.setButtonText("Register").onClick(async () => {
				b.setDisabled(true);
				b.setButtonText("Touch your key…");
				let result;
				try {
					result = await this.plugin.authenticate(() => registerSecurityKey(this.plugin.settings.securityKeys));
				} catch (error) {
					new Notice(`Authentication failed: ${String(error)}`, 8000);
					return;
				} finally {
					b.setDisabled(false);
					b.setButtonText("Register");
				}
				if (!result) return;
				if (result.status === "registered") {
					this.plugin.settings.securityKeys.push({
						id: result.id,
						label: `Security key ${this.plugin.settings.securityKeys.length + 1}`,
						createdAt: Date.now(),
					});
					await this.plugin.saveSettings();
					new Notice("Security key registered.");
					this.update();
				} else if (result.status === "unavailable") {
					new Notice(`Can't register: ${result.message}`, 8000);
				} else {
					new Notice(`Registration failed: ${result.message}`, 8000);
				}
			})
		);
	}

	private async removeSecurityKey(index: number): Promise<void> {
		const settings = this.plugin.settings;
		settings.securityKeys.splice(index, 1);
		if (settings.securityKeys.length === 0) {
			settings.securityKeyEnabled = false;
		}
		await this.plugin.saveSettings();
		new Notice("Security key removed.");
		this.update();
	}

	private helperInfoItems(): SettingDefinitionItem[] {
		if (getBiometricPlatform() === "touchid") {
			return [
				{
					type: "group",
					heading: "Native Touch ID helper",
					items: [
						{
							name: "",
						desc: TOUCH_ID_HELPER_INFO,
							searchable: false,
						},
					],
				},
			];
		}
		if (getBiometricPlatform() === "windows-hello") {
			return [
				{
					type: "group",
					heading: "Windows Hello helper",
					items: [
						{
							name: "",
						desc: WINDOWS_HELLO_HELPER_INFO,
							searchable: false,
						},
					],
				},
			];
		}
		return [];
	}
}
