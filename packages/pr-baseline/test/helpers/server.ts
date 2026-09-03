import { createServer } from 'node:http';
import type { FakeGitHub } from './fake-github.ts';

/** Serves the fake over HTTP so the CLI can be exercised end to end in a subprocess. */
export async function serve(github: FakeGitHub): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks).toString();
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (typeof value === 'string') {
				headers[name] = value;
			}
		}
		const response = await github.fetch(
			new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
				method: incoming.method ?? 'GET',
				headers,
				...(body.length > 0 ? { body } : {}),
			}),
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(await response.text());
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
