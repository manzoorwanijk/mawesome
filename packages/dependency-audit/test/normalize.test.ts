import { describe, expect, it } from 'vitest';
import { normalizeSpecifier, typesPackageFor } from '../src/normalize.ts';

describe('normalizeSpecifier', () => {
	it('classifies exact builtins, including real slash subpaths', () => {
		expect(normalizeSpecifier('fs')).toEqual({ packageName: 'fs', isBuiltin: true });
		expect(normalizeSpecifier('fs/promises')).toEqual({ packageName: 'fs', isBuiltin: true });
		expect(normalizeSpecifier('node:path')).toEqual({ packageName: 'path', isBuiltin: true });
	});

	it('does not treat package-like subpaths or fake node: entries as builtins', () => {
		expect(normalizeSpecifier('events/foo')).toEqual({ packageName: 'events', isBuiltin: false });
		expect(normalizeSpecifier('node:events/foo')).toEqual({
			packageName: 'events',
			isBuiltin: false,
		});
	});

	it('reduces scoped and subpath specifiers to their owning package', () => {
		expect(normalizeSpecifier('react/jsx-runtime')?.packageName).toBe('react');
		expect(normalizeSpecifier('@scope/pkg/sub')?.packageName).toBe('@scope/pkg');
	});

	it('ignores relative, absolute, URI, and #imports specifiers', () => {
		for (const spec of ['./x', '../x', '/abs', '#internal', 'data:x', 'https://x', 'file:x']) {
			expect(normalizeSpecifier(spec)).toBeNull();
		}
	});

	it('maps packages to their DefinitelyTyped name', () => {
		expect(typesPackageFor('react')).toBe('@types/react');
		expect(typesPackageFor('@scope/pkg')).toBe('@types/scope__pkg');
	});
});
