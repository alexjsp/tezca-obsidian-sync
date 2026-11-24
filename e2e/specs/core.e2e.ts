// Two devices of one person: "mac" (desktop) and "phone" (mobile emulation), syncing one vault.
import assert from "node:assert/strict";
import { Device } from "../support/device";
import { claimHost, pairDevice } from "../support/flows";
import { TezcaServer } from "../support/server";
import { sleep, waitFor } from "../support/wait";

describe("core: two devices, one vault", function () {
	let server: TezcaServer;
	let mac: Device;
	let phone: Device;

	before(async function () {
		server = await TezcaServer.start();
		[mac, phone] = await Promise.all([Device.launch("mac"), Device.launch("phone", { mobile: true })]);
	});

	after(async function () {
		await mac?.quit();
		await phone?.quit();
		await server?.stop();
	});

	it("sets up through the settings UI: claim the host, then pair the phone", async function () {
		await claimHost(mac, server);
		await mac.write("Welcome.md", "# Welcome\n\nWritten on the mac before pairing.\n");
		await mac.waitSynced();
		await pairDevice(mac, phone);
		await phone.waitForFile("Welcome.md", "# Welcome\n\nWritten on the mac before pairing.\n");
		assert.equal((await phone.status()).conn, "online");
	});
});
