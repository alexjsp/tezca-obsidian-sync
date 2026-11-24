import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import qrcode from "qrcode-generator";

/**
 * Copy text to the clipboard from a UI element. Writes through Electron's clipboard on desktop
 * (navigator.clipboard refuses when the document isn't focused, e.g. a dialog in the Settings
 * window copying via the main window), else the element's own window, else select-and-copy.
 */
export async function copyText(text: string, from: HTMLElement): Promise<boolean> {
	try {
		const electron = (window as unknown as { require?: (m: string) => { clipboard?: { writeText(t: string): void } } }).require?.("electron");
		if (electron?.clipboard) {
			electron.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* not desktop */
	}
	const win = (from as HTMLElement & { win?: Window }).win ?? window;
	try {
		await win.navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through */
	}
	const doc = from.ownerDocument;
	const ta = doc.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	doc.body.appendChild(ta);
	ta.select();
	const ok = doc.execCommand("copy");
	ta.remove();
	return ok;
}

export function qrSvg(text: string, cell = 4): string {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

/** Shows a link as a QR code + copy button. */
export class LinkModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly link: string,
		private readonly warning?: string,
	) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.setTitle(this.title);
		contentEl.createEl("p", { text: this.description });
		const qr = contentEl.createDiv({ cls: "tezca-qr" });
		// qrcode-generator output is a self-contained SVG built from our own link text.
		qr.innerHTML = qrSvg(this.link);
		const code = contentEl.createEl("textarea", { cls: "tezca-link", text: this.link });
		code.readOnly = true;
		code.rows = 3;
		if (this.warning) contentEl.createEl("p", { cls: "tezca-warning", text: this.warning });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Copy link")
				.setCta()
				.onClick(async () => {
					new Notice((await copyText(this.link, this.contentEl)) ? "Link copied" : "Couldn't copy: select the link and copy it");
				}),
		);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Displays the recovery phrase and requires acknowledgement. */
export class RecoveryPhraseModal extends Modal {
	constructor(
		app: App,
		private readonly phrase: string,
		private readonly onDone: () => void = () => undefined,
	) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.setTitle("Your recovery phrase");
		contentEl.createEl("p", {
			text: "Everything you sync is end-to-end encrypted. These 24 words are the only way to restore access if you lose all of your devices. Write them down and keep them somewhere safe. Tezca cannot recover them for you.",
		});
		const grid = contentEl.createDiv({ cls: "tezca-phrase" });
		this.phrase.split(" ").forEach((w, i) => grid.createDiv({ text: `${i + 1}. ${w}` }));
		const copy = contentEl.createEl("button", { cls: "tezca-copy-phrase" });
		const icon = copy.createSpan({ cls: "tezca-copy-icon" });
		setIcon(icon, "copy");
		const label = copy.createSpan({ text: "Copy recovery phrase" });
		copy.onclick = async () => {
			if (await copyText(this.phrase, contentEl)) {
				setIcon(icon, "check");
				label.setText("Copied. Paste it somewhere safe, then clear your clipboard.");
				copy.addClass("is-copied");
			} else new Notice("Couldn't copy. Select the words and copy them instead.");
		};
		let ack = false;
		new Setting(contentEl)
			.setName("I have saved my recovery phrase")
			.addToggle((t) => t.onChange((v) => (ack = v)));
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Done")
				.setCta()
				.onClick(() => {
					if (!ack) {
						new Notice("Please confirm you've saved the phrase first.");
						return;
					}
					this.close();
				}),
		);
	}
	onClose() {
		this.contentEl.empty();
		this.onDone();
	}
}

/** Generic single-choice picker. */
export class ChoiceModal<T> extends Modal {
	private chosen = false;
	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly choices: { label: string; detail?: string; value: T; cta?: boolean }[],
		private readonly resolve: (v: T | null) => void,
	) {
		super(app);
	}
	onOpen() {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.description });
		for (const c of this.choices) {
			new Setting(this.contentEl)
				.setName(c.label)
				.setDesc(c.detail ?? "")
				.addButton((b) => {
					b.setButtonText("Choose").onClick(() => {
						this.chosen = true;
						this.close();
						this.resolve(c.value);
					});
					if (c.cta) b.setCta();
				});
		}
	}
	onClose() {
		this.contentEl.empty();
		if (!this.chosen) this.resolve(null);
	}
}

export function choose<T>(app: App, title: string, description: string, choices: { label: string; detail?: string; value: T; cta?: boolean }[]): Promise<T | null> {
	return new Promise((r) => new ChoiceModal(app, title, description, choices, r).open());
}

/** Text prompt with one or more fields. */
export class FormModal extends Modal {
	private submitted = false;
	private values: Record<string, string> = {};
	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly fields: { key: string; name: string; desc?: string; placeholder?: string; value?: string; multiline?: boolean }[],
		private readonly submitText: string,
		private readonly resolve: (v: Record<string, string> | null) => void,
	) {
		super(app);
	}
	onOpen() {
		this.setTitle(this.title);
		if (this.description) this.contentEl.createEl("p", { text: this.description });
		for (const f of this.fields) {
			this.values[f.key] = f.value ?? "";
			const s = new Setting(this.contentEl).setName(f.name).setDesc(f.desc ?? "");
			if (f.multiline)
				s.addTextArea((t) => {
					t.setPlaceholder(f.placeholder ?? "").setValue(f.value ?? "").onChange((v) => (this.values[f.key] = v));
					t.inputEl.rows = 4;
				});
			else s.addText((t) => t.setPlaceholder(f.placeholder ?? "").setValue(f.value ?? "").onChange((v) => (this.values[f.key] = v)));
		}
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(this.submitText)
				.setCta()
				.onClick(() => {
					this.submitted = true;
					this.close();
					this.resolve(this.values);
				}),
		);
	}
	onClose() {
		this.contentEl.empty();
		if (!this.submitted) this.resolve(null);
	}
}

export function form(
	app: App,
	title: string,
	description: string,
	fields: { key: string; name: string; desc?: string; placeholder?: string; value?: string; multiline?: boolean }[],
	submitText = "Continue",
): Promise<Record<string, string> | null> {
	return new Promise((r) => new FormModal(app, title, description, fields, submitText, r).open());
}

export function confirm(app: App, title: string, message: string, ok = "Continue"): Promise<boolean> {
	return choose(app, title, message, [{ label: ok, value: true, cta: true }]).then((v) => v === true);
}
