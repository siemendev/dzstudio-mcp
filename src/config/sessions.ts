import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What it takes to return to a session after the MCP restarted: the participation and its counters. */
export interface SavedSession {
  handle: string;
  server: string;
  sessionId: string;
  projectName: string;
  map: string;
  participantId: string;
  /** The session prefix of the instance; `resume` names it again as `instanceKey`. */
  prefix: string;
  /** The next clientSeq and lockSeq the server expects from this participant. */
  clientSeq: number;
  lockSeq: number;
  phase: 'waiting' | 'working' | 'review';
  status: string;
  lastWorkMs: number;
}

/**
 * The sessions the agent is in, kept in `sessions/` of the config directory: per session a small file with the
 * participation and a file with the project state at a sequence number (the cursor `resume` continues from).
 */
export class SessionStore {
  constructor(readonly dir: string) {}

  private base(server: string, sessionId: string): string {
    return join(this.dir, createHash('sha256').update(`${server}\u0000${sessionId}`).digest('hex').slice(0, 24));
  }

  private write(path: string, data: string): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  }

  list(): SavedSession[] {
    if (!existsSync(this.dir)) return [];
    const out: SavedSession[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as SavedSession;
        if (typeof s.sessionId === 'string' && typeof s.participantId === 'string') out.push(s);
      } catch {
        // a broken file is no session to return to
      }
    }
    return out;
  }

  save(s: SavedSession): void {
    this.write(`${this.base(s.server, s.sessionId)}.json`, JSON.stringify(s) + '\n');
  }

  /** The project state after sequence number `seq`, as its text form. */
  saveState(server: string, sessionId: string, seq: number, text: string): void {
    this.write(`${this.base(server, sessionId)}.state`, `${seq}\n${text}`);
  }

  state(server: string, sessionId: string): { seq: number; text: string } | undefined {
    try {
      const raw = readFileSync(`${this.base(server, sessionId)}.state`, 'utf8');
      const nl = raw.indexOf('\n');
      const seq = Number(raw.slice(0, nl));
      if (nl < 0 || !Number.isSafeInteger(seq) || seq < 0) return undefined;
      return { seq, text: raw.slice(nl + 1) };
    } catch {
      return undefined;
    }
  }

  remove(server: string, sessionId: string): void {
    const b = this.base(server, sessionId);
    rmSync(`${b}.json`, { force: true });
    rmSync(`${b}.state`, { force: true });
  }
}
