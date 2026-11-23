import { App, PluginSettingTab, Setting } from "obsidian";
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

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();

		if (!p.isConfigured) {
			containerEl.createEl("p", {
				text: "Tezca syncs this vault live and end-to-end encrypted through a host you run yourself (a small Docker container).",
			});
			new Setting(containerEl)
				.setName("Set up with a link")
				.setDesc("Paste a claim link (from your new host's setup page), an invite link, or a pairing link from another device. Opening the link directly on this device works too.")
				.addButton((b) => b.setButtonText("Paste link").setCta().onClick(() => void p.setupFromLinkOrCode()));
			new Setting(containerEl)
				.setName("Restore with recovery phrase")
				.setDesc("Connect using your 24-word recovery phrase and your host's URL.")
				.addButton((b) => b.setButtonText("Restore").onClick(() => void p.restoreFromPhrase()));
		} else {
			const status = p.engine?.currentStatus();
			new Setting(containerEl)
				.setName("Status")
				.setDesc(`${status?.conn ?? "stopped"} · host ${p.settings.host} · vault ${p.engine?.space?.meta?.name ?? p.settings.spaceId}`)
				.addButton((b) => b.setButtonText("Reconnect").onClick(() => p.engine?.conn.reconnectNow()));
			if (p.identityFingerprint())
				containerEl.createEl("p", { cls: "setting-item-description", text: `Identity: ${p.identityFingerprint()}…` });

			containerEl.createEl("h3", { text: "Devices" });
			new Setting(containerEl)
				.setName("Pair another device")
				.setDesc("Shows a one-time QR code / link to connect another device to this vault.")
				.addButton((b) => b.setButtonText("Pair device").setCta().onClick(() => void p.pairDevice()));
			new Setting(containerEl)
				.setName("Set up another synced vault")
				.setDesc("Connect a different Obsidian vault as a separate synced vault with the same identity.")
				.addButton((b) => b.setButtonText("Create link").onClick(() => void p.pairDevice(true)));
			new Setting(containerEl)
				.setName("Recovery phrase")
				.setDesc("Your 24-word key. Needed if you lose every device.")
				.addButton((b) => b.setButtonText("Show").onClick(() => void p.showRecoveryPhrase()));
			if (p.settings.hostRole === "admin")
				new Setting(containerEl)
					.setName("Invite a member")
					.setDesc("Create a one-time invite link so someone else can use this host.")
					.addButton((b) => b.setButtonText("Create invite").onClick(() => void p.createInvite()));

			containerEl.createEl("h3", { text: "Shared folders" });
			const mounts = p.engine?.mounts?.all() ?? [];
			if (!mounts.length)
				containerEl.createEl("p", {
					cls: "setting-item-description",
					text: "None yet. Right-click a folder and choose \"Share folder…\" to share it with someone on this host.",
				});
			for (const m of mounts) {
				const sh = p.engine?.shares.get(m.spaceId);
				const role = p.engine?.roleIn(m.spaceId);
				new Setting(containerEl)
					.setName(m.path)
					.setDesc(sh ? `${sh.space.meta?.name ?? ""}${role ? ` · you're ${role === "owner" ? "an owner" : `a${role === "editor" ? "n editor" : " viewer"}`}` : ""}` : "Connecting…")
					.addButton((b) =>
						b
							.setButtonText("Manage")
							.setDisabled(!sh)
							.onClick(() => new ShareModal(this.app, p.engine!, m.spaceId).open()),
					);
			}

			containerEl.createEl("h3", { text: "Presence" });
			new Setting(containerEl)
				.setName("Display name")
				.setDesc("Shown next to your cursor, and to the other members of your shared folders.")
				.addText((t) =>
					t
						.setPlaceholder(p.settings.deviceName)
						.setValue(p.settings.displayName)
						.onChange(async (v) => {
							p.settings.displayName = v.trim();
							await p.saveSettings();
							p.editors.updateUser();
							p.engine?.updateProfile();
						}),
				);
			new Setting(containerEl)
				.setName("Device name")
				.setDesc("Used in conflict file names.")
				.addText((t) =>
					t.setValue(p.settings.deviceName).onChange(async (v) => {
						p.settings.deviceName = v.trim() || "Device";
						await p.saveSettings();
					}),
				);
			new Setting(containerEl).setName("Cursor colour").addColorPicker((c) =>
				c.setValue(p.settings.color).onChange(async (v) => {
					p.settings.color = v;
					await p.saveSettings();
					p.editors.updateUser();
					p.engine?.updateProfile();
				}),
			);

			containerEl.createEl("h3", { text: "Advanced" });
			new Setting(containerEl).setName("Debug logging").addToggle((t) =>
				t.setValue(p.settings.debug).onChange(async (v) => {
					p.settings.debug = v;
					log.level = v ? "debug" : "info";
					await p.saveSettings();
				}),
			);
			new Setting(containerEl)
				.setName("Disconnect this vault")
				.setDesc("Stop syncing on this device. Files are kept.")
				.addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(() => void p.disconnect()));
		}
	}
}
