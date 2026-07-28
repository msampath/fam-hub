// Boot-time Node floor check. package.json's `engines` only makes npm WARN (no engine-strict is
// shipped), and the first hard dependency on a modern runtime is node:sqlite — which on an older Node
// dies with a bare unknown-builtin-module error pointing nowhere. Import this BEFORE any module that
// pulls ./src/storage so the failure is one clear FATAL line instead. 22.5 is the documented floor
// (node:sqlite exists from there, behind a flag until late 22.x — the check names that caveat).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`FATAL: Family-Hub needs Node >= 22.5 (found ${process.versions.node}). `
    + 'Install a newer Node (node:sqlite is unflagged only in recent releases) and restart.');
  process.exit(1);
}

export {};
