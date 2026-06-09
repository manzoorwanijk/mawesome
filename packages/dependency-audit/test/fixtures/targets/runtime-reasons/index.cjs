// `esm-only` exposes only an `import` condition — requiring it is an ESM/CJS mismatch.
const esm = require('esm-only');
// `broken-exports` maps `.` to ./dist/index.js, which is not shipped — a missing target file.
const broken = require('broken-exports');
/*
 * `dual-broken` maps the `require` condition to a file that is not shipped (its `import` one is).
 * The requested condition exists, so this is a missing file, not a condition mismatch.
 */
const dual = require('dual-broken');
// `legacy-module-only` has no `exports` and no `main`/index — only a bundler `module` field.
const legacy = require('legacy-module-only');

module.exports = { esm, broken, dual, legacy };
