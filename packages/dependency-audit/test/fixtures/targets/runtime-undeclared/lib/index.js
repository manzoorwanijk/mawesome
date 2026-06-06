/* oxlint-disable import/no-unassigned-import -- fixture: intentional imports under audit */
import leftpad from 'leftpad';
import { readFile } from 'node:fs/promises';

// A local `require` in an ESM file must NOT be read as a CommonJS require.
const require = (id) => id;
require('ghost');

// Template-literal specifier is a literal — checkable under import conditions.
export const tmpl = () => import(`tmpl-dep`);

// Dynamic, non-literal specifier — surfaced as unchecked, not a finding.
export const lazy = (name) => import(name);

export const value = leftpad(readFile);
