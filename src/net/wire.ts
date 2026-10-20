/**
 * Bytes for what a room sends often or keeps long: the host's report, the shots, and
 * the paint in the room's log.
 *
 * Places are in centimetres in sixteen bits, which holds the park (336m across) with
 * room to spare. The log takes JSON only, so what goes into it is these bytes as
 * base64: a splat is 13 bytes, and the park's 2,000 splats fit one snapshot.
 */

const CM = 100;

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private at = 0;

  constructor(size = 1024) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }

  private room(n: number): void {
    if (this.at + n <= this.buf.byteLength) return;
    const bigger = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.at + n));
    new Uint8Array(bigger).set(new Uint8Array(this.buf, 0, this.at));
    this.buf = bigger;
    this.view = new DataView(bigger);
  }

  u8(v: number): this {
    this.room(1);
    this.view.setUint8(this.at, clampInt(v, 0, 255));
    this.at += 1;
    return this;
  }

  u16(v: number): this {
    this.room(2);
    this.view.setUint16(this.at, clampInt(v, 0, 65535));
    this.at += 2;
    return this;
  }

  i8(v: number): this {
    this.room(1);
    this.view.setInt8(this.at, clampInt(v, -128, 127));
    this.at += 1;
    return this;
  }

  i16(v: number): this {
    this.room(2);
    this.view.setInt16(this.at, clampInt(v, -32768, 32767));
    this.at += 2;
    return this;
  }

  /** A time on the room's clock, in ms. */
  f64(v: number): this {
    this.room(8);
    this.view.setFloat64(this.at, Number.isFinite(v) ? v : 0);
    this.at += 8;
    return this;
  }

  /** A place along one axis, in metres. */
  pos(v: number): this {
    return this.i16(v * CM);
  }

  /** -1 to 1: a part of a direction. */
  unit(v: number): this {
    return this.i16(v * 32767);
  }

  /** An angle, in 65536 steps round the circle. */
  angle(v: number): this {
    const turn = Math.PI * 2;
    return this.u16(((((v % turn) + turn) % turn) / turn) * 65536 % 65536);
  }

  get length(): number {
    return this.at;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.at);
  }

  /** Starts again, keeping the buffer. */
  reset(): this {
    this.at = 0;
    return this;
  }
}

export class Reader {
  private readonly view: DataView;
  private at = 0;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Throws when the bytes run out: what came was not whole, and is dropped whole. */
  private need(n: number): void {
    if (this.at + n > this.view.byteLength) throw new RangeError('short message');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.at++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at);
    this.at += 2;
    return v;
  }

  i8(): number {
    this.need(1);
    return this.view.getInt8(this.at++);
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.at);
    this.at += 2;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.at);
    this.at += 8;
    return v;
  }

  pos(): number {
    return this.i16() / CM;
  }

  unit(): number {
    return this.i16() / 32767;
  }

  angle(): number {
    return (this.u16() / 65536) * Math.PI * 2;
  }

  get done(): boolean {
    return this.at >= this.view.byteLength;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(Number.isFinite(v) ? v : 0);
  return n < lo ? lo : n > hi ? hi : n;
}

/** Bytes as text, for the log, which holds JSON. */
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/** And back. Throws on text that is not base64. */
export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** A number from somebody else's message, or `fallback` when it is not one. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
