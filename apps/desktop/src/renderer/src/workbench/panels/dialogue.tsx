/**
 * Dialogue panels: dialogue graph (with editing and the «▶ Play» strip under it), line inspector,
 * conversation player (the same strip on its own, for a character).
 * Lines selected in the graph or inspector are a selection of kind «line»: the graph does not jump after them,
 * the line inspector shows the latest one.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { EVENT_TALK, formatEnumValue, refValueEnum, simulateTalk, squadIndex, talkSources } from '@kenshi-editor/core';
import { DialogueGraphTab } from '../../components/DialogueGraphTab.tsx';
import { LineInspector } from '../../components/LineInspector.tsx';
import { TalkExample } from '../../components/ConversationPlayer.tsx';
import { PlayStrip } from '../../components/PlayStrip.tsx';
import { TalkRulesBody, TalkTab } from '../../components/TalkTab.tsx';
import { useLang, useT } from '../../i18n.ts';
import { recordName } from '../../data-names.ts';
import type { Project } from '../../project.ts';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Select a line (without «back/forward» history: these are steps inside a dialogue). */
function useSelectLine(dialog: string | undefined): (sid: string, parent?: string) => void {
  const { selection } = useWorkbench();
  return (sid, parent) => {
    selection.select({ kind: 'line', sid, ...(dialog !== undefined ? { dialog } : {}), ...(parent !== undefined ? { parent } : {}) }, { history: false });
  };
}

function GraphPanel({ def, params }: PanelProps): ReactNode {
  const { project } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  if (sid === undefined) return <Empty types={def.shows?.types} />;
  const rec = project.record(sid);
  if (rec && project.ctx.typeName(rec.type) === 'CHARACTER') return <CharacterGraph key={sid} character={sid} version={version} />;
  return <Graph sid={sid} version={version} />;
}

/** One dialogue of a character, in the order the switcher lists them. */
interface CharDialog {
  dialog: string;
  event: number;
  main: boolean;
}

/**
 * Every dialogue that reaches a character: the talk dialogues in the order the game tries them
 * (the one it picks first is the main one and goes first), then those of the other events.
 */
function characterDialogs(project: Project, character: string): CharDialog[] {
  const ctx = project.ctx;
  const rec = ctx.get(character);
  if (!rec) return [];
  const squads = squadIndex(ctx);
  const sim = simulateTalk(ctx, character, EVENT_TALK, { squads });
  const talk = sim.candidates.filter((c) => c.verdict !== 'missing').map((c) => c.dialog);
  const main = sim.winner ?? talk[0];
  const out: CharDialog[] = [];
  const seen = new Set<string>();
  const add = (dialog: string, event: number): void => {
    if (seen.has(dialog) || !ctx.get(dialog)) return;
    seen.add(dialog);
    out.push({ dialog, event, main: dialog === main });
  };
  if (main !== undefined) add(main, EVENT_TALK);
  for (const d of talk) add(d, EVENT_TALK);
  const events = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0)?.values ?? [];
  for (const v of events) if (v.value !== EVENT_TALK) for (const s of talkSources(ctx, rec, v.value, squads)) add(s.dialog, v.value);
  return out;
}

/** A character in the graph: its main dialogue, with a switcher to any other of its dialogues. */
function CharacterGraph({ character, version }: { character: string; version: number }): ReactNode {
  const { project } = useWorkbench();
  const t = useT();
  const lang = useLang();
  const list = useMemo(() => characterDialogs(project, character), [project, character, version]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const selectLine = useSelectLine(undefined);
  const selectPlayed = useSelectPlayed();
  const who = recordName(project.ctx, character);
  if (!list.length) return <Empty text={t.dgCharNone(who)} />;
  const cur = list.find((d) => d.dialog === picked) ?? list[0]!;
  const at = list.indexOf(cur);
  const evDef = refValueEnum(project.ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  const evName = (event: number): string => (evDef ? formatEnumValue(evDef, event, lang) : String(event));
  return (
    <div className="dg-char" data-testid="graph-character" data-sid={character}>
      <div className="dg-char-bar">
        <span className="dg-char-who">{t.dgCharOf(who)}</span>
        <select
          data-testid="graph-character-dialog"
          value={cur.dialog}
          onChange={(e) => {
            setPicked(e.target.value);
          }}
        >
          {list.map((d) => (
            <option key={d.dialog} value={d.dialog} title={d.main ? t.dgCharMainHint : undefined}>
              {recordName(project.ctx, d.dialog)} — {evName(d.event)}
              {d.main ? ` (${t.dgCharMain})` : ''}
            </option>
          ))}
        </select>
        <span className="muted small" data-testid="graph-character-count">
          {t.dgCharCount(at + 1, list.length)}
        </span>
      </div>
      <Graph
        sid={cur.dialog}
        version={version}
        playWith={{
          character,
          event: cur.event,
          // A line of the conversation: the switcher goes to its dialogue, the strip keeps playing.
          onSelectLine: (line, dialog) => {
            if (dialog === undefined || !list.some((d) => d.dialog === dialog)) {
              selectPlayed(line, dialog);
              return;
            }
            setPicked(dialog);
            selectLine(line);
          },
        }}
      />
    </div>
  );
}

/** A line from the conversation: its dialogue goes to the graph, the line itself to the line inspector. */
function useSelectPlayed(): (line: string, dialog?: string) => void {
  const { selection } = useWorkbench();
  return (line, dialog) => {
    if (dialog !== undefined) selection.select({ kind: 'record', sid: dialog }, { history: false });
    selection.select({ kind: 'line', sid: line, ...(dialog !== undefined ? { dialog } : {}) }, { history: false });
  };
}

/** A character graph plays the character; its own line handler keeps the character graph on screen. */
interface PlayWith {
  character: string;
  event: number;
  onSelectLine: (line: string, dialog?: string) => void;
}

/**
 * The dialogue graph of one dialogue (or package / line) with the «▶ Play» strip under it. The strip
 * stays open while the panel follows other records; `playWith` — a character graph plays the character.
 */
function Graph({ sid, version, playWith }: { sid: string; version: number; playWith?: PlayWith }): ReactNode {
  const { project, go, report, selection, open, hasPanel, reveal, newEventDialogue } = useWorkbench();
  const selectLine = useSelectLine(sid);
  // A click on a node shows the «Line» panel even if «Inspector» is the front tab next to it.
  const select = (line: string, parent?: string): void => {
    selectLine(line, parent);
    reveal('line');
  };
  const selectPlayed = useSelectPlayed();
  const line = selection.latest((s) => s.kind === 'line');
  const [playOpen, setPlayOpen] = useState(false);
  // The strip stays on the record it was opened on while the graph walks to other dialogues.
  const [playFrom, setPlayFrom] = useState(sid);
  const [playing, setPlaying] = useState<string | undefined>();
  const strip = (
    <PlayStrip
      key={playWith ? playWith.character : playFrom}
      project={project}
      sid={playFrom}
      version={version}
      onGo={go}
      onSelectLine={playWith?.onSelectLine ?? selectPlayed}
      {...(playWith ? { character: playWith.character, event: playWith.event, sample: sid } : {})}
      onClose={() => { setPlayOpen(false); }}
      onPlaying={setPlaying}
      onLike={newEventDialogue}
    />
  );
  return (
    <DialogueGraphTab
      key={sid}
      project={project}
      sid={sid}
      version={version}
      onGo={go}
      selected={line?.kind === 'line' ? line.sid : undefined}
      onSelect={select}
      onReport={report}
      onShowLine={() => { open('line'); }}
      isLineOpen={() => hasPanel('line')}
      onPlay={() => {
        if (!playOpen) setPlayFrom(sid);
        setPlayOpen(!playOpen);
      }}
      playOpen={playOpen}
      strip={strip}
      playing={playOpen ? playing : undefined}
    />
  );
}

function LinePanel({ def, params }: PanelProps): ReactNode {
  const { project, go: goRecord, report, reveal, newEventDialogue } = useWorkbench();
  // «↗ Inspector» and other links of the panel select the record and bring the inspector to the front.
  const go = (s: string): void => {
    goRecord(s);
    reveal('inspector');
  };
  const { sid, item, version } = useFollowed(def, params);
  const dialog = item?.kind === 'line' ? item.dialog : undefined;
  const select = useSelectLine(dialog);
  if (sid === undefined || !project.record(sid)) return <Empty types={def.shows?.types} />;
  const parent = item?.kind === 'line' ? item.parent : undefined;
  return <LineInspector project={project} sid={sid} {...(parent !== undefined ? { parent } : {})} version={version} onGo={go} onSelect={select} onReport={report} onLike={newEventDialogue} />;
}

/** The «▶ Play» strip of a character on its own (the census opens it), with the talk summary. */
function PlayerPanel({ def, params }: PanelProps): ReactNode {
  const { project, go, newEventDialogue } = useWorkbench();
  const t = useT();
  const { sid, version } = useFollowed(def, params);
  const selectLine = useSelectPlayed();
  if (sid === undefined) return <Empty types={def.shows?.types} />;
  return (
    <div className="panel-scroll panel-pad">
      <PlayStrip key={sid} project={project} sid={sid} character={sid} version={version} onGo={go} onSelectLine={selectLine} onLike={newEventDialogue} />
      <details className="pl-summary" open>
        <summary>{t.plSummary}</summary>
        <TalkTab project={project} sid={sid} version={version} onGo={go} />
      </details>
    </div>
  );
}

/** «How the game chooses a dialogue»: the rule in plain words and an example on the selected character. */
function HowtoPanel({ def, params }: PanelProps): ReactNode {
  const { project } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  return (
    <div className="panel-scroll panel-pad howto" data-testid="howto">
      <TalkExample project={project} sid={sid} version={version} />
      <TalkRulesBody />
    </div>
  );
}

registerPanel({
  id: 'graph', group: 'dialogue',
  title: (t) => t.panel_graph,
  icon: '⑂',
  component: GraphPanel,
  area: 'center',
  // Lines from the graph itself are selected as «line» — the graph does not jump after them.
  // A character opens its main dialogue, with a switcher to its other dialogues.
  shows: { kinds: ['record'], types: ['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE', 'CHARACTER'] },
  multi: true,
  order: 40,
});
registerPanel({
  id: 'line', group: 'dialogue',
  title: (t) => t.panel_line,
  icon: '❝',
  component: LinePanel,
  area: 'right',
  shows: { kinds: ['line', 'record'], types: ['DIALOGUE', 'DIALOGUE_LINE'] },
  multi: true,
  order: 45,
});
registerPanel({
  id: 'player', group: 'dialogue',
  title: (t) => t.panel_player,
  icon: '▶',
  component: PlayerPanel,
  area: 'bottom',
  shows: { kinds: ['record'], types: ['CHARACTER'] },
  multi: true,
  order: 60,
});
registerPanel({
  id: 'howto', group: 'dialogue',
  title: (t) => t.panel_howto,
  icon: '?',
  component: HowtoPanel,
  area: 'bottom',
  shows: { kinds: ['record'], types: ['CHARACTER'] },
  order: 70,
});
