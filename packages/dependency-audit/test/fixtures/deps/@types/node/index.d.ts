declare module 'path' {
	export interface ParsedPath {
		readonly base: string;
	}
}
declare module 'node:path' {
	export * from 'path';
}
