// Setup flows through the plugin's real UI (settings tab, modals).
import type { Device } from "./device";
import type { TezcaServer } from "./server";

/** Paste a setup link into the "Set up with a link" form on an unconfigured device, and confirm it. */
export async function pasteSetupLink(d: Device, link: string) {
	await d.openSettings();
	await d.clickButton("Paste link");
	await d.submitForm("Connect to a Tezca host", link);
	await confirmLinkPrompt(d);
}

/** Accept the "which host is this link for" confirmation every setup link shows first. */
export async function confirmLinkPrompt(d: Device) {
	const m = await d.modal(/^(Claim this Tezca host|Connect to your account|Join )/);
	await d.click((await m.$(".setting-item button")) as unknown as WebdriverIO.Element);
	await d.browser.pause(300);
}

/** Claim a fresh host from `d` (becomes its admin, with a new synced vault). */
export async function claimHost(d: Device, server: TezcaServer, opts: { checkCopy?: boolean } = {}) {
	await pasteSetupLink(d, server.claimLink);
	await d.ackRecoveryKey(opts.checkCopy);
	await waitConfigured(d);
	await d.closeSettings();
	await d.waitSynced();
}

/** Pair `to` with `from`'s synced vault using "Pair device" in `from`'s settings. */
export async function pairDevice(from: Device, to: Device) {
	await from.openSettings();
	await from.clickButton("Pair device");
	const link = await from.takeLink("Pair another device");
	await from.closeSettings();
	const vault = await from.exec(({ plugins, app }) => plugins.tezcaSync.engine?.space?.meta?.name ?? app.vault.getName());
	await pasteSetupLink(to, link);
	// Pairing always shows the account's synced vaults; the one from the link is first.
	await to.choose("Choose a synced vault", vault);
	await waitConfigured(to);
	await to.closeSettings();
	await to.waitSynced();
}

/** `admin` invites `member` to the host; the member gets their own new synced vault. */
export async function inviteToHost(admin: Device, member: Device) {
	await admin.openSettings();
	await admin.clickButton("Create invite");
	const link = await admin.takeLink("Invite a member to this host");
	await admin.closeSettings();
	// Host invites are the host's invite page with the deep link in the fragment, pasted as is.
	if (!/^https?:\/\/[^#]+\/invite#do=join&host=[^&]+&token=[^&]+$/.test(link)) throw new Error(`unexpected host invite link: ${link}`);
	await pasteSetupLink(member, link);
	await member.ackRecoveryKey();
	await waitConfigured(member);
	await member.closeSettings();
	await member.waitSynced();
}

async function waitConfigured(d: Device) {
	await d.browser.waitUntil(async () => (await d.status()).configured, { timeout: 20_000, timeoutMsg: `${d.name} didn't connect` });
}

/**
 * Open a setup link on `d` (what Obsidian does when you open an obsidian://tezca?… URL). Takes the
 * deep link itself or an https://…/invite#… invite link, whose fragment holds the same params.
 */
export async function openDeepLink(d: Device, link: string) {
	const u = new URL(link);
	const params = Object.fromEntries(u.protocol === "obsidian:" ? u.searchParams : new URLSearchParams(u.hash.slice(1)));
	if (!params.do) throw new Error(`not a setup link: ${link}`);
	await d.exec(({ plugins }, params) => {
		void plugins.tezcaSync.handleDeepLink({ action: "tezca", ...params });
	}, params);
	await confirmLinkPrompt(d);
}

/** Set the name shown to others (settings → Profile → Edit…). */
export async function setDisplayName(d: Device, name: string) {
	await d.openSettings();
	await d.clickButton("Edit profile");
	await fillProfile(d, "Your profile", name);
	await d.closeSettings();
}

/** Fill in the profile screen (welcome or edit) and save. */
export async function fillProfile(d: Device, title: string, name: string, color?: string) {
	const m = await d.modal(title);
	const input = await m.$("input.tezca-profile-name");
	await input.clearValue();
	await input.setValue(name);
	if (color) await d.click((await m.$(`.tezca-swatch[data-color="${color}"]`)) as unknown as WebdriverIO.Element);
	await d.clickButton("Save", m);
	await d.noModal(title);
}

/** A tiny real community plugin (for plugin tests): sets window.__<id> when it loads. */
export function dummyPlugin(id: string, name: string) {
	const flag = `__${id.replace(/\W/g, "_")}`;
	return {
		manifest: { id, name, version: "1.0.0", minAppVersion: "1.0.0", description: "Test plugin", author: "e2e", isDesktopOnly: false },
		mainJs: `const { Plugin } = require("obsidian");\nmodule.exports = class extends Plugin {\n\tonload() { window.${flag} = true; }\n\tonunload() { delete window.${flag}; }\n};\n`,
		flag,
	};
}

/** Install and enable a plugin from its files, the way Obsidian does after a download. */
export async function installPluginFiles(d: Device, p: ReturnType<typeof dummyPlugin>) {
	await d.exec(
		async ({ app }, manifest, mainJs) => {
			const dir = `${app.vault.configDir}/plugins/${manifest.id}`;
			await app.vault.adapter.mkdir(dir);
			await app.vault.adapter.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, "\t"));
			await app.vault.adapter.write(`${dir}/main.js`, mainJs);
			await app.plugins.loadManifests();
			await app.plugins.enablePluginAndSave(manifest.id);
		},
		p.manifest,
		p.mainJs,
	);
}
