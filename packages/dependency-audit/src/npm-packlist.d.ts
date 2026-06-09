/*
 * Minimal typing for npm-packlist v10's tree-based API.
 * The published `@types/npm-packlist` still describes the v7 path-based signature, so it would
 * mistype the call — this local declaration covers exactly the slice `pack-set.ts` uses.
 */
declare module 'npm-packlist' {
	/** The Arborist-tree-like node npm-packlist walks. */
	interface PackTree {
		path: string;
		package: Record<string, unknown>;
		isProjectRoot?: boolean;
		edgesOut?: Map<string, unknown>;
	}
	/** Resolves to the publish file list as package-relative POSIX paths. */
	export default function packlist(tree: PackTree): Promise<string[]>;
}
