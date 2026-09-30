const path = require('node:path');

function joinParts(a, b) {
  return path.join(a, b);
}

module.exports = { joinParts };
module.exports.helper = () => 1;
exports.version = '1.0.0';
exports.run = function () {};
