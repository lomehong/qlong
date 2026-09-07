var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../core/src/params.ts
var DEFAULT_PARAMS = {
  offerTtlMsProject: 6e4,
  offerTtlMsAid: 1e4,
  leaseMsProject: 3e5,
  leaseMsAid: 12e4,
  graceMs: 3e4,
  drainMs: 3e4,
  cancelWaitMs: 3e4,
  expDriftBudgetMs: 10 * 60 * 1e3,
  expHorizonMs: 24 * 60 * 60 * 1e3,
  maxAttempts: 3,
  maxDispatchRounds: 3,
  maxHops: 8,
  maxBodyInlineBytes: 256 * 1024
};
function defaultOfferTtlMs(kind, p = DEFAULT_PARAMS) {
  return kind === "aid" ? p.offerTtlMsAid : p.offerTtlMsProject;
}
function defaultLeaseMs(kind, p = DEFAULT_PARAMS) {
  return kind === "aid" ? p.leaseMsAid : p.leaseMsProject;
}
function heartbeatIntervalMs(leaseMs) {
  return Math.floor(leaseMs / 3);
}
function lostAfterMs(leaseMs, p = DEFAULT_PARAMS) {
  return 2 * heartbeatIntervalMs(leaseMs) + p.graceMs;
}

// ../core/src/reason-codes.ts
var REJECT_CODES = [
  "busy",
  "policy_denied",
  "unsupported_caps",
  "unsupported_version",
  "unsupported_type",
  "expired",
  "refused_loop",
  "stale_attempt",
  "other"
];
var FAIL_CODES = [
  "deadline_exceeded",
  "caps_missing",
  "payload_unavailable",
  "payload_corrupt",
  "internal_error",
  "cancelled_by_peer",
  "other"
];
function normalizeRejectCode(raw) {
  return REJECT_CODES.includes(raw) ? { code: raw, custom: false } : { code: "other", custom: true };
}
function normalizeFailCode(raw) {
  return FAIL_CODES.includes(raw) ? { code: raw, custom: false } : { code: "other", custom: true };
}

// ../core/src/ids.ts
function newId() {
  return globalThis.crypto.randomUUID();
}

// ../../node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// ../../node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// ../../node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G: G2, H } = this;
    return [A, B, C, D, E, F, G2, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G2, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G2 | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G: G2, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G2;
      G2 = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G2 = G2 + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G2, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA2_64B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // h -- high 32 bits, l -- low 32 bits
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and slows hashing down (measured on sha256).
  Ah = 0;
  Al = 0;
  Bh = 0;
  Bl = 0;
  Ch = 0;
  Cl = 0;
  Dh = 0;
  Dl = 0;
  Eh = 0;
  El = 0;
  Fh = 0;
  Fl = 0;
  Gh = 0;
  Gl = 0;
  Hh = 0;
  Hl = 0;
  constructor(outputLen, IV) {
    super(128, outputLen, 16, false);
    this.Ah = IV[0] | 0;
    this.Al = IV[1] | 0;
    this.Bh = IV[2] | 0;
    this.Bl = IV[3] | 0;
    this.Ch = IV[4] | 0;
    this.Cl = IV[5] | 0;
    this.Dh = IV[6] | 0;
    this.Dl = IV[7] | 0;
    this.Eh = IV[8] | 0;
    this.El = IV[9] | 0;
    this.Fh = IV[10] | 0;
    this.Fl = IV[11] | 0;
    this.Gh = IV[12] | 0;
    this.Gl = IV[13] | 0;
    this.Hh = IV[14] | 0;
    this.Hl = IV[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var _SHA512 = class extends SHA2_64B {
  constructor() {
    super(64, SHA512_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);
var sha512 = /* @__PURE__ */ createHasher(
  () => new _SHA512(),
  /* @__PURE__ */ oidNist(3)
);

// ../core/src/hash.ts
var te = new TextEncoder();
function sha256Hex(text) {
  const digest = sha256(te.encode(text));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

// ../../node_modules/canonicalize/lib/canonicalize.js
var canonicalize_exports = {};
__export(canonicalize_exports, {
  default: () => canonicalize
});
function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      if (i === value.length - 1) {
        return true;
      }
      const next = value.charCodeAt(i + 1);
      if (!(next >= 56320 && next <= 57343)) {
        return true;
      }
      i++;
    } else if (code >= 56320 && code <= 57343) {
      return true;
    }
  }
  return false;
}
function canonicalize(object, seen = /* @__PURE__ */ new Set()) {
  if (typeof object === "number" && isNaN(object)) {
    throw new Error("NaN is not allowed");
  }
  if (typeof object === "number" && !isFinite(object)) {
    throw new Error("Infinity is not allowed");
  }
  if (typeof object === "string" && hasLoneSurrogate(object)) {
    throw new Error("Lone surrogate is not allowed");
  }
  if (object === null || typeof object !== "object") {
    return JSON.stringify(object);
  }
  if (typeof object.toJSON === "function") {
    if (seen.has(object)) {
      throw new Error("Circular reference detected");
    }
    seen.add(object);
    const result2 = canonicalize(object.toJSON(), seen);
    seen.delete(object);
    return result2;
  }
  if (seen.has(object)) {
    throw new Error("Circular reference detected");
  }
  seen.add(object);
  let result;
  if (Array.isArray(object)) {
    const values = object.map((cv) => {
      const value = cv === void 0 || typeof cv === "symbol" ? null : cv;
      return canonicalize(value, seen);
    });
    result = `[${values.join(",")}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(object).sort()) {
      if (object[key] === void 0 || typeof object[key] === "symbol") {
        continue;
      }
      parts.push(`${canonicalize(key)}:${canonicalize(object[key], seen)}`);
    }
    result = `{${parts.join(",")}}`;
  }
  seen.delete(object);
  return result;
}

// ../core/src/jcs.ts
var mod = canonicalize_exports;
var impl = typeof mod === "function" ? mod : mod.default ?? mod.canonicalize ?? mod;
function jcs(input) {
  const out = impl(input);
  if (typeof out !== "string") throw new TypeError("JCS: \u8F93\u5165\u4E0D\u53EF\u5E8F\u5217\u5316");
  return out;
}

// ../../node_modules/@noble/ed25519/index.js
var P = 2n ** 255n - 19n;
var N = 2n ** 252n + 27742317777372353535851937790883648493n;
var Gx = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an;
var Gy = 0x6666666666666666666666666666666666666666666666666666666666666658n;
var CURVE = {
  a: -1n,
  d: 37095705934669439343138083508754565189542113879843219016388785533085940283555n,
  p: P,
  n: N,
  h: 8,
  Gx,
  Gy
  // field prime, curve (group) order, cofactor
};
var err = (m = "") => {
  throw new Error(m);
};
var str = (s) => typeof s === "string";
var au8 = (a, l) => (
  // is Uint8Array (of specific length)
  !(a instanceof Uint8Array) || typeof l === "number" && l > 0 && a.length !== l ? err("Uint8Array expected") : a
);
var u8n = (data) => new Uint8Array(data);
var toU8 = (a, len) => au8(str(a) ? h2b(a) : u8n(a), len);
var mod2 = (a, b = P) => {
  let r = a % b;
  return r >= 0n ? r : b + r;
};
var isPoint = (p) => p instanceof Point ? p : err("Point expected");
var Gpows = void 0;
var Point = class _Point {
  constructor(ex, ey, ez, et) {
    this.ex = ex;
    this.ey = ey;
    this.ez = ez;
    this.et = et;
  }
  static fromAffine(p) {
    return new _Point(p.x, p.y, 1n, mod2(p.x * p.y));
  }
  static fromHex(hex, strict = true) {
    const { d } = CURVE;
    hex = toU8(hex, 32);
    const normed = hex.slice();
    normed[31] = hex[31] & ~128;
    const y = b2n_LE(normed);
    if (y === 0n) {
    } else {
      if (strict && !(0n < y && y < P))
        err("bad y coord 1");
      if (!strict && !(0n < y && y < 2n ** 256n))
        err("bad y coord 2");
    }
    const y2 = mod2(y * y);
    const u = mod2(y2 - 1n);
    const v = mod2(d * y2 + 1n);
    let { isValid, value: x } = uvRatio(u, v);
    if (!isValid)
      err("bad y coordinate 3");
    const isXOdd = (x & 1n) === 1n;
    const isHeadOdd = (hex[31] & 128) !== 0;
    if (isHeadOdd !== isXOdd)
      x = mod2(-x);
    return new _Point(x, y, 1n, mod2(x * y));
  }
  get x() {
    return this.toAffine().x;
  }
  // .x, .y will call expensive toAffine.
  get y() {
    return this.toAffine().y;
  }
  // Should be used with care.
  equals(other) {
    const { ex: X1, ey: Y1, ez: Z1 } = this;
    const { ex: X2, ey: Y2, ez: Z2 } = isPoint(other);
    const X1Z2 = mod2(X1 * Z2), X2Z1 = mod2(X2 * Z1);
    const Y1Z2 = mod2(Y1 * Z2), Y2Z1 = mod2(Y2 * Z1);
    return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
  }
  is0() {
    return this.equals(I);
  }
  negate() {
    return new _Point(mod2(-this.ex), this.ey, this.ez, mod2(-this.et));
  }
  double() {
    const { ex: X1, ey: Y1, ez: Z1 } = this;
    const { a } = CURVE;
    const A = mod2(X1 * X1);
    const B = mod2(Y1 * Y1);
    const C = mod2(2n * mod2(Z1 * Z1));
    const D = mod2(a * A);
    const x1y1 = X1 + Y1;
    const E = mod2(mod2(x1y1 * x1y1) - A - B);
    const G2 = D + B;
    const F = G2 - C;
    const H = D - B;
    const X3 = mod2(E * F);
    const Y3 = mod2(G2 * H);
    const T3 = mod2(E * H);
    const Z3 = mod2(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  add(other) {
    const { ex: X1, ey: Y1, ez: Z1, et: T1 } = this;
    const { ex: X2, ey: Y2, ez: Z2, et: T2 } = isPoint(other);
    const { a, d } = CURVE;
    const A = mod2(X1 * X2);
    const B = mod2(Y1 * Y2);
    const C = mod2(T1 * d * T2);
    const D = mod2(Z1 * Z2);
    const E = mod2((X1 + Y1) * (X2 + Y2) - A - B);
    const F = mod2(D - C);
    const G2 = mod2(D + C);
    const H = mod2(B - a * A);
    const X3 = mod2(E * F);
    const Y3 = mod2(G2 * H);
    const T3 = mod2(E * H);
    const Z3 = mod2(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  mul(n, safe = true) {
    if (n === 0n)
      return safe === true ? err("cannot multiply by 0") : I;
    if (!(typeof n === "bigint" && 0n < n && n < N))
      err("invalid scalar, must be < L");
    if (!safe && this.is0() || n === 1n)
      return this;
    if (this.equals(G))
      return wNAF(n).p;
    let p = I, f = G;
    for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
      if (n & 1n)
        p = p.add(d);
      else if (safe)
        f = f.add(d);
    }
    return p;
  }
  multiply(scalar) {
    return this.mul(scalar);
  }
  // Aliases for compatibilty
  clearCofactor() {
    return this.mul(BigInt(CURVE.h), false);
  }
  // multiply by cofactor
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  // check if P is small order
  isTorsionFree() {
    let p = this.mul(N / 2n, false).double();
    if (N % 2n)
      p = p.add(this);
    return p.is0();
  }
  toAffine() {
    const { ex: x, ey: y, ez: z } = this;
    if (this.is0())
      return { x: 0n, y: 0n };
    const iz = invert(z);
    if (mod2(z * iz) !== 1n)
      err("invalid inverse");
    return { x: mod2(x * iz), y: mod2(y * iz) };
  }
  toRawBytes() {
    const { x, y } = this.toAffine();
    const b = n2b_32LE(y);
    b[31] |= x & 1n ? 128 : 0;
    return b;
  }
  toHex() {
    return b2h(this.toRawBytes());
  }
  // encode to hex string
};
Point.BASE = new Point(Gx, Gy, 1n, mod2(Gx * Gy));
Point.ZERO = new Point(0n, 1n, 1n, 0n);
var { BASE: G, ZERO: I } = Point;
var padh = (num, pad) => num.toString(16).padStart(pad, "0");
var b2h = (b) => Array.from(b).map((e) => padh(e, 2)).join("");
var h2b = (hex) => {
  const l = hex.length;
  if (!str(hex) || l % 2)
    err("hex invalid 1");
  const arr = u8n(l / 2);
  for (let i = 0; i < arr.length; i++) {
    const j = i * 2;
    const h = hex.slice(j, j + 2);
    const b = Number.parseInt(h, 16);
    if (Number.isNaN(b) || b < 0)
      err("hex invalid 2");
    arr[i] = b;
  }
  return arr;
};
var n2b_32LE = (num) => h2b(padh(num, 32 * 2)).reverse();
var b2n_LE = (b) => BigInt("0x" + b2h(u8n(au8(b)).reverse()));
var concatB = (...arrs) => {
  const r = u8n(arrs.reduce((sum, a) => sum + au8(a).length, 0));
  let pad = 0;
  arrs.forEach((a) => {
    r.set(a, pad);
    pad += a.length;
  });
  return r;
};
var invert = (num, md = P) => {
  if (num === 0n || md <= 0n)
    err("no inverse n=" + num + " mod=" + md);
  let a = mod2(num, md), b = md, x = 0n, y = 1n, u = 1n, v = 0n;
  while (a !== 0n) {
    const q = b / a, r = b % a;
    const m = x - u * q, n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  return b === 1n ? mod2(x, md) : err("no inverse");
};
var pow2 = (x, power) => {
  let r = x;
  while (power-- > 0n) {
    r *= r;
    r %= P;
  }
  return r;
};
var pow_2_252_3 = (x) => {
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, 2n) * b2 % P;
  const b5 = pow2(b4, 1n) * x % P;
  const b10 = pow2(b5, 5n) * b5 % P;
  const b20 = pow2(b10, 10n) * b10 % P;
  const b40 = pow2(b20, 20n) * b20 % P;
  const b80 = pow2(b40, 40n) * b40 % P;
  const b160 = pow2(b80, 80n) * b80 % P;
  const b240 = pow2(b160, 80n) * b80 % P;
  const b250 = pow2(b240, 10n) * b10 % P;
  const pow_p_5_8 = pow2(b250, 2n) * x % P;
  return { pow_p_5_8, b2 };
};
var RM1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
var uvRatio = (u, v) => {
  const v3 = mod2(v * v * v);
  const v7 = mod2(v3 * v3 * v);
  const pow = pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod2(u * v3 * pow);
  const vx2 = mod2(v * x * x);
  const root1 = x;
  const root2 = mod2(x * RM1);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod2(-u);
  const noRoot = vx2 === mod2(-u * RM1);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if ((mod2(x) & 1n) === 1n)
    x = mod2(-x);
  return { isValid: useRoot1 || useRoot2, value: x };
};
var _shaS;
var cr = () => (
  // We support: 1) browsers 2) node.js 19+
  typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0
);
var etc = {
  bytesToHex: b2h,
  hexToBytes: h2b,
  concatBytes: concatB,
  mod: mod2,
  invert,
  randomBytes: (len) => {
    const crypto = cr();
    if (!crypto)
      err("crypto.getRandomValues must be defined");
    return crypto.getRandomValues(u8n(len));
  },
  sha512Async: async (...messages) => {
    const crypto = cr();
    if (!crypto)
      err("crypto.subtle or etc.sha512Async must be defined");
    const m = concatB(...messages);
    return u8n(await crypto.subtle.digest("SHA-512", m.buffer));
  },
  sha512Sync: void 0
  // Actual logic below
};
Object.defineProperties(etc, { sha512Sync: {
  configurable: false,
  get() {
    return _shaS;
  },
  set(f) {
    if (!_shaS)
      _shaS = f;
  }
} });
var W = 8;
var precompute = () => {
  const points = [];
  const windows = 256 / W + 1;
  let p = G, b = p;
  for (let w = 0; w < windows; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < 2 ** (W - 1); i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  const neg = (cnd, p2) => {
    let n2 = p2.negate();
    return cnd ? n2 : p2;
  };
  let p = I, f = G;
  const windows = 1 + 256 / W;
  const wsize = 2 ** (W - 1);
  const mask = BigInt(2 ** W - 1);
  const maxNum = 2 ** W;
  const shiftBy = BigInt(W);
  for (let w = 0; w < windows; w++) {
    const off = w * wsize;
    let wbits = Number(n & mask);
    n >>= shiftBy;
    if (wbits > wsize) {
      wbits -= maxNum;
      n += 1n;
    }
    const off1 = off, off2 = off + Math.abs(wbits) - 1;
    const cnd1 = w % 2 !== 0, cnd2 = wbits < 0;
    if (wbits === 0) {
      f = f.add(neg(cnd1, comp[off1]));
    } else {
      p = p.add(neg(cnd2, comp[off2]));
    }
  }
  return { p, f };
};

// ../core/src/sig.ts
etc.sha512Sync = (...m) => sha512(etc.concatBytes(...m));
etc.sha512Async = (...m) => Promise.all(m).then((i) => sha512(etc.concatBytes(...i)));
var te2 = new TextEncoder();

// ../core/src/freshness.ts
function isExpiredByExp(exp, receivedAtMs, driftBudgetMs = DEFAULT_PARAMS.expDriftBudgetMs) {
  const expMs = Date.parse(exp);
  if (Number.isNaN(expMs)) return true;
  return receivedAtMs > expMs + driftBudgetMs;
}

// ../core/src/audit.ts
function envelopeHeadDigest(env) {
  const { body: _body, ...head } = env;
  return sha256Hex(jcs(head)).slice(0, 32);
}
function makeAudit(event, fields, nowIso = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const rec = { event, ts: nowIso(), node_id: fields.node_id };
  if (fields.reason !== void 0) rec.reason = fields.reason;
  if (fields.envelope) rec.envelope_head_digest = envelopeHeadDigest(fields.envelope);
  if (fields.trace_id !== void 0) rec.trace_id = fields.trace_id;
  if (fields.task_id !== void 0) rec.task_id = fields.task_id;
  if (fields.attempt !== void 0) rec.attempt = fields.attempt;
  return rec;
}

// ../core/src/caps.ts
var KNOWN_CAP_CLASSES = ["env", "tool", "hw", "net", "ext"];
function parseTag(tag) {
  const i = tag.indexOf(":");
  if (i <= 0) return null;
  const cls = tag.slice(0, i);
  const rest = tag.slice(i + 1);
  const at = rest.indexOf("@");
  if (at < 0) return { cls, value: rest, version: null };
  return { cls, value: rest.slice(0, at), version: rest.slice(at + 1).split(".") };
}
function isNumeric(s) {
  return /^\d+$/.test(s);
}
function versionMatch(req, own) {
  if (own.length < req.length) return false;
  for (let i = 0; i < req.length; i++) {
    const r = req[i];
    const o = own[i];
    if (isNumeric(r) && isNumeric(o)) {
      if (Number(r) !== Number(o)) return false;
    } else if (r !== o) {
      return false;
    }
  }
  return true;
}
function matchOne(required, owned) {
  const r = parseTag(required);
  if (!r) return false;
  const known = KNOWN_CAP_CLASSES.includes(r.cls);
  for (const o of owned) {
    const p = parseTag(o);
    if (!p || p.cls !== r.cls) continue;
    if (!known) {
      if (o === required) return true;
      continue;
    }
    if (p.value !== r.value) continue;
    if (!r.version) return true;
    if (!p.version) continue;
    if (versionMatch(r.version, p.version)) return true;
  }
  return false;
}
function matchCaps(required, owned) {
  const missing = required.filter((r) => !matchOne(r, owned));
  return { ok: missing.length === 0, missing };
}

// ../node/src/lead/machine.ts
var ACTIVE_TIMERS = ["offer_ttl", "lease", "drain", "cancel_wait"];
var LeadTaskMachine = class {
  task_id;
  rec;
  params;
  terminal = false;
  validateAcceptance;
  constructor(init) {
    this.task_id = init.task_id;
    this.params = init.params ?? DEFAULT_PARAMS;
    this.validateAcceptance = init.validateAcceptance ?? ((b) => {
      const arr = b.acceptance_results;
      if (!Array.isArray(arr)) return true;
      return arr.every((x) => x?.pass !== false);
    });
    this.rec = {
      task_id: init.task_id,
      kind: init.kind,
      leaseMs: init.kind === "aid" ? this.params.leaseMsAid : this.params.leaseMsProject,
      state: "drafting",
      attempt: 0,
      target: null,
      acceptedThisAttempt: false,
      acceptedFailedBudget: 0,
      dispatchRounds: 0,
      excluded: {},
      history: []
    };
  }
  out(type, to, body, replyTo) {
    return {
      kind: "send",
      msg: { type, to_node: to, task_id: this.task_id, attempt: this.rec.attempt, reply_to: replyTo, body }
    };
  }
  stopTimers() {
    return { kind: "cancelTimers", timers: [...ACTIVE_TIMERS] };
  }
  finish(state) {
    this.terminal = true;
    this.rec.state = state;
    return [this.stopTimers(), { kind: "terminal", state }];
  }
  /** 初始派发(attempt=1)或对 requestDispatch 的应答(attempt+1)。R4:撤销已在进入本调用前完成。 */
  dispatchTo(target, offerBody, now) {
    if (this.terminal) return [];
    if (this.rec.state !== "drafting") return [];
    this.rec.attempt = 1;
    this.rec.target = target;
    this.rec.acceptedThisAttempt = false;
    this.rec.state = "offered";
    const ttl = typeof offerBody.offer_ttl_ms === "number" ? offerBody.offer_ttl_ms : defaultOfferTtlMs(this.rec.kind, this.params);
    this.rec.offerTtlUntil = now + ttl;
    delete this.rec.drainUntil;
    delete this.rec.drainClosed;
    return [
      this.stopTimers(),
      this.out("task.offer", target, offerBody),
      { kind: "schedule", timer: "offer_ttl", atMs: this.rec.offerTtlUntil }
    ];
  }
  /** 对 requestDispatch 的应答:attempt+1 重新派发(R4 撤销已完成) */
  redispatchTo(target, offerBody, now) {
    if (this.terminal || this.rec.state !== "drafting") return [];
    this.rec.attempt += 1;
    this.rec.target = target;
    this.rec.acceptedThisAttempt = false;
    this.rec.state = "offered";
    const ttl = typeof offerBody.offer_ttl_ms === "number" ? offerBody.offer_ttl_ms : defaultOfferTtlMs(this.rec.kind, this.params);
    this.rec.offerTtlUntil = now + ttl;
    delete this.rec.drainUntil;
    delete this.rec.drainClosed;
    return [
      this.stopTimers(),
      this.out("task.offer", target, offerBody),
      { kind: "schedule", timer: "offer_ttl", atMs: this.rec.offerTtlUntil }
    ];
  }
  /** 入站 task.*(attempt 已对齐本记录;attempt 不符的先行处置见 onForeignAttempt) */
  onMessage(type, fromNode, attempt, body, now) {
    if (this.terminal) return [];
    if (attempt !== this.rec.attempt) {
      if (attempt < this.rec.attempt) {
        return [
          this.out("task.reject", fromNode, { reason_code: "stale_attempt" }),
          { kind: "audit", event: "stale_attempt_rejected", reason: `inbound attempt ${attempt} < current ${this.rec.attempt}` }
        ];
      }
      return [{ kind: "audit", event: "stale_attempt_rejected", reason: `inbound attempt ${attempt} > current` }];
    }
    switch (this.rec.state) {
      case "offered":
        return this.onOfferedMessage(type, fromNode, body, now);
      case "running":
        return this.onRunningMessage(type, fromNode, body, now);
      case "reclaiming":
        return this.onReclaimingMessage(type, body, now);
      case "cancelling":
        return this.onCancellingMessage(type, body);
      default:
        return [];
    }
  }
  onOfferedMessage(type, fromNode, body, now) {
    if (type === "task.accept" && fromNode === this.rec.target) {
      this.rec.acceptedThisAttempt = true;
      this.rec.state = "running";
      const lease = typeof body.lease_ms === "number" ? body.lease_ms : this.rec.leaseMs;
      this.rec.leaseMs = lease;
      this.rec.leaseDeadline = now + lostAfterMs(lease, this.params);
      this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: "accepted" });
      return [
        this.stopTimers(),
        { kind: "schedule", timer: "lease", atMs: this.rec.leaseDeadline }
      ];
    }
    if (type === "task.reject" && fromNode === this.rec.target) {
      const { code } = normalizeRejectCode(typeof body.reason_code === "string" ? body.reason_code : "other");
      this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: "rejected", reason_code: code });
      this.applyExclusion(code, body);
      return this.budgetOrEscalate(now, false);
    }
    return [];
  }
  onRunningMessage(type, fromNode, body, now) {
    if (fromNode !== this.rec.target) return [];
    if (type === "task.progress") {
      this.rec.leaseDeadline = now + lostAfterMs(this.rec.leaseMs, this.params);
      return [
        { kind: "cancelTimers", timers: ["lease"] },
        { kind: "schedule", timer: "lease", atMs: this.rec.leaseDeadline }
      ];
    }
    if (type === "task.result") {
      this.rec.resultBody = body;
      if (this.validateAcceptance(body)) {
        this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: "result_delivered" });
        return this.finish("done");
      }
      return this.beginReclaim("acceptance_failed", now, {
        node: fromNode,
        attempt: this.rec.attempt,
        outcome: "acceptance_failed"
      });
    }
    if (type === "task.fail") {
      const { code } = normalizeFailCodeOrReject(body.reason_code);
      const retryable = body.retryable !== false;
      if (!retryable) {
        this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: "fail_fatal", reason_code: code });
        return this.finish("failed");
      }
      return this.beginReclaim("reclaim", now, {
        node: fromNode,
        attempt: this.rec.attempt,
        outcome: "fail_retryable",
        reason_code: code
      });
    }
    if (type === "task.cancel.ack") {
      return [];
    }
    return [];
  }
  onReclaimingMessage(type, body, now) {
    if (this.rec.drainClosed) return [];
    if (type === "task.result") {
      this.rec.resultBody = body;
      if (!this.validateAcceptance(body)) {
        this.rec.history.push({
          node: this.rec.target ?? "?",
          attempt: this.rec.attempt,
          outcome: "acceptance_failed"
        });
        return [];
      }
      this.rec.history.push({ node: this.rec.target ?? "?", attempt: this.rec.attempt, outcome: "result_delivered" });
      return this.finish("done");
    }
    if (type === "task.fail") {
      const { code } = normalizeFailCodeOrReject(body.reason_code);
      if (body.retryable === false) {
        this.rec.history.push({ node: this.rec.target ?? "?", attempt: this.rec.attempt, outcome: "fail_fatal", reason_code: code });
        return this.finish("failed");
      }
      this.rec.history.push({ node: this.rec.target ?? "?", attempt: this.rec.attempt, outcome: "fail_retryable", reason_code: code });
      return [];
    }
    if (type === "task.cancel.ack") {
      this.rec.drainClosed = true;
      return this.budgetOrEscalate(now, this.rec.acceptedThisAttempt);
    }
    return [];
  }
  onCancellingMessage(type, body) {
    if (type === "task.result") {
      this.rec.resultBody = body;
      this.rec.history.push({ node: this.rec.target ?? "?", attempt: this.rec.attempt, outcome: "result_delivered" });
      return this.finish("done");
    }
    if (type === "task.fail") {
      return this.finish("closed");
    }
    if (type === "task.cancel.ack") {
      return this.finish("closed");
    }
    return [];
  }
  onTimer(timer, now) {
    if (this.terminal) return [];
    if (timer === "offer_ttl" && this.rec.state === "offered") {
      this.rec.history.push({ node: this.rec.target ?? "?", attempt: this.rec.attempt, outcome: "expired" });
      return this.beginReclaim("reclaim", now);
    }
    if (timer === "lease" && this.rec.state === "running") {
      if (this.rec.leaseDeadline !== void 0 && now < this.rec.leaseDeadline) {
        return [{ kind: "schedule", timer: "lease", atMs: this.rec.leaseDeadline }];
      }
      this.rec.history.push({ node: this.rec.target ?? "?", attempt: this.rec.attempt, outcome: "lost" });
      const actions = this.beginReclaim("reclaim", now);
      return [{ kind: "audit", event: "reclaim", reason: "lease lost" }, ...actions];
    }
    if (timer === "drain" && this.rec.state === "reclaiming" && !this.rec.drainClosed) {
      this.rec.drainClosed = true;
      return this.budgetOrEscalate(now, this.rec.acceptedThisAttempt);
    }
    if (timer === "cancel_wait" && this.rec.state === "cancelling") {
      return this.finish("closed");
    }
    return [];
  }
  cancelByUser(now) {
    if (this.terminal) return [];
    if (this.rec.state === "cancelling") return [];
    this.rec.cancelReason = "user";
    const target = this.rec.target;
    const sendCancel = target ? [this.out("task.cancel", target, { reason: "user" })] : [];
    this.rec.cancelWaitUntil = now + this.params.cancelWaitMs;
    this.rec.state = "cancelling";
    return [
      this.stopTimers(),
      ...sendCancel,
      { kind: "schedule", timer: "cancel_wait", atMs: this.rec.cancelWaitUntil }
    ];
  }
  /** R4:一切回收路径统一 先撤销、后改派 */
  beginReclaim(reason, now, historyEntry) {
    if (historyEntry) this.rec.history.push(historyEntry);
    this.rec.state = "reclaiming";
    this.rec.drainClosed = false;
    this.rec.drainUntil = now + this.params.drainMs;
    const cancelBody = { reason };
    const target = this.rec.target;
    return [
      this.stopTimers(),
      ...target ? [this.out("task.cancel", target, cancelBody)] : [],
      { kind: "audit", event: "reclaim", reason },
      { kind: "schedule", timer: "drain", atMs: this.rec.drainUntil }
    ];
  }
  /** R7:双预算(已接受失败 / 未接受改派轮次);耗尽 → escalate(结构化事件,§11) */
  budgetOrEscalate(_now, acceptedThisAttempt) {
    if (acceptedThisAttempt) this.rec.acceptedFailedBudget += 1;
    else this.rec.dispatchRounds += 1;
    const exhausted = this.rec.acceptedFailedBudget >= this.params.maxAttempts || this.rec.dispatchRounds >= this.params.maxDispatchRounds;
    if (exhausted) {
      const summary = {
        task_id: this.task_id,
        attempts: [...this.rec.history],
        final_reason: acceptedThisAttempt ? `accepted-failure budget exhausted (${this.rec.acceptedFailedBudget}/${this.params.maxAttempts})` : `dispatch-round budget exhausted (${this.rec.dispatchRounds}/${this.params.maxDispatchRounds})`
      };
      this.terminal = true;
      this.rec.state = "escalated";
      return [
        this.stopTimers(),
        { kind: "audit", event: "escalate", reason: summary.final_reason },
        { kind: "escalate", summary },
        { kind: "terminal", state: "escalated" }
      ];
    }
    this.rec.state = "drafting";
    return [{ kind: "requestDispatch", nextAttempt: this.rec.attempt + 1 }];
  }
  /** R8:按失败性质区分排除 */
  applyExclusion(code, body) {
    if (!this.rec.target) return;
    const persistent = code === "unsupported_caps" || code === "policy_denied" || code === "refused_loop";
    if (persistent) {
      this.rec.excluded[this.rec.target] = "permanent";
      return;
    }
    if (code === "busy" && typeof body.retry_after_ms === "number") return;
    if (code === "busy") return;
    this.rec.excluded[this.rec.target] = "once";
  }
};
function normalizeFailCodeOrReject(raw) {
  return { code: normalizeFailCode(typeof raw === "string" ? raw : "other").code };
}

// ../node/src/lead/checkpoint.ts
function checkpointLeadMachine(m) {
  const cp = { v: 1, task_id: m.task_id, kind: m.rec.kind, terminal: m.terminal, rec: m.rec };
  return JSON.stringify(cp);
}
function restoreLeadMachine(blob, opts = {}) {
  const cp = JSON.parse(blob);
  if (cp.v !== 1) throw new Error(`checkpoint: \u4E0D\u652F\u6301\u7684\u7248\u672C ${cp.v}`);
  const m = new LeadTaskMachine({
    task_id: cp.task_id,
    kind: cp.kind,
    params: opts.params,
    validateAcceptance: opts.validateAcceptance
  });
  m.rec = cp.rec;
  m.terminal = cp.terminal;
  return m;
}
function pendingTimers(m) {
  const r = m.rec;
  const out = [];
  if (r.state === "offered" && r.offerTtlUntil !== void 0) out.push({ timer: "offer_ttl", atMs: r.offerTtlUntil });
  if (r.state === "running" && r.leaseDeadline !== void 0) out.push({ timer: "lease", atMs: r.leaseDeadline });
  if (r.state === "reclaiming" && !r.drainClosed && r.drainUntil !== void 0) {
    out.push({ timer: "drain", atMs: r.drainUntil });
  }
  if (r.state === "cancelling" && r.cancelWaitUntil !== void 0) {
    out.push({ timer: "cancel_wait", atMs: r.cancelWaitUntil });
  }
  return out;
}

// ../node/src/executor/gates.ts
function gatePolicy(policy, offer) {
  if (!policy) return { ok: true };
  const r = policy(offer);
  return r.ok ? { ok: true } : {
    ok: false,
    code: "policy_denied",
    detail: r.retry_after_ms !== void 0 ? { retry_after_ms: r.retry_after_ms } : void 0
  };
}
function gateCaps(requiredCaps, owned) {
  if (!requiredCaps || requiredCaps.length === 0) return { ok: true };
  const m = matchCaps(requiredCaps, owned);
  return m.ok ? { ok: true } : { ok: false, code: "unsupported_caps", detail: { missing: m.missing } };
}
function gateLoad(load) {
  if (!load) return { ok: true };
  if (load.queueDepth > load.maxQueue || load.running > load.maxRunning) {
    return {
      ok: false,
      code: "busy",
      detail: load.retryAfterMs !== void 0 ? { retry_after_ms: load.retryAfterMs } : void 0
    };
  }
  return { ok: true };
}

// ../node/src/executor/machine.ts
var ALL_TIMERS = ["ttl", "lease_self", "heartbeat"];
var ExecutorMachine = class {
  rec;
  params;
  opts;
  constructor(opts = {}) {
    this.opts = opts;
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.rec = { state: "idle", lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
  }
  out(type, to, body, replyTo) {
    return {
      kind: "send",
      msg: {
        type,
        to_node: to,
        task_id: this.rec.task_id,
        attempt: this.rec.attempt,
        reply_to: replyTo,
        body
      }
    };
  }
  stopAllTimers() {
    return { kind: "cancelTimers", timers: [...ALL_TIMERS] };
  }
  /**
   * 入站 offer(R0:更高 attempt = 隐式取消旧态;相同 attempt = 重复忽略;更低 = stale)。
   * 通过五道闸(闸1 在传输层)后接受并启动驱动。
   */
  onOffer(o) {
    if (this.rec.task_id === o.task_id && (this.rec.state === "result_sent" || this.rec.state === "fail_sent" || this.rec.state === "stopped" || this.rec.state === "cleaned") && (o.attempt ?? 0) <= (this.rec.attempt ?? 0)) {
      return [];
    }
    if ((this.rec.state === "offered" || this.rec.state === "running") && this.rec.task_id === o.task_id) {
      if (o.attempt === this.rec.attempt) return [];
      if (o.attempt < (this.rec.attempt ?? 0)) {
        return [
          this.out("task.reject", o.from, { reason_code: "stale_attempt" }),
          { kind: "audit", event: "stale_attempt_rejected", reason: "inbound attempt < local" }
        ];
      }
      const staleReject = {
        type: "task.reject",
        to_node: o.from,
        task_id: o.task_id,
        attempt: this.rec.attempt,
        body: { reason_code: "stale_attempt", detail: { old_attempt: this.rec.attempt, old_state: this.rec.state } }
      };
      const cleanups = this.rec.state === "running" && !this.rec.driverCompleted ? [{ kind: "stopDriver" }] : [];
      this.rec = { state: "idle", lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [
        ...cleanups,
        this.stopAllTimers(),
        { kind: "send", msg: staleReject },
        { kind: "audit", event: "stale_attempt_rejected", reason: "implicit cancel by higher attempt" },
        ...this.evaluateOffer(o)
      ];
    }
    if (o.exp !== void 0 && isExpiredByExp(o.exp, o.now)) {
      this.rec = { state: "rejected", lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [this.outFor(o, "task.reject", { reason_code: "expired" })];
    }
    if (this.rec.state === "running" || this.rec.state === "offered") {
      return [
        this.outFor(o, "task.reject", { reason_code: "busy", detail: { reason: "v1 \u5355\u6267\u884C\u4F4D,\u5DF2\u6709\u5728\u9014\u4EFB\u52A1" } })
      ];
    }
    return this.evaluateOffer(o);
  }
  evaluateOffer(o) {
    const policy = gatePolicy(this.opts.policy, o.body);
    if (!policy.ok) {
      this.rec = { state: "rejected", lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      const rejectBody = { reason_code: "policy_denied", ...policy.detail ?? {} };
      return [this.outFor(o, "task.reject", rejectBody)];
    }
    const required = Array.isArray(o.body.required_caps) ? o.body.required_caps : [];
    const caps = gateCaps(required, this.opts.capabilities?.() ?? []);
    if (!caps.ok) {
      this.rec = { state: "rejected", lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [this.outFor(o, "task.reject", { reason_code: "unsupported_caps", ...caps.detail ?? {} })];
    }
    const load = gateLoad(this.opts.load?.());
    if (!load.ok) {
      this.rec = { state: "rejected", lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [this.outFor(o, "task.reject", { reason_code: "busy", ...load.detail ?? {} })];
    }
    const requiresList = Array.isArray(o.body.requires) ? o.body.requires : [];
    const confirmReq = requiresList.find((r) => r && r.cls === "confirm");
    if (confirmReq) {
      if (!this.opts.confirmHandler) {
        return [
          (() => {
            this.rec = {
              state: "rejected",
              task_id: o.task_id,
              attempt: o.attempt,
              from: o.from,
              msg_id: o.msg_id,
              offerBody: o.body,
              receivedAt: o.now,
              lastSeq: 0,
              driverCompleted: false,
              cancelReceived: false,
              paused: false
            };
            return this.outFor(o, "task.reject", { reason_code: "policy_denied", detail: { reason: "confirm_required_no_channel" } });
          })()
        ];
      }
      const approved = this.opts.confirmHandler(
        { cls: String(confirmReq.cls), value: String(confirmReq.value ?? ""), reason: String(confirmReq.reason ?? "") },
        o.body
      );
      if (!approved) {
        return [
          (() => {
            this.rec = {
              state: "rejected",
              task_id: o.task_id,
              attempt: o.attempt,
              from: o.from,
              msg_id: o.msg_id,
              offerBody: o.body,
              receivedAt: o.now,
              lastSeq: 0,
              driverCompleted: false,
              cancelReceived: false,
              paused: false
            };
            return this.outFor(o, "task.reject", { reason_code: "policy_denied", detail: { reason: "confirmed_denied" } });
          })()
        ];
      }
    }
    const offeredLease = typeof o.body.lease_ms === "number" ? o.body.lease_ms : this.params.leaseMsProject;
    this.rec = {
      state: "running",
      task_id: o.task_id,
      attempt: o.attempt,
      from: o.from,
      msg_id: o.msg_id,
      offerBody: o.body,
      receivedAt: o.now,
      ttlMs: typeof o.body.offer_ttl_ms === "number" ? o.body.offer_ttl_ms : void 0,
      leaseConfirmedMs: offeredLease,
      leaseSelfDeadline: o.now + offeredLease,
      lastSeq: 0,
      driverCompleted: false,
      cancelReceived: false,
      paused: false
    };
    const hb = Math.floor(offeredLease / 3);
    return [
      this.outFor(o, "task.accept", { lease_ms: offeredLease, started_at: new Date(o.now).toISOString() }),
      { kind: "startDriver", task_id: o.task_id, attempt: o.attempt, offer: o.body },
      { kind: "schedule", timer: "heartbeat", atMs: o.now + hb },
      { kind: "schedule", timer: "lease_self", atMs: o.now + offeredLease }
    ];
  }
  outFor(o, type, body) {
    return {
      kind: "send",
      msg: { type, to_node: o.from, task_id: o.task_id, attempt: o.attempt, reply_to: o.msg_id, body }
    };
  }
  /** offer_ttl 到期(R2):晚于才过期;过期必须立刻 reject(expired),禁止沉默 */
  onTtlCheck(now) {
    if (this.rec.state !== "offered" || this.rec.receivedAt === void 0) return [];
    const ttl = this.rec.ttlMs ?? this.params.offerTtlMsAid;
    if (now > (this.rec.receivedAt ?? 0) + ttl) {
      this.rec.state = "rejected";
      const from = this.rec.from ?? "";
      return [this.out("task.reject", from, { reason_code: "expired" })];
    }
    return [];
  }
  /** 心跳到期:发出 progress(seq 单调递增),续自身租约由回执驱动(R11/M3) */
  onHeartbeatDue(now) {
    if (this.rec.state !== "running" || this.rec.paused) return [];
    this.rec.lastSeq += 1;
    const seq = this.rec.lastSeq;
    const from = this.rec.from ?? "";
    const actions = [
      this.out("task.progress", from, { state: "working", seq }),
      { kind: "schedule", timer: "heartbeat", atMs: now + Math.floor((this.rec.leaseConfirmedMs ?? this.params.leaseMsProject) / 3) }
    ];
    return actions;
  }
  /** 心跳获网关回执 → 自身租约续期(R3 执行方对称计时器) */
  onHeartbeatAcked(now) {
    if (this.rec.state !== "running") return [];
    if (this.rec.paused) {
      this.rec.paused = false;
      this.rec.leaseSelfDeadline = now + (this.rec.leaseConfirmedMs ?? this.params.leaseMsProject);
      return [
        { kind: "resumeDriver" },
        { kind: "schedule", timer: "lease_self", atMs: this.rec.leaseSelfDeadline }
      ];
    }
    this.rec.leaseSelfDeadline = now + (this.rec.leaseConfirmedMs ?? this.params.leaseMsProject);
    return [
      { kind: "cancelTimers", timers: ["lease_self"] },
      { kind: "schedule", timer: "lease_self", atMs: this.rec.leaseSelfDeadline }
    ];
  }
  /** 自身租约超时:暂停产生新副作用(R3),不强求杀进程 */
  onLeaseSelfTimeout(now) {
    if (this.rec.state !== "running") return [];
    if ((this.rec.leaseSelfDeadline ?? 0) > now) {
      return [{ kind: "schedule", timer: "lease_self", atMs: this.rec.leaseSelfDeadline ?? now }];
    }
    this.rec.paused = true;
    return [{ kind: "pauseDriver" }];
  }
  /** 驱动完成:R5 自检 —— 已收到 cancel(执行中)→ 不发 result 回 ack;本地租约已超时(paused)同此;否则发 result */
  onDriverCompleted(resultBody) {
    if (this.rec.state !== "running") return [];
    this.rec.driverCompleted = true;
    this.rec.resultBody = resultBody;
    if (this.rec.paused) {
      this.rec.state = "stopped";
      const from0 = this.rec.from ?? "";
      return [this.stopAllTimers(), this.out("task.cancel.ack", from0, {})];
    }
    if (this.rec.cancelReceived) {
      this.rec.state = "stopped";
      const from2 = this.rec.from ?? "";
      return [
        this.stopAllTimers(),
        this.out("task.cancel.ack", from2, {})
      ];
    }
    this.rec.state = "result_sent";
    const from = this.rec.from ?? "";
    return [
      this.stopAllTimers(),
      this.out("task.result", from, { status: "done", ...resultBody })
    ];
  }
  /** 驱动失败:发 fail(码走 §4.3 登记表) */
  onDriverFailed(failBody) {
    if (this.rec.state !== "running") return [];
    this.rec.state = "fail_sent";
    const from = this.rec.from ?? "";
    return [this.stopAllTimers(), this.out("task.fail", from, failBody)];
  }
  /** 入站 cancel(01 §5.2/R5):running → 停止+ack;已完成未交付 → result+completed_before_cancel;result_sent → ack 带标记不重发 */
  onCancel(fromNode, attempt) {
    if (this.rec.state === "running" && attempt === this.rec.attempt) {
      this.rec.cancelReceived = true;
      if (this.rec.driverCompleted) {
        this.rec.state = "result_sent";
        const result = { status: "done", ...this.rec.resultBody ?? {}, completed_before_cancel: true };
        return [this.stopAllTimers(), this.out("task.result", fromNode, result)];
      }
      this.rec.state = "stopped";
      return [
        this.stopAllTimers(),
        { kind: "stopDriver" },
        this.out("task.cancel.ack", fromNode, {})
      ];
    }
    if (this.rec.state === "offered" && attempt === this.rec.attempt) {
      this.rec.state = "stopped";
      return [this.stopAllTimers(), this.out("task.cancel.ack", fromNode, {})];
    }
    if (this.rec.state === "result_sent") {
      return [this.out("task.cancel.ack", fromNode, { completed_before_cancel: true })];
    }
    return [];
  }
  /** 收到 reject(stale_attempt):本地记账/清理 → 终态(R0/R5) */
  onStaleReject() {
    if (this.rec.state === "running" || this.rec.state === "offered") {
      const actions = [];
      if (this.rec.state === "running") actions.push({ kind: "stopDriver" });
      this.rec.state = "cleaned";
      return [...actions, this.stopAllTimers()];
    }
    return [];
  }
};

// ../node/src/executor/driver.ts
var ScriptStubDriver = class {
  host = null;
  cancelFn = null;
  stopped = false;
  startedCount = 0;
  scripts;
  constructor(scripts) {
    this.scripts = Array.isArray(scripts) ? scripts : [scripts];
  }
  start(task, host) {
    void task;
    this.host = host;
    this.stopped = false;
    this.cancelFn = null;
    const startedAt = host.now();
    const script = this.scripts[Math.min(this.startedCount, this.scripts.length - 1)];
    this.startedCount += 1;
    if (script.completeAfterMs !== void 0) {
      const at = startedAt + script.completeAfterMs;
      this.cancelFn = host.schedule(at, () => {
        if (this.stopped) return;
        host.complete({ summary: "stub \u5B8C\u6210", ...script.resultBody ?? {} });
      });
    } else if (script.failAfter) {
      const failSpec = script.failAfter;
      const at = startedAt + failSpec.ms;
      this.cancelFn = host.schedule(at, () => {
        if (this.stopped) return;
        host.fail(failSpec.body);
      });
    }
  }
  stop() {
    this.stopped = true;
    this.cancelFn?.();
    this.cancelFn = null;
  }
  pause() {
  }
  resume() {
  }
};

// ../node/src/local/harness.ts
var SingleNodeHarness = class {
  taskId;
  kind;
  nodeAId;
  nodeBId;
  params;
  opts;
  lead;
  exec;
  driver;
  audits = [];
  escalateSummary;
  terminalState;
  heartbeatCount = 0;
  clock = 0;
  timers = [];
  lastOfferBody;
  constructor(opts = {}) {
    this.opts = opts;
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.kind = opts.kind ?? "project";
    this.taskId = opts.taskId ?? newId();
    this.nodeAId = newId();
    this.nodeBId = newId();
    this.lead = new LeadTaskMachine({
      task_id: this.taskId,
      kind: this.kind,
      params: this.params,
      validateAcceptance: opts.validateAcceptance
    });
    this.exec = new ExecutorMachine({
      params: this.params,
      capabilities: opts.capabilities ?? (() => ["tool:node@20"]),
      policy: opts.policy,
      load: opts.load
    });
    this.driver = new ScriptStubDriver(Array.isArray(opts.script) ? opts.script : [opts.script ?? {}]);
    this.lastOfferBody = this.defaultOfferBody();
  }
  defaultOfferBody() {
    return {
      kind: this.kind,
      summary: "stub \u4EFB\u52A1:\u5355\u673A\u603B\u7EBF\u96C6\u6210",
      lease_ms: defaultLeaseMs(this.kind, this.params),
      offer_ttl_ms: defaultOfferTtlMs(this.kind, this.params)
    };
  }
  startTask(offerBody) {
    this.lastOfferBody = offerBody ?? this.defaultOfferBody();
    this.processLead(this.lead.dispatchTo(this.nodeBId, this.lastOfferBody, this.clock), this.clock);
  }
  cancelTask() {
    this.processLead(this.lead.cancelByUser(this.clock), this.clock);
  }
  /**
   * 同机进程重启接管:从检查点恢复牵头方,并按 pendingTimers 重挂定时器
   * (评审 M1-ARCH-1/M1-QA-5:恢复不重挂 = 接管特性不可用)。
   * 执行方/驱动不恢复 —— 重启后其工作即丢失,由牵头方租约超时 → 改派闭环兜底。
   */
  adoptRestoredLead(blob) {
    this.lead = restoreLeadMachine(blob, {
      params: this.params,
      validateAcceptance: this.opts.validateAcceptance
    });
    for (const t of pendingTimers(this.lead)) {
      const timer = t.timer;
      this.schedule("lead", timer, t.atMs, () => this.processLead(this.lead.onTimer(timer, t.atMs), t.atMs));
    }
    if (this.lead.rec.state === "drafting") {
      this.processLead(this.lead.redispatchTo(this.nodeBId, this.lastOfferBody, this.clock), this.clock);
    }
  }
  /** 推演时钟:按时间序触发全部到期定时器(含过程中新排程的) */
  advanceTo(ms) {
    for (; ; ) {
      const due = this.timers.filter((t) => !t.cancelled && t.at <= ms).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.clock = Math.max(this.clock, due.at);
      due.cb();
    }
    this.clock = Math.max(this.clock, ms);
  }
  schedule(owner, name, at, cb) {
    this.timers.push({ owner, name, at, cb, cancelled: false });
  }
  cancelTimers(owner, names) {
    for (const t of this.timers) {
      if (t.owner === owner && names.includes(t.name)) t.cancelled = true;
    }
  }
  processLead(actions, now) {
    for (const a of actions) {
      switch (a.kind) {
        case "send":
          this.deliverToExecutor(a.msg, now);
          break;
        case "audit":
          this.audits.push(makeAudit(a.event, { node_id: this.nodeAId, reason: a.reason }, () => new Date(now).toISOString()));
          break;
        case "requestDispatch":
          this.processLead(this.lead.redispatchTo(this.nodeBId, this.lastOfferBody, now), now);
          break;
        case "schedule":
          this.schedule("lead", a.timer, a.atMs, () => this.processLead(this.lead.onTimer(a.timer, a.atMs), a.atMs));
          break;
        case "cancelTimers":
          this.cancelTimers("lead", a.timers);
          break;
        case "terminal":
          this.terminalState = a.state;
          break;
        case "escalate":
          this.escalateSummary = a.summary;
          break;
      }
    }
  }
  deliverToExecutor(msg, now) {
    if (msg.type === "task.offer") {
      this.processExec(
        this.exec.onOffer({
          from: this.nodeAId,
          task_id: msg.task_id,
          attempt: msg.attempt,
          msg_id: newId(),
          body: msg.body,
          now,
          exp: new Date(now + this.params.expHorizonMs).toISOString()
        }),
        now
      );
    } else if (msg.type === "task.cancel") {
      this.processExec(this.exec.onCancel(this.nodeAId, msg.attempt ?? 0), now);
    } else if (msg.type === "task.reject") {
      this.processExec(this.exec.onStaleReject(), now);
    }
  }
  deliverToLead(msg, now) {
    if (msg.type === "task.progress") this.heartbeatCount += 1;
    this.processLead(
      this.lead.onMessage(msg.type, this.nodeBId, msg.attempt ?? this.lead.rec.attempt, msg.body, now),
      now
    );
    if (msg.type === "task.progress") {
      this.processExec(this.exec.onHeartbeatAcked(now), now);
    }
  }
  processExec(actions, now) {
    for (const a of actions) {
      switch (a.kind) {
        case "send":
          this.deliverToLead(a.msg, now);
          break;
        case "audit":
          this.audits.push(makeAudit(a.event, { node_id: this.nodeBId, reason: a.reason }, () => new Date(now).toISOString()));
          break;
        case "startDriver":
          this.driver.start({ task_id: a.task_id, attempt: a.attempt, offer: a.offer }, this.driverHost());
          break;
        case "stopDriver":
          this.driver.stop();
          break;
        case "pauseDriver":
          this.driver.pause();
          break;
        case "resumeDriver":
          this.driver.resume();
          break;
        case "schedule":
          this.schedule("exec", a.timer, a.atMs, () => this.fireExecTimer(a.timer, a.atMs));
          break;
        case "cancelTimers":
          this.cancelTimers("exec", a.timers);
          break;
      }
    }
  }
  fireExecTimer(timer, at) {
    if (timer === "heartbeat") {
      this.processExec(this.exec.onHeartbeatDue(at), at);
      this.processExec(this.exec.onHeartbeatAcked(at), at);
    } else if (timer === "lease_self") {
      this.processExec(this.exec.onLeaseSelfTimeout(at), at);
    } else {
      this.processExec(this.exec.onTtlCheck(at), at);
    }
  }
  driverHost() {
    return {
      now: () => this.clock,
      schedule: (at, cb) => {
        const entry = { owner: "driver", name: "cb", at, cb, cancelled: false };
        this.timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      complete: (b) => this.processExec(this.exec.onDriverCompleted(b), this.clock),
      fail: (b) => this.processExec(this.exec.onDriverFailed(b), this.clock)
    };
  }
};

// ../node/src/lead/supervisor.ts
var LeadSupervisor = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  machines = /* @__PURE__ */ new Map();
  create(taskId, kind) {
    const m = new LeadTaskMachine({
      task_id: taskId,
      kind,
      params: this.deps.params,
      validateAcceptance: this.deps.validateAcceptance
    });
    this.machines.set(taskId, m);
    this.persist(m);
    return m;
  }
  /** 进程重启后调用:从存储恢复全部任务(含终态),重挂定时器并上报改派意图 */
  restoreAll() {
    const restored = [];
    const needDispatch = [];
    for (const taskId of this.deps.store.list()) {
      const blob = this.deps.store.load(taskId);
      if (!blob) continue;
      const m = restoreLeadMachine(blob, this.deps);
      this.machines.set(taskId, m);
      restored.push(taskId);
      if (m.terminal) continue;
      this.deps.rearm?.(taskId, pendingTimers(m));
      if (m.rec.state === "drafting") {
        needDispatch.push(taskId);
        this.deps.onNeedDispatch?.(taskId, m.rec.attempt + 1);
      }
    }
    return { restored, needDispatch };
  }
  get(taskId) {
    return this.machines.get(taskId);
  }
  dispatch(taskId, target, offerBody, now) {
    const m = this.must(taskId);
    const actions = m.dispatchTo(target, offerBody, now);
    this.persist(m);
    return actions;
  }
  redispatch(taskId, target, offerBody, now) {
    const m = this.must(taskId);
    const actions = m.redispatchTo(target, offerBody, now);
    this.persist(m);
    return actions;
  }
  deliver(taskId, type, from, attempt, body, now) {
    const m = this.must(taskId);
    const actions = m.onMessage(type, from, attempt, body, now);
    this.persist(m);
    return actions;
  }
  tick(taskId, timer, now) {
    const m = this.must(taskId);
    const actions = m.onTimer(timer, now);
    this.persist(m);
    return actions;
  }
  cancel(taskId, now) {
    const m = this.must(taskId);
    const actions = m.cancelByUser(now);
    this.persist(m);
    return actions;
  }
  historyOf(taskId) {
    return this.must(taskId).rec.history;
  }
  must(taskId) {
    const m = this.machines.get(taskId);
    if (!m) throw new Error(`supervisor: \u4EFB\u52A1\u4E0D\u5B58\u5728 ${taskId}`);
    return m;
  }
  persist(m) {
    this.deps.store.save(m.task_id, checkpointLeadMachine(m));
  }
};

// ../node/src/lead/store.ts
var MemoryStore = class {
  map = /* @__PURE__ */ new Map();
  save(taskId, blob) {
    this.map.set(taskId, blob);
  }
  load(taskId) {
    return this.map.get(taskId);
  }
  list() {
    return [...this.map.keys()];
  }
  delete(taskId) {
    this.map.delete(taskId);
  }
};

// src/main.ts
var cmd = process.argv[2] ?? "demo";
if (cmd === "demo") {
  const h = new SingleNodeHarness({
    kind: "project",
    script: [
      { failAfter: { ms: 1e3, body: { reason_code: "internal_error", retryable: true, summary: "\u77AC\u6001\u9519\u8BEF" } } },
      { completeAfterMs: 2e3, resultBody: { summary: "\u91CD\u505A\u6210\u529F" } }
    ]
  });
  h.startTask();
  h.advanceTo(2e5);
  console.log("state        :", h.lead.rec.state);
  console.log("attempt      :", h.lead.rec.attempt);
  console.log("heartbeats   :", h.heartbeatCount);
  console.log("audit events :", h.audits.map((a) => a.event).join(", "));
  process.exit(h.lead.rec.state === "done" && h.lead.rec.attempt === 2 ? 0 : 1);
}
if (cmd === "takeover") {
  const store = new MemoryStore();
  const s1 = new LeadSupervisor({ store });
  const m1 = s1.create("demo-task", "project");
  s1.dispatch("demo-task", "node-b", { kind: "project", summary: "\u63A5\u7BA1\u6F14\u7EC3", lease_ms: 3e5, offer_ttl_ms: 6e4 }, 0);
  s1.deliver("demo-task", "task.accept", "node-b", 1, { lease_ms: 3e5 }, 0);
  console.log("before crash :", m1.rec.state, "| attempt", m1.rec.attempt);
  const s2 = new LeadSupervisor({ store });
  s2.restoreAll();
  const m2 = s2.get("demo-task");
  console.log("after restore:", m2?.rec.state, "| attempt", m2?.rec.attempt);
  s2.deliver("demo-task", "task.result", "node-b", 1, { status: "done", summary: "\u6062\u590D\u540E\u4EA4\u4ED8" }, 100);
  console.log("after result :", m2?.rec.state);
  process.exit(m2?.rec.state === "done" ? 0 : 1);
}
if (cmd === "status") {
  console.log("qlong v0.2");
  console.log("Team: " + (process.env.QLONG_TEAM_ID ?? "(unset)"));
  console.log("Registry: " + (process.env.QLONG_REGISTRY_URL ?? "http://127.0.0.1:3200"));
  process.exit(0);
}
if (cmd === "tasks") {
  const regUrl = process.env.QLONG_REGISTRY_URL ?? "http://127.0.0.1:3200";
  const teamId = process.env.QLONG_TEAM_ID ?? "";
  const tok = process.env.QLONG_NODE_TOKEN ?? "";
  if (!teamId || !tok) {
    console.error("set QLONG_TEAM_ID + QLONG_NODE_TOKEN");
    process.exit(1);
  }
  const res = await fetch(regUrl + "/v1/teams/" + teamId + "/tasks", { headers: { Authorization: "Bearer " + tok } });
  const d = await res.json();
  for (const t of d.tasks ?? []) console.log(t.task_id.slice(0, 12), t.type, t.status);
  process.exit(0);
}
console.log("usage: qlong <demo|takeover|status|tasks>");
process.exit(2);
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)
*/
