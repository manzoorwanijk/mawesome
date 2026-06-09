/* `aliased` is declared via `npm:real-aliased-pkg@3.0.3`; its materialized manifest
 * keeps the real name, yet the bare and deep specifiers must still resolve. */
const aliased = require('aliased');
const extra = require('aliased/extra');

module.exports = { aliased, extra };
