// The `evm-call` watch source (watch.mjs): one read-only eth_call against a view a module relies on (a registry entry,
// a version, a pause flag), with the answer decoded so the digest can say what it changed from and to. Pure functions,
// no dependencies (the watch sandbox tests copy these files alone): keccak256 for `signature` selectors, static-argument
// encoding, and a bounds-checked decoder for the answer, which is untrusted RPC data.
//
//   node --test scripts/watch/watch-2026-11-05-evm-call.test.mjs

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets, lane x + 5y. */
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

/** Keccak-256 (the Ethereum one, not SHA3-256) of a UTF-8 string or bytes, as 0x-hex. */
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "0x";
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out += ((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A static ABI type as written in a signature → its canonical name, or null when it is not one we encode / decode. */
function staticType(t) {
  if (t === "address" || t === "bool") return t;
  const int = /^(u?int)(\d*)$/.exec(t);
  if (int) {
    const bits = int[2] === "" ? 256 : Number(int[2]);
    return bits >= 8 && bits <= 256 && bits % 8 === 0 ? `${int[1]}${bits}` : null;
  }
  const fixed = /^bytes(\d+)$/.exec(t);
  return fixed && Number(fixed[1]) >= 1 && Number(fixed[1]) <= 32 ? t : null;
}

/** `name(type,…)` → {name, types} with canonical static types; nested tuples, arrays and dynamic arguments are refused. */
export function parseSignature(signature) {
  const m = /^([A-Za-z_$][\w$]*)\(([^()[\]]*)\)$/.exec(String(signature ?? "").replace(/\s+/g, ""));
  if (!m) throw new Error(`evm-call: bad signature ${signature}`);
  const types = m[2] === "" ? [] : m[2].split(",").map((t) => {
    const c = staticType(t);
    if (!c) throw new Error(`evm-call: argument type ${t} is not supported (static uint/int/address/bool/bytesN only)`);
    return c;
  });
  return {name: m[1], types};
}

/** The 4-byte selector of a signature (canonical types: `uint` is uint256). */
export function selectorOf(signature) {
  const {name, types} = parseSignature(signature);
  return keccak256(`${name}(${types.join(",")})`).slice(0, 10);
}

function encodeArg(type, v) {
  if (type === "address") {
    if (typeof v !== "string" || !ADDRESS.test(v)) throw new Error(`evm-call: ${v} is not an address`);
    return v.slice(2).toLowerCase().padStart(64, "0");
  }
  if (type === "bool") {
    if (typeof v !== "boolean") throw new Error(`evm-call: ${v} is not a bool`);
    return (v ? "1" : "0").padStart(64, "0");
  }
  if (type.startsWith("bytes")) {
    const n = Number(type.slice(5));
    if (typeof v !== "string" || !HEX.test(v) || (v.length - 2) / 2 > n) throw new Error(`evm-call: ${v} is not ${type}`);
    return v.slice(2).toLowerCase().padEnd(64, "0");
  }
  // uintN / intN: a decimal or 0x string (a JSON number only when it is a safe integer).
  if (!(typeof v === "string" && /^(-?\d+|0x[0-9a-fA-F]+)$/.test(v)) && !Number.isSafeInteger(v)) throw new Error(`evm-call: ${v} is not an integer`);
  const n = BigInt(v), bits = BigInt(type.replace(/^u?int/, ""));
  const signed = type.startsWith("int");
  const lo = signed ? -(1n << (bits - 1n)) : 0n, hi = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (n < lo || n > hi) throw new Error(`evm-call: ${v} is out of range for ${type}`);
  return (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, "0");
}

/** The calldata of a source: its `data` as given, or `signature` + `args` encoded. Exactly one of the two. */
export function callData(s) {
  if (s.data != null && s.signature != null) throw new Error("evm-call: give data or signature, not both");
  if (s.data != null) {
    if (typeof s.data !== "string" || !HEX.test(s.data) || s.data.length < 10) throw new Error("evm-call: data is not 0x-hex calldata (selector at least)");
    return s.data.toLowerCase();
  }
  if (s.signature == null) throw new Error("evm-call: needs data or signature");
  const {types} = parseSignature(s.signature);
  const args = s.args ?? [];
  if (!Array.isArray(args) || args.length !== types.length) throw new Error(`evm-call: ${s.signature} takes ${types.length} argument(s), got ${Array.isArray(args) ? args.length : "no list"}`);
  return selectorOf(s.signature) + types.map((t, i) => encodeArg(t, args[i])).join("");
}

const MAX_STRING = 8192;

/** A decode type → {kind: "static" | "string" | "tuple", type?, members?}; `(a,b,…)` is a tuple (nesting allowed), arrays are not. */
function decodeType(t, depth = 0) {
  if (typeof t !== "string") throw new Error(`evm-call: unknown decode ${JSON.stringify(t)}`);
  const x = t.replace(/\s+/g, "");
  if (x === "string") return {kind: "string"};
  if (x.startsWith("(") && x.endsWith(")") && depth < 4) {
    const members = [];
    let level = 0, from = 1;
    for (let i = 1; i < x.length - 1; i++) {
      if (x[i] === "(") level++;
      else if (x[i] === ")" && --level < 0) break;
      else if (x[i] === "," && level === 0) { members.push(x.slice(from, i)); from = i + 1; }
    }
    if (level !== 0) throw new Error(`evm-call: unknown decode ${t}`);
    members.push(x.slice(from, -1));
    if (members.some((m) => m === "")) throw new Error(`evm-call: unknown decode ${t}`);
    return {kind: "tuple", members: members.map((m) => decodeType(m, depth + 1))};
  }
  const c = staticType(x);
  if (!c || (c.startsWith("bytes") && c !== "bytes32")) throw new Error(`evm-call: unknown decode ${t}`);
  return {kind: "static", type: c};
}
const isDynamic = (d) => d.kind === "string" || (d.kind === "tuple" && d.members.some(isDynamic));
const headWords = (d) => (d.kind === "tuple" && !isDynamic(d) ? d.members.reduce((n, m) => n + headWords(m), 0) : 1);

/**
 * An eth_call answer decoded as `decode`: `raw` (the hex itself), one type (`uint256`, `int256`, `address`, `bool`,
 * `string`, `bytes32`, or a tuple `(address,string,uint256,uint256)`), or a list of them for a multi-value return.
 * Integers come back as decimal strings (bigint-exact), addresses lower-cased, tuples as arrays. Every word, offset and
 * length is checked against the payload: a malformed answer throws instead of yielding a wrong value.
 */
export function decodeResult(hex, decode = "raw") {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Error("eth_call: answer is not hex");
  if (decode === "raw") return hex.toLowerCase();
  const list = Array.isArray(decode);
  if (list && !decode.length) throw new Error("evm-call: decode lists no types");
  const top = list ? {kind: "tuple", members: decode.map((t) => decodeType(t))} : {kind: "tuple", members: [decodeType(decode)]};
  const body = hex.slice(2).toLowerCase();
  if (!body.length) throw new Error("eth_call: empty answer (no contract, or no such function)");
  if (body.length % 64) throw new Error("eth_call: answer is not ABI words");
  const words = body.length / 64;
  const word = (i) => {
    if (i >= words) throw new Error("eth_call: answer is too short");
    return BigInt("0x" + body.slice(i * 64, (i + 1) * 64));
  };
  /** The word an offset (relative to the enclosing tuple at `base`) points at. */
  const target = (base, off) => {
    if (off % 32n !== 0n || BigInt(base) + off / 32n >= BigInt(words)) throw new Error("eth_call: bad offset");
    return base + Number(off / 32n);
  };
  const one = (d, w) => {
    const t = d.type;
    if (t === "address") {
      if (w >> 160n) throw new Error("eth_call: not an address");
      return "0x" + w.toString(16).padStart(40, "0");
    }
    if (t === "bool") {
      if (w > 1n) throw new Error("eth_call: not a bool");
      return w === 1n;
    }
    if (t === "bytes32") return "0x" + w.toString(16).padStart(64, "0");
    const bits = BigInt(t.replace(/^u?int/, ""));
    if (t.startsWith("uint")) {
      if (w >> bits) throw new Error(`eth_call: not a ${t}`);
      return w.toString();
    }
    // intN: sign-extended two's complement in the full word.
    const signed = w >> 255n ? w - (1n << 256n) : w;
    if (signed < -(1n << (bits - 1n)) || signed >= 1n << (bits - 1n)) throw new Error(`eth_call: not a ${t}`);
    return signed.toString();
  };
  const string = (at) => {
    const len = word(at);
    if (len > BigInt(MAX_STRING) || BigInt(at + 1) * 32n + len > BigInt(words) * 32n) throw new Error("eth_call: bad string length");
    const start = (at + 1) * 64, bytes = new Uint8Array(Number(len));
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(body.slice(start + k * 2, start + k * 2 + 2), 16);
    try { return new TextDecoder("utf-8", {fatal: true}).decode(bytes); } catch { throw new Error("eth_call: string is not UTF-8"); }
  };
  const tuple = (members, base) => {
    let pos = base;
    return members.map((m) => {
      let v;
      if (isDynamic(m)) { const at = target(base, word(pos)); v = m.kind === "string" ? string(at) : tuple(m.members, at); }
      else v = m.kind === "tuple" ? tuple(m.members, pos) : one(m, word(pos));
      pos += headWords(m);
      return v;
    });
  };
  const out = tuple(top.members, 0);
  return list ? out : out[0];
}
