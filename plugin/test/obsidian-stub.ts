// Test stand-in for the parts of the `obsidian` module the plugin uses at runtime in tests
// (the real package ships types only). Aliased in vitest.config.ts.
import { StateEffect, StateField } from "@codemirror/state";

/** Test-only: sets which file the editor shows. */
export const setFile = StateEffect.define<string | null>();

export const editorInfoField = StateField.define<{ file: { path: string } | null }>({
	create: () => ({ file: null }),
	update: (v, tr) => {
		for (const e of tr.effects) if (e.is(setFile)) return { file: e.value ? { path: e.value } : null };
		return v;
	},
});
