import { describe, expect, it } from 'vitest';
import { createNormalizer, normalizeSpecifier, typesPackageFor } from '../src/normalize.ts';

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

	it('treats prefix-only builtins as builtin only under the node: scheme', () => {
		// A bare `test`/`sqlite` import is a real npm package, not the Node builtin.
		expect(normalizeSpecifier('test')).toEqual({ packageName: 'test', isBuiltin: false });
		expect(normalizeSpecifier('sqlite')).toEqual({ packageName: 'sqlite', isBuiltin: false });
		expect(normalizeSpecifier('node:test')).toEqual({ packageName: 'test', isBuiltin: true });
		expect(normalizeSpecifier('node:sqlite')).toEqual({ packageName: 'sqlite', isBuiltin: true });
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

describe('createNormalizer (injected builtins)', () => {
	it('classifies builtins from the injected set (e.g. a newer Node adds one)', () => {
		const normalize = createNormalizer(['fs', 'newcore']);
		expect(normalize('newcore')?.isBuiltin).toBe(true);
		expect(normalize('node:newcore')?.isBuiltin).toBe(true);
		// Not in the injected set → audited as a package.
		expect(normalize('os')?.isBuiltin).toBe(false);
	});

	it('keeps prefix-only builtins package-classified even if the injected set lists them bare', () => {
		const normalize = createNormalizer(['test', 'sqlite']);
		expect(normalize('test')).toEqual({ packageName: 'test', isBuiltin: false });
		expect(normalize('node:test')).toEqual({ packageName: 'test', isBuiltin: true });
	});
});
