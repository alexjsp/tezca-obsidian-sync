import { Notice, Platform, Plugin, addIcon, requestUrl, MarkdownView, TFile, TFolder, type ObsidianProtocolData } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { HostConnection } from "./core/connection";
import {
	b64u,
	fromB64u,
	identityFromSeed,
	initCrypto,
	newIdentity,
	randomBytes,
	recoveryPhrase,
	seedFromRecoveryPhrase,
	hex,
	type Identity,
} from "./core/crypto";
import { SyncEngine, type EngineStatus } from "./core/engine";
import { HostApi, ShareApi, createRootSpace, createSpace, httpResponse, listSpaces, normalizeHost, parseDeepLink, waitOnline, type HttpFn } from "./core/setup";
import { SpaceSync } from "./core/space";
import { IdbStore } from "./core/store";
import { log } from "./core/util";
import { SpaceKind } from "./proto/tezca/v1/sync_pb";
import { DeletedFilesModal, HistoryModal } from "./obsidian/history-modal";
import { ShareModal } from "./obsidian/share-modal";
import { EditorBindings } from "./obsidian/editor";
import { LinkModal, RecoveryPhraseModal, choose, confirm, form } from "./obsidian/modals";
import { TezcaSettingTab } from "./obsidian/settings";
import { ObsidianVault } from "./obsidian/vault-adapter";

export interface TezcaSettings {
	host: string;
	spaceId: string;
	deviceId: string;
	deviceName: string;
	displayName: string;
	color: string;
	hostRole: string;
	debug: boolean;
}

const DEFAULT_SETTINGS: TezcaSettings = {
	host: "",
	spaceId: "",
	deviceId: "",
	deviceName: "",
	displayName: "",
	color: "",
	hostRole: "",
	debug: false,
};

/** Monochrome take on assets/icon.svg (an obsidian mirror) for Obsidian's 100×100 icon grid. */
const TEZCA_ICON = `<ellipse cx="50" cy="50" rx="34" ry="42" fill="none" stroke="currentColor" stroke-width="8"/><ellipse cx="50" cy="50" rx="23" ry="31" fill="currentColor" opacity="0.35"/><path d="M38 66 L62 30" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity="0.8"/>`;

const COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e03131", "#5c7cfa"];
const KEYSTORE = "tezca-keys";

const obsidianHttp: HttpFn = async ({ method, url, headers, body }) => {
	const raw = body instanceof Uint8Array ? body.slice().buffer : body;
	const res = await requestUrl({ url, method, headers, body: raw, throw: false });
	return httpResponse(res.status, new Uint8Array(res.arrayBuffer));
};

export default class TezcaPlugin extends Plugin {
	declare settings: TezcaSettings;
	engine: SyncEngine | null = null;
	identity: Identity | null = null;
	editors!: EditorBindings;
	private statusEl: HTMLElement | null = null;
	private presenceEl: HTMLElement | null = null;
	private lastStatus: EngineStatus | null = null;
	private keystore: IdbStore | null = null;
	private vaultStore: IdbStore | null = null;
	settingTab!: TezcaSettingTab;

	async onload() {
		await initCrypto();
		await this.loadSettings();
		log.level = this.settings.debug ? "debug" : "info";

		this.editors = new EditorBindings(
			() => this.engine,
			() => ({ name: this.settings.displayName || this.settings.deviceName, color: this.settings.color }),
		);
		this.registerEditorExtension(this.editors.extension());

		addIcon("tezca", TEZCA_ICON);
		this.addRibbonIcon("tezca", "Tezca Sync", () => {
			// Open this plugin's settings tab.
			const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
			setting.open();
			setting.openTabById(this.manifest.id);
		});

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("tezca-status");
		this.renderStatus();
		this.presenceEl = this.addStatusBarItem();
		this.presenceEl.addClass("tezca-presence");
		this.registerInterval(window.setInterval(() => this.renderPresence(), 2000));

		this.settingTab = new TezcaSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerObsidianProtocolHandler("tezca", (params) => void this.handleDeepLink(params));

		this.addCommand({ id: "reconnect", name: "Reconnect to sync host", callback: () => this.engine?.conn.reconnectNow() });
		this.addCommand({ id: "pair-device", name: "Pair another device", callback: () => void this.pairDevice() });
		this.addCommand({ id: "show-recovery-phrase", name: "Show recovery phrase", callback: () => void this.showRecoveryPhrase() });
		this.addCommand({
			id: "file-history",
			name: "Show version history of the current file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const mirror = file ? this.engine?.spaceFor(file.path)?.mirror : undefined;
				if (!file || !mirror?.isReady) return false;
				if (!checking) new HistoryModal(this.app, mirror, file).open();
				return true;
			},
		});
		this.addCommand({
			id: "recently-deleted",
			name: "Show recently deleted files",
			checkCallback: (checking) => {
				// The shared folder the active file is in, or the private vault.
				const file = this.app.workspace.getActiveFile();
				const mirror = (file ? this.engine?.spaceFor(file.path) : this.engine?.root)?.mirror;
				if (!mirror?.isReady) return false;
				if (!checking) new DeletedFilesModal(this.app, mirror).open();
				return true;
			},
		});
		this.addCommand({
			id: "manage-share",
			name: "Manage the shared folder of the current file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const sh = file ? this.engine?.spaceFor(file.path) : null;
				if (!sh || sh === this.engine?.root) return false;
				if (!checking) new ShareModal(this.app, this.engine!, sh.spaceId).open();
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				const engine = this.engine;
				if (!engine?.mirror?.isReady) return;
				if (file instanceof TFile) {
					const mirror = engine.spaceFor(file.path)?.mirror;
					if (!mirror) return;
					menu.addItem((item) =>
						item
							.setTitle("Version history")
							.setIcon("history")
							.onClick(() => new HistoryModal(this.app, mirror, file).open()),
					);
					return;
				}
				if (!(file instanceof TFolder) || file.isRoot()) return;
				const mount = engine.mounts?.all().find((m) => m.path === file.path);
				if (mount) {
					menu.addItem((item) =>
						item
							.setTitle("Manage shared folder…")
							.setIcon("users")
							.onClick(() => new ShareModal(this.app, engine, mount.spaceId).open()),
					);
				} else if (!engine.isProfile && !engine.mounts?.containing(file.path) && !engine.mounts?.all().some((m) => m.path.startsWith(file.path + "/"))) {
					menu.addItem((item) =>
						item
							.setTitle("Share folder…")
							.setIcon("users")
							.onClick(() => void this.shareFolder(file.path)),
					);
				}
			}),
		);

		this.registerEvent(this.app.workspace.on("layout-change", () => this.rebindOpenEditors()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.rebindOpenEditors()));
		this.registerDomEvent(window, "online", () => this.engine?.conn.reconnectNow());
		this.registerInterval(window.setInterval(() => void this.engine?.space?.flush(), 30_000));
		this.app.workspace.onLayoutReady(() => void this.startEngine());
	}

	async onunload() {
		await this.stopEngine();
		this.keystore?.close();
	}

	// ───────────── settings & identity ─────────────

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		let dirty = false;
		if (!this.settings.deviceId) {
			this.settings.deviceId = b64u(randomBytes(12));
			dirty = true;
		}
		if (!this.settings.deviceName) {
			this.settings.deviceName = Platform.isMobile ? "Mobile" : Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows" : "Desktop";
			dirty = true;
		}
		if (!this.settings.color) {
			this.settings.color = COLORS[Math.floor(Math.random() * COLORS.length)];
			dirty = true;
		}
		if (dirty) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	get isConfigured(): boolean {
		return !!(this.settings.host && this.settings.spaceId);
	}

	private async keys(): Promise<IdbStore> {
		if (!this.keystore) this.keystore = await IdbStore.open(KEYSTORE);
		return this.keystore;
	}

	/** The identity seed lives in IndexedDB (never in data.json, which other sync tools may copy). */
	async loadIdentity(): Promise<Identity | null> {
		const seed = await (await this.keys()).get<Uint8Array>(`identity/${this.settings.deviceId}`);
		return seed ? identityFromSeed(seed) : null;
	}

	async saveIdentity(id: Identity) {
		await (await this.keys()).put(`identity/${this.settings.deviceId}`, id.seed);
		this.identity = id;
	}

	// ───────────── engine ─────────────

	async startEngine() {
		await this.stopEngine();
		if (!this.isConfigured) return this.renderStatus();
		this.identity = await this.loadIdentity();
		if (!this.identity) {
			new Notice("Tezca: this device's identity key is missing. Re-pair it or restore from your recovery phrase in settings.", 10000);
			return this.renderStatus();
		}
		this.vaultStore = await IdbStore.open(`tezca-vault-${this.settings.deviceId}`);
		const engine = new SyncEngine({
			host: this.settings.host,
			identity: this.identity,
			deviceId: this.settings.deviceId,
			deviceName: this.settings.deviceName,
			spaceId: this.settings.spaceId,
			store: this.vaultStore,
			vault: new ObsidianVault(this.app),
			clientVersion: this.manifest.version,
			isBound: (p) => this.editors.isBound(p),
			http: obsidianHttp,
			profile: () => ({ name: this.settings.displayName || this.settings.deviceName, color: this.settings.color }),
		});
		this.engine = engine;
		engine.status.on((s) => {
			this.lastStatus = s;
			this.renderStatus();
		});
		engine.notices.on((n) => new Notice(`Tezca: ${n.message}`, n.kind === "brake" ? 0 : 8000));
		engine.conn.statusChanged.on((s) => {
			if (s === "unauthorized") new Notice("Tezca: the host rejected this device's identity.", 10000);
			if (s === "update-required") new Notice("Tezca: the host runs a different protocol version. Update the plugin or the server.", 10000);
		});
		this.renderStatus();
		try {
			await engine.start();
		} catch (e) {
			log.error("engine start failed", e);
			new Notice(`Tezca: could not start sync: ${(e as Error).message}`, 10000);
			return;
		}
		if (this.engine !== engine) return;
		this.rebindOpenEditors();
	}

	private rebindOpenEditors() {
		if (!this.engine?.mirror?.isReady) return;
		const views: EditorView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				// @ts-expect-error: `cm` is the CodeMirror 6 EditorView (undocumented but stable)
				const cm = leaf.view.editor?.cm as EditorView | undefined;
				if (cm) views.push(cm);
			}
		});
		this.editors.rebindViews(views);
	}

	async stopEngine() {
		this.editors?.unbindAll();
		const e = this.engine;
		this.engine = null;
		if (e) await e.stop();
		this.vaultStore?.close();
		this.vaultStore = null;
		this.lastStatus = null;
		this.renderStatus();
	}

	renderStatus() {
		const el = this.statusEl;
		if (!el) return;
		let text: string;
		let cls: string;
		if (!this.isConfigured) [text, cls] = ["Tezca: not set up", "off"];
		else if (!this.engine) [text, cls] = ["Tezca: stopped", "off"];
		else {
			const s = this.lastStatus ?? this.engine.currentStatus();
			if (s.conn === "online") [text, cls] = s.ready && !s.busy ? ["Tezca: synced", "ok"] : ["Tezca: syncing…", "busy"];
			else if (s.conn === "connecting") [text, cls] = ["Tezca: connecting…", "busy"];
			else if (s.conn === "unauthorized") [text, cls] = ["Tezca: access denied", "err"];
			else if (s.conn === "update-required") [text, cls] = ["Tezca: update required", "err"];
			else [text, cls] = ["Tezca: offline", "off"];
		}
		el.setText(text);
		el.dataset.state = cls;
		el.setAttr("aria-label", text);
	}

	/** Who else has the active note open (from encrypted awareness). */
	private renderPresence() {
		const el = this.presenceEl;
		if (!el) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		// @ts-expect-error: `cm` is the CodeMirror 6 EditorView (undocumented but stable)
		const cm = view?.editor?.cm as EditorView | undefined;
		const people = cm ? this.editors.presence(cm) : [];
		el.empty();
		el.toggle(people.length > 0);
		if (!people.length) return;
		el.setAttr("aria-label", `Also here: ${people.map((p) => p.name).join(", ")}`);
		for (const p of people.slice(0, 5)) {
			const dot = el.createSpan({ cls: "tezca-avatar", text: (p.name.trim()[0] ?? "?").toUpperCase() });
			dot.style.backgroundColor = p.color;
			dot.setAttr("title", p.name);
		}
		if (people.length > 5) el.createSpan({ text: ` +${people.length - 5}` });
	}

	// ───────────── sharing ─────────────

	async shareFolder(path: string) {
		const engine = this.engine;
		if (!engine) return;
		const name = path.split("/").pop() ?? path;
		const ok = await confirm(
			this.app,
			`Share "${name}"?`,
			"This turns the folder into a shared folder that you can invite people to. Its files keep syncing to all your devices. Version history from before sharing stays with your private vault.",
			"Share folder",
		);
		if (!ok) return;
		try {
			const spaceId = await engine.shareFolder(path, name);
			new Notice(`"${name}" is now a shared folder`);
			const open = () => {
				if (engine.shares.has(spaceId)) new ShareModal(this.app, engine, spaceId).open();
				else window.setTimeout(open, 300);
			};
			open();
		} catch (e) {
			new Notice(`Tezca: couldn't share the folder: ${(e as Error).message}`, 10000);
		}
	}

	async joinShare(host: string, token: string, secret: string) {
		host = normalizeHost(host);
		if (!this.isConfigured) return this.joinShareAsNewGuest(host, token, secret);
		const engine = this.engine;
		if (!engine) throw new Error("Tezca isn't running. Check its settings, then open the invite link again.");
		const path = await engine.joinShare(token, secret, (n) => this.askMountPath(n), host);
		if (path) new Notice(`Joined. The shared folder is at "${path}".`);
	}

	/**
	 * Someone without Tezca set up opens an invite: they join that host as a guest. Only shared
	 * folders sync; their own notes stay on this device. Their mount list lives in a profile space.
	 */
	private async joinShareAsNewGuest(host: string, token: string, secret: string) {
		const ok = await confirm(
			this.app,
			"Join a shared folder",
			`You've been invited to a shared folder on ${host}. You'll join that host as a guest: only shared folders sync, and the rest of this vault stays on this device. You can add a host of your own later.`,
			"Join",
		);
		if (!ok) return;
		const id = newIdentity();
		await new ShareApi(this.api(host), id).redeemAsGuest(token);
		await new Promise<void>((resolve) => new RecoveryPhraseModal(this.app, recoveryPhrase(id.seed), resolve).open());
		const conn = new HostConnection({ host, identity: id, deviceId: this.settings.deviceId, clientVersion: this.manifest.version });
		conn.start();
		try {
			await waitOnline(conn);
			const profile = await createSpace(conn, id, this.settings.displayName || this.app.vault.getName(), SpaceKind.PROFILE);
			await this.stopEngine();
			await this.saveIdentity(id);
			this.settings.host = host;
			this.settings.spaceId = profile.spaceId;
			this.settings.hostRole = "guest";
			await this.saveSettings();
		} finally {
			conn.stop();
		}
		await this.startEngine();
		this.settingTab.display();
		const engine = this.engine;
		if (!engine) return;
		const path = await engine.joinShare(token, secret, (n) => this.askMountPath(n), host);
		if (path) new Notice(`Joined. The shared folder is at "${path}".`);
	}

	private async askMountPath(shareName: string): Promise<string | null> {
		let suggestion = shareName;
		for (let i = 2; this.app.vault.getAbstractFileByPath(suggestion); i++) suggestion = `${shareName} ${i}`;
		const v = await form(this.app, `Join "${shareName}"`, "Choose the folder in your vault where this shared folder will live.", [
			{ key: "path", name: "Folder", value: suggestion },
		], "Join");
		const p = v?.path.trim().replace(/^\/+|\/+$/g, "");
		return p ? p : null;
	}

	// ───────────── setup flows ─────────────

	private api(host: string) {
		return new HostApi(normalizeHost(host), obsidianHttp);
	}

	async handleDeepLink(params: ObsidianProtocolData) {
		const link = parseDeepLink(params as unknown as Record<string, string>);
		if (!link) return new Notice("Tezca: unrecognised link");
		try {
			if (link.action === "claim") await this.claimHost(link.host, link.code ?? "");
			else if (link.action === "join") await this.joinHost(link.host, link.token ?? "");
			else if (link.action === "share") await this.joinShare(link.host, link.token ?? "", link.k ?? "");
			else await this.acceptPairing(link.host, link.id ?? "", link.k ?? "");
		} catch (e) {
			log.error(e);
			new Notice(`Tezca: ${(e as Error).message}`, 10000);
		}
	}

	private async confirmReplace(): Promise<boolean> {
		if (!this.isConfigured) return true;
		return confirm(
			this.app,
			"Replace sync setup?",
			"This vault is already connected to a Tezca host. Continuing will disconnect it and connect to the new one. Local files are kept.",
		);
	}

	async claimHost(host: string, code: string) {
		if (!(await this.confirmReplace())) return;
		const id = newIdentity();
		await this.api(host).claim(code, id);
		await this.finishNewIdentity(host, id, "admin");
	}

	async joinHost(host: string, token: string) {
		if (!(await this.confirmReplace())) return;
		const existing = this.identity ?? (await this.loadIdentity());
		let id = existing;
		if (!id) id = newIdentity();
		await this.api(host).redeem(token, id);
		if (existing) {
			await this.connectSpace(normalizeHost(host), existing, "member");
		} else await this.finishNewIdentity(host, id, "member");
	}

	private async finishNewIdentity(host: string, id: Identity, role: string) {
		await new Promise<void>((resolve) => new RecoveryPhraseModal(this.app, recoveryPhrase(id.seed), resolve).open());
		await this.connectSpace(normalizeHost(host), id, role);
	}

	/** Connect with `id`, let the user pick (or create) the vault space, and start syncing. */
	async connectSpace(host: string, id: Identity, role: string, preselectSpace?: string) {
		const conn = new HostConnection({ host, identity: id, deviceId: this.settings.deviceId, clientVersion: this.manifest.version });
		conn.start();
		try {
			await waitOnline(conn);
			let spaceId = preselectSpace ?? "";
			if (!spaceId) {
				const roots = (await listSpaces(conn)).filter((s) => s.kind === SpaceKind.ROOT);
				const choices = roots.map((s) => {
					const name = new SpaceSync(conn, null as never, id, s).meta?.name ?? s.spaceId;
					return { label: name, detail: "Sync this vault with the existing synced vault", value: s.spaceId };
				});
				choices.push({ label: `New synced vault "${this.app.vault.getName()}"`, detail: "Upload this vault as a new synced vault", value: "" });
				const picked = roots.length ? await choose(this.app, "Choose a synced vault", "Which synced vault should this Obsidian vault use?", choices) : "";
				if (picked === null) return;
				spaceId = picked;
				if (!spaceId) spaceId = (await createRootSpace(conn, id, this.app.vault.getName())).spaceId;
			}
			await this.stopEngine();
			await this.saveIdentity(id);
			this.settings.host = host;
			this.settings.spaceId = spaceId;
			this.settings.hostRole = role;
			await this.saveSettings();
			new Notice("Tezca: connected. Syncing…");
			await this.startEngine();
			this.settingTab.display();
		} finally {
			conn.stop();
		}
	}

	async acceptPairing(host: string, pairingId: string, secret: string) {
		if (!(await this.confirmReplace())) return;
		const payload = await this.api(host).fetchPairing(pairingId, secret);
		const id = identityFromSeed(fromB64u(payload.seed));
		if (payload.displayName && !this.settings.displayName) this.settings.displayName = payload.displayName;
		await this.connectSpace(normalizeHost(payload.host || host), id, "member", payload.spaceId || undefined);
	}

	async restoreFromPhrase() {
		const v = await form(
			this.app,
			"Restore with recovery phrase",
			"Connect this vault using your 24-word recovery phrase.",
			[
				{ key: "host", name: "Host URL", placeholder: "https://sync.example.com", value: this.settings.host },
				{ key: "phrase", name: "Recovery phrase", multiline: true },
			],
		);
		if (!v) return;
		try {
			if (!(await this.confirmReplace())) return;
			const id = identityFromSeed(seedFromRecoveryPhrase(v.phrase));
			await this.connectSpace(normalizeHost(v.host), id, "member");
		} catch (e) {
			new Notice(`Tezca: ${(e as Error).message}`, 10000);
		}
	}

	async setupFromLinkOrCode() {
		const v = await form(this.app, "Connect to a Tezca host", "Paste a setup link (claim, invite or pairing link).", [
			{ key: "link", name: "Setup link", placeholder: "obsidian://tezca?do=…", multiline: true },
		]);
		if (!v?.link) return;
		try {
			const url = new URL(v.link.trim());
			const params: Record<string, string> = {};
			url.searchParams.forEach((val, k) => (params[k] = val));
			await this.handleDeepLink(params as unknown as ObsidianProtocolData);
		} catch {
			new Notice("Tezca: that doesn't look like a Tezca setup link.");
		}
	}

	async pairDevice(newVault = false) {
		if (!this.identity || !this.isConfigured) return new Notice("Tezca: set up sync first.");
		try {
			const { link } = await this.api(this.settings.host).createPairing(this.identity, {
				seed: b64u(this.identity.seed),
				host: this.settings.host,
				spaceId: newVault ? "" : this.settings.spaceId,
				displayName: this.settings.displayName,
			});
			new LinkModal(
				this.app,
				newVault ? "Set up another synced vault" : "Pair another device",
				newVault
					? "Open this link in the other Obsidian vault (on any device) to connect it as a separate synced vault."
					: "Scan this QR code with your phone's camera, or open the link on the other device. It opens Obsidian and connects this vault.",
				link,
				"This link carries your identity key. It works once and expires in 15 minutes. Don't share it.",
			).open();
		} catch (e) {
			new Notice(`Tezca: could not create pairing link: ${(e as Error).message}`);
		}
	}

	async createInvite() {
		if (!this.identity || !this.isConfigured) return;
		try {
			const inv = await this.api(this.settings.host).createInvite(this.identity);
			new LinkModal(
				this.app,
				"Invite a member to this host",
				"Send this link to the person you want to invite. They'll get their own private synced vaults on this host.",
				inv.link,
				"Anyone with this link can join the host until it's used or expires.",
			).open();
		} catch (e) {
			new Notice(`Tezca: could not create invite: ${(e as Error).message}`);
		}
	}

	async showRecoveryPhrase() {
		const id = this.identity ?? (await this.loadIdentity());
		if (!id) return new Notice("Tezca: no identity on this device.");
		if (!(await confirm(this.app, "Show recovery phrase?", "Make sure nobody can see your screen.", "Show"))) return;
		new RecoveryPhraseModal(this.app, recoveryPhrase(id.seed)).open();
	}

	async disconnect() {
		if (!(await confirm(this.app, "Disconnect this vault?", "Sync stops on this device. Your files stay as they are. You can reconnect later with a pairing link or your recovery phrase.", "Disconnect"))) return;
		await this.stopEngine();
		this.settings.spaceId = "";
		this.settings.host = "";
		await this.saveSettings();
		this.renderStatus();
		this.settingTab.display();
	}

	identityFingerprint(): string {
		return this.identity ? hex(this.identity.signPk).slice(0, 16) : "";
	}
}
