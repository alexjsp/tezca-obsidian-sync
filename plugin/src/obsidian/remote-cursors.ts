// Other people's cursors and selections in the editor, with their profile picture (or initial).
// Adapted from y-codemirror.next's y-remote-selections (MIT, Kevin Jahns): same awareness handling,
// different caret widget.
import { Annotation, RangeSet, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { ySyncFacet } from "y-codemirror.next";

/** Someone's presence as sent in awareness: name, colour and their key (to look up a picture). */
export interface CursorUser {
	name?: string;
	color?: string;
	colorLight?: string;
	pk?: string;
}

/** Look up a profile picture (data URL) for a user, or null. */
export type AvatarLookup = (user: CursorUser) => string | null;

const refresh = Annotation.define<null>();

class CaretWidget extends WidgetType {
	constructor(
		readonly color: string,
		readonly name: string,
		readonly avatar: string | null,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const caret = document.createElement("span");
		caret.className = "tezca-caret";
		caret.style.borderColor = this.color;
		caret.append("⁠");
		const badge = document.createElement("span");
		badge.className = "tezca-caret-badge";
		badge.style.backgroundColor = this.color;
		badge.style.borderColor = this.color;
		if (this.avatar) {
			const img = document.createElement("img");
			img.src = this.avatar;
			img.alt = "";
			badge.append(img);
		} else badge.dataset.initial = (this.name.trim()[0] ?? "?").toUpperCase();
		const label = document.createElement("span");
		label.className = "tezca-caret-name";
		label.style.backgroundColor = this.color;
		label.textContent = this.name;
		caret.append(badge, label, "⁠");
		return caret;
	}

	eq(other: CaretWidget): boolean {
		return other.color === this.color && other.name === this.name && other.avatar === this.avatar;
	}

	get estimatedHeight(): number {
		return -1;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Remote cursors and selections; `avatarFor` supplies profile pictures. */
export function remoteCursors(avatarFor: AvatarLookup) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = RangeSet.of([]);
			private readonly conf;
			private readonly listener: (ch: { added: number[]; updated: number[]; removed: number[] }) => void;

			constructor(readonly view: EditorView) {
				this.conf = view.state.facet(ySyncFacet);
				this.listener = ({ added, updated, removed }) => {
					const me = this.conf.awareness.doc.clientID;
					if ([...added, ...updated, ...removed].some((id) => id !== me)) view.dispatch({ annotations: [refresh.of(null)] });
				};
				this.conf.awareness.on("change", this.listener);
			}

			destroy() {
				this.conf.awareness.off("change", this.listener);
			}

			update(update: ViewUpdate) {
				const { ytext, awareness } = this.conf;
				const ydoc = ytext.doc as Y.Doc;
				const local = awareness.getLocalState();
				// Publish our own cursor.
				if (local != null) {
					const hasFocus = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
					const sel = hasFocus ? update.state.selection.main : null;
					const cur = local.cursor as { anchor: unknown; head: unknown } | null | undefined;
					if (sel != null) {
						const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
						const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
						if (
							cur == null ||
							!Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.anchor), anchor) ||
							!Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.head), head)
						)
							awareness.setLocalStateField("cursor", { anchor, head });
					} else if (cur != null && hasFocus) awareness.setLocalStateField("cursor", null);
				}
				// Draw everyone else's.
				const decos: Range<Decoration>[] = [];
				awareness.getStates().forEach((state: Record<string, unknown>, clientId: number) => {
					if (clientId === awareness.doc.clientID) return;
					const cursor = state.cursor as { anchor?: unknown; head?: unknown } | undefined;
					if (!cursor?.anchor || !cursor.head) return;
					const anchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor as Y.RelativePosition, ydoc);
					const head = Y.createAbsolutePositionFromRelativePosition(cursor.head as Y.RelativePosition, ydoc);
					if (!anchor || !head || anchor.type !== ytext || head.type !== ytext) return;
					const user = (state.user ?? {}) as CursorUser;
					const color = user.color ?? "#30bced";
					const name = user.name ?? "Someone";
					const light = user.colorLight ?? color + "33";
					const docLen = update.view.state.doc.length;
					const start = Math.min(anchor.index, head.index, docLen);
					const end = Math.min(Math.max(anchor.index, head.index), docLen);
					const mark = Decoration.mark({ attributes: { style: `background-color: ${light}` }, class: "tezca-remote-selection" });
					const startLine = update.view.state.doc.lineAt(start);
					const endLine = update.view.state.doc.lineAt(end);
					if (start !== end) {
						if (startLine.number === endLine.number) decos.push(mark.range(start, end));
						else {
							decos.push(mark.range(start, startLine.to));
							decos.push(mark.range(endLine.from, end));
							for (let i = startLine.number + 1; i < endLine.number; i++) {
								const from = update.view.state.doc.line(i).from;
								decos.push(Decoration.line({ attributes: { style: `background-color: ${light}` } }).range(from));
							}
						}
					}
					const at = Math.min(head.index, docLen);
					decos.push(
						Decoration.widget({ side: head.index - anchor.index > 0 ? -1 : 1, widget: new CaretWidget(color, name, avatarFor(user)) }).range(at),
					);
				});
				this.decorations = Decoration.set(decos, true);
			}
		},
		{ decorations: (v) => v.decorations },
	);
}
