'use strict';

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

function readJsonLinesSync(filePath, callback) {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = '';
  let lineNumber = 0;
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const text = carry + decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let end;
      while ((end = text.indexOf('\n', start)) !== -1) {
        const line = text.slice(start, end).replace(/\r$/, '');
        if (line) callback(line, lineNumber);
        lineNumber += 1;
        start = end + 1;
      }
      carry = text.slice(start);
    }
    carry += decoder.end();
    if (carry) callback(carry.replace(/\r$/, ''), lineNumber);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readJsonLinesSync };
