/*
 * Each dep is declared via an `npm:` alias whose materialized manifest keeps its real name.
 * The bare, deep, scoped, and legacy (no-`exports`) specifiers must all still resolve.
 */
const aliased = require('aliased');
const extra = require('aliased/extra');
const scoped = require('@scope/aliased');
const legacy = require('legacy-aliased');

module.exports = { aliased, extra, scoped, legacy };
