import {bigintToNumber} from "@anywalletkit/core";
import {base64Bytes} from "@anywalletkit/protocol-swap2-core/util";

/**
 * A strict reader for the bag of cells Symbiosis' API returns as a TON message body — just enough
 * to open a jetton transfer and the bridge request it forwards, with no dependency and no Buffer
 * (React Native). Anything unusual is an error, never a guess: one root, ordinary cells only, no
 * absent cells, references pointing forward, a cell reachable from the root exactly as written,
 * and no bytes left over.
 */

export interface TonCell {
  /** Data bits, most significant first, padded with zero bits to a whole byte. */
  readonly data: Uint8Array;
  readonly bits: number;
  readonly refs: readonly TonCell[];
}

const MAGIC = 0xb5ee9c72;
const MAX_CELLS = 512;

export function parseBoc(base64: string): TonCell {
  const bytes = base64Bytes(base64);
  if (!bytes || bytes.length < 10) throw new Error("not a base64 bag of cells");
  let at = 0;
  const need = (n: number) => { if (at + n > bytes.length) throw new Error("bag of cells is truncated"); };
  const uint = (n: number): number => {
    need(n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + bytes[at++]!;
    return v;
  };
  if (uint(4) !== MAGIC) throw new Error("not a bag of cells");
  const flags = uint(1);
  const hasIndex = (flags & 0x80) !== 0;
  const hasCrc = (flags & 0x40) !== 0;
  if ((flags & 0x18) !== 0) throw new Error("unsupported bag-of-cells flags");
  const size = flags & 0x07;
  const offBytes = uint(1);
  if (size < 1 || size > 2 || offBytes < 1 || offBytes > 4) throw new Error("unsupported bag-of-cells sizes");
  const cells = uint(size);
  const roots = uint(size);
  const absent = uint(size);
  const total = uint(offBytes);
  if (cells < 1 || cells > MAX_CELLS) throw new Error("bag of cells holds too many cells");
  if (roots !== 1 || absent !== 0) throw new Error("bag of cells must hold exactly one root and no absent cells");
  if (uint(size) !== 0) throw new Error("the root must be the first cell");
  if (hasIndex) { need(cells * offBytes); at += cells * offBytes; }
  const start = at;
  const raw: {data: Uint8Array; bits: number; refs: number[]}[] = [];
  for (let i = 0; i < cells; i++) {
    const d1 = uint(1);
    const d2 = uint(1);
    const refCount = d1 & 0x07;
    if ((d1 & 0xf8) !== 0 || refCount > 4) throw new Error("exotic or leveled cells are not accepted");
    const len = (d2 >> 1) + (d2 & 1);
    need(len);
    const data = bytes.slice(at, at + len);
    at += len;
    let bits = len * 8;
    if (d2 & 1) {
      // Not byte-aligned: the last byte ends with a 1 bit and zero padding.
      const last = data[len - 1]!;
      if (last === 0) throw new Error("cell padding is malformed");
      let pad = 1;
      while (((last >> (pad - 1)) & 1) === 0) pad++;
      bits -= pad;
      data[len - 1] = last & (0xff << pad) & 0xff;
    }
    const refs: number[] = [];
    for (let r = 0; r < refCount; r++) {
      const ref = uint(size);
      if (ref <= i || ref >= cells) throw new Error("cell reference does not point forward");
      refs.push(ref);
    }
    raw.push({data, bits, refs});
  }
  if (at - start !== total) throw new Error("bag-of-cells size does not match its header");
  if (hasCrc) { need(4); at += 4; }
  if (at !== bytes.length) throw new Error("bag of cells has trailing bytes");
  const built: TonCell[] = new Array<TonCell>(cells);
  for (let i = cells - 1; i >= 0; i--) {
    const c = raw[i]!;
    built[i] = Object.freeze({data: c.data, bits: c.bits, refs: Object.freeze(c.refs.map((r) => built[r]!))});
  }
  return built[0]!;
}

/** Sequential reader over one cell's bits and references; every read past the end throws. */
export class Slice {
  private bit = 0;
  private ref = 0;
  constructor(private readonly cell: TonCell) {}

  get remainingBits(): number { return this.cell.bits - this.bit; }
  get remainingRefs(): number { return this.cell.refs.length - this.ref; }

  uint(n: number): bigint {
    if (n < 0 || this.bit + n > this.cell.bits) throw new Error("cell is shorter than its layout");
    let v = 0n;
    for (let i = 0; i < n; i++, this.bit++) v = (v << 1n) | BigInt((this.cell.data[this.bit >> 3]! >> (7 - (this.bit & 7))) & 1);
    return v;
  }
  bool(): boolean { return this.uint(1) === 1n; }
  /** VarUInteger 16 (`Coins`). */
  coins(): bigint { return this.uint(bigintToNumber(this.uint(4)) * 8); }
  /** `n` bytes as lowercase hex. */
  hex(n: number): string { return n === 0 ? "" : this.uint(n * 8).toString(16).padStart(n * 2, "0"); }
  /** MsgAddressInt `addr_std` without anycast as `<workchain>:<hash>`, or null for `addr_none`. */
  address(): string | null {
    const tag = this.uint(2);
    if (tag === 0n) return null;
    if (tag !== 2n || this.bool()) throw new Error("unsupported address form");
    const wc = bigintToNumber(BigInt.asIntN(8, this.uint(8)));
    return `${wc}:${this.hex(32)}`;
  }
  nextRef(): TonCell {
    const c = this.cell.refs[this.ref++];
    if (!c) throw new Error("cell has fewer references than its layout");
    return c;
  }
  /** The layout was read completely: no bits and no references left. */
  end(): void {
    if (this.remainingBits !== 0 || this.remainingRefs !== 0) throw new Error("cell is longer than its layout");
  }
}

/**
 * A byte string stored as a chain of cells (each continues in its single reference). The chain holds
 * `length` bytes followed by zero bytes up to the next multiple of 32 — the way Symbiosis' API writes
 * EVM calldata into a TON message; any other size, or a non-zero byte after `length`, is an error.
 */
export function snakeHex(cell: TonCell, length: number): string {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("byte string length is malformed");
  let out = "";
  let cur: TonCell | undefined = cell;
  for (let hops = 0; cur; hops++) {
    if (hops > MAX_CELLS || cur.bits % 8 !== 0 || cur.refs.length > 1) throw new Error("byte string cell is malformed");
    out += new Slice(cur).hex(cur.bits / 8);
    cur = cur.refs[0];
  }
  const stored = out.length / 2;
  if (stored !== Math.ceil(length / 32) * 32 && stored !== length) throw new Error("byte string length does not match its header");
  if (/[^0]/.test(out.slice(length * 2))) throw new Error("byte string is followed by non-zero bytes");
  return out.slice(0, length * 2);
}
