/// <reference types="cjs-only-types" resolution-mode="require" />
import type { Legacy } from 'cjs-only-types' with { 'resolution-mode': 'require' };
import legacy = require('cjs-only-types');
export declare function use(legacy: Legacy): void;
export declare function reuse(): import(
	'cjs-only-types',
	{ with: { 'resolution-mode': 'require' } }
).Legacy;
export { legacy };
