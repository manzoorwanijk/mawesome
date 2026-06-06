import { createRequire } from 'module';
import attr from 'attr-dep' with { type: 'json' };
createRequire(import.meta.url)('cr-esm-dep');
createRequire(import.meta.url).resolve('crr-dep');
export const x = attr;
