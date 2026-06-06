const { createRequire } = require('module');
const resolved = require.resolve('res-dep');
createRequire(__filename)('cr-dep');
module.exports = { resolved };
