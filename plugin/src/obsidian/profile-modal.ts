// "How others see you": name, colour and picture. Shown once when Tezca is first installed on a
// device (and from settings), so people don't appear as a device name or a key.
import { App, ColorComponent, Modal, Notice, Setting } from "obsidian";
import { pickImage, renderAvatar, toAvatar } from "./avatar";

export interface Profile {
	name: string;
	color: string;
	/** Data URL, null for none, undefined for unchanged. */
	avatar?: string | null;
}

export const PROFILE_COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e03131", "#5c7cfa"];

export class ProfileModal extends Modal {
	private name: string;
	private color: string;
	private avatar: string | null;
	private avatarChanged = false;
	private saved = false;
	private previewEl!: HTMLElement;
	private swatchesEl!: HTMLElement;

	constructor(
		app: App,
		current: { name: string; color: string; avatar: string | null },
		private readonly opts: { welcome: boolean; save: (p: Profile) => void | Promise<void>; onClose?: (saved: boolean) => void },
	) {
		super(app);
		this.name = current.name;
		this.color = current.color;
		this.avatar = current.avatar;
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("tezca-profile-modal");
		this.setTitle(this.opts.welcome ? "Welcome to Tezca" : "Your profile");
		contentEl.createEl("p", {
			cls: "tezca-profile-intro",
			text: "Choose how you appear next to your cursor and to the people you share folders with. You can change this any time in Tezca's settings.",
		});

		// Live preview: the cursor badge others will see.
		const preview = contentEl.createDiv({ cls: "tezca-profile-preview" });
		this.previewEl = preview.createSpan();
		const line = preview.createDiv({ cls: "tezca-profile-preview-line" });
		line.createSpan({ text: "Others see you here" });

		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("Your name")
				.setValue(this.name)
				.onChange((v) => {
					this.name = v;
					this.refresh();
				});
			t.inputEl.addClass("tezca-profile-name");
			window.setTimeout(() => t.inputEl.focus(), 50);
		});

		const colour = new Setting(contentEl).setName("Colour");
		this.swatchesEl = colour.controlEl.createDiv({ cls: "tezca-swatches" });
		let picker: ColorComponent | null = null;
		for (const c of PROFILE_COLORS) {
			const b = this.swatchesEl.createEl("button", { cls: "tezca-swatch", attr: { "aria-label": `Colour ${c}`, "data-color": c } });
			b.style.backgroundColor = c;
			b.onclick = () => {
				this.color = c;
				picker?.setValue(c);
				this.refresh();
			};
		}
		colour.addColorPicker((p) => {
			picker = p;
			p.setValue(this.color).onChange((v) => {
				this.color = v;
				this.refresh();
			});
		});

		const pic = new Setting(contentEl).setName("Picture").setDesc("Optional. A small square image works best.");
		pic.addButton((b) =>
			b.setButtonText("Choose…").onClick(async () => {
				const file = await pickImage(contentEl.ownerDocument);
				if (!file) return;
				try {
					this.avatar = await toAvatar(file, contentEl.ownerDocument);
					this.avatarChanged = true;
					this.refresh();
				} catch (e) {
					new Notice(`Tezca: ${(e as Error).message}`);
				}
			}),
		);
		pic.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("Remove picture")
				.onClick(() => {
					this.avatar = null;
					this.avatarChanged = true;
					this.refresh();
				}),
		);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(this.opts.welcome ? "Later" : "Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						const name = this.name.trim();
						if (!name) {
							new Notice("Please enter a name.");
							return;
						}
						await this.opts.save({ name, color: this.color, ...(this.avatarChanged ? { avatar: this.avatar } : {}) });
						this.saved = true;
						this.close();
					}),
			);
		this.refresh();
	}

	private refresh() {
		renderAvatar(this.previewEl, { name: this.name.trim() || "?", color: this.color, avatar: this.avatar });
		this.previewEl.addClass("tezca-avatar-large");
		const chip = this.previewEl.parentElement!.querySelector(".tezca-profile-preview-line span") as HTMLElement;
		chip.setText(this.name.trim() || "Your name");
		chip.style.backgroundColor = this.color;
		for (const s of Array.from(this.swatchesEl.children) as HTMLElement[]) s.toggleClass("is-active", s.dataset.color === this.color);
	}

	onClose() {
		this.contentEl.empty();
		this.opts.onClose?.(this.saved);
	}
}
