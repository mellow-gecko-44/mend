// mend: applies an AI-written edit (unified diff, SEARCH/REPLACE, V4A or JSON)
// to a tree of text files. Implements SPEC.md v1. Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}
class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.finalBreak ? doc.br : '');
}

function isCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** The tree as the edits leave it: changed paths in `cur` (null: deleted). */
class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

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
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.cur.has(p) ? (this.cur.get(p) as string | null) : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.cur);
  }

  restore(s: Map<string, string | null>): void {
    this.cur.clear();
    for (const [k, v] of s) this.cur.set(k, v);
  }

  changedPaths(): string[] {
    return [...this.cur.keys()];
  }
}

interface MoveRec {
  old: string;
  nw: string;
}
interface Ctx {
  moves: MoveRec[];
}
type EditFn = (tree: Tree, ctx: Ctx) => void;

/** Positions where oldLines occur in lines at one tier, at or after `from`. */
function tierOccurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  const normOld = oldLines.map((l) => normLine(l, tier));
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(lines[i + j]!, tier) !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: only 0) with at least one occurrence. */
function findTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = tierOccurrences(lines, oldLines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of the replacement text: a context line (taken from the file) or a new line. */
interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the replacement lines for a match at pos (SPEC section 5). */
function buildNewLines(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  news: NewItem[],
  tier: number,
): string[] {
  if (tier === 2 && oldLines.length > 0) {
    const f = leadingWs(fileLines[pos] ?? '');
    const p = leadingWs(oldLines[0]!);
    return news.map((n) => {
      if (n.ctx) return fileLines[pos + n.oIdx]!;
      if (n.text === '' || /^[ \t]+$/.test(n.text)) return n.text;
      if (p !== '' && !n.text.startsWith(p)) return n.text;
      return f + n.text.slice(p.length);
    });
  }
  return news.map((n) => (n.ctx ? fileLines[pos + n.oIdx]! : n.text));
}

/** Replace fileLines[pos .. pos+oldLines.length) with the built lines. */
function spliceLines(
  doc: FileDoc,
  pos: number,
  oldLen: number,
  oldLines: string[],
  news: NewItem[],
  tier: number,
): void {
  const built = buildNewLines(doc.lines, pos, oldLines, news, tier);
  doc.lines.splice(pos, oldLen, ...built);
}

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEditObject(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const cmd = o.command;
  if (cmd === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (cmd === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const crlf = isCrlf(before);
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k !== -1; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (cmd === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(lineNo, 0, ...add);
      tree.set(p, renderDoc(doc));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: EditFn[] = [];
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: EditFn[] = [];
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

interface HunkLine {
  kind: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function pathOf(s: string): string {
  return s.split('\t')[0]!.trim();
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Apply one section's hunks to a file doc (SPEC section 6). */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oItems: string[] = [];
    const nItems: NewItem[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        const oIdx = oItems.length;
        oItems.push(b.text);
        nItems.push({ text: b.text, ctx: true, oIdx });
      } else if (b.kind === 'old') {
        oItems.push(b.text);
      } else if (b.kind === 'new') {
        nItems.push({ text: b.text, ctx: false, oIdx: -1 });
      }
    }
    let endsWithoutNewline = false;
    for (let bi = h.body.length - 1; bi >= 0; bi--) {
      const b = h.body[bi]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        endsWithoutNewline = bi + 1 < h.body.length && h.body[bi + 1]!.kind === 'bslash';
        break;
      }
    }
    if (oItems.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = idx === doc.lines.length;
      doc.lines.splice(idx, 0, ...buildNewLines(doc.lines, idx, [], nItems, 0));
      if (atEnd) doc.finalBreak = !endsWithoutNewline;
      d += nItems.length;
    } else {
      const found = findTier(doc.lines, oItems, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + oItems.length === doc.lines.length;
      spliceLines(doc, best, oItems.length, oItems, nItems, found.tier);
      if (atEnd) doc.finalBreak = !endsWithoutNewline;
      d += nItems.length - oItems.length;
    }
  }
}

function unifiedSectionEdit(s: Section, strict: boolean): EditFn {
  let oldP = s.oldPath ?? s.renameFrom ?? s.gitOld ?? null;
  let newP = s.newPath ?? s.renameTo ?? s.gitNew ?? null;
  if (oldP === null) oldP = newP;
  if (newP === null) newP = oldP;
  const oldPath = oldP as string;
  const newPath = newP as string;
  const isCreate = oldPath === '/dev/null' || s.newFile;
  const isDelete = newPath === '/dev/null' || s.deletedFile;
  if (isCreate) {
    return (tree) => {
      if (!isSafe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plusLines: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plusLines.push(b.text);
      let finalBreak = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const body = s.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.kind === 'new') {
            finalBreak = !(bi + 1 < body.length && body[bi + 1]!.kind === 'bslash');
            break outer;
          }
        }
      }
      tree.set(newPath, plusLines.length === 0 ? '' : plusLines.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!isSafe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree, ctx) => {
      if (!isSafe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!isSafe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const doc = parseDoc(before);
      applyHunks(doc, s.hunks, strict, oldPath);
      tree.set(newPath, renderDoc(doc));
      tree.set(oldPath, null);
      ctx.moves.push({ old: oldPath, nw: newPath });
    };
  }
  return (tree) => {
    if (!isSafe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const doc = parseDoc(before);
    applyHunks(doc, s.hunks, strict, oldPath);
    tree.set(oldPath, renderDoc(doc));
  };
}

function parseUnifiedEdits(lines: string[], strict: boolean): EditFn[] {
  const sections: Section[] = [];
  const gitRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): Section => ({
    oldPath: null,
    newPath: null,
    gitOld: null,
    gitNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = gitRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: HunkLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          j++;
          continue;
        }
        if (bl.startsWith('-')) {
          body.push({ kind: 'old', text: bl.slice(1) });
          j++;
          continue;
        }
        if (bl.startsWith('+')) {
          body.push({ kind: 'new', text: bl.slice(1) });
          j++;
          continue;
        }
        if (bl.startsWith('\\')) {
          body.push({ kind: 'bslash', text: bl });
          j++;
          continue;
        }
        break;
      }
      while (
        body.length > 0 &&
        body[body.length - 1]!.kind === 'ctx' &&
        body[body.length - 1]!.text === ''
      )
        body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = stripPrefix(pathOf(l.slice(4)));
        cur.newPath = stripPrefix(pathOf(lines[i + 1]!.slice(4)));
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = fresh();
      cur.oldPath = stripPrefix(pathOf(l.slice(4)));
      cur.newPath = stripPrefix(pathOf(lines[i + 1]!.slice(4)));
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}
function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!isSafe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const news: NewItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    spliceLines(doc, found.positions[0]!, oldLines.length, oldLines, news, found.tier);
    tree.set(path, renderDoc(doc));
  };
}

function parseSearchReplaceEdits(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevReplaceEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let j = searchIdx + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srBlockEdit(path, lines.slice(searchIdx + 1, j), lines.slice(j + 1, k), strict));
    prevPath = path;
    prevReplaceEnd = k;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}
interface V4aChunkBody {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}
interface V4aChunk {
  anchor: string | null;
  body: V4aChunkBody[];
  eof: boolean;
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  headerLine: number;
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function v4aSectionEdit(s: V4aSection, strict: boolean): EditFn {
  if (s.kind === 'add') {
    return (tree) => {
      if (!isSafe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!isSafe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
    };
  }
  return (tree, ctx) => {
    if (!isSafe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !isSafe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const doc = parseDoc(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const found = findAnchor(doc.lines, ch.anchor, strict, cursor);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const oItems: string[] = [];
      const nItems: NewItem[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          nItems.push({ text: b.text, ctx: true, oIdx: oItems.length });
          oItems.push(b.text);
        } else if (b.kind === 'old') {
          oItems.push(b.text);
        } else {
          nItems.push({ text: b.text, ctx: false, oIdx: -1 });
        }
      }
      if (oItems.length === 0) {
        const idx = ch.eof ? doc.lines.length : cursor;
        const built = buildNewLines(doc.lines, idx, [], nItems, 0);
        doc.lines.splice(idx, 0, ...built);
        cursor = idx + built.length;
      } else {
        let chosen: { tier: number; pos: number } | null = null;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier; t++) {
          const occ = tierOccurrences(doc.lines, oItems, t, cursor);
          const ok = ch.eof ? occ.filter((p) => p + oItems.length === doc.lines.length) : occ;
          if (ok.length > 0) {
            chosen = { tier: t, pos: ok[0]! };
            break;
          }
        }
        if (chosen === null) throw new Fail('no-match', s.path);
        spliceLines(doc, chosen.pos, oItems.length, oItems, nItems, chosen.tier);
        cursor = chosen.pos + nItems.length;
      }
    }
    const out = renderDoc(doc);
    if (s.moveTo !== null) {
      tree.set(s.moveTo, out);
      tree.set(s.path, null);
      ctx.moves.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.set(s.path, out);
    }
  };
}

function parseV4aEdits(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch')
    throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionRe = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const m = sectionRe.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    const start = i;
    i++;
    const raw: { line: string; idx: number }[] = [];
    while (i < last) {
      const sl = lines[i]!;
      if (sectionRe.test(sl)) break;
      raw.push({ line: sl, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.line === '') addLines.push('');
        else if (r.line.startsWith('+')) addLines.push(r.line.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], headerLine: start + 1 });
      continue;
    }
    if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.line)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], headerLine: start + 1 });
      continue;
    }
    let moveTo: string | null = null;
    let pos = 0;
    if (pos < raw.length) {
      const mm = /^\*\*\* Move to: (.*)$/.exec(raw[pos]!.line);
      if (mm !== null) {
        moveTo = mm[1]!.trim();
        pos++;
      }
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    const endChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    for (; pos < raw.length; pos++) {
      const { line: rl, idx } = raw[pos]!;
      if (rl.startsWith('@@')) {
        endChunk();
        const anchor = rl.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        continue;
      }
      if (rl.trim() === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
        cur.eof = true;
        endChunk();
        continue;
      }
      if (rl.startsWith('***')) throw new Exit2(`error: parse ${idx + 1}`);
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
        cur = { anchor: null, body: [], eof: false };
      }
      if (rl === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (rl.startsWith(' ')) cur.body.push({ kind: 'ctx', text: rl.slice(1) });
      else if (rl.startsWith('-')) cur.body.push({ kind: 'old', text: rl.slice(1) });
      else if (rl.startsWith('+')) cur.body.push({ kind: 'new', text: rl.slice(1) });
      else throw new Exit2(`error: parse ${idx + 1}`);
    }
    endChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
    sections.push({ kind, path, moveTo, addLines: [], chunks, headerLine: start + 1 });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'json') return parseJsonEdits(text, lines);
  if (kind === 'unified') return parseUnifiedEdits(lines, strict);
  if (kind === 'search-replace') return parseSearchReplaceEdits(lines, strict);
  if (kind === 'v4a') return parseV4aEdits(lines, strict);
  throw new Error('bad kind');
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice(9);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const moveMark = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      ctx.moves.length = moveMark;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.changedPaths()) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of ctx.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.key === m.old || rows[i]!.key === m.nw) rows.splice(i, 1);
      }
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of tree.changedPaths()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
