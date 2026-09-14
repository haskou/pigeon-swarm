const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { dirname } = require('node:path');

const rejected = 'Kestrel7-Quartz9-Pigeon4-Nebula8-Harbor2-Cipher6-Orbit5-Velvet3';

function validate(value) {
  if (!/^[a-zA-Z0-9_/+=-]{32,256}$/.test(value) || value === rejected) {
    throw new Error('Invalid TURN secret');
  }
  return value;
}

function readSecret(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 256 || (info.mode & 0o077) !== 0) {
      throw new Error('Unsafe TURN secret file');
    }
    return validate(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWrite(path, value, exclusive) {
  const temp = path + '.' + randomBytes(16).toString('hex');
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (exclusive) {
      try { fs.linkSync(temp, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else {
      fs.renameSync(temp, path);
    }
  } finally {
    try { fs.unlinkSync(temp); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

try {
  const [stored, runtime] = process.argv.slice(2);
  if (!stored || !runtime || stored === runtime) throw new Error('Invalid paths');
  for (const path of [stored, runtime]) fs.mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const override = process.env.CALLS_TURN_SHARED_SECRET;
  if (override) {
    atomicWrite(stored, validate(override), false);
  } else {
    try { readSecret(stored); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      atomicWrite(stored, randomBytes(32).toString('hex'), true);
    }
  }
  atomicWrite(runtime, readSecret(stored), false);
} catch {
  process.stderr.write('TURN secret preparation failed: check private secret format, file permissions and storage.\n');
  process.exitCode = 1;
}
