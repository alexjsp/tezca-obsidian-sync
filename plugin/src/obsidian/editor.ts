// Binds open Markdown editors (CodeMirror 6) to their Y.Text, with encrypted presence/cursors.
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import type { DocSync } from "../core/doc-sync";
import { textOf } from "../core/mirror";
import type { SyncEngine } from "../core/engine";
import { log } from "../core/util";

const collabCompartment = new Compartment();

/** Remote edits must not enter the local undo history. */
const remoteNotUndoable = EditorState.transactionExtender.of((tr) =>
	tr.annotation(ySyncAnnotation) !== undefined ? { annotations: Transaction.addToHistory.of(false) } : null,
);

export interface PresenceUser {
	name: string;
	color: string;
}

interface Binding {
	view: EditorView;
	path: string;
	docId: string;
	doc: DocSync | null;
	generation: number;
}

export class EditorBindings {
	private bindings = new Map<EditorView, Binding>();
	private generation = 0;

	constructor(
		private readonly getEngine: () => SyncEngine | null,
		private readonly getUser: () => PresenceUser,
	) {}

	/** Editor extension to register with `plugin.registerEditorExtension`. */
	extension(): Extension {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const mgr = this;
		return [
			collabCompartment.of([]),
			remoteNotUndoable,
			ViewPlugin.fromClass(
				class implements PluginValue {
					constructor(readonly view: EditorView) {
						queueMicrotask(() => mgr.refresh(view));
					}
					update(u: ViewUpdate) {
						const path = mgr.pathOf(u.view);
						const b = mgr.bindings.get(u.view);
						if ((b?.path ?? null) !== path) queueMicrotask(() => mgr.refresh(u.view));
					}
					destroy() {
						mgr.unbind(this.view, false);
					}
				},
			),
		];
	}

	pathOf(view: EditorView): string | null {
		try {
			return view.state.field(editorInfoField, false)?.file?.path ?? null;
		} catch {
			return null;
		}
	}

	isBound(path: string): boolean {
		for (const b of this.bindings.values()) if (b.path === path && b.doc) return true;
		return false;
	}

	/** Re-evaluate every open editor (e.g. after the engine starts). */
	refreshAll(): void {
		for (const view of [...this.bindings.keys()]) void this.refresh(view);
	}

	/** Rebind all views known to the workspace. */
	rebindViews(views: EditorView[]): void {
		for (const v of views) void this.refresh(v);
	}

	async refresh(view: EditorView): Promise<void> {
		const path = this.pathOf(view);
		const cur = this.bindings.get(view);
		// Already bound, or a bind for this path is in flight. Tearing down an in-flight bind here used to
		// dispatch -> ViewPlugin.update -> queue another refresh -> tear down this one, forever (a microtask loop
		// that froze the window).
		if (cur && cur.path === path) return;
		if (cur) this.unbind(view, true);
		const engine = this.getEngine();
		const mirror = engine?.mirror;
		const space = engine?.space;
		if (!path || !engine || !mirror || !space || !mirror.isReady) return;
		const gen = ++this.generation;
		const placeholder: Binding = { view, path, docId: "", doc: null, generation: gen };
		this.bindings.set(view, placeholder);
		try {
			const docId = await mirror.ensureEntry(path);
			if (!docId || this.bindings.get(view) !== placeholder) return this.dropPlaceholder(view, placeholder);
			const doc = await space.acquireSynced(docId, 3000);
			if (this.bindings.get(view) !== placeholder || this.pathOf(view) !== path) {
				space.release(docId);
				return this.dropPlaceholder(view, placeholder);
			}
			const ytext = textOf(doc);
			const editorText = view.state.doc.toString();
			const target = await mirror.reconcileEditorText(docId, path, editorText);
			if (this.bindings.get(view) !== placeholder) {
				space.release(docId);
				return;
			}
			const current = view.state.doc.toString();
			if (current !== target) {
				view.dispatch({ changes: minimalChange(current, target), annotations: Transaction.addToHistory.of(false) });
			}
			const awareness = doc.getAwareness();
			const user = this.getUser();
			awareness.setLocalStateField("user", { name: user.name, color: user.color, colorLight: user.color + "33" });
			view.dispatch({ effects: collabCompartment.reconfigure(yCollab(ytext, awareness, { undoManager: false })) });
			placeholder.docId = docId;
			placeholder.doc = doc;
			log.debug(`bound editor to ${path}`);
		} catch (e) {
			log.warn(`could not bind editor for ${path}`, e);
			this.dropPlaceholder(view, placeholder);
		}
	}

	private dropPlaceholder(view: EditorView, b: Binding) {
		if (this.bindings.get(view) === b) this.bindings.delete(view);
	}

	unbind(view: EditorView, reconfigure: boolean): void {
		const b = this.bindings.get(view);
		if (!b) return;
		this.bindings.delete(view);
		// A placeholder (bind in flight) never configured the compartment, so there is nothing to dispatch.
		if (reconfigure && b.doc) {
			try {
				view.dispatch({ effects: collabCompartment.reconfigure([]) });
			} catch {
				/* view destroyed */
			}
		}
		const engine = this.getEngine();
		if (b.doc && engine?.space) {
			const stillUsed = [...this.bindings.values()].some((o) => o.docId === b.docId && o.doc);
			if (!stillUsed) b.doc.releaseAwareness();
			engine.space.release(b.docId);
			engine.mirror?.afterUnbind(b.path);
		}
	}

	unbindAll(): void {
		for (const view of [...this.bindings.keys()]) this.unbind(view, true);
	}

	updateUser(): void {
		const user = this.getUser();
		for (const b of this.bindings.values()) {
			b.doc?.getAwareness().setLocalStateField("user", { name: user.name, color: user.color, colorLight: user.color + "33" });
		}
	}
}

/** One change spec turning `a` into `b` (common prefix/suffix trimmed, keeps cursors stable). */
function minimalChange(a: string, b: string) {
	let start = 0;
	while (start < a.length && start < b.length && a.charCodeAt(start) === b.charCodeAt(start)) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--;
		endB--;
	}
	return { from: start, to: endA, insert: b.slice(start, endB) };
}
