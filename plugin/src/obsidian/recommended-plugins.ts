// Recommended plugins for a shared folder: choosing them (members who can edit) and installing
// them (anyone, offered when joining).
import { App, Modal, Notice, Setting } from "obsidian";
import type { RecommendedPlugin } from "../core/engine";
import type { DirectoryEntry, PluginInstaller } from "./plugin-installer";

/** Pick which of your installed plugins this shared folder recommends. */
export class ChooseRecommendedModal extends Modal {
	constructor(
		app: App,
		private readonly shareName: string,
		private readonly installer: PluginInstaller,
		private readonly current: RecommendedPlugin[],
		private readonly save: (list: RecommendedPlugin[]) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(`Recommend plugins for "${this.shareName}"`);
		const { contentEl } = this;
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "People who join this shared folder are offered these plugins. Pick the ones its notes need (for example Dataview queries, or Tasks).",
		});
		const chosen = new Map(this.current.map((p) => [p.id, p]));
		const mine = this.installer.installed();
		if (!mine.length) contentEl.createEl("p", { text: "You don't have any community plugins installed." });
		for (const p of mine)
			new Setting(contentEl)
				.setName(p.name)
				.setDesc(p.author ? `By ${p.author}` : p.id)
				.addToggle((t) => t.setValue(chosen.has(p.id)).onChange((v) => (v ? chosen.set(p.id, p) : chosen.delete(p.id))));
		// Recommended by someone else and not installed here: keep unless unticked.
		for (const p of this.current.filter((c) => !mine.some((m) => m.id === c.id)))
			new Setting(contentEl)
				.setName(p.name)
				.setDesc("Recommended by another member (not installed on this device)")
				.addToggle((t) => t.setValue(true).onChange((v) => (v ? chosen.set(p.id, p) : chosen.delete(p.id))));
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					this.save([...chosen.values()]);
					this.close();
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Offer to install (and enable) a shared folder's recommended plugins. The list only says which
 * plugin ids are recommended: names and authors shown here come from Obsidian's community
 * directory (or this device), never from the share, so a plugin can't pose as another.
 */
export class InstallRecommendedModal extends Modal {
	constructor(
		app: App,
		private readonly shareName: string,
		private readonly installer: PluginInstaller,
		private readonly plugins: RecommendedPlugin[],
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(`Plugins recommended for "${this.shareName}"`);
		this.contentEl.createEl("p", { text: "Loading plugin details…" });
		void this.render();
	}

	private async render() {
		const details = await Promise.all(
			this.plugins.map(async (p) => {
				const local = this.installer.installed().find((m) => m.id === p.id);
				let listed: DirectoryEntry | null = null;
				try {
					listed = await this.installer.directoryEntry(p.id);
				} catch {
					/* offline: show what we know */
				}
				return { p, local, listed };
			}),
		);
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			text: "The members of this shared folder recommend these community plugins for its notes. Plugins run code on your device, so only install ones you trust.",
		});
		if (this.installer.restricted)
			contentEl.createEl("p", { cls: "tezca-warning", text: "Community plugins are turned off in this vault (Restricted mode). Installing turns them on." });
		const selected = new Set<string>();
		for (const { p, local, listed } of details) {
			const state = this.installer.state(p.id);
			const name = listed?.name ?? local?.name ?? p.id;
			const author = listed?.author ?? local?.author;
			const s = new Setting(contentEl).setName(name);
			const desc = [author ? `By ${author}` : "", `ID: ${p.id}`];
			if (state === "enabled") {
				s.setDesc([...desc, "Installed and enabled"].filter(Boolean).join(" · "));
				continue;
			}
			if (state === "missing" && !listed) {
				s.setDesc([...desc, "Not in Obsidian's community plugin directory, so it can't be installed from here"].filter(Boolean).join(" · "));
				continue;
			}
			s.setDesc([...desc, state === "disabled" ? "Installed, but you turned it off" : ""].filter(Boolean).join(" · "));
			// Something you turned off stays off unless you tick it.
			if (state === "missing") selected.add(p.id);
			s.addToggle((t) => t.setValue(state === "missing").onChange((v) => (v ? selected.add(p.id) : selected.delete(p.id))));
		}
		const buttons = new Setting(contentEl);
		const installable = details.filter(({ p, listed }) => this.installer.state(p.id) === "disabled" || (this.installer.state(p.id) === "missing" && listed));
		if (!installable.length) {
			buttons.setDesc("Nothing to install.").addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
			return;
		}
		buttons
			.addButton((b) => b.setButtonText("Not now").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Install and enable")
					.setCta()
					.onClick(async () => {
						if (!selected.size) return this.close();
						b.setDisabled(true).setButtonText("Installing…");
						const failed: string[] = [];
						for (const { p, listed, local } of details.filter((d) => selected.has(d.p.id))) {
							try {
								await this.installer.installAndEnable({ id: p.id, name: listed?.name ?? local?.name ?? p.id });
							} catch (e) {
								failed.push((e as Error).message || p.id);
							}
						}
						this.close();
						const done = selected.size - failed.length;
						if (done) new Notice(`Installed and enabled ${done} plugin${done === 1 ? "" : "s"}.`);
						for (const f of failed) new Notice(`Tezca: ${f}`, 10000);
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
