export {};

// Real augmentation of an external package — requires `react` to exist to augment.
declare module 'react' {
	interface Extra {
		readonly a: number;
	}
}

// Pattern stub — provides modules, not a requirement.
declare module '*.svg' {
	const src: string;
	export default src;
}
