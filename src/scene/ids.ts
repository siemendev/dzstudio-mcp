import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export const PROJECT_ID = 'project';

export function randomToken(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** A session prefix: 10 characters from 0–9 and a–z, uniformly random. */
export function randomPrefix(): string {
  return randomToken(10);
}

const ID_FORM = /^([0-9a-z]{10})-([1-9][0-9]*)$/;

/**
 * Assigns ids `‹prefix›-‹n›` with one counter for elements and operations. It never hands out an id it has seen:
 * every id from the state or the log goes through `observe`.
 */
export class IdAllocator {
  private n = 0;

  constructor(readonly prefix: string = randomPrefix()) {
    if (!/^[0-9a-z]{10}$/.test(prefix)) throw new Error(`invalid prefix ${prefix}`);
  }

  observe(id: string): void {
    const m = ID_FORM.exec(id);
    if (m && m[1] === this.prefix) {
      const k = Number(m[2]);
      if (k > this.n) this.n = k;
    }
  }

  next(): string {
    this.n++;
    return `${this.prefix}-${this.n}`;
  }

  get counter(): number {
    return this.n;
  }
}
