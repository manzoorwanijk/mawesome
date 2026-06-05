import { createRequire } from 'module';
import attr from 'attr-dep' with { type: 'json' };
createRequire(import.meta.url)('cr-esm-dep');
export const x = attr;
