/** A HEAD move to a named branch (or `undefined` for a detached HEAD). */
export interface BranchSwitch {
  ts: number;
  from?: string;
  to?: string;
}

const named = (ref: string | undefined): string | undefined => {
  const name = ref?.trim().replace(/^refs\/heads\//, '');
  return !name || /^[0-9a-f]{7,40}$/i.test(name) ? undefined : name;
};

/**
 * Parse `git reflog show --date=unix --format=%gd%x09%gs HEAD` into branch
 * switches, oldest first. Only checkouts, rebase returns and renames move HEAD
 * between branches; commits, pulls and resets stay on the same branch.
 */
export function parseReflog(text: string): BranchSwitch[] {
  const switches: BranchSwitch[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\S*@\{(\d+)\}\t(.*)$/.exec(line);
    if (!m) continue;
    const ts = Number(m[1]) * 1000;
    const subject = m[2];
    let hit = /^checkout: moving from (.+) to (.+)$/.exec(subject);
    if (hit) { switches.push({ ts, from: named(hit[1]), to: named(hit[2]) }); continue; }
    hit = /^rebase(?: -i)? \((?:finish|abort)\): returning to (refs\/heads\/.+)$/.exec(subject);
    if (hit) { switches.push({ ts, to: named(hit[1]) }); continue; }
    hit = /^Branch: renamed (refs\/heads\/\S+) to (refs\/heads\/\S+)$/.exec(subject);
    if (hit) switches.push({ ts, from: named(hit[1]), to: named(hit[2]) });
  }
  return switches.sort((a, b) => a.ts - b.ts);
}

/**
 * Branch checked out at `ts`, or `undefined` when unknowable (detached HEAD,
 * no reflog coverage, or a switch within `marginMs` of `ts`).
 */
export function branchAt(switches: BranchSwitch[], ts: number, marginMs = 2000): string | undefined {
  if (!switches.length) return undefined;
  if (switches.some(s => Math.abs(s.ts - ts) < marginMs)) return undefined;
  let last: BranchSwitch | undefined;
  for (const s of switches) {
    if (s.ts > ts) break;
    last = s;
  }
  return last ? last.to : switches[0].from;
}
