// Presence data (names, colours, pictures) comes from other people: validate before display.

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** A hex colour (#rrggbb or #rrggbbaa), or `fallback`. Never put an unchecked colour into CSS. */
export function safeColor(c: unknown, fallback: string): string {
	return typeof c === "string" && HEX.test(c) ? c : fallback;
}

/** Longest profile picture accepted (data URL characters). */
export const MAX_AVATAR_CHARS = 24_000;

/** A profile picture as Tezca makes them (a small base64 JPEG or PNG data URL), or null. */
export function safeAvatar(a: unknown): string | null {
	if (typeof a !== "string" || a.length > MAX_AVATAR_CHARS) return null;
	return /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(a) ? a : null;
}

/** A display name: plain text, trimmed, at most 64 characters. */
export function safeName(n: unknown): string | undefined {
	if (typeof n !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const s = n.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
	return s || undefined;
}
