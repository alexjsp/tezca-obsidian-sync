// Text diffing helpers: apply a full-text change to a Y.Text as minimal ops, and three-way merge.
import diff from "fast-diff";
import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

/** Mutate `ytext` so its content becomes `next`, using minimal insert/delete ops. */
export function applyTextDiff(ytext: Y.Text, next: string, origin?: unknown): boolean {
	const cur = ytext.toString();
	if (cur === next) return false;
	const ops = diff(cur, next);
	const apply = () => {
		let idx = 0;
		for (const [op, text] of ops) {
			if (op === diff.EQUAL) idx += text.length;
			else if (op === diff.DELETE) ytext.delete(idx, text.length);
			else {
				ytext.insert(idx, text);
				idx += text.length;
			}
		}
	};
	if (ytext.doc) ytext.doc.transact(apply, origin);
	else apply();
	return true;
}

export interface MergeResult {
	text: string;
	/** false if some of `local`'s changes could not be placed cleanly. */
	clean: boolean;
}

/**
 * Three-way merge: apply the changes base→local onto `current`.
 * Used when disk (local) and CRDT (current) both diverged from the last synced baseline.
 */
export function threeWayMerge(base: string, local: string, current: string): MergeResult {
	if (local === current) return { text: current, clean: true };
	if (base === current) return { text: local, clean: true };
	if (base === local) return { text: current, clean: true };
	const dmp = new DiffMatchPatch();
	dmp.Match_Threshold = 0.25;
	dmp.Patch_DeleteThreshold = 0.25;
	const patches = dmp.patch_make(base, local);
	const [text, results] = dmp.patch_apply(patches, current) as [string, boolean[]];
	return { text, clean: results.every(Boolean) };
}
