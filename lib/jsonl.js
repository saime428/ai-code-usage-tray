'use strict';

const fs = require('fs');

const CHUNK_BYTES = 1024 * 1024;
// Bytes kept from just before a resume point. A file rewritten in place (same path,
// as long or longer) fails this comparison and is read again from the start.
const TAIL_BYTES = 64;

// Calls back (line, lineNumber, offset) once per line from byte `start` on — lineNumber
// counts from `start`, offset is the line's absolute byte position, stable across
// resumed reads — and returns the byte offset just past the last line it consumed.
// Lines are split on the raw 0x0A byte, which never occurs
// inside a UTF-8 sequence, so offsets stay exact however the chunks fall. A final
// line without its newline is consumed only when it is complete JSON: otherwise it
// is still being written, and the next read starts again at its first byte.
function readJsonLinesSync(filePath, callback, { start = 0 } = {}) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  let lineStart = start; // file offset of carry[0]
  let lineNumber = 0;
  try {
    let position = start;
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytes) break;
      position += bytes;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytes)]) : buffer.subarray(0, bytes);
      let from = 0;
      let newline;
      while ((newline = data.indexOf(10, from)) !== -1) {
        const end = newline > from && data[newline - 1] === 13 ? newline - 1 : newline;
        if (end > from) callback(data.toString('utf8', from, end), lineNumber, lineStart + from);
        lineNumber += 1;
        from = newline + 1;
      }
      lineStart += from;
      // Copy: `data` may be the shared read buffer, which the next read overwrites.
      carry = Buffer.from(data.subarray(from));
    }
  } finally {
    fs.closeSync(fd);
  }
  if (carry.length) {
    const line = carry.toString('utf8').replace(/\r$/, '');
    let complete = false;
    try {
      JSON.parse(line);
      complete = true;
    } catch {
      // Torn: leave it for the next read.
    }
    if (complete) {
      callback(line, lineNumber, lineStart);
      return lineStart + carry.length;
    }
  }
  return lineStart;
}

function readTail(filePath, end) {
  const length = Math.min(TAIL_BYTES, end);
  const fd = fs.openSync(filePath, 'r');
  try {
    const tail = Buffer.alloc(length);
    fs.readSync(fd, tail, 0, length, end - length);
    return tail.toString('base64');
  } finally {
    fs.closeSync(fd);
  }
}

// Parses only what was appended since the last call, carrying the parser's own state
// across calls. `entry` is what the previous call returned (or undefined); `stat` is
// the file's current fs.Stats. Returns the new entry: { size, mtimeMs, end, tail,
// state, reused } — `reused` when nothing was read at all.
//
// The state is resumed only when the file still holds the bytes it was built from:
// a shrunk file or different bytes before the resume point (a rewrite, a restored
// backup) start over with a fresh state. A read that throws discards the entry, so a
// half-applied append can never be counted twice.
function readAppended(filePath, stat, entry, { createState, consume, sameState = () => true }) {
  if (entry && sameState(entry.state) && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
    return { ...entry, reused: true };
  }
  let state = createState();
  let start = 0;
  if (entry && sameState(entry.state) && stat.size >= entry.end && entry.end > 0) {
    try {
      if (readTail(filePath, entry.end) === entry.tail) {
        state = entry.state;
        start = entry.end;
      }
    } catch {
      // Unreadable right now: fall through to a full read, which fails the same way.
    }
  }
  const end = readJsonLinesSync(filePath, (line, _lineNumber, offset) => consume(state, line, offset), { start });
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    end,
    tail: end > 0 ? readTail(filePath, end) : '',
    state,
    reused: false,
    resumedFrom: start,
  };
}

module.exports = { readJsonLinesSync, readAppended, TAIL_BYTES };
