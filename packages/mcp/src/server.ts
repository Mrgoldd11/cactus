/**
 * MCP server: search, view, check, edit and save a mod through the editor core.
 * Answers are compact text: references with target names, long lists in pages.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyBulk,
  findRace,
  createRaceFrom,
  newRaceLabel,
  type RaceCompatPlan,
  type EditOp,
  formatRaceCompat,
  parseOgreMesh,
  planRaceCompat,
  raceCompatPreview,
  raceSkeletonWarning,
  RACE_COMPAT_GROUPS,
  type RaceCompatGroup,
  applyMerge,
  applyOps,
  formatMergePlan,
  formatMergeResult,
  planMerge,
  rejectMerge,
  selectMergeChanges,
  unrejectMerge,
  formatBulkPreview,
  applyCleanup,
  applyFixPlan,
  cleanupOps,
  formatCleanup,
  formatFix,
  planFixes,
  scanCleanup,
  CLEANUP_GROUPS,
  FIX_KINDS,
  type CleanupGroup,
  type FixKind,
  previewBulk,
  buildDialogueTree,
  findTypeSchema,
  formatChangeset,
  formatDialogueTree,
  formatEnum,
  formatHit,
  formatIssue,
  formatRecord,
  formatRecordDiff,
  formatRefValues,
  formatTypeSchema,
  formatExtensionDetail,
  formatExtensionSummary,
  summarizeExtensions,
  typeOriginNote,
  filterDiffs,
  formatDiffSummary,
  listTypes,
  lookupRecord,
  modRecordDiff,
  page,
  pageFooter,
  parseFieldFilter,
  refLabel,
  searchRecords,
  validateMod,
  type GameRecord,
  type ModContext,
  formatWhere,
  whereInGame,
  formatInside,
  inspectRecord,
  modelOfRecord,
  formatTalk,
  simulateTalk,
  describeChangeset,
  formatPlay,
  playConversation,
  type Changeset,
  findConflicts,
  formatConflict,
  formatTouches,
  touchedBy,
  isVanillaLayer,
} from '@kenshi-editor/core';
import { SessionError, type OpenResult, type Session } from './session.ts';
import { GameBridge } from '@kenshi-editor/core/node';
import { registerGameTools } from './game-tools.ts';
import { registerWorldTools } from './world-tools.ts';

export const SERVER_NAME = 'kenshi-mod-editor';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function text(lines: readonly string[]): ToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** Core and session errors — as an answer with isError (the model sees them and can correct itself). */
async function guarded(fn: () => string[] | Promise<string[]>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text([e instanceof Error ? e.message : String(e)]), isError: true };
  }
}

function paged<T>(items: readonly T[], offset: number, limit: number, line: (item: T) => string[]): string[] {
  const p = page(items, offset, limit === 0 ? Infinity : limit);
  const out = p.items.flatMap(line);
  if (p.total > p.items.length || p.total === 0) out.push(pageFooter(p));
  return out;
}

function record(ctx: ModContext, sid: string): GameRecord {
  const rec = ctx.get(sid) ?? ctx.lower(sid);
  if (!rec) throw new SessionError(`No record ${sid}`);
  return rec;
}

/** Record id by id or name (English or Russian); if several match — an error with a list. */
function resolveId(ctx: ModContext, spec: string, preferTypes?: readonly string[]): string {
  const r = lookupRecord(ctx, spec, preferTypes ? { preferTypes } : {});
  if (r.stringId !== undefined) return r.stringId;
  if (!r.candidates.length) throw new SessionError(`No record "${spec}" (neither an id nor a name)`);
  const list = r.candidates.slice(0, 20).map(formatHit);
  if (r.candidates.length > 20) list.push(`… and ${r.candidates.length - 20} more`);
  throw new SessionError([`"${spec}": ${r.candidates.length} records match, give an id:`, ...list].join('\n'));
}

const DIALOGUE_TYPES = ['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE', 'WORD_SWAPS'] as const;

function statusSummary(ctx: ModContext): string {
  const counts = new Map<string, number>();
  for (const rec of ctx.modRecords()) {
    const s = ctx.status(rec.stringId) ?? '?';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const parts = [...counts].map(([k, n]) => `${k} ${n}`);
  return `records ${ctx.modRecords().length}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const offset = z.number().int().min(0).optional().describe('Page offset (from "next offset=…")');
const limit = (d: number): z.ZodOptional<z.ZodNumber> => z.number().int().min(0).optional().describe(`Page size, default ${d}; 0 for all`);
const values = z.array(z.number().int()).max(3).optional().describe('Reference values (up to three numbers); by default from the schema');
const scalar = z.union([z.boolean(), z.number(), z.string(), z.array(z.number())]);
const dict = z.string().optional().describe('Dictionary: bool, int, float, str, file, vec3, vec4 (if not clear from the schema)');
const enumIn = z.union([z.number().int(), z.string()]);
const speaker = enumIn.optional().describe('Who speaks: npc, player or a TalkerEnum (T_ME, T_TARGET, …); by default after an NPC line it is the player answer, otherwise the NPC');
const lineText = { text: z.string().optional(), texts: z.array(z.string()).optional().describe('Several wordings (the game picks one at random)') };
const as = z.string().optional().describe('Alias of the new record ($x)');

const editOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), type: z.union([z.string(), z.number()]), name: z.string(), id: z.string().optional(), as: z.string().optional() }),
  z.object({ op: z.literal('duplicate'), from: z.string(), name: z.string().optional(), id: z.string().optional(), as: z.string().optional() }),
  z.object({ op: z.literal('delete'), id: z.string(), removeReferences: z.boolean().optional() }),
  z.object({ op: z.literal('restore'), id: z.string() }),
  z.object({ op: z.literal('revert'), id: z.string() }),
  z.object({ op: z.literal('rename'), id: z.string(), name: z.string() }),
  z.object({ op: z.literal('set'), id: z.string(), field: z.string(), value: scalar, dict }),
  z.object({ op: z.literal('reset'), id: z.string(), field: z.string(), dict }),
  z.object({ op: z.literal('addRef'), id: z.string(), category: z.string(), target: z.string(), values }),
  z.object({ op: z.literal('removeRef'), id: z.string(), category: z.string(), target: z.string() }),
  z.object({ op: z.literal('setRefs'), id: z.string(), category: z.string(), refs: z.array(z.object({ target: z.string(), values })) }),
  z.object({
    op: z.literal('info'),
    author: z.string().optional(),
    description: z.string().optional(),
    version: z.number().int().optional(),
    fileType: z.number().int().optional(),
    dependencies: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
    lastId: z.number().int().optional(),
  }),
  z.object({ op: z.literal('addLine'), parent: z.string(), speaker, ...lineText, as }),
  z.object({ op: z.literal('insertLine'), parent: z.string(), child: z.string(), speaker, ...lineText, as }),
  z.object({ op: z.literal('link'), parent: z.string(), child: z.string() }),
  z.object({ op: z.literal('unlink'), parent: z.string(), child: z.string() }),
  z.object({ op: z.literal('setText'), id: z.string(), ...lineText }),
  z.object({ op: z.literal('duplicateLine'), id: z.string(), parent: z.string().optional(), as }),
  z.object({ op: z.literal('deleteLines'), lines: z.array(z.string()).optional(), links: z.array(z.object({ parent: z.string(), child: z.string() })).optional() }),
  z.object({ op: z.literal('revertLine'), id: z.string() }),
  z.object({ op: z.literal('addCondition'), id: z.string(), cond: enumIn, value: z.number().int(), who: enumIn.optional(), cmp: enumIn.optional(), tag: z.number().int().optional(), as }),
  z.object({ op: z.literal('addEffect'), id: z.string(), action: enumIn, values: z.array(z.number().int()).max(3).optional(), as }),
  z.object({ op: z.literal('removeAction'), id: z.string(), category: z.enum(['conditions', 'effects']), action: z.string() }),
]);

/** Remove keys with value undefined (exactOptionalPropertyTypes). */
/** Run `fn` inside a transaction that is always rolled back: what-if planning on scratch edits. */
function scratch<T>(ctx: ModContext, fn: () => T): T {
  const stop = new Error('scratch');
  let out: { value: T } | undefined;
  try {
    ctx.transaction('scratch', () => {
      out = { value: fn() };
      throw stop;
    });
  } catch (e) {
    if (e !== stop) throw e;
  }
  return out!.value;
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function createServer(session: Session, opts: { game?: GameBridge } = {}): McpServer {
  // Connected to the editor — take the fresh window state before the command.
  const run = (fn: () => string[] | Promise<string[]>): Promise<ToolResult> =>
    guarded(async () => {
      await session.sync();
      return fn();
    });
  const server = new McpServer(
    { name: SERVER_NAME, version: '0.2.0-beta' },
    {
      instructions: [
        'Kenshi data: vanilla (gamedata.base → Newwworld.mod → Dialogue.mod → rebirth.mod), the mod dependencies, and the mod itself.',
        'Call open_mod first (or work on vanilla without it). Address records by string id or name (show, tree, refs, diff); find searches English and translated names.',
        'Edits (edit) go in batches of operations, one undo per batch; save writes only the changes. save writes into the game folder only with force: true.',
        'Schema of types and fields with descriptions from fcs.def: the schema tool and kenshi://schema/… resources.',
        'A mod can extend the schema with FCS Extended files in its folder (fcs.def, fcs_preload.def, *.def.patch): open_mod applies those of the mod and of its dependencies and lists what they add; schema marks such types, fields and enum values with [extension NAME], and schema with extension shows the warnings about those files. DLL plugins of FCS Extended are not run.',
        'Dialogues: tree shows the tree, talk shows which dialogue the game picks for a character, play runs a conversation step by step with player answers; graph edits are the edit operations addLine, insertLine, link, unlink, setText, duplicateLine, deleteLines, addCondition, addEffect.',
        'Bulk edits: bulk shows a was → will be preview first and applies only with apply: true.',
        'Fixing validation problems: fix; removing obsolete fields, no-op changes, orphans and invalid references: cleanup. Both preview first and apply only with apply: true.',
        'history lists steps in plain words; undo/redo with `to` go back or forward to a given step.',
        'If the game runs with the Kenshi Bridge plugin (optional, separate open-source plugin for RE_Kenshi/KenshiLib, https://github.com/Mrgoldd11/Kenshi-Bridge; the user has to install it themselves): game_state (what is in the game), game_trace (which dialogue the game chose and why), game_towns (game towns, border radii), game_dump (real foliage and all buildings of the game dumped for the World view), game_flyover (camera fly-over that dumps the whole map: only when the user asked, confirm: true), game_command (teleport, camera, speed, pause: only with the user consent, confirm: true).',
        'If Cactus is open: connect_editor. After that everything is read from the editor window, and edit sends changes to the window as a change set that the user accepts or reverts (editor_changes shows their state). In this mode the user does save and undo.',
        'World: list_in_area shows what stands around a point or town; place / move / remove edit the world of the mod (y is above ground), with their own world_undo and world_history; save also writes level files into leveldata.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'open_mod',
    {
      title: 'Open mod',
      description: 'Open a .mod (path or name of an installed mod) on top of vanilla and its dependencies. Without mod: a new empty mod named name.',
      inputSchema: {
        mod: z.string().optional().describe('Path to a .mod, or a mod name from mods/ or the Workshop; if the file does not exist, a new mod at that path'),
        name: z.string().optional().describe('File name of the new mod (My mod.mod) when mod is not set'),
        dependencies: z.array(z.string()).optional().describe('Dependencies instead of those recorded in the mod header'),
      },
      annotations: { ...READ, title: 'Open mod' },
    },
    (a) =>
      run(() => {
        const r = session.open(compact({ mod: a.mod, name: a.name, dependencies: a.dependencies }));
        const lines = [`${r.ctx.modName}${r.path ? ` — ${r.path}` : ' — new, give a path in save'}`, statusSummary(r.ctx)];
        if (r.dependencyPaths.length) lines.push(`dependencies: ${r.dependencyPaths.join(', ')}`);
        if (r.missingDependencies.length) lines.push(`missing dependencies: ${r.missingDependencies.join(', ')}`);
        lines.push(...extensionLines(r));
        if (r.ctx.dirty) lines.push('there are unsaved changes');
        return lines;
      }),
  );

  server.registerTool(
    'find',
    {
      title: 'Find records',
      description: 'Records by name (English or translated) or id, type, field values, status. Line: id  TYPE  "name" (translated)  [status].',
      inputSchema: {
        text: z.string().optional().describe('Substring of name or id'),
        type: z.union([z.string(), z.number()]).optional().describe('Type: name (DIALOGUE) or number'),
        fields: z.array(z.string()).optional().describe('Conditions: key=val, key~substring (or key:substring), key!:substring (does not contain), key?regexp, != < > <= >=, key? (field exists); for references: list>5, list.v0=4, ref>0, list.key=… (through references); keywords type, state, ref'),
        status: z.array(z.enum(['base', 'new', 'changed', 'deleted'])).optional(),
        anywhere: z.string().optional().describe('Substring anywhere in the record'),
        exact: z.boolean().optional().describe('Exact name match only'),
        mod_only: z.boolean().optional().describe('Mod records only'),
        query: z
          .string()
          .optional()
          .describe(
            'Search-box syntax of the Cactus record list: plain words and conditions separated by ; (same operators as fields). Keywords: type=CHARACTER, state=new|changed|deleted|mod, ref=target id or name (ref>N — referenced by N records). list.key=… — some record of reference list `list` matches key=… (any depth). Quoted key ("type"=…) — a plain field. Example: "bandit; type=CHARACTER; vendors.value>500"',
          ),
        offset,
        limit: limit(30),
      },
      annotations: { ...READ, title: 'Find records' },
    },
    (a) =>
      run(() => {
        const hits = searchRecords(
          session.ctx(),
          compact({
            text: a.text === '' ? undefined : a.text,
            type: a.type,
            fields: a.fields?.map(parseFieldFilter),
            status: a.status,
            anywhere: a.anywhere,
            exact: a.exact,
            modOnly: a.mod_only,
            query: a.query === '' ? undefined : a.query,
          }),
        );
        return paged(hits, a.offset ?? 0, a.limit ?? 30, (h) => [formatHit(h)]);
      }),
  );

  server.registerTool(
    'show',
    {
      title: 'Show record',
      description: 'Resulting fields and references of a record (references with target names), status; layers shows which layers define it.',
      inputSchema: {
        id: z.string().describe('String id or record name (English or translated)'),
        max_refs: z.number().int().min(0).optional().describe('References per category, default 20; 0 for all'),
        layers: z.boolean().optional(),
      },
      annotations: { ...READ, title: 'Show record' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const max = a.max_refs ?? 20;
        return formatRecord(ctx, record(ctx, resolveId(ctx, a.id)), { showLayers: a.layers ?? false, ...(max > 0 ? { maxRefsPerCategory: max } : {}) });
      }),
  );

  server.registerTool(
    'tree',
    {
      title: 'Dialogue tree',
      description: 'Dialogue tree by dialogs/lines references: lines, conditions, actions. Repeats and cycles are not expanded.',
      inputSchema: {
        id: z.string().describe('Id or name of a dialogue, package or line'),
        depth: z.number().int().min(1).optional().describe('Depth, default 6'),
        max_nodes: z.number().int().min(1).optional().describe('Nodes, default 60'),
        full: z.boolean().optional().describe('All line fields'),
      },
      annotations: { ...READ, title: 'Dialogue tree' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id, DIALOGUE_TYPES);
        const tree = buildDialogueTree(ctx, id, { maxDepth: a.depth ?? 6, maxNodes: a.max_nodes ?? 60 });
        return formatDialogueTree(ctx, tree, { full: a.full ?? false });
      }),
  );

  server.registerTool(
    'refs',
    {
      title: 'Record references',
      description: 'References from a record (→ category: target) and to it (← source category).',
      inputSchema: {
        id: z.string().describe('Id or record name'),
        direction: z.enum(['from', 'to', 'both']).optional().describe('Default both'),
        offset,
        limit: limit(50),
      },
      annotations: { ...READ, title: 'Record references' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const dir = a.direction ?? 'both';
        const lines: string[] = [];
        if (dir !== 'to') {
          for (const e of ctx.referencesFrom(id)) lines.push(`→ ${e.category}: ${refLabel(ctx, e.target)}${e.ref ? `  ${formatRefValues(e.ref)}` : ''}`);
        }
        if (dir !== 'from') {
          for (const e of ctx.referencesTo(id)) lines.push(`← ${refLabel(ctx, e.source)} ${e.category}${e.ref ? `  ${e.ref.v0} ${e.ref.v1} ${e.ref.v2}` : ''}`);
        }
        return paged(lines, a.offset ?? 0, a.limit ?? 50, (l) => [l]);
      }),
  );

  server.registerTool(
    'where',
    {
      title: 'Where in the game',
      description:
        'Where a record appears in the game: a chain of back-references (item ← trader list ← squad ← town) up to towns, buildings, factions and biomes, with coordinates from level files. Every step of the path has its reference category. Ends with a summary line, e.g. where the item is sold and in which towns. `tree` adds the back-reference tree.',
      inputSchema: {
        id: z.string().describe('Id or record name'),
        tree: z.boolean().optional().describe('Also show the back-reference tree'),
        limit: limit(20),
      },
      annotations: { ...READ, title: 'Where in the game' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const res = whereInGame(ctx, id, { world: session.world() });
        const max = a.limit ?? 20;
        return formatWhere(res, { tree: a.tree ?? false, maxFacts: max === 0 ? Infinity : max }).split('\n');
      }),
  );

  server.registerTool(
    'inspect',
    {
      title: 'What is inside',
      description:
        'Object card, as on a click in the scene or in the Model panel: what it is (name, type, which mod it comes from, whether mods change it), what is inside and what it references (building parts, interior, furniture, goods, squads, dialogues… by category; for placed objects, coordinates), who references it, and which model files it is built from. Kenshi objects have no scripts, so inside means only the record data. Empty parts are marked as such.',
      inputSchema: {
        id: z.string().describe('Id or name of a record (scene object, building, part, item)'),
        limit: limit(20),
      },
      annotations: { ...READ, title: 'What is inside' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const max = a.limit ?? 20;
        const lines = formatInside(inspectRecord(ctx, id, { limit: max === 0 ? Infinity : max })).split('\n');
        const model = modelOfRecord(ctx, id);
        if (model.pieces.length > 0) {
          lines.push('model:');
          for (const p of model.pieces) lines.push(`  ${p.mesh}${p.texture ? ` + ${p.texture}` : ''}${p.source !== id ? `  (part ${refLabel(ctx, p.source)})` : ''}`);
        }
        for (const n of model.notes) lines.push(`  ${n.en}`);
        return lines;
      }),
  );

  server.registerTool(
    'talk',
    {
      title: 'Talk to a character',
      description:
        'Conversation simulator: which dialogues a character has for an event (1 is the player speaking, the default), where each comes from (character, its package, squad, faction; source layer), scores, conditions, actions (arrest, attack, trade, hire) and a verdict: which one the game picks, which fires only under conditions, which never plays. Then the start of the winning conversation with its text and the player choices. The choice follows the rule from the game code (scores, order, equal draw, chances). Use play to continue step by step.',
      inputSchema: {
        id: z.string().describe('Id or name of a character (CHARACTER)'),
        event: z.number().int().min(0).optional().describe('Event (DIALOGUE_PACKAGE dialogs v0); 1 is a conversation on click'),
      },
      annotations: { ...READ, title: 'Talk to a character' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id, ['CHARACTER']);
        const translation = session.translation();
        return formatTalk(simulateTalk(ctx, id, a.event ?? 1, translation ? { translation } : {}));
      }),
  );

  server.registerTool(
    'diff',
    {
      title: 'What the mod changes',
      description: 'Changes of the mod relative to the lower layers: for all mod records or for one (id). The last line is a summary: new N, changed M, deleted K.',
      inputSchema: {
        id: z.string().optional().describe('Id or record name'),
        status: z.array(z.enum(['added', 'changed', 'removed'])).optional().describe('Only these changes'),
        offset,
        limit: limit(20),
      },
      annotations: { ...READ, title: 'What the mod changes' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const ids = a.id !== undefined ? [resolveId(ctx, a.id)] : ctx.modRecords().map((r) => r.stringId);
        const diffs = ids.flatMap((sid) => modRecordDiff(ctx, sid) ?? []);
        const shown = filterDiffs(diffs, a.status);
        const lines = paged(shown, a.offset ?? 0, a.limit ?? 20, (d) => formatRecordDiff(ctx, d));
        lines.push(`${formatDiffSummary(diffs)}${a.status ? `; shown: ${a.status.join(', ')}` : ''}`);
        return lines;
      }),
  );

  server.registerTool(
    'validate',
    {
      title: 'Validate mod',
      description: 'Broken references, fields outside the schema, references of the wrong type, values outside the enum, dialogues without lines, dangling references to records removed by dependencies, too many references in a list, record type changed over the lower layer, string id taken by another mod. The fix tool repairs them.',
      inputSchema: { offset, limit: limit(50) },
      annotations: { ...READ, title: 'Validate mod' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const issues = validateMod(ctx);
        const errors = issues.filter((i) => i.severity === 'error').length;
        const lines = issues.length ? paged(issues, a.offset ?? 0, a.limit ?? 50, (i) => [formatIssue(ctx, i)]) : [];
        lines.push(`errors ${errors}, warnings ${issues.length - errors}`);
        return lines;
      }),
  );

  /** Step title in plain words (English: MCP texts are English), as in the editor window. */
  const title = (ctx: ModContext, cs: Changeset): string => {
    const tr = session.translation();
    return `#${String(cs.id)} ${describeChangeset(ctx, cs, tr ? { translation: tr } : {}).text.en}`;
  };
  server.registerTool(
    'edit',
    {
      title: 'Edit mod',
      description: [
        'A batch of operations as one edit (one undo). New records can be named with an alias as: "$x" and referenced later (id/target: "$x").',
        'create {type,name,id?,as?}; duplicate {from,name?,id?,as?}; delete {id,removeReferences?}; restore {id}; revert {id} (remove the record from the mod);',
        'rename {id,name}; set {id,field,value,dict?} (an enum field can be set by name, DR_ONCE_ONLY or ONCE_ONLY, or by number); reset {id,field,dict?} (return the value of the lower layer);',
        'addRef {id,category,target,values?}; removeRef {id,category,target}; setRefs {id,category,refs:[{target,values?}]};',
        'info {author?,description?,dependencies?,references?,version?,lastId?} (the mod header).',
        'Dialogue graph (as in the editor; parent is a dialogue or a line, child is a line):',
        'addLine {parent,speaker?,text?|texts?,as?} (a new line at the end of the branch); insertLine {parent,child,speaker?,text?,as?} (instead of the link parent→child: parent→new→child);',
        'link {parent,child} (a link: loop, shared answer); unlink {parent,child}; setText {id,text|texts}; duplicateLine {id,parent?,as?} (a copy with its own conditions);',
        'deleteLines {lines?,links?:[{parent,child}]} (delete lines with their conditions, and links); revertLine {id} (restore a game line as in the game);',
        'addCondition {id,cond,value,who?,cmp?,tag?} — cond: DialogConditionEnum (DC_…), who: TalkerEnum, cmp: ComparisonEnum (CE_EQUALS, CE_LESS, CE_MORE); addEffect {id,action,values?} — DialogActionEnum (DA_…); removeAction {id,category,action}.',
        'Vanilla lines can be edited: the edit goes into the mod layer on top of the game.',
      ].join('\n'),
      inputSchema: {
        ops: z.array(editOp).min(1),
        label: z.string().optional().describe('Label of the edit in the history'),
      },
      annotations: { ...EDIT, title: 'Edit mod' },
    },
    (a) =>
      run(async () => {
        if (session.editor) {
          const r = await session.propose(a.label ?? `${a.ops.length} edits`, a.ops.map((op) => compact(op)));
          const lines = [`in the editor: change set #${r.changeset.id} "${r.changeset.title}" is waiting for the user decision (accept / revert)`];
          const aliases = Object.entries(r.aliases);
          if (aliases.length) lines.push(`aliases: ${aliases.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
          lines.push(...r.changeset.summary);
          return lines;
        }
        const ctx = session.ctx();
        const before = ctx.history().undo.length;
        const r = applyOps(ctx, a.ops.map((op) => compact(op)), a.label);
        const lines: string[] = [];
        const aliases = Object.entries(r.aliases);
        if (aliases.length) lines.push(`aliases: ${aliases.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
        const cs = ctx.history().undo.at(-1);
        if (cs && ctx.history().undo.length > before) lines.push(title(ctx, cs), ...formatChangeset(ctx, cs).slice(1));
        else lines.push('nothing changed');
        return lines;
      }),
  );

  server.registerTool(
    'fix',
    {
      title: 'Fix validation problems',
      description: [
        'Fixes for the problems validate finds: remove-ref (remove the invalid reference or field), revert (return the record or field to the lower layer, or restore a deleted target),',
        'remove-record (delete a record the mod added), new-id (give the record a free id of this mod and remap the mod references). Only what the mod itself changes is touched.',
        'Without kind each problem gets its recommended fix. By default only a preview; apply: true applies all chosen fixes as one edit (one undo);',
        'if the editor is connected, it sends a change set to the window. Saving is separate (save).',
      ].join('\n'),
      inputSchema: {
        kind: z.enum(FIX_KINDS as [FixKind, ...FixKind[]]).optional().describe('Fix kind; problems without such a fix are skipped'),
        codes: z.array(z.string()).optional().describe('Only problems with these codes (broken-ref, unknown-field, wrong-kind, too-many-refs, type-changed, id-taken, …)'),
        ids: z.array(z.string()).optional().describe('Only problems of these records (string ids)'),
        apply: z.boolean().optional().describe('true to apply; without it only a preview'),
        limit: limit(50),
      },
      annotations: { ...EDIT, title: 'Fix validation problems' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const codes = a.codes ? new Set(a.codes) : undefined;
        const ids = a.ids ? new Set(a.ids) : undefined;
        const issues = validateMod(ctx).filter((i) => (!codes || codes.has(i.code)) && (!ids || ids.has(i.stringId)));
        const plan = planFixes(ctx, issues, a.kind);
        const max = a.limit === 0 ? Infinity : (a.limit ?? 50);
        const lines = plan.fixed.slice(0, max).map((f) => formatFix(f));
        if (plan.fixed.length > max) lines.push(`… ${plan.fixed.length - max} more (limit)`);
        lines.push(`problems ${issues.length}, will be fixed ${plan.fixed.length}, without a fix ${plan.skipped.length}`);
        if (!a.apply) return [...lines, 'preview: nothing changed (apply: true to apply)'];
        if (plan.ops.length === 0) return [...lines, 'nothing to fix'];
        if (session.editor) {
          const r = await session.propose(plan.label, plan.ops);
          return [...lines, `in the editor: change set #${r.changeset.id} "${r.changeset.title}" is waiting for the user decision (accept / revert)`];
        }
        applyFixPlan(ctx, plan);
        const cs = ctx.history().undo.at(-1);
        return [...lines, cs ? `applied: ${title(ctx, cs)}` : 'applied'];
      }),
  );

  server.registerTool(
    'cleanup',
    {
      title: 'Clean up mod',
      description: [
        'What can be removed from the mod: obsolete-field (fields and reference lists the schema does not know, FCS Extended fields count as known), no-op (changes equal to the lower layer),',
        'deleted-base (changes to records no lower layer has any more), orphaned (new dialogue lines or effects nothing references), invalid-refs (references to missing records),',
        'undefined-type (new records of a type the schema does not know). By default only a grouped preview; apply: true removes the chosen groups or items as one edit (one undo).',
      ].join('\n'),
      inputSchema: {
        groups: z.array(z.enum(CLEANUP_GROUPS as [CleanupGroup, ...CleanupGroup[]])).optional().describe('Only these groups'),
        ids: z.array(z.string()).optional().describe('Only items of these records (string ids)'),
        apply: z.boolean().optional().describe('true to apply; without it only a preview'),
        limit: limit(100),
      },
      annotations: { ...EDIT, title: 'Clean up mod' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const scan = scanCleanup(ctx);
        const groups = a.groups ? new Set(a.groups) : undefined;
        const ids = a.ids ? new Set(a.ids) : undefined;
        const items = scan.items.filter((i) => (!groups || groups.has(i.group)) && (!ids || ids.has(i.stringId)));
        const all = formatCleanup(ctx, { ...scan, items });
        const max = a.limit === 0 ? Infinity : (a.limit ?? 100);
        const lines = all.slice(0, max);
        if (all.length > max) lines.push(`… ${all.length - max} more lines (limit)`);
        lines.push(`will be removed: ${items.length}`);
        if (!a.apply) return [...lines, 'preview: nothing changed (apply: true to apply)'];
        if (items.length === 0) return [...lines, 'nothing to clean'];
        if (session.editor) {
          const r = await session.propose(`очистка: ${items.length}`, cleanupOps(items));
          return [...lines, `in the editor: change set #${r.changeset.id} "${r.changeset.title}" is waiting for the user decision (accept / revert)`];
        }
        applyCleanup(ctx, items);
        const cs = ctx.history().undo.at(-1);
        return [...lines, cs ? `applied: ${title(ctx, cs)}` : 'applied'];
      }),
  );

  server.registerTool(
    'bulk',
    {
      title: 'Bulk edit',
      description: [
        'Records of one type by conditions → one operation on a field: set, mul (multiply), add, replace (replace text; field "name" is the record name), refAdd / refRemove (add or remove a reference: field is a reference list such as items; value is the id or name of the target; values are v0..v2).',
        'By default only a was → will be preview, nothing is changed. apply: true applies it as one edit (one undo);',
        'if the editor is connected, it sends a change set to the window and the user accepts or reverts it. Saving is separate (save).',
      ].join('\n'),
      inputSchema: {
        type: z.union([z.string(), z.number()]).describe('Record type: name (WEAPON) or number'),
        text: z.string().optional().describe('Substring of name (English or translated) or id'),
        fields: z.array(z.string()).optional().describe('Conditions: key=val, key~substring (or key:substring), key!:substring (does not contain), key?regexp, != < > <= >=, key? (field exists); for references: list>5, list.v0=4, ref>0, list.key=… (through references); keywords type, state, ref'),
        mod_only: z.boolean().optional().describe('Only records that already exist in the mod'),
        op: z.enum(['set', 'mul', 'add', 'replace', 'refAdd', 'refRemove']),
        field: z.string().describe('Field key (for replace it can be name)'),
        value: z.string().describe('set: the value (enum: name or number); mul/add: a number; replace: what to replace with'),
        find: z.string().optional().describe('replace: what to look for'),
        values: z.array(z.number()).optional().describe('refAdd: reference values v0, v1, v2'),
        regex: z.boolean().optional().describe('replace: find is a regular expression ($1 for groups)'),
        case_sensitive: z.boolean().optional(),
        apply: z.boolean().optional().describe('true to apply; without it only a preview'),
        limit: limit(50),
      },
      annotations: { ...EDIT, title: 'Bulk edit' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const p = previewBulk(
          ctx,
          compact({ type: a.type, text: a.text === '' ? undefined : a.text, fields: a.fields?.map(parseFieldFilter), modOnly: a.mod_only }),
          compact({ kind: a.op, field: a.field, value: a.value, find: a.find, regex: a.regex, caseSensitive: a.case_sensitive, values: a.values }),
        );
        const lines = formatBulkPreview(p, a.limit === 0 ? Infinity : (a.limit ?? 50));
        if (!a.apply) return [...lines, 'preview: nothing changed (apply: true to apply)'];
        if (p.ops.length === 0) return [...lines, 'nothing to change'];
        if (session.editor) {
          const r = await session.propose(p.label, p.ops);
          return [...lines, `in the editor: change set #${r.changeset.id} "${r.changeset.title}" is waiting for the user decision (accept / revert)`];
        }
        applyBulk(ctx, p);
        const cs = ctx.history().undo.at(-1);
        return [...lines, cs ? `applied: ${title(ctx, cs)}` : 'applied'];
      }),
  );

  server.registerTool(
    'race_compat',
    {
      title: 'Race compatibility',
      description: [
        'Make a new race work like a sample race ("like Greenlander"): finds every place the sample is referenced and offers to add the new race there with the same values.',
        'Groups: armour (races / races exclude of armour and clothing), weapons (race damage), items (backpacks and other items), dialogue (my race, my subrace, target race, no target race),',
        'raceGroups (RACE_GROUP, needed to be playable), starts (NEW_GAME_STARTOFF force race), animations (animation files of the sample race copied into the new race);',
        'body (combat anatomy, limb replacement, severed limbs, AI Goals of the sample; on when the new race has none of its own);',
        'off by default: factions (faction population), looks (hairs, hair colors, heads), flags (no hats / no shirts / no shoes, part maps), other. Single-race fields (CHARACTER race, squad race override) are only listed.',
        'Also warns when the race meshes use different skeletons. By default only a preview; apply: true applies the chosen changes as one edit (one undo) into the open mod;',
        'if the editor is connected, it sends a change set to the window. Saving is separate (save).',
        'New race from scratch: give new_name instead of race. The new race is a full copy of the sample (like) under that name (its body, heads, hairs, animations come along), then the compatibility edits;',
        'the preview shows both, apply: true makes them one edit. The name must not be empty, the name of the sample or of another race.',
      ].join('\n'),
      inputSchema: {
        race: z.string().optional().describe('The new race: id or name of an existing race (or give new_name instead)'),
        new_name: z.string().optional().describe('Create the new race as a copy of the sample under this name (instead of race)'),
        like: z.string().describe('The sample race: id or name'),
        groups: z.array(z.enum(RACE_COMPAT_GROUPS as [RaceCompatGroup, ...RaceCompatGroup[]])).optional().describe('Apply exactly these groups (default: the groups that are on by default)'),
        exclude: z.array(z.string()).optional().describe('Records (string ids) to leave out'),
        apply: z.boolean().optional().describe('true to apply; without it only a preview'),
        limit: limit(50),
      },
      annotations: { ...EDIT, title: 'Race compatibility' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        if ((a.race === undefined) === (a.new_name === undefined)) throw new SessionError('Give either race (an existing race) or new_name (a new race copied from like)');
        const sample = findRace(ctx, a.like);
        // A new race is planned on a scratch copy that is rolled back: the preview changes nothing.
        let newSid: string | undefined;
        let plan: RaceCompatPlan;
        if (a.new_name !== undefined) {
          const name = a.new_name;
          plan = scratch(ctx, () => {
            newSid = createRaceFrom(ctx, sample, name);
            return planRaceCompat(ctx, newSid, sample);
          });
        } else plan = planRaceCompat(ctx, findRace(ctx, a.race!), sample);
        const groups = a.groups ? new Set<RaceCompatGroup>(a.groups) : undefined;
        const exclude = new Set(a.exclude ?? []);
        const chosen = new Set(plan.changes.filter((c) => (groups ? groups.has(c.group) : c.checked) && !exclude.has(c.sid)).map((c) => c.key));
        const lines = formatRaceCompat(plan, chosen, a.limit === 0 ? Infinity : (a.limit ?? 50));
        const warning = raceSkeletonWarning(ctx, plan, (path) => {
          try {
            return parseOgreMesh(readFileSync(join(session.paths.kenshi, path))).skeleton;
          } catch {
            return undefined;
          }
        });
        if (warning) lines.push(`warning: ${warning.en}`);
        if (newSid !== undefined) lines.unshift(`new race: ${newSid} “${plan.raceName}”, a copy of ${plan.sample} “${plan.sampleName}”`);
        if (!a.apply) return [...lines, 'preview: nothing changed (apply: true to apply)'];
        const p = raceCompatPreview(plan, chosen);
        if (newSid !== undefined) {
          const sid = newSid;
          const label = newRaceLabel(plan.raceName, plan.sampleName, p.changes.length);
          if (session.editor) {
            const ops: EditOp[] = [{ op: 'duplicate', from: sample, id: sid, name: plan.raceName }, ...p.ops];
            const r = await session.propose(label, ops);
            return [...lines, `in the editor: change set #${r.changeset.id} "${r.changeset.title}" is waiting for the user decision (accept / revert)`];
          }
          ctx.transaction(label, () => {
            createRaceFrom(ctx, sample, plan.raceName, { stringId: sid });
            if (p.ops.length > 0) applyBulk(ctx, p);
          });
          const cs = ctx.history().undo.at(-1);
          return [...lines, cs ? `applied: ${title(ctx, cs)}` : 'applied'];
        }
        if (p.ops.length === 0) return [...lines, 'nothing to change'];
        if (session.editor) {
          const r = await session.propose(p.label, p.ops);
          return [...lines, `in the editor: change set #${r.changeset.id} "${r.changeset.title}" is waiting for the user decision (accept / revert)`];
        }
        applyBulk(ctx, p);
        const cs = ctx.history().undo.at(-1);
        return [...lines, cs ? `applied: ${title(ctx, cs)}` : 'applied'];
      }),
  );

  server.registerTool(
    'merge',
    {
      title: 'Merge mods',
      description: [
        'Merge: what another mod (source is the name of an installed mod or a path to .mod/.base) changes relative to the open mod: new, changed (with was → will be fields) and deleted records; conflicts are when the field was changed both by you and by the source.',
        'By default only a preview. apply: true merges the selection as one edit (one undo), selection: ids / types / kinds / all. recursive also takes the records they reference (a whole dialogue); fix_refs also adds the new records referenced by the accepted ones.',
        'conflicts: mine (the default, your values stay) | source; resolutions are per record and field (the key from the preview, for example ints:value; for deletion it is record).',
        'reject / unreject reject and hide in the next merges (show_rejected shows them). Merging level data (leveldata, *.zone) is not supported: levels: true only reports it.',
        'A mod that is open as a dependency cannot be merged. The mod and the decisions file <mod>.kedit-merge.json are written by save (into the game folder only with force). With the editor connected only a preview is possible; merge with the Merge panel in the window.',
      ].join('\n'),
      inputSchema: {
        source: z.string().describe('Source mod: name of an installed mod or a path to the file'),
        ids: z.array(z.string()).optional().describe('Which records to merge (ids from the preview)'),
        types: z.array(z.string()).optional().describe('Merge records of these types (name or number)'),
        kinds: z.array(z.enum(['new', 'changed', 'deleted'])).optional().describe('Merge records of this kind of change'),
        all: z.boolean().optional().describe('Merge everything in the list'),
        recursive: z.boolean().optional(),
        fix_refs: z.boolean().optional(),
        conflicts: z.enum(['mine', 'source']).optional(),
        resolutions: z.record(z.string(), z.record(z.string(), z.enum(['mine', 'source']))).optional().describe('record id → field key → mine | source'),
        reject: z.array(z.string()).optional(),
        unreject: z.array(z.string()).optional(),
        show_rejected: z.boolean().optional(),
        levels: z.boolean().optional().describe('Show the level data of the source (it is not merged)'),
        apply: z.boolean().optional().describe('true to merge; without it only a preview'),
        limit: limit(50),
      },
      annotations: { ...EDIT, title: 'Merge mods' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const ledger = session.mergeLedger();
        const { source, levelData } = session.mergeSource(a.source, a.levels ?? false);
        const options = { showRejected: a.show_rejected ?? false, ...(levelData ? { levelData } : {}) };
        const lines: string[] = [];
        if (a.reject?.length || a.unreject?.length) {
          if (session.editor) throw new SessionError('Connected to the editor: merge decisions are made in the Merge panel');
          const done = a.reject?.length ? rejectMerge(ctx, source, ledger, a.reject, options) : [];
          if (a.unreject?.length) unrejectMerge(ledger, source, a.unreject);
          lines.push(`rejected ${done.length}, restored ${a.unreject?.length ?? 0} (saved together with the mod: save)`);
        }
        const plan = planMerge(ctx, source, ledger, options);
        lines.push(...formatMergePlan(plan, a.limit === 0 ? Infinity : (a.limit ?? 50)));
        if (!a.apply) return [...lines, 'preview: nothing changed (apply: true with ids / types / kinds / all to merge)'];
        if (session.editor) throw new SessionError('Connected to the editor: the merge is applied in the Merge panel of the window (only a preview is available here)');
        const accept = selectMergeChanges(plan, compact({ ids: a.ids, types: a.types, kinds: a.kinds, all: a.all }));
        if (accept.length === 0) throw new SessionError('What to merge? Give ids, types, kinds or all: true');
        const result = applyMerge(
          ctx,
          source,
          ledger,
          compact({ accept, recursive: a.recursive, fixReferences: a.fix_refs, levelData: a.levels, conflicts: a.conflicts, resolutions: a.resolutions }),
          options,
        );
        const cs = ctx.history().undo.at(-1);
        return [...formatMergeResult(result), cs && result.changesetId !== undefined ? `applied: ${title(ctx, cs)}` : 'nothing to change', 'saving is separate (save)'];
      }),
  );

  const stepTo = {
    to: z.number().int().min(0).optional().describe('Step number #N from history: undo/redo everything up to it inclusive (undo to: 0 is the mod as it was opened)'),
  };
  const step = (dir: 'undo' | 'redo', to: number | undefined): Promise<ToolResult> =>
    run(() => {
      if (session.editor) throw new SessionError('Connected to the editor: the user undoes in the window (or reverts the change set)');
      const ctx = session.ctx();
      let done: Changeset[];
      if (to === undefined) {
        const cs = dir === 'undo' ? ctx.undo() : ctx.redo();
        done = cs ? [cs] : [];
      } else if (dir === 'undo') {
        const first = ctx.history().undo[0];
        done = to === 0 ? (first ? ctx.undoTo(first.id) : []) : ctx.undoTo(to);
      } else done = ctx.redoTo(to);
      if (!done.length) return [dir === 'undo' ? 'nothing to undo' : 'nothing to redo'];
      return [`${dir === 'undo' ? 'undone' : 'redone'}:`, ...done.map((cs) => `  ${title(ctx, cs)}`)];
    });
  server.registerTool(
    'undo',
    {
      title: 'Undo',
      description: 'Undo the last edit or (to) all edits up to step #N inclusive. The answer lists the undone steps in plain words.',
      inputSchema: stepTo,
      annotations: { ...EDIT, title: 'Undo' },
    },
    (a) => step('undo', a.to),
  );
  server.registerTool(
    'redo',
    {
      title: 'Redo',
      description: 'Redo an undone edit or (to) all undone ones up to step #N inclusive.',
      inputSchema: stepTo,
      annotations: { ...EDIT, title: 'Redo' },
    },
    (a) => step('redo', a.to),
  );

  server.registerTool(
    'history',
    {
      title: 'Edit history',
      description:
        'Edit steps in plain words, as in the editor window: the active ones in order up to "you are here", below them the undone ones (redo brings them back). detail shows the changes of one step by number.',
      inputSchema: { detail: z.number().int().optional().describe('Step number (#N)') },
      annotations: { ...READ, title: 'Edit history' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const { undo, redo } = ctx.history();
        if (a.detail !== undefined) {
          const cs = [...undo, ...redo].find((c) => c.id === a.detail);
          if (!cs) throw new SessionError(`No edit #${a.detail}`);
          return [title(ctx, cs), ...formatChangeset(ctx, cs).slice(1)];
        }
        const state = ctx.dirty ? 'there are unsaved changes' : 'everything is saved';
        if (!undo.length && !redo.length) return ['no edits', state];
        const done = ['#0 the mod as it was opened', ...undo.map((c) => title(ctx, c))];
        const lines = [...done.slice(0, -1), `${done.at(-1) ?? ''}  ← you are here`];
        if (redo.length) lines.push('undone (redo brings them back):', ...[...redo].reverse().map((c) => `  ${title(ctx, c)}`));
        lines.push(state);
        return lines;
      }),
  );

  server.registerTool(
    'play',
    {
      title: 'Conversation step by step',
      description:
        'Conversation player, as in the editor window: character + event → which dialogue the game picks and why the others do not (by the rule from the game code), what the NPC says, which answers the player sees. answers are the ids of the player answers in order (or @npc: the NPC continues alone) to go further. mode: met means conditions are treated as met (the default), none means only lines without conditions pass; assume sets, for individual records, whether conditions are met (true) or not (false).',
      inputSchema: {
        id: z.string().describe('Id or name of a character (CHARACTER)'),
        event: z.number().int().min(0).optional().describe('Event; 1 is the player speaking (the default)'),
        answers: z.array(z.string()).optional().describe('Player answers in order: line ids from the previous output, or @npc'),
        mode: z.enum(['met', 'none']).optional(),
        assume: z.record(z.string(), z.boolean()).optional().describe('dialogue or line id → conditions met (true) or not (false)'),
      },
      annotations: { ...READ, title: 'Conversation step by step' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id, ['CHARACTER']);
        const res = playConversation(ctx, id, {
          event: a.event ?? 1,
          ...(a.mode ? { mode: a.mode } : {}),
          ...(a.answers ? { answers: a.answers } : {}),
          ...(a.assume ? { assume: new Map(Object.entries(a.assume)) } : {}),
        });
        const tr = session.translation();
        return formatPlay(ctx, res, { ...(tr ? { translation: tr } : {}), ...(a.mode ? { mode: a.mode } : {}) });
      }),
  );

  server.registerTool(
    'save',
    {
      title: 'Save mod',
      description: 'Write the mod (only the changes relative to the lower layers). Without path: to where it was opened from. Into the game or Workshop folder only with force: true.',
      inputSchema: {
        path: z.string().optional(),
        force: z.boolean().optional().describe('Allow writing into the game or Workshop folder'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: 'Save mod' },
    },
    (a) =>
      run(() => {
        const r = session.save(a.path, a.force ?? false);
        const ctx = session.ctx();
        const errors = validateMod(ctx).filter((i) => i.severity === 'error');
        const lines = [`${r.path}: ${statusSummary(ctx)}`];
        if (errors.length) lines.push(`validation errors: ${errors.length} (validate)`);
        if (r.mergeStore) lines.push(`merge decisions: ${r.mergeStore}`);
        if (r.world) lines.push(`level files: ${r.world.map((f) => `leveldata/${f}`).join(', ')}`);
        return lines;
      }),
  );

  server.registerTool(
    'connect_editor',
    {
      title: 'Connect to the editor',
      description:
        'Connect to the open Cactus window (locally): after that find/show/… read the mod from the window, and edit sends changes to the window as a change set that the user accepts or reverts. disconnect: true disconnects.',
      inputSchema: { disconnect: z.boolean().optional() },
      annotations: { ...READ, title: 'Connect to the editor' },
    },
    (a) =>
      guarded(async () => {
        if (a.disconnect) {
          const was = session.editor !== undefined;
          session.disconnectEditor();
          return [was ? 'disconnected from the editor; now working on vanilla (open_mod opens a mod)' : 'the editor was not connected anyway'];
        }
        const st = await session.connectEditor();
        const ctx = session.ctx();
        const lines = [`connected to the editor: ${st.modName}${st.modPath ? ` — ${st.modPath}` : ' (new, not saved)'}`, statusSummary(ctx)];
        if (st.dependencies.length) lines.push(`dependencies: ${st.dependencies.map((d) => d.name).join(', ')}`);
        if (st.game !== undefined && st.game.toLowerCase() !== session.paths.kenshi.toLowerCase()) lines.push(`warning: the editor uses the game ${st.game}, the server uses ${session.paths.kenshi}`);
        if (st.dirty) lines.push('there are unsaved changes in the window');
        return lines;
      }),
  );

  server.registerTool(
    'editor_changes',
    {
      title: 'Change sets in the editor',
      description: 'Change sets sent to the editor (edit while connect_editor is active) and the user decision on each: pending, accepted, rolled back, undone.',
      annotations: { ...READ, title: 'Change sets in the editor' },
    },
    () =>
      run(async () => {
        const list = await session.editorChangesets();
        if (!list.length) return ['no change sets'];
        const label: Record<string, string> = { pending: 'waiting for a decision', accepted: 'accepted', 'rolled-back': 'rolled back', undone: 'undone in the window' };
        return list.map((c) => `#${c.id} "${c.title}" — ${label[c.status] ?? c.status}; records: ${c.touched.join(', ')}`);
      }),
  );

  server.registerTool(
    'touched',
    {
      title: 'Who changes a record',
      description:
        'Which mods of the player (in mods.cfg order; all means all installed) and the open mod change the record and what exactly: fields, references, deletion. A later mod wins. Read only.',
      inputSchema: {
        id: z.string().describe('String id or record name'),
        all: z.boolean().optional().describe('All installed mods, not only those enabled in mods.cfg'),
      },
      annotations: { ...READ, title: 'Who changes a record' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        let sid = a.id;
        try {
          sid = resolveId(ctx, a.id);
        } catch (e) {
          if (!(e instanceof SessionError) || !e.message.startsWith('No record')) throw e;
        }
        const { layers, broken } = session.modLayers(a.all ?? false);
        const r = touchedBy(layers, sid);
        const nameOf = (s: string): string => refLabel(ctx, s);
        const lines = [`${sid} ${ctx.name(sid) ?? ''} — mods: ${r.touches.length}${r.base ? '' : ' (the record is not in vanilla)'}`, ...formatTouches(r, nameOf)];
        for (const b of broken) lines.push(`could not read ${b.name}: ${b.error}`);
        return lines;
      }),
  );

  server.registerTool(
    'conflicts',
    {
      title: 'Mod conflicts',
      description:
        'Records and fields that several mods change differently, the value of each mod and who wins (the later one in mods.cfg). mod_only: only conflicts of the open mod. Read only.',
      inputSchema: {
        mod_only: z.boolean().optional().describe('Only conflicts of the open mod (including its unsaved edits)'),
        all: z.boolean().optional().describe('All installed mods, not only those enabled in mods.cfg'),
        offset,
        limit: limit(20),
      },
      annotations: { ...READ, title: 'Mod conflicts' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const { layers, broken, opened } = session.modLayers(a.all ?? false);
        if (a.mod_only && opened === undefined) throw new SessionError('No mod is open or it has no records: open_mod');
        const found = findConflicts(layers, a.mod_only && opened !== undefined ? { only: opened } : {});
        const nameOf = (s: string): string => refLabel(ctx, s);
        const fields = found.reduce((n, x) => n + x.fields.length, 0);
        const head = [`mods ${layers.filter((l) => !isVanillaLayer(l.name)).length}; records with conflicts ${found.length}, fields ${fields}`];
        for (const b of broken) head.push(`could not read ${b.name}: ${b.error}`);
        return [...head, ...paged(found, a.offset ?? 0, a.limit ?? 20, (x) => formatConflict(x, nameOf))];
      }),
  );

  server.registerTool(
    'schema',
    {
      title: 'Schema',
      description:
        'Without arguments: the record types; type: the fields of a type with descriptions from fcs.def; enum: the values of an enumeration; ' +
        'extension: what a schema extension of the opened mod adds, with its warnings. Whatever comes from a schema extension is marked [extension NAME].',
      inputSchema: {
        type: z.string().optional(),
        enum: z.string().optional(),
        extension: z.string().optional().describe('Name of a schema extension (FCS Extended files in a mod folder), as open_mod lists it'),
        offset,
        limit: limit(100),
      },
      annotations: { ...READ, title: 'Schema' },
    },
    (a) =>
      run(() => {
        const schema = session.schema();
        if (a.enum !== undefined) {
          const lines = formatEnum(schema, a.enum);
          if (!lines) throw new SessionError(`No enumeration ${a.enum}`);
          return lines;
        }
        if (a.type !== undefined) {
          const t = findTypeSchema(schema, a.type);
          if (!t) throw new SessionError(`No type ${a.type}`);
          return formatTypeSchema(t);
        }
        const extensions = summarizeExtensions(schema);
        if (a.extension !== undefined) {
          const wanted = a.extension.toLowerCase();
          const found = extensions.filter((s) => s.name.toLowerCase() === wanted);
          if (found.length === 0) {
            const have = extensions.length ? `; applied: ${extensions.map((s) => s.name).join(', ')}` : '; the opened mod has no schema extensions';
            throw new SessionError(`No schema extension ${a.extension}${have}`);
          }
          return found.flatMap(formatExtensionDetail);
        }
        return [...extensions.map((s) => formatExtensionSummary(s)), ...paged(listTypes(schema), a.offset ?? 0, a.limit ?? 100, (t) => [typeLine(t)])];
      }),
  );

  // ------------------------------------------------------------------ resources

  const resourceText = (uri: URL, lines: readonly string[]): { contents: { uri: string; mimeType: string; text: string }[] } => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: lines.join('\n') }],
  });
  const one = (v: string | string[] | undefined): string => decodeURIComponent((Array.isArray(v) ? v[0] : v) ?? '');

  server.registerResource(
    'schema-types',
    'kenshi://schema/types',
    { title: 'Record types', description: 'All record types: number of fields and references', mimeType: 'text/plain' },
    (uri) => resourceText(uri, listTypes(session.schema()).map(typeLine)),
  );

  server.registerResource(
    'schema-type',
    new ResourceTemplate('kenshi://schema/type/{name}', {
      list: () => ({
        resources: listTypes(session.schema()).map((t) => ({ uri: `kenshi://schema/type/${t.name}`, name: t.name, mimeType: 'text/plain' })),
      }),
    }),
    { title: 'Type fields', description: 'Fields of a record type with kinds, default values and descriptions from fcs.def', mimeType: 'text/plain' },
    (uri, vars) => {
      const name = one(vars['name']);
      const t = findTypeSchema(session.schema(), name);
      if (!t) throw new SessionError(`No type ${name}`);
      return resourceText(uri, formatTypeSchema(t));
    },
  );

  server.registerResource(
    'schema-enum',
    new ResourceTemplate('kenshi://schema/enum/{name}', { list: undefined }),
    { title: 'Enumeration', description: 'Values of an enumeration from fcs_enums.def', mimeType: 'text/plain' },
    (uri, vars) => {
      const name = one(vars['name']);
      const lines = formatEnum(session.schema(), name);
      if (!lines) throw new SessionError(`No enumeration ${name}`);
      return resourceText(uri, lines);
    },
  );

  registerGameTools(server, opts.game ?? new GameBridge());
  registerWorldTools(server, session, { run, resolveId });

  return server;
}

function typeLine(t: ReturnType<typeof listTypes>[number]): string {
  return `${t.name}  fields ${t.fields}, references ${t.references}${t.inferred ? ' (from data)' : ''}${typeOriginNote(t)}`;
}

/** Lines of open_mod about the schema extensions of the mod: what each adds, its DLL plugins, its warnings. */
function extensionLines(r: OpenResult): string[] {
  const out: string[] = [];
  const summaries = r.ctx.schema ? summarizeExtensions(r.ctx.schema) : [];
  for (const s of summaries) {
    out.push(formatExtensionSummary(s));
    if (s.warnings.length) out.push(`  details: schema with extension: ${JSON.stringify(s.name)}`);
  }
  for (const e of r.extensions) {
    if (!summaries.some((s) => s.name === e.name)) out.push(`schema extension ${e.name}: no schema files, only FCS_extended.json`);
    if (e.plugins.length) out.push(`  DLL plugins of FCS Extended, not run here: ${e.plugins.join(', ')}`);
    if (e.configError !== undefined) out.push(`  ${e.configError}`);
  }
  return out;
}
