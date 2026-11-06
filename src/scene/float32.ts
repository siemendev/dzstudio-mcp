/**
 * float32 numbers as text: the shortest decimal that reads back to the same float32 (at most 9 significant digits,
 * the closest on a tie in length), never with an exponent, whole values with `.0`, negative zero as `0.0`.
 * Reading is exact: to the nearest float32, ties to the even mantissa — not via a float64 detour.
 */

export class NumberTextError extends Error {}

interface Decimal {
  neg: boolean;
  digits: bigint;
  exp: number;
}

const TWO24 = 1n << 24n;
const TWO23 = 1n << 23n;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/** Nearest float32 (ties to even) of digits × 10^exp, as a JS number; Infinity on overflow. */
function decimalToFloat32(digits: bigint, exp: number): number {
  if (digits === 0n) return 0;
  let num = digits;
  let den = 1n;
  if (exp >= 0) num *= pow10(exp);
  else den = pow10(-exp);

  let e = bitLength(num) - bitLength(den) - 24;
  for (;;) {
    if (e < -149) e = -149;
    const [n2, d2] = e >= 0 ? [num, den << BigInt(e)] : [num << BigInt(-e), den];
    let q = n2 / d2;
    if (q >= TWO24) {
      e++;
      continue;
    }
    if (q < TWO23 && e > -149) {
      e--;
      continue;
    }
    const r2 = (n2 % d2) * 2n;
    if (r2 > d2 || (r2 === d2 && (q & 1n) === 1n)) q++;
    if (q === TWO24) {
      q = TWO23;
      e++;
    }
    if (e > 104) return Infinity;
    return Number(q) * 2 ** e;
  }
}

function parseDecimal(text: string): Decimal | undefined {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!m) return undefined;
  const intPart = m[2] ?? '';
  const frac = m[3] ?? '';
  if (intPart === '' && frac === '') return undefined;
  const exp = Number(m[4] ?? '0') - frac.length;
  if (!Number.isSafeInteger(exp)) return undefined;
  return { neg: m[1] === '-', digits: BigInt(intPart + frac || '0'), exp };
}

/** Reads one number to the nearest float32. Throws on anything that is not a finite decimal number. */
export function readFloat32(text: string): number {
  const d = parseDecimal(text);
  if (!d) throw new NumberTextError(`not a number: ${JSON.stringify(text)}`);
  let exp = d.exp;
  let digits = d.digits;
  if (digits !== 0n && exp < -400) return d.neg ? -0 : 0;
  if (digits !== 0n && exp > 400) throw new NumberTextError(`out of float32 range: ${text}`);
  while (digits !== 0n && digits % 10n === 0n) {
    digits /= 10n;
    exp++;
  }
  const v = decimalToFloat32(digits, exp);
  if (!Number.isFinite(v)) throw new NumberTextError(`out of float32 range: ${text}`);
  return d.neg ? -v : v;
}

/** Exact rational of a float32 held in a JS number. */
function floatRational(x: number): [bigint, bigint] {
  let m = x;
  let e = 0;
  while (!Number.isInteger(m)) {
    m *= 2;
    e--;
  }
  return e < 0 ? [BigInt(m), 1n << BigInt(-e)] : [BigInt(m), 1n];
}

function absDiff(digits: bigint, exp: number, x: [bigint, bigint]): [bigint, bigint] {
  let num = digits;
  let den = 1n;
  if (exp >= 0) num *= pow10(exp);
  else den = pow10(-exp);
  const n = num * x[1] - x[0] * den;
  return [n < 0n ? -n : n, den * x[1]];
}

function less(a: [bigint, bigint], b: [bigint, bigint]): boolean {
  return a[0] * b[1] < b[0] * a[1];
}

function fromPrecision(s: string): { digits: bigint; exp: number } {
  const [mant = '', ePart] = s.split('e');
  const dot = mant.indexOf('.');
  const fracLen = dot < 0 ? 0 : mant.length - dot - 1;
  return { digits: BigInt(mant.replace('.', '')), exp: Number(ePart ?? '0') - fracLen };
}

function plain(digits: bigint, exp: number): string {
  while (digits !== 0n && digits % 10n === 0n) {
    digits /= 10n;
    exp++;
  }
  const d = digits.toString();
  if (exp >= 0) return d + '0'.repeat(exp) + '.0';
  const point = d.length + exp;
  if (point > 0) return d.slice(0, point) + '.' + d.slice(point);
  return '0.' + '0'.repeat(-point) + d;
}

/** Writes a number as float32 text. The value is first rounded to float32. */
export function writeFloat32(value: number): string {
  if (!Number.isFinite(value)) throw new NumberTextError('NaN and infinity are never written');
  const x = Math.fround(value);
  if (!Number.isFinite(x)) throw new NumberTextError(`out of float32 range: ${value}`);
  if (x === 0) return '0.0';
  const neg = x < 0;
  const ax = Math.abs(x);
  const exact = floatRational(ax);
  for (let p = 1; p <= 9; p++) {
    const near = fromPrecision(ax.toPrecision(p));
    let best: { digits: bigint; exp: number; diff: [bigint, bigint] } | undefined;
    for (const delta of [0n, -1n, 1n]) {
      const digits = near.digits + delta;
      if (digits <= 0n) continue;
      if (decimalToFloat32(digits, near.exp) !== ax) continue;
      const diff = absDiff(digits, near.exp, exact);
      if (!best || less(diff, best.diff)) best = { digits, exp: near.exp, diff };
    }
    if (best) return (neg ? '-' : '') + plain(best.digits, best.exp);
  }
  throw new NumberTextError(`no text of at most 9 digits for ${x}`);
}

/** Three numbers in one string, separated by exactly one space. */
export function writeVec3(v: readonly [number, number, number]): string {
  return v.map(writeFloat32).join(' ');
}

export function readVec3(text: string): [number, number, number] {
  const parts = text.split(' ');
  if (parts.length !== 3) throw new NumberTextError(`expected three numbers: ${JSON.stringify(text)}`);
  return [readFloat32(parts[0]!), readFloat32(parts[1]!), readFloat32(parts[2]!)];
}
