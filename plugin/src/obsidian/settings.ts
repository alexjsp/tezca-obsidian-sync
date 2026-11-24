import { App, ButtonComponent, ExtraButtonComponent, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { confirm, copyText } from "./modals";
import { b64u, fromB64u, hex } from "../core/crypto";
import type { HostUser } from "../core/setup";
import { renderAvatar } from "./avatar";
import type TezcaPlugin from "../main";
import { ShareModal } from "./share-modal";
import { log } from "../core/util";

export class TezcaSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: TezcaPlugin,
	) {
		super(app, plugin);
	}

	private avatarEl: HTMLElement | null = null;
	private nameEl: HTMLElement | null = null;

	/** Redraw the profile picture preview (after it changes here or on another device). */
	refreshProfile(): void {
		const el = this.avatarEl;
		const p = this.plugin;
		if (!el || !el.isConnected) return;
		const name = p.settings.displayName || p.settings.deviceName;
		renderAvatar(el, { name, color: p.settings.color, avatar: p.currentAvatar() });
		this.nameEl?.setText(name);
	}

	private statusOff: (() => void) | null = null;

	hide(): void {
		this.statusOff?.();
		this.statusOff = null;
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();
		containerEl.addClass("tezca-settings");
		this.statusOff?.();
		this.statusOff = null;

		if (!p.isConfigured) {
			const hero = containerEl.createDiv({ cls: "tezca-hero tezca-hero-setup" });
			const icon = hero.createDiv({ cls: "tezca-hero-icon" });
			setIcon(icon, "tezca");
			const body = hero.createDiv({ cls: "tezca-hero-body" });
			body.createDiv({ cls: "tezca-hero-title", text: "Sync this vault with Tezca" });
			body.createDiv({
				cls: "tezca-hero-sub",
				text: "Live, end-to-end encrypted sync through a host you run yourself. Your notes are only ever readable on your devices.",
			});
			const actions = body.createDiv({ cls: "tezca-hero-actions" });
			new ButtonComponent(actions).setButtonText("Paste link").setCta().onClick(() => void p.setupFromLinkOrCode());
			new ButtonComponent(actions).setButtonText("Restore").onClick(() => void p.restoreFromPhrase());
			body.createDiv({
				cls: "tezca-hero-note",
				text: "Paste a claim link from your new host, an invite link, or a pairing link from another of your devices. Restore uses your recovery key.",
			});
			heading(containerEl, "Your profile");
			this.profileRow(containerEl);
			return;
		}

		// ── Account card: who you are, and the state of sync ──
		const hero = containerEl.createDiv({ cls: "tezca-hero" });
		this.avatarEl = hero.createSpan({ cls: "tezca-avatar tezca-avatar-hero" });
		const body = hero.createDiv({ cls: "tezca-hero-body" });
		this.nameEl = body.createDiv({ cls: "tezca-hero-title" });
		const meta = body.createDiv({ cls: "tezca-hero-meta" });
		const pill = meta.createSpan({ cls: "tezca-pill" });
		meta.createSpan({ cls: "tezca-hero-chip", text: hostLabel(p.settings.host), attr: { title: p.settings.host } });
		if (!p.engine?.isProfile) meta.createSpan({ cls: "tezca-hero-chip", text: `Vault: ${p.engine?.space?.meta?.name ?? this.app.vault.getName()}` });
		else meta.createSpan({ cls: "tezca-hero-chip", text: "Guest" });
		const renderPill = () => {
			const [text, state] = statusLabel(p);
			pill.empty();
			pill.dataset.state = state;
			pill.createSpan({ cls: "tezca-status-dot" });
			pill.createSpan({ text });
		};
		renderPill();
		const off = p.engine?.status.on(() => renderPill());
		this.statusOff = off ?? null;
		const heroActions = hero.createDiv({ cls: "tezca-hero-actions" });
		new ButtonComponent(heroActions).setButtonText("Edit profile").onClick(() => p.editProfile(false));
		new ExtraButtonComponent(heroActions)
			.setIcon("refresh-cw")
			.setTooltip("Reconnect")
			.onClick(() => p.engine?.conn.reconnectNow());
		this.refreshProfile();

		// ── Devices ──
		heading(containerEl, "Devices");
		new Setting(containerEl)
			.setName("Pair another device")
			.setDesc("Show a one-time QR code and link that connects another device to this vault.")
			.addButton((b) => b.setButtonText("Pair device").setCta().onClick(() => void p.pairDevice()));
		new Setting(containerEl)
			.setName("Another synced vault")
			.setDesc("Connect a different Obsidian vault as its own synced vault, with the same identity.")
			.addButton((b) => b.setButtonText("Create link").onClick(() => void p.pairDevice(true)));
		new Setting(containerEl)
			.setName("Recovery key")
			.setDesc("The only way back in if you lose every device.")
			.addButton((b) => b.setButtonText("Show").onClick(() => void p.showRecoveryKey()));

		if (p.settings.hostRole === "admin") {
			heading(containerEl, "People");
			new Setting(containerEl)
				.setName("Invite someone to this host")
				.setDesc("They get their own private synced vaults here. The link works once.")
				.addButton((b) => b.setButtonText("Create invite").onClick(() => void p.createInvite()));
			void this.renderPeople(containerEl.createDiv({ cls: "tezca-people" }));
		}

		// ── Shared folders ──
		heading(containerEl, "Shared folders");
		const mounts = p.engine?.mounts?.all() ?? [];
		if (p.engine?.isProfile)
			note(containerEl, "You're using Tezca as a guest: only shared folders sync, and the rest of this vault stays on this device.");
		if (!mounts.length) note(containerEl, 'None yet. Right-click a folder and choose "Share folder…", or open an invite link to join one.');
		for (const m of mounts) {
			const sh = p.engine?.shares.get(m.spaceId);
			const role = p.engine?.roleIn(m.spaceId);
			const row = new Setting(containerEl).setClass("tezca-share-row");
			const icon = row.nameEl.createSpan({ cls: "tezca-row-icon" });
			setIcon(icon, "folder-sync");
			row.nameEl.createSpan({ text: m.path });
			if (role) row.nameEl.createSpan({ cls: `tezca-role tezca-role-${role}`, text: role[0].toUpperCase() + role.slice(1) });
			const name = sh?.space.meta?.name;
			row.setDesc(
				sh
					? [name && name !== m.path.split("/").pop() ? `Shared as "${name}"` : "", m.host ? `On ${hostLabel(m.host)}` : ""].filter(Boolean).join(" · ") || "Syncing"
					: `Connecting…${m.host ? ` (${hostLabel(m.host)})` : ""}`,
			);
			row.addButton((b) =>
				b
					.setButtonText("Manage")
					.setDisabled(!sh)
					.onClick(() => new ShareModal(this.app, p.engine!, m.spaceId, p.installer).open()),
			);
		}

		// ── Settings sync ──
		if (!p.engine?.isProfile) {
			heading(containerEl, "Settings sync", "Choose, per device, which parts of Obsidian's settings sync through your vault. Changes from other devices apply after reloading Obsidian. Workspace layout, Tezca's own settings and BRAT's list of beta plugins never sync.");
			const cats: [keyof typeof p.settings.configSync, string, string][] = [
				["core", "Core settings", "Editor and app options, core plugins and their settings."],
				["appearance", "Appearance", "Theme, themes and CSS snippets."],
				["hotkeys", "Hotkeys", "Custom keyboard shortcuts."],
				["plugins", "Community plugin list and settings", "Which plugins are on, and each plugin's settings."],
				["pluginCode", "Community plugin code", "The plugins themselves, so one installed here appears on your other devices."],
			];
			for (const [key, name, desc] of cats)
				new Setting(containerEl)
					.setName(name)
					.setDesc(desc)
					.addToggle((t) =>
						t.setValue(p.settings.configSync[key]).onChange(async (v) => {
							p.settings.configSync[key] = v;
							await p.saveSettings();
							await p.startEngine(); // re-scan with the new selection
						}),
					);
		}

		// ── This device ──
		heading(containerEl, "This device");
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Used in the names of conflict copies.")
			.addText((t) =>
				t.setValue(p.settings.deviceName).onChange(async (v) => {
					p.settings.deviceName = v.trim() || "Device";
					await p.saveSettings();
				}),
			);

		// ── Advanced ──
		heading(containerEl, "Advanced");
		const fp = p.identityFingerprint();
		if (fp) {
			const idRow = new Setting(containerEl).setName("Identity key").setDesc("Identifies you to hosts and to the people you share with.");
			idRow.controlEl.createEl("code", { cls: "tezca-key", text: fp.match(/.{1,4}/g)!.join(" ") });
			idRow.addExtraButton((b) =>
				b
					.setIcon("copy")
					.setTooltip("Copy")
					.onClick(async () => new Notice((await copyText(fp, containerEl)) ? "Copied" : "Couldn't copy")),
			);
		}
		new Setting(containerEl).setName("Debug logging").setDesc("More detail in the developer console, for reporting problems.").addToggle((t) =>
			t.setValue(p.settings.debug).onChange(async (v) => {
				p.settings.debug = v;
				log.level = v ? "debug" : "info";
				await p.saveSettings();
			}),
		);
		new Setting(containerEl)
			.setName("Disconnect this vault")
			.setDesc("Stop syncing on this device. Your files stay as they are.")
			.addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(() => void p.disconnect()));
	}

	/** Everyone with an account on this host, with Remove (admins). */
	private async renderPeople(el: HTMLElement) {
		const p = this.plugin;
		if (!p.identity || !p.engine) return;
		let users: HostUser[];
		try {
			users = await p.engine.primary.api.listUsers(p.identity);
		} catch {
			return; // an older host without the list
		}
		el.empty();
		const names = p.engine.knownNames();
		const me = b64u(p.identity.signPk);
		for (const u of users) {
			const key = hex(fromB64u(u.sign_pk)).slice(0, 16).match(/.{4}/g)!.join(" ");
			const isMe = u.sign_pk === me;
			const name = isMe ? `${p.settings.displayName || "You"} (you)` : names.get(u.sign_pk) ?? `Key ${key}`;
			const row = new Setting(el).setName(name).setDesc([u.role[0].toUpperCase() + u.role.slice(1), names.has(u.sign_pk) || isMe ? `key ${key}` : "", `joined ${new Date(u.created_at * 1000).toLocaleDateString()}`].filter(Boolean).join(" · "));
			const admins = users.filter((x) => x.role === "admin").length;
			if (isMe) {
				if (admins > 1) row.addButton((b) => b.setButtonText("Step down as admin").onClick(() => void this.setRole(el, u, name, "member")));
				continue;
			}
			if (u.role === "member") row.addButton((b) => b.setButtonText("Make admin").onClick(() => void this.setRole(el, u, name, "admin")));
			if (u.role === "admin") row.addButton((b) => b.setButtonText("Remove admin").onClick(() => void this.setRole(el, u, name, "member")));
			row.addButton((b) =>
				b
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						const ok = await confirm(
							this.app,
							`Remove ${name} from this host?`,
							"All of their devices lose access straight away. Their own synced vaults stay on the host but can't be opened by them any more. Shared folders of yours they were in get a new key, so they can't read anything written from now on (they keep what they already have).",
							"Remove",
						);
						if (!ok) return;
						try {
							await p.engine!.removeHostUser(fromB64u(u.sign_pk));
							new Notice(`Removed ${name}`);
							void this.renderPeople(el);
						} catch (e) {
							new Notice(`Couldn't remove: ${(e as Error).message}`);
						}
					}),
			);
		}
	}

	/** Make someone (or yourself) an admin or a member, after confirming. */
	private async setRole(el: HTMLElement, u: HostUser, name: string, role: "admin" | "member") {
		const p = this.plugin;
		if (!p.identity || !p.engine) return;
		const isMe = u.sign_pk === b64u(p.identity.signPk);
		const [title, body, action] =
			role === "admin"
				? [`Make ${name} an admin?`, "Admins can invite people to this host, see everyone who has an account here, and remove people or change their role, including yours.", "Make admin"]
				: isMe
					? ["Step down as admin?", "You'll keep your vaults and shared folders, but you won't be able to invite people to this host or manage its accounts any more. Another admin can make you an admin again.", "Step down"]
					: [`Remove ${name} as an admin?`, "They keep their vaults and shared folders, but can no longer invite people to this host or manage its accounts.", "Remove admin"];
		if (!(await confirm(this.app, title, body, action))) return;
		try {
			await p.engine.primary.api.setUserRole(p.identity, fromB64u(u.sign_pk), role);
			new Notice(isMe ? "You're no longer an admin of this host" : role === "admin" ? `${name} is now an admin` : `${name} is no longer an admin`);
			void this.renderPeople(el);
		} catch (e) {
			new Notice(`Couldn't change the role: ${(e as Error).message}`);
		}
	}

	/** Profile row (before setup, where there's no account card). */
	private profileRow(containerEl: HTMLElement) {
		const prof = new Setting(containerEl).setName("Name, colour and picture").setDesc("Shown on your cursor and to the people you share folders with.");
		this.avatarEl = prof.controlEl.createSpan({ cls: "tezca-avatar tezca-avatar-large" });
		this.nameEl = prof.controlEl.createSpan({ cls: "tezca-profile-name-label" });
		this.refreshProfile();
		prof.addButton((b) => b.setButtonText("Edit…").onClick(() => this.plugin.editProfile(false)));
	}
}

/** A section heading that lines up with the setting rows. */
function heading(containerEl: HTMLElement, text: string, desc?: string) {
	const h = new Setting(containerEl).setName(text).setHeading();
	if (desc) h.setDesc(desc);
}

function note(containerEl: HTMLElement, text: string) {
	containerEl.createDiv({ cls: "tezca-settings-note", text });
}

function hostLabel(host: string): string {
	try {
		const u = new URL(host);
		return u.host;
	} catch {
		return host;
	}
}

function statusLabel(p: TezcaPlugin): [string, "ok" | "busy" | "off" | "err"] {
	const s = p.engine?.currentStatus();
	if (!s) return ["Stopped", "off"];
	if (s.conn === "online") return s.ready && !s.busy ? ["Synced", "ok"] : ["Syncing…", "busy"];
	if (s.conn === "connecting") return ["Connecting…", "busy"];
	if (s.conn === "unauthorized") return ["Access denied", "err"];
	if (s.conn === "update-required") return ["Update required", "err"];
	return ["Offline", "off"];
}
