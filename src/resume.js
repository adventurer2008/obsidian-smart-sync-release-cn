import { fingerprint } from './codec.js';

const hex = /^[a-f0-9]{64}$/;
const chunk = /^([a-f0-9]{64})\.bin$/;
const link = /^(source|receive)-[a-f0-9]{64}\.json$/;
const maximumObject = 2 * 1024 * 1024;
// Only authenticated ciphertext is stored here. No plaintext attachment or vault path.
export class ReceiveCache {
 constructor(adapter, folder, { active = () => true, maximum = 384 * 1024 * 1024, lifetime = 7 * 86400000 } = {}) {
  Object.assign(this, { adapter, folder, active, maximum, lifetime });
  this.enabled = ['exists', 'mkdir', 'list', 'stat', 'read', 'write', 'readBinary', 'writeBinary', 'rename', 'remove'].every(key => typeof adapter?.[key] === 'function');
  this.files = new Map(); this.links = new Map(); this.bytes = 0; this.reservedBytes = 0; this.serial = Promise.resolve();
  this.metrics = { reusedBytes: 0, savedBytes: 0, corruptObjects: 0, storageFailures: 0 };
 }
 check() { if (!this.active()) throw new DOMException('Receive cache cancelled', 'AbortError'); }
 async init() {
  if (!this.enabled) return false;
  this.initializing ??= (async () => {
   let path = '';
   for (const part of this.folder.split('/')) { if (!part || part === '.' || part === '..' || part.includes('\\')) throw Error('Invalid cache directory'); path = path ? `${path}/${part}` : part; if (!await this.adapter.exists(path)) await this.adapter.mkdir(path); }
   const listing = await this.adapter.list(this.folder);
   for (const path of listing.files) {
    const name = path.slice(this.folder.length + 1);
    if (path !== `${this.folder}/${name}` || name.includes('/')) continue;
    if (!chunk.test(name) && !link.test(name) && !/^[a-f0-9-]{36}\.tmp$/.test(name)) continue;
    const stat = await this.adapter.stat(path);
    if (!stat || !Number.isSafeInteger(stat.size) || stat.size < 0) continue;
    if (Date.now() - stat.mtime > this.lifetime) { await this.adapter.remove(path); continue; }
    if (name.endsWith('.tmp')) { this.reservedBytes += stat.size; continue; }
    if (link.test(name)) this.links.set(name, stat.mtime);
    if (chunk.test(name)) { this.files.set(name, { size: stat.size, at: stat.mtime }); this.bytes += stat.size; }
   }
   return true;
  })().catch(() => { this.enabled = false; this.metrics.storageFailures++; return false; });
  return this.initializing;
 }
 async get(address) {
  this.check();
  if (!hex.test(address) || !await this.init()) return null;
  const name = `${address}.bin`, entry = this.files.get(name);
  if (!entry || entry.size < 33 || entry.size > maximumObject) return null;
  try {
   const stat = await this.adapter.stat(`${this.folder}/${name}`);
   if (!stat || stat.size !== entry.size) throw Error('Cache length changed');
   const bytes = new Uint8Array(await this.adapter.readBinary(`${this.folder}/${name}`));
   this.check();
   if (bytes.length !== entry.size || await fingerprint(bytes) !== address) throw Error('Cache digest mismatch');
   this.metrics.reusedBytes += bytes.length; return bytes;
  } catch {
   this.check(); this.metrics.corruptObjects++;
   await this.adapter.remove(`${this.folder}/${name}`).catch(() => {});
   this.files.delete(name); this.bytes -= entry.size; return null;
  }
 }
 async put(address, bytes) {
  this.check();
  if (!this.enabled || !hex.test(address) || !(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > maximumObject || bytes.length > this.maximum || !await this.init() || await fingerprint(bytes) !== address) return false;
  const operation = this.serial.catch(() => {}).then(async () => {
   this.check(); const name = `${address}.bin`;
   if (this.files.has(name)) return true;
   while (this.bytes + this.reservedBytes + bytes.length > this.maximum || this.files.size >= 4096) {
    const oldest = [...this.files].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) return false;
    await this.adapter.remove(`${this.folder}/${oldest[0]}`); this.files.delete(oldest[0]); this.bytes -= oldest[1].size;
   }
   const temporary = `${this.folder}/${crypto.randomUUID()}.tmp`;
   try {
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : Uint8Array.from(bytes).buffer;
    await this.adapter.writeBinary(temporary, buffer); this.check();
    await this.adapter.rename(temporary, `${this.folder}/${name}`);
    this.files.set(name, { size: bytes.length, at: Date.now() }); this.bytes += bytes.length; this.metrics.savedBytes += bytes.length; return true;
   } finally { await this.adapter.remove(temporary).catch(() => {}); }
  });
  this.serial = operation;
  try { return await operation; } catch { this.check(); this.metrics.storageFailures++; return false; }
 }
 async readLink(kind, manifest) {
  this.check(); if (!['source', 'receive'].includes(kind) || !hex.test(manifest) || !await this.init()) return null;
  try {
   const path = `${this.folder}/${kind}-${manifest}.json`, stat = await this.adapter.stat(path);
   if (!stat || stat.size > 65536 || Date.now() - stat.mtime > this.lifetime) return null;
   const value = JSON.parse(await this.adapter.read(path));
   if (value.format !== 1 || !hex.test(value.note) || !hex.test(value.manifest) || !Array.isArray(value.objects) || value.objects.length > 512 || value.objects.some(address => !hex.test(address))) return null;
   return value;
  } catch { return null; }
 }
 async writeLink(kind, manifest, value) {
  this.check(); if (!hex.test(manifest) || !['source', 'receive'].includes(kind) || !await this.init()) return false;
  try {
   const name = `${kind}-${manifest}.json`;
   while (this.links.size >= 128 && !this.links.has(name)) {
    const oldest = [...this.links].sort((a, b) => a[1] - b[1])[0]; await this.adapter.remove(`${this.folder}/${oldest[0]}`); this.links.delete(oldest[0]);
   }
   await this.adapter.write(`${this.folder}/${name}`, JSON.stringify({ ...value, format: 1 })); this.links.set(name, Date.now()); this.check(); return true;
  }
  catch { this.check(); this.metrics.storageFailures++; return false; }
 }
 loader(load, allowed) {
  const addresses = new Set(allowed);
  return async address => {
   this.check(); if (!addresses.has(address)) throw Error('Object outside authenticated manifest');
   const cached = await this.get(address); if (cached) return cached;
   const bytes = await load(address); this.check();
   if (!(bytes instanceof Uint8Array)) throw Error('Invalid encrypted object');
   await this.put(address, bytes); return bytes;
  };
 }
 async bundle(manifest, note, stamp, mtime) {
  if (typeof stamp !== 'string') return null;
  const value = await this.readLink('source', manifest);
  if (!value || value.note !== note || value.stamp !== stamp || value.mtime !== mtime) return null;
  if (value.objects.some(address => !this.files.has(`${address}.bin`))) return null;
  return { manifest: value.manifest, objects: value.objects.map(address => ({ address, load: async () => { const bytes = await this.get(address); if (!bytes) throw Error('Cached peer bundle unavailable'); return bytes; } })) };
 }
 async saveBundle(manifest, note, packed, stamp, mtime, active = () => true) {
  for (const object of packed.objects) {
   if (!active() || !await this.put(object.address, object.body ?? await object.load())) return false;
  }
  if (!active()) return false;
  return this.writeLink('source', manifest, { note, manifest: packed.manifest, objects: packed.objects.map(object => object.address), stamp, mtime });
 }
 snapshot() { return { enabled: this.enabled, bytes: this.bytes, ...this.metrics }; }
}
