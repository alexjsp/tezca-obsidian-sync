// Shared-folder management: members and roles, invites, leaving.
import { App, Modal, Notice, Setting } from "obsidian";
import type { SyncEngine } from "../core/engine";
import { b64u, fingerprint } from "../core/crypto";
import type { ShareInviteInfo, ShareRole } from "../core/setup";
import { SpaceRole } from "../proto/tezca/v1/sync_pb";
import { LinkModal, confirm } from "./modals";

const ROLE: Record<number, ShareRole> = { [SpaceRole.OWNER]: "owner", [SpaceRole.EDITOR]: "editor", [SpaceRole.VIEWER]: "viewer" };

function shortKey(pk: Uint8Array): string {
	return fingerprint(b64u(pk)).slice(0, 8);
}

export class ShareModal extends Modal {
	private off: (() => void) | null = null;

	constructor(
		app: App,
		private readonly engine: SyncEngine,
		private readonly spaceId: string,
	) {
		super(app);
	}

	onOpen() {
		this.off = this.engine.sharesChanged.on(() => void this.render());
		void this.render();
	}

	onClose() {
		this.off?.();
		this.contentEl.empty();
	}

	private async render() {
		const { contentEl } = this;
		const sh = this.engine.shares.get(this.spaceId);
		if (!sh) {
			contentEl.empty();
			contentEl.setText("This shared folder isn't mounted on this device any more.");
			return;
		}
		const name = sh.space.meta?.name ?? sh.mount;
		this.setTitle(`Shared folder: ${name}`);
		const myRole = this.engine.roleIn(this.spaceId);
		const isOwner = myRole === "owner";
		contentEl.empty();
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `Mounted at "${sh.mount}". You are ${myRole === "owner" ? "an owner" : `a${myRole === "editor" ? "n editor" : " viewer"}`}. Everything in it is end-to-end encrypted; the host can't read it.`,
		});

		contentEl.createEl("h4", { text: "Members" });
		for (const m of this.engine.members(this.spaceId)) {
			const label = `${m.name ?? `Member ${shortKey(m.signPk)}`}${m.isMe ? " (you)" : ""}`;
			// Names come from each member's profile in the shared folder; viewers can't write there.
			const unnamed = m.role === SpaceRole.VIEWER ? "View-only members' names aren't shown" : "Hasn't opened the shared folder yet";
			const s = new Setting(contentEl).setName(label).setDesc(m.name ? `Key ${shortKey(m.signPk)}` : `${unnamed} · key ${shortKey(m.signPk)}`);
			if (m.color) s.nameEl.style.color = m.color;
			if (isOwner && !m.isMe) {
				s.addDropdown((d) =>
					d
						.addOptions({ owner: "Owner", editor: "Editor", viewer: "Viewer" })
						.setValue(ROLE[m.role] ?? "editor")
						.onChange(async (v) => {
							try {
								await this.engine.setRole(this.spaceId, m.signPk, v as ShareRole);
								new Notice(`${label} is now ${v === "owner" ? "an owner" : `a${v === "editor" ? "n editor" : " viewer"}`}`);
							} catch (e) {
								new Notice(`Couldn't change the role: ${(e as Error).message}`);
								void this.render();
							}
						}),
				);
				s.addExtraButton((b) =>
					b
						.setIcon("user-minus")
						.setTooltip("Remove from this shared folder")
						.onClick(async () => {
							const ok = await confirm(
								this.app,
								`Remove ${label}?`,
								"They keep the copy they already have, but can't see any new changes. The folder's key is replaced so they can't read anything written from now on.",
								"Remove",
							);
							if (!ok) return;
							try {
								await this.engine.removeMember(this.spaceId, m.signPk);
								new Notice(`${label} was removed`);
							} catch (e) {
								new Notice(`Couldn't remove: ${(e as Error).message}`);
							}
						}),
				);
			} else s.addText((t) => t.setValue(ROLE[m.role] ?? "").setDisabled(true));
		}

		if (isOwner) {
			contentEl.createEl("h4", { text: "Invite someone" });
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: "Invites are single-use links that expire after 7 days. The person needs an account on this host (an admin can invite them from Tezca's settings).",
			});
			new Setting(contentEl)
				.setName("Create an invite link")
				.addButton((b) => b.setButtonText("Can edit").setCta().onClick(() => void this.invite("editor")))
				.addButton((b) => b.setButtonText("View only").onClick(() => void this.invite("viewer")));
			const list = contentEl.createDiv();
			void this.renderInvites(list);
		}

		contentEl.createEl("h4", { text: "Leave" });
		new Setting(contentEl)
			.setName("Leave this shared folder")
			.setDesc("Stops syncing it on all your devices. The files stay in your vault as private files.")
			.addButton((b) =>
				b
					.setButtonText("Leave")
					.setWarning()
					.onClick(async () => {
						if (!(await confirm(this.app, `Leave "${name}"?`, "The files stay in your vault as private files. You'd need a new invite to rejoin.", "Leave"))) return;
						try {
							await this.engine.leaveShare(this.spaceId);
							new Notice(`You left "${name}"`);
							this.close();
						} catch (e) {
							new Notice(`Couldn't leave: ${(e as Error).message}`);
						}
					}),
			);
	}

	private async invite(role: "editor" | "viewer") {
		try {
			const link = await this.engine.createInvite(this.spaceId, role);
			new LinkModal(
				this.app,
				`Invite to "${this.engine.shares.get(this.spaceId)?.space.meta?.name ?? "shared folder"}"`,
				`Send this link to the person you're inviting (${role === "editor" ? "they can edit" : "view only"}). It works once and expires in 7 days.`,
				link,
				"Anyone with this link can join until it's used. Send it privately.",
			).open();
			void this.render();
		} catch (e) {
			new Notice(`Couldn't create an invite: ${(e as Error).message}`);
		}
	}

	private async renderInvites(el: HTMLElement) {
		let invites: ShareInviteInfo[] = [];
		try {
			invites = await this.engine.shareApi.listInvites(this.spaceId);
		} catch {
			return;
		}
		const pending = invites.filter((i) => !i.redeemed_by && i.expires_at * 1000 > Date.now());
		for (const i of pending) {
			new Setting(el)
				.setName(`Pending invite (${i.role === "editor" ? "can edit" : "view only"})`)
				.setDesc(`Expires ${new Date(i.expires_at * 1000).toLocaleString()}`)
				.addButton((b) =>
					b.setButtonText("Revoke").onClick(async () => {
						try {
							await this.engine.shareApi.revokeInvite(this.spaceId, i.token);
							void this.render();
						} catch (e) {
							new Notice(`Couldn't revoke: ${(e as Error).message}`);
						}
					}),
				);
		}
	}
}
