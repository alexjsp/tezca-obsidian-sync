// One sandboxed Obsidian instance ("device") with the Tezca plugin installed.
// Launched with wdio-obsidian-service's startWdioSession, so each test can run several at once.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { startWdioSession, type ObsidianPage } from "wdio-obsidian-service";
import { waitFor } from "./wait";

const E2E = resolve(import.meta.dirname, "..");
const PLUGIN_DIR = resolve(E2E, "..", "plugin");
export const LOG_DIR = resolve(E2E, ".logs");

type Browser = WebdriverIO.Browser;

export interface LaunchOptions {
	/** Obsidian's mobile emulation (phone-sized window, Platform.isMobile). */
	mobile?: boolean;
	/** Vault to copy in (default: an empty vault). */
	vault?: string;
}

/** What the plugin reports about sync (from `engine.currentStatus()`). */
export interface SyncStatus {
	configured: boolean;
	conn: string;
	ready: boolean;
	busy: boolean;
	unsent: number;
}

const live = new Set<Device>();

export class Device {
	readonly page: ObsidianPage;

	private constructor(
		readonly name: string,
		public browser: Browser,
		readonly vaultPath: string,
		readonly mobile: boolean,
	) {
		this.page = browser.getObsidianPage();
	}

	static async launch(name: string, opts: LaunchOptions = {}): Promise<Device> {
		const mobile = opts.mobile ?? false;
		const browser = (await startWdioSession({
			cacheDir: resolve(E2E, ".obsidian-cache"),
			logLevel: "warn",
			capabilities: {
				browserName: "obsidian",
				browserVersion: process.env.OBSIDIAN_VERSION ?? "latest",
				"wdio:obsidianOptions": {
					installerVersion: "latest",
					plugins: [PLUGIN_DIR],
					vault: opts.vault ?? resolve(E2E, "vaults", "empty"),
					emulateMobile: mobile,
				},
				...(mobile ? { "goog:chromeOptions": { mobileEmulation: { deviceMetrics: { width: 430, height: 932 } } } } : {}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any)) as Browser;
		const vaultPath = await browser.executeObsidian(({ app }) => (app.vault.adapter as unknown as { basePath: string }).basePath);
		const d = new Device(name, browser, vaultPath, mobile);
		await d.afterLaunch();
		live.add(d);
		return d;
	}

	private async afterLaunch() {
		await this.captureConsole();
		await this.browser.waitUntil(() => this.exec(({ plugins }) => !!plugins.tezcaSync), { timeout: 30_000, timeoutMsg: `${this.name}: plugin didn't load` });
	}

	/** Keep the page's console output so a failing test can save it. */
	private async captureConsole() {
		await this.browser.execute(() => {
			const w = window as unknown as { __e2eLog?: string[] };
			if (w.__e2eLog) return;
			const buf: string[] = (w.__e2eLog = []);
			for (const level of ["log", "info", "warn", "error", "debug"] as const) {
				const orig = console[level].bind(console);
				console[level] = (...args: unknown[]) => {
					try {
						buf.push(`${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
						if (buf.length > 5000) buf.splice(0, 1000);
					} catch {
						/* unserialisable */
					}
					orig(...args);
				};
			}
			// Notices (what the user would see) go in the log too.
			new MutationObserver((muts) => {
				for (const m of muts)
					for (const n of m.addedNodes)
						if (n instanceof HTMLElement && n.classList.contains("notice")) buf.push(`${new Date().toISOString()} NOTICE ${n.textContent}`);
			}).observe(document.body, { childList: true, subtree: true });
			window.addEventListener("error", (e) => buf.push(`uncaught ${e.message}`));
			window.addEventListener("unhandledrejection", (e) => buf.push(`unhandledrejection ${String(e.reason?.stack ?? e.reason)}`));
		});
	}

	// ───────── running code inside Obsidian ─────────

	/** `browser.executeObsidian`: `plugins.tezcaSync` is the Tezca plugin instance. */
	async exec<R, P extends unknown[]>(fn: (o: { app: any; obsidian: any; plugins: any }, ...p: P) => R, ...params: P): Promise<R> {
		await this.toMain();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return this.browser.executeObsidian(fn as any, ...params) as Promise<R>;
	}

	async command(id: string) {
		await this.browser.executeObsidianCommand(id);
	}

	// ───────── sync state ─────────

	async status(): Promise<SyncStatus> {
		return this.exec(({ plugins }) => {
			const p = plugins.tezcaSync;
			const s = p.engine?.currentStatus();
			return { configured: p.isConfigured, conn: s?.conn ?? "stopped", ready: !!s?.ready, busy: !!s?.busy, unsent: s?.unsent ?? 0 };
		});
	}

	/** Online, ready and nothing left to send. */
	async waitSynced(timeout = 30_000) {
		await waitFor(
			async () => {
				const s = await this.status();
				return s.conn === "online" && s.ready && !s.busy && s.unsent === 0;
			},
			{ timeout, what: `${this.name} to be synced`, detail: () => this.status() },
		);
	}

	// ───────── files ─────────

	abs(path: string): string {
		return join(this.vaultPath, path);
	}

	/** Read a vault file from disk (null if missing). */
	read(path: string): string | null {
		const p = this.abs(path);
		return existsSync(p) ? readFileSync(p, "utf8") : null;
	}

	readBytes(path: string): Buffer | null {
		const p = this.abs(path);
		return existsSync(p) ? readFileSync(p) : null;
	}

	exists(path: string): boolean {
		return existsSync(this.abs(path));
	}

	/** Write straight to disk, like another app (or a closed Obsidian) would. */
	writeOnDisk(path: string, content: string | Buffer) {
		mkdirSync(dirname(this.abs(path)), { recursive: true });
		writeFileSync(this.abs(path), content);
	}

	removeOnDisk(path: string) {
		rmSync(this.abs(path), { recursive: true, force: true });
	}

	renameOnDisk(from: string, to: string) {
		mkdirSync(dirname(this.abs(to)), { recursive: true });
		renameSync(this.abs(from), this.abs(to));
	}

	/** Create or overwrite a file through Obsidian's vault API (what the UI and other plugins use). */
	async write(path: string, content: string) {
		await this.exec(
			async ({ app }, path, content) => {
				const f = app.vault.getAbstractFileByPath(path);
				if (f) await app.vault.modify(f, content);
				else {
					const dir = path.split("/").slice(0, -1).join("/");
					if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
					await app.vault.create(path, content);
				}
			},
			path,
			content,
		);
	}

	async writeBinary(path: string, bytes: Buffer) {
		await this.exec(
			async ({ app }, path, b64) => {
				const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const dir = path.split("/").slice(0, -1).join("/");
				if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
				const f = app.vault.getAbstractFileByPath(path);
				if (f) await app.vault.modifyBinary(f, bin.buffer);
				else await app.vault.createBinary(path, bin.buffer);
			},
			path,
			bytes.toString("base64"),
		);
	}

	async mkdir(path: string) {
		await this.exec(async ({ app }, path) => {
			if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
		}, path);
	}

	/** Rename/move through the file manager (updates links, like the UI does). */
	async rename(from: string, to: string) {
		await this.exec(
			async ({ app }, from, to) => {
				const dir = to.split("/").slice(0, -1).join("/");
				if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
				await app.fileManager.renameFile(app.vault.getAbstractFileByPath(from), to);
			},
			from,
			to,
		);
	}

	/** Delete to Obsidian's trash (the default for deletes from the UI). */
	async delete(path: string) {
		await this.exec(async ({ app }, path) => {
			const f = app.vault.getAbstractFileByPath(path);
			if (f) await app.vault.trash(f, false);
		}, path);
	}

	async waitForFile(path: string, content?: string | ((c: string) => boolean), timeout = 30_000) {
		await waitFor(
			() => {
				const c = this.read(path);
				if (c === null) return false;
				if (content === undefined) return true;
				return typeof content === "string" ? c === content : content(c);
			},
			{ timeout, what: `${this.name}: ${path}${typeof content === "string" ? ` = ${JSON.stringify(content)}` : ""}`, detail: () => this.read(path) },
		);
	}

	async waitGone(path: string, timeout = 30_000) {
		await waitFor(() => !this.exists(path), { timeout, what: `${this.name}: ${path} to be gone` });
	}

	// ───────── editor ─────────

	/** Open a file in the active leaf (like clicking it in the file list). */
	async open(path: string) {
		await this.page.openFile(path);
		await this.browser.pause(300);
	}

	/** Click a file in the file explorer (desktop only). */
	async clickInExplorer(path: string) {
		await this.toMain();
		const item = await this.browser.$(`.nav-file-title[data-path="${path}"]`);
		await item.waitForExist({ timeout: 15_000 });
		await item.click();
		await this.browser.pause(300);
	}

	/** The active editor's text (what's on screen, which can differ from the file until it saves). */
	async editorText(): Promise<string | null> {
		return this.exec(({ app }) => app.workspace.activeEditor?.editor?.getValue() ?? null);
	}

	async waitEditorText(want: string | ((t: string) => boolean), timeout = 20_000) {
		await waitFor(
			async () => {
				const t = await this.editorText();
				return t !== null && (typeof want === "string" ? t === want : want(t));
			},
			{ timeout, what: `${this.name}: editor text${typeof want === "string" ? ` = ${JSON.stringify(want)}` : ""}`, detail: () => this.editorText() },
		);
	}

	/** Put the cursor somewhere in the active editor (default: the end). */
	async cursor(at: "end" | "start" | { line: number; ch: number } = "end") {
		await this.toMain();
		const editor = await this.browser.$(".workspace-leaf.mod-active .cm-content");
		await editor.waitForExist({ timeout: 10_000 });
		await editor.click();
		await this.exec(({ app }, at) => {
			const ed = app.workspace.activeEditor.editor;
			const pos = at === "end" ? ed.offsetToPos(ed.getValue().length) : at === "start" ? { line: 0, ch: 0 } : at;
			ed.setCursor(pos);
			ed.focus();
		}, at);
	}

	/** Type into the focused editor as real key presses. */
	async type(text: string) {
		await this.toMain();
		for (const chunk of text.match(/[\s\S]{1,20}/g) ?? []) await this.browser.keys(chunk.split(""));
	}

	async isEditorReadOnly(): Promise<boolean> {
		return this.exec(({ app }) => {
			const cm = app.workspace.activeEditor?.editor?.cm;
			return cm ? cm.state.readOnly || cm.contentDOM.getAttribute("contenteditable") === "false" : false;
		});
	}

	// ───────── UI ─────────
	// Obsidian 1.15+ opens Settings in its own window, and modals open in whichever window is
	// active. So element lookups search every window (and leave that window selected), while
	// `exec` always runs in the main window.

	private mainHandle = "";
	private current = "";

	private async switchTo(handle: string) {
		if (this.current === handle) return;
		await this.browser.switchToWindow(handle);
		this.current = handle;
	}

	async toMain() {
		if (!this.mainHandle) {
			this.mainHandle = await this.browser.getWindowHandle();
			this.current = this.mainHandle;
		}
		const handles = await this.browser.getWindowHandles();
		if (!handles.includes(this.current) || this.current !== this.mainHandle) {
			await this.browser.switchToWindow(this.mainHandle);
			this.current = this.mainHandle;
		}
	}

	/** Find the first window where `find` returns something; that window stays selected. */
	private async inWindows<T>(find: () => Promise<T | null | undefined>): Promise<T | null> {
		const handles = await this.browser.getWindowHandles();
		// Popouts (settings) first, they're usually where the action is.
		const order = [...handles.filter((h) => h !== this.mainHandle), this.mainHandle];
		for (const h of order) {
			try {
				await this.switchTo(h);
				const r = await find();
				if (r) return r;
			} catch {
				/* window closed under us */
				this.current = "";
			}
		}
		await this.toMain();
		return null;
	}

	/** Wait for an element (in any window) and select its window. */
	async find(selector: string, opts: { timeout?: number; text?: string | RegExp; within?: string } = {}): Promise<WebdriverIO.Element> {
		let el: WebdriverIO.Element | null = null;
		await waitFor(
			async () => {
				el = await this.inWindows(async () => {
					const roots = opts.within ? await this.browser.$$(opts.within) : [await this.browser.$("body")];
					for (const root of roots) {
						for (const e of await root.$$(selector)) {
							if (!(await e.isDisplayed().catch(() => false))) continue;
							if (opts.text !== undefined) {
								const t = await e.getText().catch(() => "");
								if (typeof opts.text === "string" ? t.trim() !== opts.text : !opts.text.test(t)) continue;
							}
							return e as unknown as WebdriverIO.Element;
						}
					}
					return null;
				});
				return !!el;
			},
			{ timeout: opts.timeout ?? 15_000, what: `${this.name}: ${selector}${opts.text ? ` "${opts.text}"` : ""}`, detail: () => this.modalTitles() },
		);
		return el!;
	}

	/** Open Tezca's settings tab. */
	async openSettings() {
		await this.exec(({ app }) => {
			app.setting.open();
			app.setting.openTabById("tezca-sync");
		});
		await this.find(".vertical-tab-content .setting-item");
		await this.browser.pause(500); // let the open animation finish (clicks during it are dropped)
	}

	async closeSettings() {
		await this.toMain();
		await this.exec(({ app }) => app.setting.close());
		await this.browser.pause(300);
	}

	/** The open modal whose title contains `title` (waits for it; selects its window). */
	async modal(title: string | RegExp, timeout = 20_000): Promise<WebdriverIO.Element> {
		const t = await this.find(".modal-container .modal .modal-title", { text: typeof title === "string" ? new RegExp(escapeRe(title)) : title, timeout });
		return (await t.$(`./ancestor::div[${cls("modal")}][1]`)) as unknown as WebdriverIO.Element;
	}

	async modalTitles(): Promise<string[]> {
		const out: string[] = [];
		await this.inWindows(async () => {
			for (const m of await this.browser.$$(".modal-container .modal .modal-title")) out.push(await m.getText().catch(() => "?"));
			return null;
		});
		return out;
	}

	async noModal(title: string, timeout = 20_000) {
		await waitFor(async () => !(await this.modalTitles()).some((t) => t.includes(title)), { timeout, what: `${this.name}: modal "${title}" to close` });
	}

	/** Close modals (not the settings window). */
	async closeModals() {
		for (let i = 0; i < 5; i++) {
			const titles = (await this.modalTitles()).filter((t) => t !== "Tezca Sync");
			if (!titles.length) return;
			await this.modal(titles[titles.length - 1]);
			await this.browser.keys("Escape");
			await this.browser.pause(200);
		}
	}

	/** Click a button by its text inside `scope` (default: any window, topmost modal first). */
	async clickButton(text: string, scope?: WebdriverIO.Element) {
		const b = (scope ? await scope.$(`button=${text}`) : await this.find("button", { text })) as WebdriverIO.Element;
		await this.click(b);
	}

	/** Click once the element is clickable and has stopped moving (clicks mid-animation get lost or hit the backdrop). */
	async click(el: WebdriverIO.Element) {
		await el.waitForClickable({ timeout: 15_000 });
		await el.waitForStable({ timeout: 5_000 }).catch(() => undefined);
		await el.click();
	}

	/** The setting row (in `scope`, default: the settings window) whose name is `name`. */
	async settingRow(name: string, scope?: WebdriverIO.Element): Promise<WebdriverIO.Element> {
		if (scope) {
			for (const r of await scope.$$(".setting-item"))
				if ((await r.$(".setting-item-name").getText().catch(() => "")) === name) return r as unknown as WebdriverIO.Element;
			throw new Error(`${this.name}: no setting "${name}"`);
		}
		const nameEl = await this.find(".setting-item .setting-item-name", { text: name });
		return (await nameEl.$(`./ancestor::div[${cls("setting-item")}][1]`)) as unknown as WebdriverIO.Element;
	}

	/** Turn a settings toggle on or off. */
	async setToggle(name: string, on: boolean, scope?: WebdriverIO.Element) {
		const row = await this.settingRow(name, scope);
		const toggle = await row.$(".checkbox-container");
		const isOn = ((await toggle.getAttribute("class")) ?? "").includes("is-enabled");
		if (isOn !== on) await this.click(toggle as unknown as WebdriverIO.Element);
		await this.browser.pause(200);
	}

	/** Read the link out of a LinkModal (QR + textarea) and close it. */
	async takeLink(title: string): Promise<string> {
		const m = await this.modal(title);
		const link = await m.$("textarea.tezca-link").getValue();
		await this.browser.keys("Escape");
		await this.noModal(title);
		return link;
	}

	/** Fill the first text field (input or textarea) of a FormModal and submit it. */
	async submitForm(title: string, value: string, submit = "Continue") {
		const m = await this.modal(title);
		const field = await m.$("textarea, input[type=text]");
		await field.clearValue();
		await field.setValue(value);
		await this.clickButton(submit, m);
		await this.noModal(title);
	}

	/** Acknowledge the recovery phrase screen. */
	async ackRecoveryPhrase() {
		const m = await this.modal("Your recovery phrase");
		await this.click((await m.$(".checkbox-container")) as unknown as WebdriverIO.Element);
		await this.clickButton("Done", m);
		await this.noModal("Your recovery phrase");
	}

	/** Pick an option in a ChoiceModal (its rows have a "Choose" button, confirms have one CTA). */
	async choose(title: string, option: string) {
		const m = await this.modal(title);
		const row = await this.settingRow(option, m);
		await this.click((await row.$("button")) as unknown as WebdriverIO.Element);
		await this.noModal(title);
	}

	/** Right-click a folder or file in the file explorer and pick a menu item (desktop only). */
	async contextMenu(path: string, item: string) {
		await this.toMain();
		const sel = `.nav-folder-title[data-path="${path}"], .nav-file-title[data-path="${path}"]`;
		const el = await this.browser.$(sel);
		await el.waitForExist({ timeout: 15_000 });
		await el.scrollIntoView();
		await el.click({ button: "right" });
		const menuItem = await this.find(".menu .menu-item-title", { text: item, timeout: 10_000 });
		await this.click(menuItem);
	}

	/** Notices currently showing. */
	async notices(): Promise<string[]> {
		await this.toMain();
		const out: string[] = [];
		for (const n of await this.browser.$$(".notice")) out.push(await n.getText().catch(() => ""));
		return out;
	}

	// ───────── lifecycle ─────────

	/** Quit and relaunch Obsidian with the same vault and app data (IndexedDB etc. survive). */
	async restart() {
		await this.toMain();
		await this.browser.reloadObsidian();
		this.mainHandle = "";
		await this.afterLaunch();
	}

	/** Save a screenshot and the console log (on failure). */
	async saveArtifacts(label: string) {
		const dir = join(LOG_DIR, label.replace(/[^\w.-]+/g, "_").slice(0, 120));
		mkdirSync(dir, { recursive: true });
		const handles = await this.browser.getWindowHandles().catch(() => [] as string[]);
		for (const [i, h] of handles.entries()) {
			await this.switchTo(h).catch(() => undefined);
			await this.browser.saveScreenshot(join(dir, `${this.name}${h === this.mainHandle ? "" : `-window${i}`}.png`)).catch(() => undefined);
		}
		await this.toMain().catch(() => undefined);
		const log = await this.browser.execute(() => (window as unknown as { __e2eLog?: string[] }).__e2eLog ?? []).catch(() => [] as string[]);
		writeFileSync(join(dir, `${this.name}.log`), log.join("\n"));
		const status = await this.status().catch((e) => String(e));
		writeFileSync(join(dir, `${this.name}.status.json`), JSON.stringify({ status, vault: this.vaultPath }, null, 2));
		return dir;
	}

	async quit() {
		live.delete(this);
		await this.browser.deleteSession().catch(() => undefined);
	}

	static live(): Device[] {
		return [...live];
	}
}

function escapeRe(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** XPath test for an element having CSS class `c`. */
function cls(c: string) {
	return `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`;
}
