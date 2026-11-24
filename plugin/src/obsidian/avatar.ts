// Profile pictures: pick an image, crop it to a small square and encode it as a data URL.

/** Pixel size of the stored picture (shown at up to ~24px, so 2x is plenty). */
const SIZE = 64;
/** Largest data URL we store (it's copied into every shared folder's member list). */
export const MAX_AVATAR_CHARS = 24_000;

/** Ask the user for an image file (works with the phone's photo picker too). */
export function pickImage(doc: Document = document): Promise<File | null> {
	return new Promise((resolve) => {
		const input = doc.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.style.display = "none";
		input.onchange = () => {
			resolve(input.files?.[0] ?? null);
			input.remove();
		};
		doc.body.appendChild(input);
		input.click();
	});
}

/** Centre-crop to a square, scale to SIZE and encode as JPEG. */
export async function toAvatar(file: Blob, doc: Document = document): Promise<string> {
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = doc.createElement("img");
			i.onload = () => resolve(i);
			i.onerror = () => reject(new Error("That file isn't an image Obsidian can open."));
			i.src = url;
		});
		const side = Math.min(img.naturalWidth, img.naturalHeight);
		if (!side) throw new Error("That image is empty.");
		const canvas = doc.createElement("canvas");
		canvas.width = canvas.height = SIZE;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Couldn't process the image.");
		ctx.fillStyle = "#fff"; // transparent PNGs get a white background in JPEG
		ctx.fillRect(0, 0, SIZE, SIZE);
		ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
		for (const q of [0.85, 0.7, 0.5]) {
			const data = canvas.toDataURL("image/jpeg", q);
			if (data.length <= MAX_AVATAR_CHARS) return data;
		}
		throw new Error("Couldn't make that image small enough.");
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** A round avatar: the picture, or the name's initial on the colour. */
export function renderAvatar(el: HTMLElement, p: { name: string; color: string; avatar?: string | null }) {
	el.empty();
	el.addClass("tezca-avatar");
	el.style.backgroundColor = p.color;
	if (p.avatar) el.createEl("img", { attr: { src: p.avatar, alt: "" } });
	else el.setText((p.name.trim()[0] ?? "?").toUpperCase());
	el.setAttr("title", p.name);
}
