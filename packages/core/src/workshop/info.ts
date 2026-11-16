/**
 * FCS Workshop companion files next to a mod: `_<mod>.info` and `_<mod>.img`.
 *
 * `_<mod>.info` is what .NET `XmlSerializer` writes for FCS's `ModData` class:
 *
 * ```xml
 * <?xml version="1.0"?>
 * <ModData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
 *   <id>3835566412</id>
 *   <mod>Cactus Info</mod>
 *   <title>Cactus - Mod Editor for Kenshi (external tool)</title>
 *   <tags>
 *     <string>Environment/Map</string>
 *   </tags>
 *   <visibility>0</visibility>
 *   <lastUpdate>2026-11-07T22:38:27.6001766+03:00</lastUpdate>
 * </ModData>
 * ```
 *
 * Facts taken from the 119 `.info` files on the author's disk (2026-11-16): UTF-8 without BOM,
 * CRLF line ends, two-space indent, no newline after `</ModData>`; no tags → `<tags />`;
 * no date → `<lastUpdate xsi:nil="true" />`; `&`, `<`, `>` escaped in text; `id` is the Workshop
 * item number (u64, kept as a decimal string); `visibility` uses the `ERemoteStoragePublishedFileVisibility`
 * numbers (0 public, 1 friends only, 2 private, 3 unlisted).
 *
 * `_<mod>.img` is the preview picture copied byte for byte (PNG, JPEG or GIF; the extension
 * does not say which).
 *
 * Parsing keeps the original order of elements and unknown elements verbatim, so a file FCS
 * wrote comes back byte for byte when nothing changed.
 */

/** Visibility values of a Workshop item (the numbers Steam and FCS use). */
export const WORKSHOP_VISIBILITY = { public: 0, friends: 1, private: 2, unlisted: 3 } as const;
export type WorkshopVisibility = (typeof WORKSHOP_VISIBILITY)[keyof typeof WORKSHOP_VISIBILITY];

/** Tags FCS offers (its upload window), in its order. */
export const FCS_WORKSHOP_TAGS = [
  'Buildings',
  'Characters',
  'Cheats',
  'Clothing/Armour',
  'Environment/Map',
  'Factions',
  'Gameplay',
  'Graphical',
  'GUI',
  'Items/Weapons',
  'Races',
  'Research',
  'Total Overhaul',
] as const;

/** Tags Cactus offers: the FCS ones plus `Translation` (used by about a third of installed items). */
export const WORKSHOP_TAGS: readonly string[] = [...FCS_WORKSHOP_TAGS, 'Translation'];

/** Contents of `_<mod>.info`. */
export interface WorkshopInfo {
  /** Workshop item number; `'0'` or empty — not published yet. */
  id: string;
  /** Mod name without `.mod`. */
  mod: string;
  title: string;
  tags: string[];
  visibility: number;
  /** .NET round-trip date (`2019-06-10T02:46:48.1320735-03:00`); `null` — `xsi:nil`. */
  lastUpdate: string | null;
}

/** Parsed file: the data plus what is needed to write it back unchanged. */
export interface WorkshopInfoFile {
  info: WorkshopInfo;
  /** `<?xml …?>` line and the `<ModData …>` open tag as they were. */
  prolog: string;
  /** Element names in file order (known and unknown). */
  order: string[];
  /** Unknown elements, verbatim (`<name …>…</name>`). */
  unknown: Record<string, string>;
  /** Line end used in the file. */
  eol: string;
}

const KNOWN = ['id', 'mod', 'title', 'tags', 'visibility', 'lastUpdate'] as const;
const DEFAULT_PROLOG =
  '<?xml version="1.0"?>\r\n<ModData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">';

/** Escape text the way `XmlSerializer` does for element content. */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeXmlText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** Thrown when a `.info` file does not read as `ModData`. */
export class WorkshopInfoError extends Error {}

/** Workshop info of a mod that has none yet. */
export function newWorkshopInfo(modName: string, title = modName): WorkshopInfo {
  return { id: '0', mod: modName, title, tags: [], visibility: WORKSHOP_VISIBILITY.public, lastUpdate: null };
}

/** True if the info names a published item (non-zero number). */
export function isPublishedId(id: string | undefined): id is string {
  return id !== undefined && /^\d{1,20}$/.test(id) && !/^0+$/.test(id);
}

/** Read `_<mod>.info` text. */
export function parseWorkshopInfo(text: string): WorkshopInfoFile {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const open = /<ModData\b[^>]*>/.exec(text);
  if (!open) throw new WorkshopInfoError('not a ModData file: no <ModData> element');
  const prolog = text.slice(0, open.index + open[0].length);
  const end = text.lastIndexOf('</ModData>');
  if (end < 0) throw new WorkshopInfoError('not a ModData file: no </ModData>');
  const body = text.slice(open.index + open[0].length, end);
  const info = newWorkshopInfo('');
  const order: string[] = [];
  const unknown: Record<string, string> = {};
  let pos = 0;
  for (;;) {
    const start = body.indexOf('<', pos);
    if (start < 0) break;
    if (body.startsWith('<!--', start)) {
      const close = body.indexOf('-->', start);
      pos = close < 0 ? body.length : close + 3;
      continue;
    }
    const head = /^<([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/.exec(body.slice(start));
    if (!head) throw new WorkshopInfoError(`bad element at ${String(start)}`);
    const name = head[1]!;
    const attrs = head[2] ?? '';
    const selfClosing = head[3] === '/';
    let raw: string;
    let inner = '';
    if (selfClosing) raw = head[0];
    else {
      const closeTag = `</${name}>`;
      const close = body.indexOf(closeTag, start + head[0].length);
      if (close < 0) throw new WorkshopInfoError(`element <${name}> is not closed`);
      inner = body.slice(start + head[0].length, close);
      raw = body.slice(start, close + closeTag.length);
    }
    pos = start + raw.length;
    order.push(name);
    const nil = /\bxsi:nil\s*=\s*"true"/.test(attrs);
    switch (name) {
      case 'id':
        info.id = unescapeXmlText(inner).trim() || '0';
        break;
      case 'mod':
        info.mod = unescapeXmlText(inner);
        break;
      case 'title':
        info.title = unescapeXmlText(inner);
        break;
      case 'tags':
        info.tags = [...inner.matchAll(/<string>([\s\S]*?)<\/string>|<string\s*\/>/g)].map((m) => unescapeXmlText(m[1] ?? ''));
        break;
      case 'visibility': {
        const v = Number(unescapeXmlText(inner).trim());
        info.visibility = Number.isInteger(v) ? v : 0;
        break;
      }
      case 'lastUpdate':
        info.lastUpdate = nil || selfClosing ? null : unescapeXmlText(inner);
        break;
      default:
        unknown[name] = raw;
    }
  }
  return { info, prolog, order, unknown, eol };
}

/** Element order for writing: the file's order, known elements missing from it in their usual place. */
function writeOrder(order: readonly string[]): string[] {
  const out = [...order];
  for (let i = 0; i < KNOWN.length; i++) {
    const name = KNOWN[i]!;
    if (out.includes(name)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(KNOWN[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, name);
  }
  return out;
}

/** Write `_<mod>.info` text: the original layout of `base` if given, FCS's layout otherwise. */
export function formatWorkshopInfo(info: WorkshopInfo, base?: WorkshopInfoFile): string {
  const eol = base?.eol ?? '\r\n';
  const lines: string[] = [base?.prolog ?? DEFAULT_PROLOG];
  const order = writeOrder(base?.order ?? []);
  const seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    switch (name) {
      case 'id':
        lines.push(`  <id>${escapeXmlText(info.id || '0')}</id>`);
        break;
      case 'mod':
        lines.push(`  <mod>${escapeXmlText(info.mod)}</mod>`);
        break;
      case 'title':
        lines.push(`  <title>${escapeXmlText(info.title)}</title>`);
        break;
      case 'tags':
        if (info.tags.length === 0) lines.push('  <tags />');
        else {
          lines.push('  <tags>');
          for (const t of info.tags) lines.push(`    <string>${escapeXmlText(t)}</string>`);
          lines.push('  </tags>');
        }
        break;
      case 'visibility':
        lines.push(`  <visibility>${String(info.visibility)}</visibility>`);
        break;
      case 'lastUpdate':
        lines.push(info.lastUpdate === null ? '  <lastUpdate xsi:nil="true" />' : `  <lastUpdate>${escapeXmlText(info.lastUpdate)}</lastUpdate>`);
        break;
      default: {
        const raw = base?.unknown[name];
        if (raw !== undefined) lines.push(`  ${raw}`);
      }
    }
  }
  lines.push('</ModData>');
  return lines.join(eol);
}

/** A date as .NET writes `DateTime.Now` in XML: local time, 7 fraction digits, offset. */
export function dotNetDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}0000${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`
  );
}

/** `_<mod>.info` / `_<mod>.img` file names for a mod file name (`My mod.mod` → `_My mod.info`). */
export function workshopFileNames(modFileName: string): { info: string; img: string; mod: string } {
  const mod = modFileName.replace(/\.mod$/i, '');
  return { info: `_${mod}.info`, img: `_${mod}.img`, mod };
}

export type ImageFormat = 'png' | 'jpeg' | 'gif';

/** Picture format by its first bytes (what Steam accepts as a preview); `undefined` — something else. */
export function imageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  return undefined;
}
