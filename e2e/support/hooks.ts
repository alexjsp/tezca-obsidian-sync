// Mocha root hooks: save screenshots + console logs of every open Obsidian when a test fails,
// and close any instances a spec left open.
import type { Context } from "mocha";
import { Device } from "./device";

export const mochaHooks = {
	async afterEach(this: Context) {
		const t = this.currentTest;
		if (t?.state !== "failed") return;
		for (const d of Device.live()) {
			const dir = await d.saveArtifacts(t.fullTitle());
			console.log(`    saved ${d.name} screenshot + log in ${dir}`);
		}
	},
	async afterAll() {
		for (const d of Device.live()) await d.quit();
	},
};
