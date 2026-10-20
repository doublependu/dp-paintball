import { Vector3 } from 'three';
import type { Tag } from '../character/Character';
import { Reader, Writer } from './wire';

/**
 * What the room's log keeps: splats on the park and tags on people, as bytes.
 *
 * A splat is everything a page needs to paint it the way the shooter's page did: where,
 * facing which way, whose colour, how hard, and which of the atlas's shapes at which
 * roll. A tag adds who and when, and puts its paint in a joint's own frame.
 */

export interface Splat {
  point: Vector3;
  normal: Vector3;
  /** Index into `paintColors`. */
  color: number;
  impactSpeed: number;
  variant: number;
  roll: number;
}

export const SPLAT_BYTES = 13;

export function writeSplat(w: Writer, s: Splat): void {
  w.pos(s.point.x).pos(s.point.y).pos(s.point.z);
  w.i8(s.normal.x * 127).i8(s.normal.y * 127).i8(s.normal.z * 127);
  w.u8(s.color).u8(s.impactSpeed * 4).u8(s.variant);
  w.u8((((s.roll / (Math.PI * 2)) % 1) + 1) % 1 * 256);
}

export function readSplat(r: Reader): Splat {
  const point = new Vector3(r.pos(), r.pos(), r.pos());
  const normal = new Vector3(r.i8() / 127, r.i8() / 127, r.i8() / 127).normalize();
  return {
    point,
    normal,
    color: r.u8(),
    impactSpeed: r.u8() / 4,
    variant: r.u8(),
    roll: (r.u8() / 256) * Math.PI * 2,
  };
}

/** A tag as the log holds it: on whom, by whom, when, and the paint. */
export interface TagRecord {
  /** The places in the room's park of the one tagged, and of the shooter. */
  target: number;
  shooter: number;
  /** When the ball landed, by the server's clock, in ms. */
  at: number;
  tag: Tag;
}

export function writeTag(w: Writer, t: TagRecord): void {
  w.u8(t.target).u8(t.shooter).i8(t.tag.joint);
  w.i16(t.tag.point.x * 1e4).i16(t.tag.point.y * 1e4).i16(t.tag.point.z * 1e4);
  w.i8(t.tag.normal.x * 127).i8(t.tag.normal.y * 127).i8(t.tag.normal.z * 127);
  w.u16(t.tag.radius * 1e4).u8(t.tag.variant);
  w.u8((((t.tag.rotation / (Math.PI * 2)) % 1) + 1) % 1 * 256);
  w.f64(t.at);
}

export function readTag(r: Reader): TagRecord {
  const target = r.u8();
  const shooter = r.u8();
  const joint = r.i8();
  const point = new Vector3(r.i16() / 1e4, r.i16() / 1e4, r.i16() / 1e4);
  const normal = new Vector3(r.i8() / 127, r.i8() / 127, r.i8() / 127).normalize();
  const radius = r.u16() / 1e4;
  const variant = r.u8();
  const rotation = (r.u8() / 256) * Math.PI * 2;
  const at = r.f64();
  return { target, shooter, at, tag: { joint, point, normal, radius, variant, rotation } };
}
