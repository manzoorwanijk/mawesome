/**
 * Maps `items` through `fn` with at most `limit` calls in flight, preserving input
 * order in the result. Bounds the load a large batch places on shared resources (the
 * registry/pacote cache, file descriptors) instead of starting every task at once.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = Array.from<R>({ length: items.length });
	const width = Math.max(1, Math.min(limit, items.length));
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			// A worker pulls tasks one at a time; the loop's serial await is the pool itself.
			// oxlint-disable-next-line no-await-in-loop
			results[index] = await fn(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: width }, worker));
	return results;
}
