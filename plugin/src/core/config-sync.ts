// Which files under the vault's config folder (.obsidian) sync, by opt-in category (plan.md "Content").
// Config files sync as blobs in the user's private (root) space only.

export interface ConfigCategories {
	/** Core settings: app.json, core plugin list and their settings (daily notes, templates, …). */
	core: boolean;
	/** appearance.json, themes/, snippets/. */
	appearance: boolean;
	/** hotkeys.json. */
	hotkeys: boolean;
	/** Community plugin list (community-plugins.json) and each plugin's settings (data.json). */
	plugins: boolean;
	/** Community plugin code: main.js, manifest.json, styles.css. */
	pluginCode: boolean;
}

export const NO_CONFIG: ConfigCategories = { core: false, appearance: false, hotkeys: false, plugins: false, pluginCode: false };

/** Never synced: per-device layout, and this plugin's own folder (it holds per-device setup). */
const ALWAYS_EXCLUDED = /^(workspace[^/]*\.json|workspaces\.json|cache|.*\.tmp)$/;

/**
 * Plugins whose settings describe this device rather than the vault, so their data.json stays
 * put even with plugin settings syncing. BRAT's list is of the beta plugins installed here: one
 * device's list replacing another's would drop plugins from it (including Tezca itself, which
 * never syncs its own code).
 */
const DEVICE_SETTINGS = new Set(["obsidian42-brat"]);

/**
 * Is `rel` (a path inside the config folder, e.g. "app.json" or "plugins/dataview/data.json")
 * synced under these categories? `ownPluginId` is never synced.
 */
export function configFileIncluded(rel: string, c: ConfigCategories, ownPluginId: string): boolean {
	if (ALWAYS_EXCLUDED.test(rel)) return false;
	const parts = rel.split("/");
	if (parts.length === 1) {
		const f = parts[0];
		if (!f.endsWith(".json")) return false;
		if (f === "appearance.json") return c.appearance;
		if (f === "hotkeys.json") return c.hotkeys;
		if (f === "community-plugins.json") return c.plugins;
		return c.core;
	}
	if (parts[0] === "themes" || parts[0] === "snippets") return c.appearance;
	if (parts[0] === "plugins" && parts.length === 3) {
		if (parts[1] === ownPluginId) return false;
		if (parts[2] === "data.json") return c.plugins && !DEVICE_SETTINGS.has(parts[1]);
		if (parts[2] === "main.js" || parts[2] === "manifest.json" || parts[2] === "styles.css") return c.pluginCode;
	}
	return false;
}

/** Could a folder inside the config folder contain synced files (so its folder entry is worth keeping)? */
export function configFolderIncluded(rel: string, c: ConfigCategories, ownPluginId: string): boolean {
	const parts = rel.split("/");
	if (parts[0] === "themes" || parts[0] === "snippets") return c.appearance;
	if (parts[0] === "plugins") return (c.plugins || c.pluginCode) && (parts.length === 1 || parts[1] !== ownPluginId);
	return false;
}

export function anyConfig(c: ConfigCategories): boolean {
	return c.core || c.appearance || c.hotkeys || c.plugins || c.pluginCode;
}
