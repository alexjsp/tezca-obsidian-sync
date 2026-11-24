// Setup flows through the plugin's real UI (settings tab, modals).
import type { Device } from "./device";
import type { TezcaServer } from "./server";

/** Paste a setup link into the "Set up with a link" form on an unconfigured device. */
export async function pasteSetupLink(d: Device, link: string) {
	await d.openSettings();
	await d.clickButton("Paste link");
	await d.submitForm("Connect to a Tezca host", link);
}

/** Claim a fresh host from `d` (becomes its admin, with a new synced vault). */
export async function claimHost(d: Device, server: TezcaServer, opts: { checkCopy?: boolean } = {}) {
	await pasteSetupLink(d, server.claimLink);
	await d.ackRecoveryPhrase(opts.checkCopy);
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
	await pasteSetupLink(to, link);
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
	await pasteSetupLink(member, link);
	await member.ackRecoveryPhrase();
	await waitConfigured(member);
	await member.closeSettings();
	await member.waitSynced();
}

async function waitConfigured(d: Device) {
	await d.browser.waitUntil(async () => (await d.status()).configured, { timeout: 20_000, timeoutMsg: `${d.name} didn't connect` });
}

/** Open a tezca:// deep link on `d` (what Obsidian does when you open an obsidian://tezca?… URL). */
export async function openDeepLink(d: Device, link: string) {
	const params = Object.fromEntries(new URL(link.replace(/^obsidian:\/\/tezca\??/, "http://x/?")).searchParams);
	await d.exec(({ plugins }, params) => {
		void plugins.tezcaSync.handleDeepLink({ action: "tezca", ...params });
	}, params);
}

/** Set the presence name shown to others (settings → Display name). */
export async function setDisplayName(d: Device, name: string) {
	await d.openSettings();
	const row = await d.settingRow("Display name");
	await row.$("input").setValue(name);
	await d.closeSettings();
}
