/**
 * «▶ Play» strip under the dialogue graph (UI review G7): who says what on an event.
 *
 * The bar: where the record is heard (a package and its event, or a character's own dialogue) and who
 * speaks — «anyone with the package» (the package itself is played) or one of its characters. Below it
 * the conversation player: every candidate dialogue in the game's order with its points, which one the
 * game picks and why, the tie; then the conversation step by step with the player's answers. The line
 * the conversation is at goes to `onPlaying` (the graph and the tree highlight it). «Make one like it…»
 * opens the G6 window filled from the sample dialogue.
 *
 * With `character` the strip plays that character (a character graph, the «Player» panel): the
 * player keeps its own character input and event select.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  dialoguePlaySpots,
  packageHolders,
  packagePlayStart,
  playCandidates,
  plainName,
  quote,
  type PlayResult,
  type PlaySpot,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { recordName } from '../data-names.ts';
import { ConversationPlayer } from './ConversationPlayer.tsx';
import type { EventDialoguePreset } from './EventDialogueModal.tsx';
import { eventEnum, eventText } from './EventUi.tsx';
import { useFcsCodes } from '../fcs-codes.ts';
import { ValueStore } from '../workbench/store.ts';

export interface PlayStripProps {
  project: Project;
  /** The record of the graph: a dialogue, a line or a package (ignored with `character`). */
  sid: string;
  version: number;
  onGo: (sid: string) => void;
  onSelectLine: (sid: string, dialog?: string) => void;
  /** Play this character with its own character input and event select. */
  character?: string;
  /** First event for `character`. */
  event?: number;
  /** Sample of «Make one like it…» (default: the dialogue of the graph, or the one the game picks). */
  sample?: string;
  onClose?: () => void;
  onPlaying?: (line: string | undefined) => void;
  onLike?: (preset: EventDialoguePreset) => void;
}

/** Characters listed in the speaker select. */
const MAX_SPEAKERS = 200;

/** The character the last shown strip plays (G9, M9): «How the game chooses» takes its example from it. */
export const playedCharacter = new ValueStore<string | undefined>(undefined);

export function PlayStrip(props: PlayStripProps): ReactNode {
  const { project, sid, version, character } = props;
  const t = useT();
  const lang = useLang();
  const codes = useFcsCodes();
  const ctx = project.ctx;
  const evDef = useMemo(() => eventEnum(ctx), [ctx]);
  const spots = useMemo(() => (character !== undefined ? [] : dialoguePlaySpots(ctx, sid)), [ctx, sid, character, version]);
  const [spotAt, setSpotAt] = useState(0);
  const [speaker, setSpeaker] = useState('');
  const spot: PlaySpot | undefined = spots[Math.min(spotAt, spots.length - 1)];
  const pkg = spot?.character === undefined ? spot?.pkg : undefined;
  const speakers = useMemo(
    () => (pkg !== undefined ? packageHolders(ctx, pkg).filter((h) => h.type === 'CHARACTER').slice(0, MAX_SPEAKERS) : []),
    [ctx, pkg, version],
  );
  const who = spot?.character ?? (speaker !== '' && speakers.some((h) => h.sid === speaker) ? speaker : undefined);
  // A package with one character (the wizard's «only this record» package) plays as that character for «How the game chooses».
  const played = character ?? who ?? (speakers.length === 1 ? speakers[0]!.sid : undefined);
  useEffect(() => {
    if (played !== undefined) playedCharacter.set(played);
  }, [played]);
  const start = useMemo(() => (pkg !== undefined && who === undefined && spot ? packagePlayStart(ctx, pkg, spot.event) : undefined), [ctx, pkg, who, spot?.event, version]);
  const typeOfGraph = ctx.typeName(ctx.get(sid)?.type ?? -1);
  const graphDialog = character === undefined && (typeOfGraph === 'DIALOGUE' || typeOfGraph === 'DIALOGUE_LINE') ? spot?.dialog : undefined;

  const close = props.onClose && (
    <button className="small ps-close" data-testid="ps-close" title={t.psClose} onClick={props.onClose}>
      ✕
    </button>
  );
  const title = <b className="ps-title">▶ {t.psTitle}</b>;

  /** Under the bar: the pick, the tie and «Make one like it…». */
  const summary = (r: PlayResult, holder: string | undefined): ReactNode => {
    const first = r.steps[0];
    const c = first ? playCandidates(ctx, first.options) : undefined;
    const chosen = c?.rows.find((x) => x.sid === c.chosen);
    const sample = props.sample ?? graphDialog ?? c?.chosen;
    // The G6 window starts from the package of the spot, or from where the sample reaches the character.
    const via = first?.options.find((o) => o.sid === sample)?.sources?.[0]?.holder;
    const likeWho = holder ?? via ?? r.character;
    const name = (id: string): string => plainName(recordName(ctx, id));
    return (
      <div className="ps-summary" data-testid="ps-summary" data-chosen={c?.chosen ?? ''}>
        {chosen ? (
          <span data-testid="ps-chosen">{t.psChosen(name(chosen.sid), chosen.key)}</span>
        ) : (
          <span data-testid="ps-chosen" className="muted">
            {t.psNothing}
          </span>
        )}
        {c && c.tie.length > 1 && (
          <span className="ps-tie" data-testid="ps-tie" data-sids={c.tie.join(' ')}>
            {t.psTie(c.tie.map((x) => quote(name(x), lang)).join(', '))}
          </span>
        )}
        {props.onLike && sample !== undefined && ctx.typeName(ctx.get(sample)?.type ?? -1) === 'DIALOGUE' && (
          <button
            className="small"
            data-testid="ps-like"
            data-sample={sample}
            title={t.psLikeTip(name(sample))}
            onClick={() => {
              props.onLike?.({ like: sample, event: r.event, who: likeWho });
            }}
          >
            {t.psLike}
          </button>
        )}
      </div>
    );
  };

  if (character !== undefined)
    return (
      <div className="play-strip" data-testid="play-strip" data-mode="character">
        <ConversationPlayer
          key={character}
          project={project}
          sid={character}
          version={version}
          onGo={props.onGo}
          onSelectLine={props.onSelectLine}
          {...(props.event !== undefined ? { initialEvent: props.event } : {})}
          lead={title}
          tail={close}
          aside={(r) => summary(r, undefined)}
          {...(props.onPlaying ? { onPlaying: props.onPlaying } : {})}
        />
      </div>
    );

  if (!spot)
    return (
      <div className="play-strip" data-testid="play-strip" data-mode="none">
        <div className="talk-bar">
          {title}
          <span className="spacer" />
          {close}
        </div>
        <p className="muted small" data-testid="ps-none">
          {t.psNone}
        </p>
      </div>
    );

  const spotText = (s: PlaySpot): string =>
    s.character !== undefined ? t.psSpotChar(eventText(evDef, s.event, lang, codes), recordName(ctx, s.character)) : t.psSpotPkg(eventText(evDef, s.event, lang, codes), recordName(ctx, s.pkg ?? ''));
  const lead = (
    <>
      {title}
      <label title={t.psSpotTip}>
        {t.psSpot}{' '}
        <select
          data-testid="ps-spot"
          value={spots.indexOf(spot)}
          disabled={spots.length < 2}
          onChange={(e) => {
            setSpotAt(Number(e.target.value));
            setSpeaker('');
          }}
        >
          {spots.map((s, i) => (
            <option key={`${String(s.event)}|${s.pkg ?? ''}|${s.character ?? ''}`} value={i}>
              {spotText(s)}
            </option>
          ))}
        </select>
      </label>
      {pkg !== undefined && (
        <label title={t.psSpeakerTip}>
          {t.psSpeaker}{' '}
          <select
            data-testid="ps-speaker"
            value={who ?? ''}
            onChange={(e) => {
              setSpeaker(e.target.value);
            }}
          >
            <option value="">{t.psAnyone}</option>
            {speakers.map((h) => (
              <option key={h.sid} value={h.sid}>
                {recordName(ctx, h.sid)} — {h.sid}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
  const playSid = who ?? pkg ?? sid;
  return (
    <div className="play-strip" data-testid="play-strip" data-mode={who !== undefined ? 'character' : 'package'} data-event={spot.event}>
      <ConversationPlayer
        key={`${String(spots.indexOf(spot))}|${who ?? ''}`}
        project={project}
        sid={playSid}
        version={version}
        onGo={props.onGo}
        onSelectLine={props.onSelectLine}
        event={spot.event}
        {...(start ? { start, speakerName: t.psAnyone } : {})}
        noCharacter
        lead={lead}
        tail={close}
        aside={(r) => summary(r, pkg)}
        {...(props.onPlaying ? { onPlaying: props.onPlaying } : {})}
      />
    </div>
  );
}
