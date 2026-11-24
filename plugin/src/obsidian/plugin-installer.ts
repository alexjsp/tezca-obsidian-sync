// Installing community plugins a shared folder recommends, through Obsidian's own installer
// (the same one Settings → Community plugins uses, with its checks for blocked plugins).
import { requestUrl, type App, type PluginManifest } from "obsidian";
import type { RecommendedPlugin } from "../core/engine";

const DIRECTORY_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";

/** The parts of Obsidian's (undocumented) plugin manager used here. */
interface PluginManager {
	manifests: Record<string, PluginManifest>;
	enabledPlugins: Set<string>;
	isEnabled(): boolean;
	setEnable(on: boolean): Promise<void>;
	installPlugin(repo: string, version: string, manifest: PluginManifest): Promise<boolean | void>;
	enablePluginAndSave(id: string): Promise<boolean | void>;
	loadManifests(): Promise<void>;
}

export type PluginState = "enabled" | "disabled" | "missing";

export interface DirectoryEntry {
	id: string;
	name: string;
	author: string;
	repo: string;
	description?: string;
}

export class PluginInstaller {
	private directory: Promise<Map<string, DirectoryEntry>> | null = null;

	constructor(
		private readonly app: App,
		private readonly ownId: string,
	) {}

	private get plugins(): PluginManager {
		return (this.app as unknown as { plugins: PluginManager }).plugins;
	}

	/** Community plugins installed here (not Tezca itself), for choosing what to recommend. */
	installed(): RecommendedPlugin[] {
		return Object.values(this.plugins.manifests)
			.filter((m) => m.id !== this.ownId)
			.map((m) => ({ id: m.id, name: m.name, author: m.author }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	state(id: string): PluginState {
		if (!this.plugins.manifests[id]) return "missing";
		return this.plugins.enabledPlugins.has(id) ? "enabled" : "disabled";
	}

	/** Community plugins are switched off (restricted mode). */
	get restricted(): boolean {
		return !this.plugins.isEnabled();
	}

	/** A plugin's entry in Obsidian's community plugin directory (its real name, author and repo), or null. */
	async directoryEntry(id: string): Promise<DirectoryEntry | null> {
		if (!this.directory)
			this.directory = requestUrl({ url: DIRECTORY_URL })
				.then((r) => new Map((r.json as DirectoryEntry[]).filter((p) => p && typeof p.id === "string").map((p) => [p.id, p])))
				.catch((e) => {
					this.directory = null;
					throw e;
				});
		return (await this.directory).get(id) ?? null;
	}

	/** The latest manifest in a plugin's repository (its version is what gets installed). */
	async remoteManifest(repo: string): Promise<PluginManifest> {
		return (await requestUrl({ url: `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json` })).json as PluginManifest;
	}

	/**
	 * Install (if missing) and enable a plugin. Throws with a user-facing message if it isn't in
	 * the community directory or Obsidian refuses it.
	 */
	async installAndEnable(p: RecommendedPlugin): Promise<void> {
		const pm = this.plugins;
		if (this.restricted) await pm.setEnable(true);
		if (!pm.manifests[p.id]) {
			const repo = (await this.directoryEntry(p.id))?.repo;
			if (!repo) throw new Error(`${p.id} isn't in Obsidian's community plugin directory, so it has to be installed by hand.`);
			const manifest = await this.remoteManifest(repo);
			if (manifest.id !== p.id) throw new Error(`${p.name}'s repository doesn't match its listing.`);
			const ok = await pm.installPlugin(repo, manifest.version, manifest);
			await pm.loadManifests();
			if (ok === false || !pm.manifests[p.id]) throw new Error(`Obsidian couldn't install ${p.name}.`);
		}
		if (!pm.enabledPlugins.has(p.id)) await pm.enablePluginAndSave(p.id);
	}
}
