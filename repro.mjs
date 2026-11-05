import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccessToken } from 'livekit-server-sdk';
import { chromium } from 'playwright';

const url = process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880';
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
// --listen publishes the tones and prints a link to listen.html, to test any browser by ear.
const listenMode = process.argv.includes('--listen');
const listenPage = process.env.LISTEN_PAGE;
const headed = process.env.HEADED === '1' && !listenMode;
// livekit-client's "require" entry is its UMD bundle.
const clientUmd = process.env.LK_CLIENT_UMD ?? createRequire(import.meta.url).resolve('livekit-client');
const listenMs = headed ? 8000 : 5000;
// Chrome's audio level of the played-out samples, 0 to 1. The tones are published at 0.3.
const AUDIBLE_LEVEL = 0.01;

const scenarios = {
	'other-audio-playing': {
		description: 'stop rendering the sandbox audio while the client audio keeps playing',
		withClient: true,
		clearSrcObjectFirst: false,
	},
	'no-other-audio': {
		description: 'stop rendering the sandbox audio when nothing else is playing',
		withClient: false,
		clearSrcObjectFirst: false,
	},
	'srcObject-cleared-first': {
		description: 'same as other-audio-playing, with srcObject cleared before detach (the fix)',
		withClient: true,
		clearSrcObjectFirst: true,
	},
};
const selected = process.env.SCENARIOS?.split(',') ?? Object.keys(scenarios);

const files = {
	'/': ['index.html', 'text/html'],
	'/index.html': ['index.html', 'text/html'],
	'/listen.html': ['listen.html', 'text/html'],
	'/participant.js': ['participant.js', 'text/javascript'],
};
const server = createServer(async (req, res) => {
	const path = new URL(req.url, 'http://localhost').pathname;
	if (path === '/livekit-client.umd.js') {
		res.setHeader('content-type', 'text/javascript');
		res.end(await readFile(clientUmd));
	} else if (files[path]) {
		const [file, contentType] = files[path];
		res.setHeader('content-type', contentType);
		res.end(await readFile(new URL(`./${file}`, import.meta.url)));
	} else {
		res.statusCode = 404;
		res.end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
	headless: !headed,
	args: ['--autoplay-policy=no-user-gesture-required', ...(headed ? [] : ['--mute-audio'])],
});

const createToken = (room, identity, { ttl, ...grant } = {}) => {
	const token = new AccessToken(apiKey, apiSecret, { identity, ttl });
	token.addGrant({ roomJoin: true, room, ...grant });
	return token.toJwt();
};

// Each participant gets its own browser context, like separate devices.
const join = async (room, identity, { autoSubscribe }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => console.error(`[${identity}]`, error));
	await page.goto(pageUrl);
	const token = await createToken(room, identity);
	await page.evaluate((options) => window.join(options), { url, token, autoSubscribe });
	return page;
};

const sampleStats = (page, identities) =>
	page.evaluate((ids) => Promise.all(ids.map((id) => window.receiverStats(id))), identities);

// Average played-out audio level, packets received and seconds of samples pulled for playout,
// per identity, over ms. totalAudioEnergy is the sum of audioLevel² × duration.
const measure = async (page, identities, ms) => {
	const before = await sampleStats(page, identities);
	await sleep(ms);
	const after = await sampleStats(page, identities);
	return Object.fromEntries(
		identities.map((identity, i) => {
			const pulledSeconds = after[i].totalSamplesDuration - before[i].totalSamplesDuration;
			const energy = after[i].totalAudioEnergy - before[i].totalAudioEnergy;
			return [
				identity,
				{
					level: pulledSeconds > 0 ? Math.sqrt(Math.max(0, energy) / pulledSeconds) : 0,
					packets: after[i].packetsReceived - before[i].packetsReceived,
					pulledSeconds,
				},
			];
		}),
	);
};

const run = async (name) => {
	const { withClient, clearSrcObjectFirst } = scenarios[name];
	const room = `detach-audio-${randomUUID().slice(0, 8)}`;
	const pages = [];
	try {
		// The listener subscribes to everyone, as a viewer does. The publishers only publish.
		const listener = await join(room, 'listener', { autoSubscribe: true });
		pages.push(listener);

		// "sandbox" stands in for a participant whose audio the app stops rendering while it
		// keeps publishing, for example a screen share or a shared activity that gets hidden.
		const sandbox = await join(room, 'sandbox', { autoSubscribe: false });
		pages.push(sandbox);
		await sandbox.evaluate(() => window.publishTone({ frequency: 440, name: 'sandbox' }));
		const identities = ['sandbox'];

		if (withClient) {
			const client = await join(room, 'client', { autoSubscribe: false });
			pages.push(client);
			await client.evaluate(() => window.publishTone({ frequency: 660, name: 'client' }));
			identities.push('client');
		}

		for (const identity of identities) {
			await listener.waitForFunction((id) => window.hasAudioTrack(id), identity);
			await listener.evaluate((id) => window.render(id), identity);
		}

		// Let the jitter buffers fill before measuring.
		await sleep(2000);
		const rendered = await measure(listener, identities, 3000);

		await listener.evaluate(
			({ id, clearSrcObjectFirst }) => window.stopRendering(id, { clearSrcObjectFirst }),
			{ id: 'sandbox', clearSrcObjectFirst },
		);
		await sleep(500);
		const stopped = await measure(listener, identities, listenMs);

		return { name, rendered, stopped };
	} finally {
		await Promise.all(pages.map((page) => page.context().close()));
	}
};

const format = (label, { level, packets, pulledSeconds }) =>
	`  ${label.padEnd(29)} level ${level.toFixed(3)}, ${packets} packets, ${pulledSeconds.toFixed(1)} s pulled for playout`;

const runScenarios = async () => {
	console.log(`livekit-client from ${clientUmd}`);
	console.log(`LiveKit server ${url}\n`);
	for (const name of selected) {
		const { rendered, stopped } = await run(name);
		console.log(`${name}: ${scenarios[name].description}`);
		console.log(format('sandbox while rendered:', rendered.sandbox));
		console.log(format('sandbox after stopRendering:', stopped.sandbox));
		if (stopped.client) {
			console.log(format('client meanwhile:', stopped.client));
		}
		if (rendered.sandbox.level < AUDIBLE_LEVEL) {
			console.log('  => not measured: the listener never played the sandbox audio\n');
		} else if (stopped.sandbox.level >= AUDIBLE_LEVEL) {
			console.log('  => the sandbox audio is still played out after detach\n');
		} else {
			console.log('  => the sandbox audio stopped\n');
		}
	}
};

// Publishes the two tones until Ctrl+C, for a listener that a person opens in any browser.
const publishForListener = async () => {
	const room = `detach-audio-${randomUUID().slice(0, 8)}`;
	const sandbox = await join(room, 'sandbox', { autoSubscribe: false });
	await sandbox.evaluate(() => window.publishTone({ frequency: 440, name: 'sandbox', beep: true }));
	const client = await join(room, 'client', { autoSubscribe: false });
	await client.evaluate(() => window.publishTone({ frequency: 660, name: 'client' }));

	// The link can only subscribe in this room, and every browser that opens it joins as the
	// same "listener", so a new one disconnects the previous one.
	const token = await createToken(room, 'listener', {
		ttl: '2h',
		canPublish: false,
		canPublishData: false,
	});
	const hash = new URLSearchParams({ url, token }).toString();
	console.log(`Publishing in room ${room} on ${url}:`);
	console.log('  sandbox: a beeping 440 Hz tone');
	console.log('  client:  a steady 660 Hz tone\n');
	console.log('Open the listening page, in one browser at a time. Its link expires in 2 hours.\n');
	console.log(`  On this computer: ${pageUrl}listen.html#${hash}\n`);
	if (listenPage) {
		console.log(`  Hosted:           ${listenPage}#${hash}\n`);
		if (!url.startsWith('wss:') && !url.startsWith('https:')) {
			console.log('  An https page can only connect to a wss:// server, such as LiveKit Cloud.\n');
		}
	}
	console.log('Press Ctrl+C to stop publishing.');
	await new Promise((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
};

try {
	await (listenMode ? publishForListener() : runScenarios());
} finally {
	await browser.close();
	server.close();
}
