// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order, for the `R` output lines. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines: its break, and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** A line as one tier sees it (SPEC.md section 5). */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Positions at or after `from` where O occurs in `lines` at `tier`. */
function tierOccurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || from > lines.length - k) return out;
  const want = o.map((l) => tierLine(l, tier));
  for (let i = Math.max(0, from); i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (tierLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = tierOccurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line) or a new line. */
interface NewLine {
  ctx: boolean;
  /** Index into O for a context line. */
  oIdx: number;
  text: string;
}

/** Build the replacement lines for a match at `pos` (SPEC.md section 5). */
function buildReplacement(lines: string[], o: string[], n: NewLine[], pos: number, tier: number): string[] {
  if (o.length === 0) return n.map((x) => x.text);
  const f = leadingWs(lines[pos]!);
  const p = leadingWs(o[0]!);
  return n.map((x) => {
    if (x.ctx) return lines[pos + x.oIdx]!;
    if (tier !== 2) return x.text;
    if (x.text === '' || x.text.trim() === '') return x.text;
    return x.text.startsWith(p) ? f + x.text.slice(p.length) : x.text;
  });
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function hunkON(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ ctx: true, oIdx: o.length - 1, text: b.text });
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push({ ctx: false, oIdx: -1, text: b.text });
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNewline(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === 'bs';
}

/** Apply a section's hunks to a file model, in order (SPEC.md section 6). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  const lines = [...model.lines];
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...buildReplacement(lines, o, n, at, 0));
      if (atEnd) final = !hunkNoNewline(h.body);
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + o.length === lines.length;
    const rep = buildReplacement(lines, o, n, best, found.tier);
    lines.splice(best, o.length, ...rep);
    if (atEnd) final = !hunkNoNewline(h.body);
    d += n.length - o.length;
  }
  return { lines, br: model.br, final };
}

type Edit = (tree: Tree) => void;

/** One unified diff section, as parsed (SPEC.md section 6). */
interface RawSection {
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A path as the patch wrote it: `/dev/null` means no file. */
function toPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  return stripPrefix(raw);
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The `a/<X> b/<Y>` paths of a `diff --git` line, or null when it is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function parseUnified(lines: string[]): RawSection[] {
  const n = lines.length;
  const sections: RawSection[] = [];
  const pairStartsAt = (i: number): boolean =>
    lines[i]!.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ');
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = diffGitPaths(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const cur: RawSection = {
        hasPair: false, pairOld: null, pairNew: null, renOld: null, renNew: null,
        diffOld: toPath(dg[0]), diffNew: toPath(dg[1]), create: false, del: false, hunks: [],
      };
      sections.push(cur);
      i += 1;
      i = parseSectionHeader(lines, i, cur, pairStartsAt);
    } else if (pairStartsAt(i)) {
      const cur: RawSection = {
        hasPair: false, pairOld: null, pairNew: null, renOld: null, renNew: null,
        diffOld: null, diffNew: null, create: false, del: false, hunks: [],
      };
      sections.push(cur);
      i = parseSectionHeader(lines, i, cur, pairStartsAt);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections;
}

/** Parse one section's header and hunks, starting at `i`; returns where it stopped. */
function parseSectionHeader(
  lines: string[],
  i0: number,
  cur: RawSection,
  pairStartsAt: (i: number) => boolean,
): number {
  const n = lines.length;
  let i = i0;
  let pairSeen = false;
  let sawHunk = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sawHunk = true;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (pairStartsAt(i)) break;
        if (l.startsWith('@@')) break;
        if (!isBodyLine(l)) break;
        if (l === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') hunk.body.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') hunk.body.push({ kind: 'old', text: l.slice(1) });
        else if (l[0] === '+') hunk.body.push({ kind: 'new', text: l.slice(1) });
        else hunk.body.push({ kind: 'bs', text: l.slice(1) });
        i += 1;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if (pairStartsAt(i)) {
        if (!pairSeen && !sawHunk) {
          pairSeen = true;
          cur.hasPair = true;
          cur.pairOld = toPath(headerPath(line));
          cur.pairNew = toPath(headerPath(lines[i + 1]!));
          i += 2;
          continue;
        }
        break;
      }
      if (sawHunk) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ')) {
      if (cur.renOld === null) cur.renOld = toPath(line.slice('rename from '.length).trim());
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (cur.renNew === null) cur.renNew = toPath(line.slice('rename to '.length).trim());
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.create = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => {
    const oldPath = s.hasPair ? s.pairOld : (s.renOld ?? s.diffOld);
    const newPath = s.hasPair ? s.pairNew : (s.renNew ?? s.diffNew);
    const isCreate = oldPath === null || s.create;
    const isDelete = !isCreate && (newPath === null || s.del);
    const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
    if (isCreate) {
      return (tree) => {
        const p = newPath ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noNl = false;
        for (const h of s.hunks) {
          for (let k = 0; k < h.body.length; k += 1) {
            const b = h.body[k]!;
            if (b.kind === 'new') {
              plus.push(b.text);
              noNl = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      };
    }
    if (isDelete) {
      return (tree) => {
        const p = oldPath ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (isMove) {
      const oldP = oldPath!;
      const newP = newPath!;
      return (tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const cur = tree.get(oldP);
        if (cur === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(parseFile(cur), s.hunks, strict, oldP);
        tree.now.set(newP, renderFile(out));
        tree.now.set(oldP, null);
        tree.moves.push({ old: oldP, new: newP });
      };
    }
    const p = oldPath ?? newPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      tree.now.set(p, renderFile(applyHunks(parseFile(cur), s.hunks, strict, p)));
    };
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const marker = (l: string, m: string): boolean => l.replace(/[ \t]+$/, '') === m;
  const n = lines.length;
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (!marker(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < n; j += 1) {
      if (marker(lines[j]!, '=======')) {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (marker(lines[j]!, '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => {
    return (tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const model = parseFile(cur);
      const found = findTier(model.lines, b.oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.pos[0]!;
      const nItems: NewLine[] = b.newLines.map((t) => ({ ctx: false, oIdx: -1, text: t }));
      const rep = buildReplacement(model.lines, b.oldLines, nItems, pos, found.tier);
      const out = [...model.lines];
      out.splice(pos, b.oldLines.length, ...rep);
      tree.now.set(b.path, renderFile({ lines: out, br: model.br, final: model.final }));
    };
  });
}

/** One V4A chunk (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  const sectionStart = /^(\*\*\* (?:Add|Delete|Update) File: )(.*)$/;
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const m = sectionStart.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!.includes('Add') ? 'add' : m[1]!.includes('Delete') ? 'del' : 'upd';
    const path = m[2]!.trim();
    const headerLine = i + 1;
    const start = i + 1;
    let end = last;
    for (let j = start; j < last; j += 1) {
      if (sectionStart.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    const raw = lines.slice(start, end);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const rl = raw[k]!;
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (blank(rl)) fileLines.push('');
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${start + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(vUpdEdit(path, raw, start, headerLine, strict));
    }
    i = end;
  }
  return edits;
}

function vUpdEdit(path: string, raw: string[], start: number, headerLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  let j = 0;
  while (j < raw.length && blank(raw[j]!)) j += 1;
  if (j < raw.length && raw[j]!.startsWith('*** Move to: ')) {
    moveTo = raw[j]!.slice('*** Move to: '.length).trim();
    idx = j + 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let firstChunk = true;
  for (let k = idx; k < raw.length; k += 1) {
    const l = raw[k]!;
    const lineNo = start + k + 1;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
      firstChunk = false;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      cur = null;
      firstChunk = false;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo}`);
    if (cur === null) {
      if (!firstChunk) throw new Exit2(`error: parse ${lineNo}`);
      cur = { anchor: null, eof: false, body: [] };
      chunks.push(cur);
      firstChunk = false;
    }
    if (l === '') cur.body.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
    else if (l[0] === '+') cur.body.push({ kind: 'new', text: l.slice(1) });
    else throw new Exit2(`error: parse ${lineNo}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(cur);
    const lines = [...model.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const { o, n } = hunkON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const rep = buildReplacement(lines, o, n, at, 0);
        lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let occ = found.pos;
      if (ch.eof) occ = occ.filter((p) => p + o.length === lines.length);
      if (occ.length === 0) throw new Fail('no-match', path);
      const pos = occ[0]!;
      const rep = buildReplacement(lines, o, n, pos, found.tier);
      lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = renderFile({ lines, br: model.br, final: model.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()]
    .filter((p) => tree.original(p) !== tree.now.get(p))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      covered.add(mv.old);
      covered.add(mv.new);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
