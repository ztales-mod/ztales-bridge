/**
 * A minimal SSH-2 client with an SFTP (v3) session on top, pure protocol over WebCrypto, so it runs
 * on a Cloudflare Worker (no Node, no library) and on Node in the tests. The socket comes from an
 * `open` function, exactly as for ftp-core.js:
 *
 *   open(host, port) -> { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close() }
 *
 * SftpSession has the same shape as FtpSession (list, get, put, rename, del, mkdir, close), so the
 * transport above it (transport.js) does not know which one it holds.
 *
 * Supported, in the order offered:
 *   kex       curve25519-sha256, curve25519-sha256@libssh.org, ecdh-sha2-nistp256
 *   host key  ssh-ed25519, ecdsa-sha2-nistp256, rsa-sha2-512, rsa-sha2-256
 *   cipher    aes128-gcm@openssh.com, aes256-gcm@openssh.com, aes128-ctr, aes256-ctr
 *   mac       hmac-sha2-256-etm@openssh.com, hmac-sha2-512-etm@openssh.com, hmac-sha2-256, hmac-sha2-512
 *   auth      password
 * Sessions are short (one tick), so a re-key asked by the server ends the session with an error;
 * the next tick connects again.
 */

import { withDeadline } from "./ftp-core.js";

export class SshError extends Error {
  constructor(message, code = 0) {
    super(message);
    this.name = "SshError";
    this.code = code;
  }
}

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const CLIENT_VERSION = "SSH-2.0-ZTales_1.0";

export const ALGOS = {
  kex: ["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256"],
  hostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"],
  cipher: ["aes128-gcm@openssh.com", "aes256-gcm@openssh.com", "aes128-ctr", "aes256-ctr"],
  mac: ["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"],
};

const CIPHERS = {
  "aes128-gcm@openssh.com": { gcm: true, keyLen: 16, ivLen: 12 },
  "aes256-gcm@openssh.com": { gcm: true, keyLen: 32, ivLen: 12 },
  "aes128-ctr": { gcm: false, keyLen: 16, ivLen: 16 },
  "aes256-ctr": { gcm: false, keyLen: 32, ivLen: 16 },
};
const MACS = {
  "hmac-sha2-256-etm@openssh.com": { hash: "SHA-256", len: 32, etm: true },
  "hmac-sha2-512-etm@openssh.com": { hash: "SHA-512", len: 64, etm: true },
  "hmac-sha2-256": { hash: "SHA-256", len: 32, etm: false },
  "hmac-sha2-512": { hash: "SHA-512", len: 64, etm: false },
};

// message numbers (RFC 4250)
const MSG = {
  DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53,
  USERAUTH_INFO_REQUEST: 60, USERAUTH_INFO_RESPONSE: 61,
  GLOBAL_REQUEST: 80, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
};

// ---------- bytes ----------

export class Writer {
  constructor() { this.parts = []; this.len = 0; }
  raw(a) { this.parts.push(a); this.len += a.length; return this; }
  byte(b) { return this.raw(Uint8Array.of(b)); }
  bool(v) { return this.byte(v ? 1 : 0); }
  u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return this.raw(a); }
  u64(n) {
    const a = new Uint8Array(8);
    const dv = new DataView(a.buffer);
    dv.setUint32(0, Math.floor(n / 2 ** 32));
    dv.setUint32(4, n >>> 0);
    return this.raw(a);
  }
  str(s) { const b = typeof s === "string" ? te.encode(s) : s; this.u32(b.length); return this.raw(b); }
  /** an unsigned big-endian number as an SSH mpint */
  mpint(bytes) {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    let b = bytes.subarray(i);
    if (b.length && b[0] & 0x80) { const c = new Uint8Array(b.length + 1); c.set(b, 1); b = c; }
    return this.str(b);
  }
  bytes() {
    const o = new Uint8Array(this.len);
    let p = 0;
    for (const a of this.parts) { o.set(a, p); p += a.length; }
    return o;
  }
}

export class Reader {
  constructor(a) { this.a = a; this.p = 0; this.dv = new DataView(a.buffer, a.byteOffset, a.byteLength); }
  need(n) { if (this.p + n > this.a.length) throw new SshError("truncated packet"); }
  byte() { this.need(1); return this.a[this.p++]; }
  bool() { return this.byte() !== 0; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  u64() { const h = this.u32(); const l = this.u32(); return h * 2 ** 32 + l; }
  bytes() { const n = this.u32(); this.need(n); const b = this.a.subarray(this.p, this.p + n); this.p += n; return b; }
  str() { return td.decode(this.bytes()); }
  rest() { const b = this.a.subarray(this.p); this.p = this.a.length; return b; }
}

const concat = (...arrs) => {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const a of arrs) { o.set(a, p); p += a.length; }
  return o;
};
const u32be = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; };
const equal = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};
const b64 = (a) => { let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); };
const b64url = (a) => b64(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const stripZeros = (a) => { let i = 0; while (i < a.length - 1 && a[i] === 0) i++; return a.subarray(i); };
const leftPad = (a, n) => { if (a.length >= n) return a.subarray(a.length - n); const o = new Uint8Array(n); o.set(a, n - a.length); return o; };
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const digest = async (hash, data) => new Uint8Array(await subtle().digest(hash, data));

/** 128-bit big-endian counter + n (AES-CTR). */
export function addCounter(ctr, n) {
  const o = ctr.slice();
  let carry = n;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const v = o[i] + (carry % 256);
    o[i] = v & 0xff;
    carry = Math.floor(carry / 256) + (v > 0xff ? 1 : 0);
  }
  return o;
}

/** The first algorithm of ours the server also has (RFC 4253 7.1). */
export function pick(ours, theirs, what) {
  const found = ours.find((a) => theirs.includes(a));
  if (!found) throw new SshError(`no common ${what} (server offers: ${theirs.join(",").slice(0, 200)})`);
  return found;
}

// ---------- the socket ----------

class ByteReader {
  constructor(readable) { this.r = readable.getReader(); this.buf = new Uint8Array(0); }
  async fill(n, ms) {
    while (this.buf.length < n) {
      const { value, done } = await withDeadline(this.r.read(), ms, "SSH server");
      if (done) throw new SshError("connection closed by the server");
      this.buf = this.buf.length ? concat(this.buf, value) : value;
    }
  }
  async take(n, ms) {
    await this.fill(n, ms);
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async line(ms) {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const l = td.decode(this.buf.subarray(0, i)).replace(/\r$/, "");
        this.buf = this.buf.subarray(i + 1);
        return l;
      }
      if (this.buf.length > 8192) throw new SshError("no SSH version line");
      await this.fill(this.buf.length + 1, ms);
    }
  }
  release() { try { this.r.releaseLock(); } catch { /* ignore */ } }
}

// ---------- host keys ----------

/** Verifies `sig` (an SSH signature blob) over `data` with the host key blob `keyBlob`. */
export async function verifyHostSig(alg, keyBlob, sigBlob, data) {
  const k = new Reader(keyBlob);
  const keyType = k.str();
  const s = new Reader(sigBlob);
  const sigType = s.str();
  const sig = s.bytes();
  if (alg === "ssh-ed25519") {
    if (keyType !== alg || sigType !== alg) throw new SshError("host key type mismatch");
    const key = await subtle().importKey("raw", k.bytes(), { name: "Ed25519" }, false, ["verify"]);
    return subtle().verify({ name: "Ed25519" }, key, sig, data);
  }
  if (alg === "ecdsa-sha2-nistp256") {
    if (keyType !== alg || sigType !== alg) throw new SshError("host key type mismatch");
    if (k.str() !== "nistp256") throw new SshError("ecdsa curve mismatch");
    const key = await subtle().importKey("raw", k.bytes(), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const rs = new Reader(sig);
    const raw = concat(leftPad(stripZeros(rs.bytes()), 32), leftPad(stripZeros(rs.bytes()), 32));
    return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, data);
  }
  if (alg === "rsa-sha2-256" || alg === "rsa-sha2-512") {
    if (keyType !== "ssh-rsa" || sigType !== alg) throw new SshError("host key type mismatch");
    const e = stripZeros(k.bytes());
    const n = stripZeros(k.bytes());
    const hash = alg === "rsa-sha2-256" ? "SHA-256" : "SHA-512";
    const key = await subtle().importKey("jwk", { kty: "RSA", n: b64url(n), e: b64url(e), ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return subtle().verify({ name: "RSASSA-PKCS1-v1_5" }, key, leftPad(sig, n.length), data);
  }
  throw new SshError(`host key algorithm not supported: ${alg}`);
}

/** "SHA256:..." as OpenSSH prints it. */
export async function fingerprint(keyBlob) {
  return `SHA256:${b64(await digest("SHA-256", keyBlob)).replace(/=+$/, "")}`;
}

// ---------- key exchange ----------

async function kexKeys(kex) {
  if (kex.startsWith("curve25519")) {
    const kp = await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const pub = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
    return {
      pub,
      async secret(theirs) {
        if (theirs.length !== 32) throw new SshError("bad curve25519 server key");
        const key = await subtle().importKey("raw", theirs, { name: "X25519" }, false, []);
        const s = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: key }, kp.privateKey, 256));
        if (s.every((x) => x === 0)) throw new SshError("curve25519 shared secret is zero");
        return s;
      },
    };
  }
  const kp = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  return {
    pub,
    async secret(theirs) {
      const key = await subtle().importKey("raw", theirs, { name: "ECDH", namedCurve: "P-256" }, false, []);
      return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: key }, kp.privateKey, 256));
    },
  };
}

// ---------- packets ----------

/** One direction's cipher state. Before NEWKEYS: none. */
class Crypt {
  static async make(cipherName, macName, key, iv, macKey) {
    const c = new Crypt();
    c.spec = CIPHERS[cipherName];
    c.block = 16;
    c.iv = iv.slice(0, c.spec.ivLen);
    c.key = await subtle().importKey("raw", key.slice(0, c.spec.keyLen), c.spec.gcm ? "AES-GCM" : "AES-CTR", false, ["encrypt", "decrypt"]);
    if (!c.spec.gcm) {
      c.mac = MACS[macName];
      c.macKey = await subtle().importKey("raw", macKey.slice(0, c.mac.len), { name: "HMAC", hash: c.mac.hash }, false, ["sign", "verify"]);
    }
    return c;
  }

  nextGcmIv() {
    const iv = this.iv.slice();
    // the last 8 bytes are the invocation counter, +1 per packet
    for (let i = 11; i >= 4; i--) { this.iv[i] = (this.iv[i] + 1) & 0xff; if (this.iv[i] !== 0) break; }
    return iv;
  }

  async ctr(data) {
    const out = new Uint8Array(await subtle().encrypt({ name: "AES-CTR", counter: this.iv, length: 128 }, this.key, data));
    this.iv = addCounter(this.iv, data.length / 16);
    return out;
  }

  async hmac(data) { return new Uint8Array(await subtle().sign("HMAC", this.macKey, data)); }
}

function padded(payload, block, lengthInBlock) {
  // padding: at least 4, and the encrypted part a multiple of the block
  const head = lengthInBlock ? 5 : 1;
  let pad = block - ((head + payload.length) % block);
  if (pad < 4) pad += block;
  return { pad, body: concat(Uint8Array.of(pad), payload, random(pad)) };
}

// ---------- the SSH session ----------

export class SshSession {
  constructor(open, cfg) {
    this.open = open;
    this.cfg = { port: 22, timeout: 30000, ...cfg };
    this.seqOut = 0;
    this.seqIn = 0;
    this.out = null;   // Crypt after NEWKEYS
    this.in = null;
    this.chan = null;
  }

  async send(payload) {
    let pkt;
    const c = this.out;
    if (!c) {
      const { body } = padded(payload, 8, true);
      pkt = concat(u32be(body.length), body);
    } else if (c.spec.gcm) {
      const { body } = padded(payload, 16, false);
      const len = u32be(body.length);
      const enc = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: c.nextGcmIv(), additionalData: len, tagLength: 128 }, c.key, body));
      pkt = concat(len, enc);
    } else if (c.mac.etm) {
      const { body } = padded(payload, 16, false);
      const len = u32be(body.length);
      const enc = await c.ctr(body);
      const mac = await c.hmac(concat(u32be(this.seqOut), len, enc));
      pkt = concat(len, enc, mac);
    } else {
      const { body } = padded(payload, 16, true);
      const plain = concat(u32be(body.length), body);
      const mac = await c.hmac(concat(u32be(this.seqOut), plain));
      pkt = concat(await c.ctr(plain), mac);
    }
    this.seqOut = (this.seqOut + 1) >>> 0;
    await this.writer.write(pkt);
  }

  async recv() {
    const ms = this.cfg.timeout;
    const c = this.in;
    let body;
    const checkLen = (n) => { if (n < 5 || n > 256 * 1024) throw new SshError(`bad packet length ${n}`); };
    if (!c) {
      const len = new Reader(await this.bytes.take(4, ms)).u32();
      checkLen(len);
      body = await this.bytes.take(len, ms);
    } else if (c.spec.gcm) {
      const lenB = await this.bytes.take(4, ms);
      const len = new Reader(lenB).u32();
      checkLen(len);
      const enc = await this.bytes.take(len + 16, ms);
      try {
        body = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: c.nextGcmIv(), additionalData: lenB, tagLength: 128 }, c.key, enc));
      } catch { throw new SshError("packet failed authentication"); }
    } else if (c.mac.etm) {
      const lenB = await this.bytes.take(4, ms);
      const len = new Reader(lenB).u32();
      checkLen(len);
      const enc = await this.bytes.take(len, ms);
      const mac = await this.bytes.take(c.mac.len, ms);
      if (!equal(mac, await c.hmac(concat(u32be(this.seqIn), lenB, enc)))) throw new SshError("packet failed authentication");
      body = await c.ctr(enc);
    } else {
      const first = await c.ctr(await this.bytes.take(16, ms));
      const len = new Reader(first).u32();
      checkLen(len);
      if ((len + 4) % 16) throw new SshError("bad packet length");
      const rest = await c.ctr(await this.bytes.take(len + 4 - 16, ms));
      const plain = concat(first, rest);
      const mac = await this.bytes.take(c.mac.len, ms);
      if (!equal(mac, await c.hmac(concat(u32be(this.seqIn), plain)))) throw new SshError("packet failed authentication");
      body = plain.subarray(4);
    }
    this.seqIn = (this.seqIn + 1) >>> 0;
    const pad = body[0];
    if (pad + 1 > body.length) throw new SshError("bad padding");
    return body.subarray(1, body.length - pad);
  }

  /** The next message that matters; the ones that never do are answered or dropped here. */
  async next() {
    for (;;) {
      const p = await this.recv();
      const t = p[0];
      if (t === MSG.IGNORE || t === MSG.DEBUG || t === MSG.UNIMPLEMENTED || t === MSG.EXT_INFO || t === MSG.USERAUTH_BANNER) continue;
      if (t === MSG.DISCONNECT) {
        const r = new Reader(p.subarray(1));
        const code = r.u32();
        throw new SshError(`server disconnected (${code}): ${r.str().slice(0, 120)}`, code);
      }
      if (t === MSG.GLOBAL_REQUEST) {
        const r = new Reader(p.subarray(1));
        r.str();
        if (r.bool()) await this.send(Uint8Array.of(MSG.REQUEST_FAILURE));
        continue;
      }
      if (t === MSG.KEXINIT && this.out) throw new SshError("the server asked to re-key; reconnecting next time");
      return p;
    }
  }

  async expect(type, what) {
    const p = await this.next();
    if (p[0] !== type) throw new SshError(`${what}: unexpected message ${p[0]}`);
    return new Reader(p.subarray(1));
  }

  static async connect(open, cfg) {
    const s = new SshSession(open, cfg);
    try {
      await s.start();
    } catch (e) {
      await s.drop();
      throw e;
    }
    return s;
  }

  async start() {
    const { host, user, pass } = this.cfg;
    if (!host || !user || pass == null) throw new SshError("incomplete SFTP settings (host, user, password)");
    await this.hello();
    await this.auth(user, pass);
    await this.openSftp();
  }

  /** Connects, swaps versions and keys: everything before the login. */
  async hello() {
    const { host, port, timeout } = this.cfg;
    this.socket = await this.open(host, port);
    this.bytes = new ByteReader(this.socket.readable);
    this.writer = this.socket.writable.getWriter();
    await this.writer.write(te.encode(`${CLIENT_VERSION}\r\n`));
    let vs;
    // a server may say a few lines before its version (RFC 4253 4.2)
    for (let i = 0; i < 20; i++) {
      const l = await this.bytes.line(timeout);
      if (l.startsWith("SSH-")) { vs = l; break; }
    }
    if (!vs) throw new SshError("not an SSH server");
    if (!/^SSH-(2\.0|1\.99)-/.test(vs)) throw new SshError(`SSH version not supported: ${vs.slice(0, 40)}`);
    this.serverVersion = vs;
    await this.kex(te.encode(CLIENT_VERSION), te.encode(vs));
  }

  async kex(vc, vs) {
    const algos = this.cfg.algos ? { ...ALGOS, ...this.cfg.algos } : ALGOS;
    const ic = new Writer().byte(MSG.KEXINIT).raw(random(16))
      .str(algos.kex.join(",")).str(algos.hostKey.join(","))
      .str(algos.cipher.join(",")).str(algos.cipher.join(","))
      .str(algos.mac.join(",")).str(algos.mac.join(","))
      .str("none").str("none").str("").str("").bool(false).u32(0).bytes();
    await this.send(ic);
    const is = await this.next();
    if (is[0] !== MSG.KEXINIT) throw new SshError(`key exchange: unexpected message ${is[0]}`);
    const r = new Reader(is.subarray(17));
    const list = () => r.str().split(",").filter(Boolean);
    const [kexS, hostS, encCS, encSC, macCS, macSC, compCS, compSC] = [list(), list(), list(), list(), list(), list(), list(), list()];
    r.str(); r.str();
    const follows = r.bool();
    const kex = pick(algos.kex, kexS, "key exchange");
    const hostAlg = pick(algos.hostKey, hostS, "host key type");
    const cs = pick(algos.cipher, encCS, "cipher");
    const sc = pick(algos.cipher, encSC, "cipher");
    const macCs = CIPHERS[cs].gcm ? null : pick(algos.mac, macCS, "MAC");
    const macSc = CIPHERS[sc].gcm ? null : pick(algos.mac, macSC, "MAC");
    pick(["none"], compCS, "compression");
    pick(["none"], compSC, "compression");
    // a guessed first kex packet from the server is wrong unless its first choices are ours
    let skipGuess = follows && (kexS[0] !== kex || hostS[0] !== hostAlg);
    this.algos = { kex, hostAlg, cs, sc, macCs, macSc };

    const mine = await kexKeys(kex);
    await this.send(new Writer().byte(MSG.KEX_ECDH_INIT).str(mine.pub).bytes());
    let rp = await this.next();
    if (skipGuess) { skipGuess = false; rp = await this.next(); }
    if (rp[0] !== MSG.KEX_ECDH_REPLY) throw new SshError(`key exchange: unexpected message ${rp[0]}`);
    const rr = new Reader(rp.subarray(1));
    const ks = rr.bytes().slice();
    const qs = rr.bytes().slice();
    const sig = rr.bytes().slice();
    const k = await this.mineSecret(mine, qs);
    const kmp = new Writer().mpint(k).bytes();
    const h = await digest("SHA-256", new Writer().str(vc).str(vs).str(ic).str(is).str(ks).str(mine.pub).str(qs).raw(kmp).bytes());
    if (!(await verifyHostSig(hostAlg, ks, sig, h))) throw new SshError("the server's host key signature is wrong");
    this.hostKey = await fingerprint(ks);
    if (this.cfg.hostKey && this.cfg.hostKey !== this.hostKey) {
      throw new SshError(`host key changed: expected ${this.cfg.hostKey}, got ${this.hostKey}`);
    }
    this.sessionId = h;

    await this.send(Uint8Array.of(MSG.NEWKEYS));
    const nk = await this.next();
    if (nk[0] !== MSG.NEWKEYS) throw new SshError(`key exchange: unexpected message ${nk[0]}`);
    const derive = async (letter, need) => {
      let out = await digest("SHA-256", concat(kmp, h, Uint8Array.of(letter.charCodeAt(0)), this.sessionId));
      while (out.length < need) out = concat(out, await digest("SHA-256", concat(kmp, h, out)));
      return out.slice(0, need);
    };
    const need = (c) => Math.max(CIPHERS[c].keyLen, CIPHERS[c].ivLen, 64);
    this.out = await Crypt.make(cs, macCs, await derive("C", need(cs)), await derive("A", need(cs)), await derive("E", 64));
    this.in = await Crypt.make(sc, macSc, await derive("D", need(sc)), await derive("B", need(sc)), await derive("F", 64));
  }

  mineSecret(mine, qs) { return mine.secret(qs); }

  async auth(user, pass) {
    await this.send(new Writer().byte(MSG.SERVICE_REQUEST).str("ssh-userauth").bytes());
    await this.expect(MSG.SERVICE_ACCEPT, "ssh-userauth");
    await this.send(new Writer().byte(MSG.USERAUTH_REQUEST).str(user).str("ssh-connection").str("password").bool(false).str(pass).bytes());
    let p = await this.next();
    if (p[0] === MSG.USERAUTH_SUCCESS) return;
    // 60 after a password request is "change your password": nothing a bridge may do
    if (p[0] === 60) throw new SshError("login refused (the server wants the password changed)");
    if (p[0] !== MSG.USERAUTH_FAILURE) throw new SshError(`login: unexpected message ${p[0]}`);
    let methods = new Reader(p.subarray(1)).str();
    // many OpenSSH hosts take the password only through keyboard-interactive: the same password,
    // answered to each prompt the server asks
    if (methods.split(",").includes("keyboard-interactive")) {
      await this.send(new Writer().byte(MSG.USERAUTH_REQUEST).str(user).str("ssh-connection").str("keyboard-interactive").str("").str("").bytes());
      for (let round = 0; round < 5; round++) {
        p = await this.next();
        if (p[0] === MSG.USERAUTH_SUCCESS) return;
        if (p[0] === MSG.USERAUTH_FAILURE) { methods = new Reader(p.subarray(1)).str(); break; }
        if (p[0] !== MSG.USERAUTH_INFO_REQUEST) throw new SshError(`login: unexpected message ${p[0]}`);
        const r = new Reader(p.subarray(1));
        r.str(); r.str(); r.str();
        const n = r.u32();
        const w = new Writer().byte(MSG.USERAUTH_INFO_RESPONSE).u32(n);
        for (let i = 0; i < n; i++) { r.str(); r.bool(); w.str(pass); }
        await this.send(w.bytes());
      }
    }
    throw new SshError(`login refused (the server takes: ${methods.slice(0, 80)})`);
  }

  // ---------- the channel ----------

  async openSftp() {
    const localWindow = 2 * 1024 * 1024;
    const localMax = 32768;
    await this.send(new Writer().byte(MSG.CHANNEL_OPEN).str("session").u32(0).u32(localWindow).u32(localMax).bytes());
    const p = await this.next();
    if (p[0] === MSG.CHANNEL_OPEN_FAILURE) throw new SshError("the server refused a session channel");
    if (p[0] !== MSG.CHANNEL_OPEN_CONFIRMATION) throw new SshError(`channel: unexpected message ${p[0]}`);
    const r = new Reader(p.subarray(1));
    r.u32();
    this.chan = { remote: r.u32(), window: r.u32(), max: r.u32(), localWindow, localStart: localWindow, data: new Uint8Array(0), closed: false };
    await this.send(new Writer().byte(MSG.CHANNEL_REQUEST).u32(this.chan.remote).str("subsystem").bool(true).str("sftp").bytes());
    for (;;) {
      const q = await this.pump();
      if (q === MSG.CHANNEL_SUCCESS) break;
      if (q === MSG.CHANNEL_FAILURE) throw new SshError("the server has no SFTP on this account");
    }
  }

  /** Handles one incoming message for the channel; returns its type. */
  async pump() {
    const p = await this.next();
    const t = p[0];
    const r = new Reader(p.subarray(1));
    const ch = this.chan;
    if (t === MSG.CHANNEL_DATA || t === MSG.CHANNEL_EXTENDED_DATA) {
      r.u32();
      if (t === MSG.CHANNEL_EXTENDED_DATA) r.u32();
      const d = r.bytes();
      ch.localWindow -= d.length;
      if (t === MSG.CHANNEL_DATA) ch.data = ch.data.length ? concat(ch.data, d) : d.slice();
      if (ch.localWindow < ch.localStart / 2) {
        const add = ch.localStart - ch.localWindow;
        ch.localWindow += add;
        await this.send(new Writer().byte(MSG.CHANNEL_WINDOW_ADJUST).u32(ch.remote).u32(add).bytes());
      }
    } else if (t === MSG.CHANNEL_WINDOW_ADJUST) {
      r.u32();
      ch.window += r.u32();
    } else if (t === MSG.CHANNEL_EOF || t === MSG.CHANNEL_CLOSE) {
      ch.closed = true;
      throw new SshError("the server closed the SFTP channel");
    } else if (t === MSG.CHANNEL_REQUEST) {
      r.u32();
      r.str();
      if (r.bool()) await this.send(new Writer().byte(MSG.CHANNEL_FAILURE).u32(ch.remote).bytes());
    }
    return t;
  }

  async chanWrite(data) {
    const ch = this.chan;
    let off = 0;
    while (off < data.length) {
      while (ch.window === 0) await this.pump();
      const n = Math.min(data.length - off, ch.window, ch.max);
      await this.send(new Writer().byte(MSG.CHANNEL_DATA).u32(ch.remote).str(data.subarray(off, off + n)).bytes());
      ch.window -= n;
      off += n;
    }
  }

  async chanRead(n) {
    const ch = this.chan;
    while (ch.data.length < n) await this.pump();
    const out = ch.data.slice(0, n);
    ch.data = ch.data.subarray(n);
    return out;
  }

  async drop() {
    try { this.bytes?.release(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.socket?.close(); } catch { /* ignore */ }
  }

  async close() {
    try {
      await withDeadline((async () => {
        if (this.chan && !this.chan.closed) await this.send(new Writer().byte(MSG.CHANNEL_CLOSE).u32(this.chan.remote).bytes());
        await this.send(new Writer().byte(MSG.DISCONNECT).u32(11).str("bye").str("").bytes());
      })(), 3000, "SSH close");
    } catch { /* closing anyway */ }
    await this.drop();
  }
}

// ---------- SFTP v3 (draft-ietf-secsh-filexfer-02) ----------

const FX = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, OPENDIR: 11, READDIR: 12, REMOVE: 13,
  MKDIR: 14, RENAME: 18, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104,
};
const ST = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3 };
const PF = { READ: 1, WRITE: 2, CREAT: 8, TRUNC: 0x10 };

function skipAttrs(r) {
  const f = r.u32();
  if (f & 1) r.u64();
  if (f & 2) { r.u32(); r.u32(); }
  if (f & 4) r.u32();
  if (f & 8) { r.u32(); r.u32(); }
  if (f & 0x80000000) { const n = r.u32(); for (let i = 0; i < n; i++) { r.bytes(); r.bytes(); } }
}

export class SftpSession {
  constructor(ssh, cfg) {
    this.ssh = ssh;
    this.cfg = { maxBytes: 4 * 1024 * 1024, chunk: 32768, ...cfg };
    this.id = 0;
  }

  static async connect(open, cfg) {
    const ssh = await SshSession.connect(open, cfg);
    const s = new SftpSession(ssh, cfg);
    try {
      await ssh.chanWrite(new Writer().u32(5).byte(FX.INIT).u32(3).bytes());
      const v = await s.packet();
      if (v.type !== FX.VERSION) throw new SshError(`SFTP: unexpected reply ${v.type}`);
    } catch (e) {
      await ssh.close();
      throw e;
    }
    return s;
  }

  get hostKey() { return this.ssh.hostKey; }

  async packet() {
    const len = new Reader(await this.ssh.chanRead(4)).u32();
    if (len > this.cfg.maxBytes + 1024) throw new SshError(`SFTP reply too large (${len})`);
    const body = await this.ssh.chanRead(len);
    const r = new Reader(body);
    const type = r.byte();
    return { type, r };
  }

  async request(type, build) {
    const id = (this.id = (this.id + 1) >>> 0);
    const w = new Writer().byte(type).u32(id);
    build?.(w);
    const body = w.bytes();
    await this.ssh.chanWrite(concat(u32be(body.length), body));
    const p = await this.packet();
    if (p.r.u32() !== id) throw new SshError("SFTP: reply out of order");
    if (p.type === FX.STATUS) {
      const code = p.r.u32();
      let msg = "";
      try { msg = p.r.str(); } catch { /* v3 servers may omit it */ }
      return { type: p.type, status: code, msg, r: p.r };
    }
    return p;
  }

  fail(what, p) {
    if (p.type === FX.STATUS) return new SshError(`${what}: SFTP status ${p.status} ${String(p.msg || "").slice(0, 100)}`, p.status);
    return new SshError(`${what}: unexpected reply ${p.type}`);
  }

  async handle(type, build, what, missing) {
    const p = await this.request(type, build);
    if (p.type === FX.HANDLE) return p.r.bytes().slice();
    if (p.type === FX.STATUS && p.status === ST.NO_SUCH_FILE && missing) return null;
    throw this.fail(what, p);
  }

  async closeHandle(h) {
    await this.request(FX.CLOSE, (w) => w.str(h)).catch(() => {});
  }

  /** Names directly inside dir. A missing directory gives []. */
  async list(dir) {
    const h = await this.handle(FX.OPENDIR, (w) => w.str(dir), `list ${dir}`, true);
    if (!h) return [];
    const names = [];
    try {
      for (;;) {
        const p = await this.request(FX.READDIR, (w) => w.str(h));
        if (p.type === FX.STATUS && p.status === ST.EOF) break;
        if (p.type !== FX.NAME) throw this.fail(`list ${dir}`, p);
        const n = p.r.u32();
        for (let i = 0; i < n; i++) {
          const name = p.r.str();
          p.r.str();
          skipAttrs(p.r);
          if (name !== "." && name !== "..") names.push(name.replace(/^.*\//, ""));
        }
      }
    } finally {
      await this.closeHandle(h);
    }
    return names;
  }

  /** Whole file as text, or null when it does not exist. */
  async get(path) {
    const h = await this.handle(FX.OPEN, (w) => w.str(path).u32(PF.READ).u32(0), `read ${path}`, true);
    if (!h) return null;
    const chunks = [];
    let off = 0;
    try {
      for (;;) {
        const at = off;
        const p = await this.request(FX.READ, (w) => w.str(h).u64(at).u32(this.cfg.chunk));
        if (p.type === FX.STATUS && p.status === ST.EOF) break;
        if (p.type !== FX.DATA) throw this.fail(`read ${path}`, p);
        const d = p.r.bytes();
        if (!d.length) break;
        off += d.length;
        if (off > this.cfg.maxBytes) throw new SshError(`file larger than ${this.cfg.maxBytes} bytes`);
        chunks.push(d.slice());
      }
    } finally {
      await this.closeHandle(h);
    }
    return td.decode(concat(...chunks));
  }

  async put(path, text) {
    const data = te.encode(text);
    const h = await this.handle(FX.OPEN, (w) => w.str(path).u32(PF.WRITE | PF.CREAT | PF.TRUNC).u32(0), `write ${path}`, false);
    try {
      for (let off = 0; off < data.length; off += this.cfg.chunk) {
        const part = data.subarray(off, off + this.cfg.chunk);
        const at = off;
        const p = await this.request(FX.WRITE, (w) => w.str(h).u64(at).str(part));
        if (!(p.type === FX.STATUS && p.status === ST.OK)) throw this.fail(`write ${path}`, p);
      }
    } finally {
      await this.closeHandle(h);
    }
  }

  async rename(from, to) {
    const p = await this.request(FX.RENAME, (w) => w.str(from).str(to));
    if (!(p.type === FX.STATUS && p.status === ST.OK)) throw this.fail(`rename ${from}`, p);
  }

  /** true when deleted, false when it was not there. */
  async del(path) {
    const p = await this.request(FX.REMOVE, (w) => w.str(path));
    if (p.type === FX.STATUS && p.status === ST.OK) return true;
    if (p.type === FX.STATUS && p.status === ST.NO_SUCH_FILE) return false;
    throw this.fail(`delete ${path}`, p);
  }

  /** Creates a directory; one that already exists is fine. */
  async mkdir(path) {
    const p = await this.request(FX.MKDIR, (w) => w.str(path).u32(0));
    return p.type === FX.STATUS && p.status === ST.OK;
  }

  close() { return this.ssh.close(); }
}

/** Runs fn(session) and always closes the connection. */
export async function withSftp(open, cfg, fn) {
  const s = await SftpSession.connect(open, cfg);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

/**
 * Which protocol a host speaks, from its first line: SSH servers say "SSH-2.0-...", FTP servers
 * "220 ...". The probe connection is closed; the caller opens the real one.
 */
export async function detectProtocol(open, host, port, ms = 10000) {
  const socket = await open(host, port);
  const bytes = new ByteReader(socket.readable);
  try {
    const l = await bytes.line(ms);
    if (l.startsWith("SSH-")) return "sftp";
    if (/^220[ -]/.test(l)) return "ftp";
    // an SSH server may print a banner before its version line; FTP never does
    for (let i = 0; i < 20; i++) if ((await bytes.line(ms)).startsWith("SSH-")) return "sftp";
    throw new SshError("the host speaks neither FTP nor SFTP");
  } finally {
    bytes.release();
    try { await socket.close(); } catch { /* ignore */ }
  }
}
