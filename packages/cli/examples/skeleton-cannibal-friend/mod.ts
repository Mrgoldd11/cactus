/**
 * Мод «Skeleton Cannibal Friend» командами ядра — перенос tools/build_skeleton_cannibal.py.
 * Людоеды дружат со скелетом-игроком: болтовня, торговля, найм, квесты вождей и Шамана в Столице
 * людоедов (Deadcat, Cannibal Capital), рост деревни по этапам, повар Котлоед, фразы людоедов про
 * скелета и визиты с дарами.
 *
 * Порядок создания записей, ключей и категорий — как в Python-сборщике: от него зависят номера
 * записей, которые не закреплены в scf_ids.json, и байты файла. Новые записи получают временные id,
 * в конце — постоянные (scf_ids.json) через `changeStringIds`.
 *
 * Без Node: источник ванили и таблица id передаются снаружи (см. build.ts).
 */
import {
  encodeText,
  isRemovedRef,
  removedRef,
  type GameRecord,
  type ModContext,
  type Reference,
  type Vec3,
  type Vec4,
} from '@kenshi-editor/core';

export const MOD = 'Skeleton Cannibal Friend';
export const MOD_FILE = `${MOD}.mod`;

/** Откуда сборщик берёт ванильные записи (поля для копий и условия подключения). */
export interface ScfSource {
  get(stringId: string): GameRecord | undefined;
  /** Все записи по порядку первого появления в файлах ванили. */
  all(): Iterable<GameRecord>;
}

/** scf_ids.json: постоянные номера уникальных пар (тип, имя) — на них ссылаются сохранения. */
export interface ScfIds {
  next: number;
  ids: Record<string, number>;
}

export interface ScfResult {
  /** Ключи `тип|имя`, которых не было в scf_ids.json (им выданы новые номера). */
  added: string[];
  /** Итоговая таблица id (с добавленными). */
  ids: ScfIds;
}

type Dict<V> = Readonly<Record<string, V>> | ReadonlyMap<string, V>;
type Refs = Record<string, Reference[]>;
type Flag = readonly [faction: string, worldState: string];
type Pair = readonly [string, number];

interface Fields {
  bools?: Dict<boolean | number>;
  floats?: Dict<number>;
  ints?: Dict<number>;
  strs?: Dict<string | Uint8Array>;
  refs?: Dict<readonly Reference[]>;
  vec3?: ReadonlyMap<string, Vec3>;
  vec4?: ReadonlyMap<string, Vec4>;
  files?: ReadonlyMap<string, Uint8Array>;
}

function entries<V>(d: Dict<V> | undefined): [string, V][] {
  if (!d) return [];
  return d instanceof Map ? [...(d as ReadonlyMap<string, V>)] : Object.entries(d as Record<string, V>);
}

/** `{**base, **patch}`: ключи base по порядку, затем новые из patch. */
function over<V>(base: ReadonlyMap<string, V>, patch: Dict<V> = {}): Map<string, V> {
  const out = new Map<string, V>(base);
  for (const [k, v] of entries(patch)) out.set(k, v);
  return out;
}

const R = (x: string, a = 0, b = 0, c = 0): Reference => ({ target: x, v0: a, v1: b, v2: c });
const NPC = 0;
const PL = 1;

export function buildSkeletonCannibalFriend(ctx: ModContext, src: ScfSource, pinned: ScfIds): ScfResult {
  const A = (sid: string): GameRecord => {
    const r = src.get(sid);
    if (!r) throw new Error(`Нет записи ${sid} в ванили`);
    return r;
  };
  const mine: { sid: string; key: string }[] = [];
  let nid = 100;
  const sid = (): string => `${++nid}-${MOD_FILE}`;

  /** Новая запись. */
  const rec = (t: number, name: string, sd: string, f: Fields = {}): string => {
    ctx.createRecord(t, name, { stringId: sd });
    ctx.editRecord(sd, (d) => {
      for (const [k, v] of entries(f.bools)) d.bools.set(k, Boolean(v));
      for (const [k, v] of entries(f.floats)) d.floats.set(k, v);
      for (const [k, v] of entries(f.ints)) d.ints.set(k, v);
      for (const [k, v] of entries(f.strs)) d.strings.set(k, typeof v === 'string' ? encodeText(v) : v);
      for (const [c, l] of entries(f.refs)) d.refs.set(c, l.map((r) => ({ ...r })));
      for (const [k, v] of f.vec3 ?? []) d.vec3s.set(k, [...v]);
      for (const [k, v] of f.vec4 ?? []) d.vec4s.set(k, [...v]);
      for (const [k, v] of f.files ?? []) d.files.set(k, v);
    });
    mine.push({ sid: sd, key: `${t}|${name}` });
    return sd;
  };

  /**
   * Изменение ванильной записи. Каждое поле и категория — отдельной правкой по порядку: так ключи
   * в записи мода идут в том же порядке, что у Python. Ссылка на цель, которая уже есть, заменяет
   * её значения; маркер удаления снимает цель.
   */
  const chg = (sd: string, f: Fields): void => {
    const steps: ((d: GameRecord) => void)[] = [];
    for (const [k, v] of entries(f.bools)) steps.push((d) => d.bools.set(k, Boolean(v)));
    for (const [k, v] of entries(f.ints)) steps.push((d) => d.ints.set(k, v));
    for (const [c, l] of entries(f.refs)) {
      steps.push((d) => {
        let list = d.refs.get(c) ?? [];
        for (const ref of l) {
          if (isRemovedRef(ref)) list = list.filter((x) => x.target !== ref.target);
          else {
            const i = list.findIndex((x) => x.target === ref.target);
            if (i >= 0) list[i] = { ...ref };
            else list.push({ ...ref });
          }
        }
        d.refs.set(c, list);
      });
    }
    for (const step of steps) ctx.editRecord(sd, step);
  };

  /** Новая запись по образцу src: поля копируются, refs заменяются по категориям, drop убирает категории. */
  const clone = (from: string, name: string, f: Fields & { drop?: readonly string[] } = {}): string => {
    const o = A(from);
    const refs = new Map<string, Reference[]>();
    for (const [c, l] of o.refs) if (!f.drop?.includes(c)) refs.set(c, l.map((x) => ({ ...x })));
    for (const [c, l] of entries(f.refs)) refs.set(c, [...l]);
    return rec(o.type, name, sid(), {
      bools: over<boolean | number>(o.bools, f.bools),
      floats: over(o.floats, f.floats),
      ints: over(o.ints, f.ints),
      strs: over<string | Uint8Array>(o.strings, f.strs),
      refs,
      vec3: o.vec3s,
      vec4: o.vec4s,
      files: o.files,
    });
  };

  // ---------- справочник
  // все скелеты, включая подрасы из «Just Unlock Skeleton Subraces» (P4 Unit, Soldierbot, Screamer MkI)
  const SKELS = [
    '17946-stick_people.mod',
    '66529-Newwworld.mod',
    '1533504-Newwworld.mod',
    '65266-Newwworld.mod',
    '95870-Newwworld.mod',
    '57774-Newwworld.mod',
    '57778-Newwworld.mod',
    '57782-Newwworld.mod',
  ];
  const CANNIBALS = '518-gamedata.base';
  const PKG = '3721-gamedata.base';
  const DEADCAT = '50522-rebirth.mod';
  const [CHIEF, WIZ, MEATLORD] = ['50518-rebirth.mod', '50519-rebirth.mod', '64911-rebirth.mod'];
  const [ROBUN, SIMION, DUSTBOSS, ONI] = ['65861-Dialogue.mod', '65004-Dialogue.mod', '2849-gamedata.base', '51676-Dialogue.mod'];
  const CANNIBAL = '2604-gamedata.base';
  const [REPAIR, ER, ASB] = ['97903-rebirth.mod', '43951-rebirth.mod', '43953-rebirth.mod'];
  const [DRIED, FOODCUBE, GROG, FAK] = ['42334-changes_otto.mod', '43959-rebirth.mod', '42311-changes_otto.mod', '209-gamedata.base'];
  const [SQ_GUARDS, SQ_RAID, SQ_SCRAWNY, SQ_WIZ, SQ_HOUSE, SQ_GATES] = [
    '2609-gamedata.base',
    '2605-gamedata.base',
    '50520-rebirth.mod',
    '50521-rebirth.mod',
    '50526-rebirth.mod',
    '50527-rebirth.mod',
  ];
  const AI_HOME = '2677-gamedata.base';
  const SITSPOTS = '49371-rebirth.mod';

  // ---------- диалоговые кирпичики
  const action = (n: number): string => rec(31, 'DIALOG_ACTION', sid(), { ints: { 'action name': n } });
  const cond = (n: number, who: number, cmp: number): string =>
    rec(31, 'DIALOG_ACTION', sid(), { ints: { 'compare by': cmp, 'condition name': n, tag: -1, who }, strs: { stringvar: '' } });
  const line = (text: string | readonly string[], speaker: number, children: readonly string[] = [], o: { refs?: Refs; score?: number; chance?: number } = {}): string => {
    const texts = typeof text === 'string' ? [text] : text;
    const r: Refs = children.length ? { lines: children.map((c) => R(c)) } : {};
    for (const [c, l] of Object.entries(o.refs ?? {})) (r[c] ??= []).push(...l);
    return rec(19, 'DIALOGUE_LINE', sid(), {
      floats: { 'chance permanent': 100, 'chance temporary': o.chance ?? 100 },
      ints: { 'repetition limit': 0, 'score bonus': o.score ?? 0, speaker, 'target is type': 0 },
      strs: Object.fromEntries(texts.map((t, k) => [`text${k}`, t])),
      refs: r,
    });
  };
  const dialog = (name: string, roots: readonly string[], o: { monologue?: number; one?: number; chance?: number; enemies?: number } = {}): string =>
    rec(18, name, sid(), {
      bools: { 'for enemies': o.enemies ?? 0, locked: 0, monologue: o.monologue ?? 1, 'one at a time': o.one ?? 0 },
      floats: { 'chance permanent': 100, 'chance temporary': o.chance ?? 100 },
      ints: { 'repetition limit': 0, 'score bonus': 0, 'target is type': 0 },
      strs: { tag: '' },
      refs: { lines: roots.map((x) => R(x)) },
    });
  const merge = (...ds: Refs[]): Refs => {
    const out: Refs = {};
    for (const d of ds) for (const [c, l] of Object.entries(d)) (out[c] ??= []).push(...l);
    return out;
  };
  const ws = (...pairs: Pair[]): Refs => ({ 'world state': pairs.map(([w, v]) => R(w, v)) });
  const give = (...items: Pair[]): Refs => ({ 'give item': items.map(([x, n]) => R(x, n)) });
  const setf = (fl: Flag): Refs => ({ 'change relations': [R(fl[0], 100)] });
  const skel = (): Refs => ({ 'target race': SKELS.map((x) => R(x)) });
  const ischar = (...c: string[]): Refs => ({ 'is character': c.map((x) => R(x)) });
  const eff = (...a: Pair[]): Refs => ({ effects: a.map(([x, v]) => R(x, v)) });
  const cnd = (...a: Pair[]): Refs => ({ conditions: a.map(([x, v]) => R(x, v)) });

  const [TRADE, JOIN, TAKEMONEY, TAKECAPTIVE, WAIT, ENDVISIT] = [action(1), action(3), action(8), action(40), action(12), action(38)];
  const [HAS1000, LESS1000] = [cond(2, 1, 2), cond(2, 1, 1)];
  const CARRYING = cond(46, 1, 0); // DC_CARRYING_SOMEONE_TO_ENSLAVE: игрок несёт того, кого игра считает годным в рабы
  const SQUAD_GT = cond(35, 1, 2); // в отряде игрока больше N
  const HAS_OUTPOST = cond(74, 1, 2); // у игрока есть своё поселение (уровень > -1)
  const PRICE = 1000;

  // ---------- флаги прогресса: фиктивная фракция + world state «игрок — союзник»
  const FLAG_FIELDS = A('48708-rebirth.mod');
  const flag = (title: string): Flag => {
    const fa = rec(10, title, sid(), {
      bools: over<boolean | number>(FLAG_FIELDS.bools, { 'not real': 0 }),
      floats: over(FLAG_FIELDS.floats, { 'emotion fade rate': 0, 'effect of anger': 0, 'effect of happy': 0 }),
      ints: over(FLAG_FIELDS.ints, { 'default relation': 0, 'roaming population': 0 }),
      strs: new Map(FLAG_FIELDS.strings),
    });
    const w = rec(110, `SCF: ${title}`, sid(), { bools: { 'player involvement': 0 }, strs: { notes: '' }, refs: { 'player ally': [R(fa, 1)] } });
    return [fa, w];
  };
  const wsrec = (name: string, cat: string, items: Reference[], involve = 0): string =>
    rec(110, `SCF: ${name}`, sid(), { bools: { 'player involvement': involve }, strs: { notes: '' }, refs: { [cat]: items } });
  const P = 'Столица людоедов: ';
  const Q1 = flag(`${P}Горячий котёл`);
  const Q2A = flag(`${P}весть соседям взята`);
  const Q2 = flag(`${P}Весть соседям`);
  const Q3 = flag(`${P}Стая Несъедобного`);
  const Q4 = flag(`${P}Несъедобный строитель`);
  const Q5 = flag(`${P}Зубы врага`);
  const Q6 = flag(`${P}Знак Шамана`);
  const Q7A = flag(`${P}договор взят`);
  const Q7 = flag(`${P}Договор с Мясным лордом`);
  const Q8 = flag(`${P}Армия Несъедобного`);
  const Q9 = flag(`${P}Главное блюдо`);
  const Q10 = flag(`${P}Охотник на охотников`);
  const FS1 = flag(`${P}этап 1 — дома отстроены`);
  const FS2 = flag(`${P}этап 2 — стены и стража`);
  const FS3 = flag(`${P}этап 3 — великий пир`);
  const READY1 = wsrec('этап 1 готов', 'player ally', [Q1, Q2, Q3, Q4].map((q) => R(q[0], 1)));
  const READY2 = wsrec('этап 2 готов', 'player ally', [Q5, Q6, Q7, Q8].map((q) => R(q[0], 1)));
  const READY3 = wsrec('этап 3 готов', 'player ally', [Q9, Q10].map((q) => R(q[0], 1)));
  const SIMION_DEAD = wsrec('Глава Симион мёртв', 'NPC is', [R(SIMION, 0)]);
  const ROBUN_DEAD = wsrec('Робун мёртв', 'NPC is', [R(ROBUN, 0)]);
  const W = (fl: Flag, v: number): Pair => [fl[1], v];
  const ST1 = [W(FS1, 0)];
  const ST2 = [W(FS1, 1), W(FS2, 0)];
  const ST3 = [W(FS2, 1), W(FS3, 0)];

  // ---------- общие ветки (болтовня, торговля, найм, прощание)
  const news = [
    line(
      [
        'Хорошо живём! Мяса много. Ходячее мясо само приходит к нашим кострам. А ты, Несъедобный, не приходишь в котёл — поэтому ты друг.',
        'Великий шаман говорит: кости без мяса — священные кости. Никто тебя не тронет, Несъедобный.',
        'Дома худые, крыши дырявые, ворота сломаны. Вожди хотят, чтобы Столица снова была сильной. Спроси у них, может, поможешь.',
      ],
      NPC,
      [],
      { refs: ws(W(FS1, 0)) },
    ),
    line(
      ['Дома стоят! Крыша над головой — мясо не мокнет. Это ты помог, Несъедобный.', 'Соседи говорят: Столица снова сильна. Хорошо! Теперь бы ворота починить...'],
      NPC,
      [],
      { refs: ws(W(FS1, 1), W(FS2, 0)) },
    ),
    line(
      ['Ворота крепкие, стены крепкие! Охотники зубы обломают.', 'Стражи стало больше. Спим спокойно, едим спокойно. Шаман готовит великий пир.'],
      NPC,
      [],
      { refs: ws(W(FS2, 1), W(FS3, 0)) },
    ),
    line(
      ['Пир был — во! Робун мёртв, охотники боятся, в деревне есть меняла. Песни про тебя поём, Несъедобный.', 'Столица сыта и сильна. Шаман говорит: без Несъедобного так бы не было.'],
      NPC,
      [],
      { refs: ws(W(FS3, 1)) },
    ),
  ];
  const ask = line('Как живёт племя?', PL, news);
  const trade = line('Давай поторгуем.', PL, [line('Меняться? Меняться можно! Смотри, что есть.', NPC, [], { refs: eff([TRADE, 0]) })]);
  const joinNpc = line('Несъедобный зовёт — я иду! Покажи, где ходит вкусное мясо.', NPC, [], { refs: eff([JOIN, 0]) });
  const pay = line(`Вот ${PRICE} кат. Пошли.`, PL, [joinNpc], { refs: merge(cnd([HAS1000, PRICE]), eff([TAKEMONEY, PRICE])) });
  const nopay = line('У меня сейчас нет денег.', PL, [line('Без блестяшек не пойду. Принеси блестяшки, Несъедобный.', NPC)], { refs: cnd([LESS1000, PRICE]) });
  const nah = line('Пожалуй, нет.', PL);
  const join = line('Пойдёшь со мной? Мне нужны воины.', PL, [line(`Идти с тобой? Хм-м... Котёл тут, мясо там. Дай ${PRICE} блестяшек — и я твой воин.`, NPC, [pay, nopay, nah])]);
  const bye = line('Ничего. Бывай.', PL, [line('Иди, Несъедобный. Мясо тебе не нужно, а нам больше достанется!', NPC)]);
  const COMMON = [ask, trade, join, bye];

  // ---------- квесты: «Что нужно племени?» (описания с подсказками)
  const ok = line('Понял. Пойду.', PL);
  const info = (title: string, text: string, gate: Pair[], refs?: Refs): string =>
    line(`[${title}] Расскажи подробнее.`, PL, [line(text, NPC, [ok], refs ? { refs } : {})], { refs: ws(...gate) });
  const needs = [
    info(
      'Горячий котёл',
      'Котёл холодный, Несъедобный! Принеси живое мясо — любое. У дорог бродят голодные бандиты: бей, клади на плечо и неси сюда, ко мне. Отдашь — котёл запоёт.',
      [...ST1, W(Q1, 0)],
    ),
    info(
      'Весть соседям',
      'Отнеси слово соседям: Столица людоедов снова сильна! Деревни племени близко — на закат, к югу и к восходу отсюда, ищи дым костров. Скажи любому вождю там, он ответит.',
      [...ST1, W(Q2A, 0)],
      setf(Q2A),
    ),
    line(
      '[Весть соседям] Напомни, куда идти?',
      PL,
      [line('Слово само не дойдёт! Деревни племени близко: на закат, к югу и к восходу. Любой вождь там выслушает.', NPC, [ok])],
      { refs: ws(...ST1, W(Q2A, 1), W(Q2, 0)) },
    ),
    info(
      'Стая Несъедобного',
      'Один Несъедобный — мало костей. Приведи стаю: тебя и ещё троих, хоть мясных, хоть костяных. Покажешь вождю — племя будет уважать.',
      [...ST1, W(Q3, 0)],
    ),
    info(
      'Несъедобный строитель',
      'Кости умеют строить? Поставь свою стоянку — стены, крышу, хоть маленькую. Шаман хочет знать, как строят кости. Построишь — приходи, скажи.',
      [...ST1, W(Q4, 0)],
    ),
    info(
      'Зубы врага',
      'Фермеры жгут наши стоянки. Их вожак, Глава Симион, сидит в Форте Симион — далеко на восход и чуть к северу. Убей его — фермеры притихнут.',
      [...ST2, W(Q5, 0)],
    ),
    info(
      'Знак Шамана',
      'Шаман хочет увидеть древнюю книгу — «Древнюю научную книгу». Её находят в руинах древних, иногда продают торговцы в больших городах. Покажи её Шаману. Он только посмотрит, книга останется у тебя.',
      [...ST2, W(Q6, 0)],
    ),
    info(
      'Договор с Мясным лордом',
      'Мясной лорд правит Первой деревней — далеко на восход и к северу. Отнеси ему слово Шамана: пусть будет союз. Говори с ним самим.',
      [...ST2, W(Q7A, 0)],
      setf(Q7A),
    ),
    line(
      '[Договор с Мясным лордом] Напомни, куда идти?',
      PL,
      [line('Первая деревня, далеко на восход и к северу. Говори с самим Мясным лордом.', NPC, [ok])],
      { refs: ws(...ST2, W(Q7A, 1), W(Q7, 0)) },
    ),
    info(
      'Армия Несъедобного',
      'Охотники на людоедов злые и смелые. Приведи большую стаю — тебя и ещё семерых, не меньше. Пусть охотники видят: Несъедобный с нами!',
      [...ST2, W(Q8, 0)],
    ),
    info(
      'Главное блюдо',
      'Великому пиру нужно главное блюдо! Принеси живьём важного врага. Главарь пыльных бандитов сидит в Башне Пыльного Короля — очень далеко на юг. Ниндзя Они — в Логове Кактуса, далеко на юго-восход. Неси на плече, живым!',
      [...ST3, W(Q9, 0)],
    ),
    info(
      'Охотник на охотников',
      'Последнее дело. Охотник на людоедов Робун — главный у охотников. Сидит в крепости Бастион, далеко прямо на восход. Там много охотников, приходи с сильной стаей. Убей Робуна — и племя сложит песню о Несъедобном.',
      [...ST3, W(Q10, 0)],
    ),
    line('[Пир] Что ещё нужно племени?', PL, [line('Ничего, Несъедобный! Столица сыта и сильна. Заходи поболтать, а Шаман пришлёт тебе даров.', NPC, [ok])], {
      refs: ws(W(FS3, 1)),
    }),
  ];
  const needsNpc = line(
    ['Слушай, Несъедобный. Вот что нужно Столице. Если все дела этапа сделаны — скажи «Я сделал дело».', 'Дел много, мяса мало! Выбирай, Несъедобный.'],
    NPC,
    [...needs, ok],
  );
  const pNeeds = line('Что нужно племени?', PL, [needsNpc]);

  // ---------- квесты: «Я сделал дело» (проверка и награда)
  // после сдачи дела NPC говорит, что ещё осталось на этапе: по варианту реплики на каждое сочетание
  // остальных флагов этапа (только что сданное дело считается сделанным — не зависим от того, успел ли флаг обновиться)
  const STAGES: (readonly [Flag, string])[][] = [
    [
      [Q1, 'Горячий котёл'],
      [Q2, 'Весть соседям'],
      [Q3, 'Стая Несъедобного'],
      [Q4, 'Несъедобный строитель'],
    ],
    [
      [Q5, 'Зубы врага'],
      [Q6, 'Знак Шамана'],
      [Q7, 'Договор с Мясным лордом'],
      [Q8, 'Армия Несъедобного'],
    ],
    [
      [Q9, 'Главное блюдо'],
      [Q10, 'Охотник на охотников'],
    ],
  ];
  const leftHint = (fl: Flag): string[] => {
    const others = STAGES.filter((qs) => qs.some(([q]) => q === fl)).flatMap((qs) => qs.filter(([q]) => q !== fl));
    const n = others.length;
    const out: string[] = [];
    // как itertools.product((0,1), repeat=n): первый флаг меняется медленнее всех
    for (let m = 0; m < 2 ** n; m++) {
      const mask = others.map((_, i) => (m >> (n - 1 - i)) & 1);
      const left = others.filter((_, i) => mask[i] === 0).map(([, t]) => `«${t}»`);
      const text = left.length
        ? `Осталось дел: ${left.length} — ${left.join(', ')}. Что к чему — спроси у вождя Столицы людоедов: «Что нужно племени?»`
        : 'Это было последнее дело! Иди к вождю Столицы людоедов или к Шаману и скажи: «Все дела для племени сделаны».';
      out.push(line(text, NPC, [], { refs: ws(...others.map(([q], i) => W(q, mask[i]!))) }));
    }
    return out;
  };
  const doneNpc = (text: string, fl: Flag, items: Pair[], refs: Refs = {}, score = 0): string => {
    const hints = [FS1, FS2, FS3].includes(fl) ? [] : leftHint(fl);
    return line(text, NPC, hints, { refs: merge(setf(fl), give(...items), refs), score });
  };
  const giveMeat = line(
    'Вот живое мясо для котла.',
    PL,
    [doneNpc('Живое! Тёплое! Котёл запоёт! Несъедобный — добрый друг. Держи, это для твоих костей.', Q1, [[REPAIR, 1]])],
    { refs: merge(ws(...ST1, W(Q1, 0)), eff([TAKECAPTIVE, 0])) },
  );
  // без условия CARRYING: условие 46 — DC_CARRYING_SOMEONE_TO_ENSLAVE, и игра не считает «годным в рабы»
  // любого пленника (охранник Святой нации не прошёл), поэтому сдача видна всё время, пока дело открыто
  const mainDish = line(
    'Я принёс главное блюдо!',
    PL,
    [
      doneNpc(
        'Главарь пыльных бандитов! Живой! Вот это блюдо! Великий пир будет!',
        Q9,
        [
          [ASB, 1],
          [ER, 1],
        ],
        merge({ 'target carrying character': [R(DUSTBOSS)] }, eff([TAKECAPTIVE, 0])),
        10,
      ),
      doneNpc(
        'Ниндзя Они! Быстрый был, а теперь — блюдо! Великий пир будет!',
        Q9,
        [
          [ASB, 1],
          [ER, 1],
        ],
        merge({ 'target carrying character': [R(ONI)] }, eff([TAKECAPTIVE, 0])),
        10,
      ),
      line('Это не главное блюдо! Неси живьём Главаря пыльных бандитов или ниндзя Они.', NPC),
    ],
    { refs: ws(...ST3, W(Q9, 0)) },
  );
  const dones = [
    giveMeat,
    line('Смотри — вот моя стая.', PL, [doneNpc('Большая стая! Мясные пахнут вкусно, но мы не тронем — они твои. Держи, лечи их.', Q3, [[FAK, 3]])], {
      refs: merge(ws(...ST1, W(Q3, 0)), cnd([SQUAD_GT, 3])),
    }),
    line('У меня есть своя стоянка.', PL, [doneNpc('Кости строят! Шаман рад. Вот мудрость — пусть твоя стоянка растёт.', Q4, [[ER, 1]])], {
      refs: merge(ws(...ST1, W(Q4, 0)), cnd([HAS_OUTPOST, -1])),
    }),
    line(
      'Все дела для племени сделаны. Что теперь?',
      PL,
      [
        doneNpc(
          'Котёл горячий, соседи знают, у Несъедобного стая и стоянка! Племя начнёт чинить дома. Уйди подальше, вернись — увидишь новые крыши. А Шаман будет слать тебе дары.',
          FS1,
          [[REPAIR, 2]],
        ),
      ],
      { refs: ws([READY1, 1], W(FS1, 0)) },
    ),
    line('Глава Симион мёртв.', PL, [doneNpc('Хо-хо! Без головы фермеры — просто мясо. Держи, Несъедобный, это для твоих костей.', Q5, [[REPAIR, 2]])], {
      refs: ws(...ST2, W(Q5, 0), [SIMION_DEAD, 1]),
    }),
    line(
      'Я принёс древнюю книгу.',
      PL,
      [
        doneNpc('Знаки древних... Да! Шаман видит. Кости знают больше, чем мясо. Возьми взамен мои записи.', Q6, [[ER, 2]], merge(ischar(WIZ), { 'target has item': [R(ASB)] }), 20),
        line('Книгу — Шаману! Я буквы не ем. Шаман в большом шатре вождей — на восточной стороне, за котлами.', NPC, [], { refs: ischar(CHIEF), score: 10 }),
        line('Это не древняя книга. Шаман ждёт «Древнюю научную книгу».', NPC),
      ],
      { refs: ws(...ST2, W(Q6, 0)) },
    ),
    line(
      'Вот моя армия.',
      PL,
      [
        doneNpc('Восемь! Девять! Много! Охотники будут дрожать. Возьми, Несъедобный.', Q8, [
          [ER, 1],
          [REPAIR, 1],
        ]),
      ],
      { refs: merge(ws(...ST2, W(Q8, 0)), cnd([SQUAD_GT, 7])) },
    ),
    line(
      'Все дела для племени сделаны. Что теперь?',
      PL,
      [
        doneNpc(
          'Соседи — друзья, враги — мясо! Племя починит ворота и стены, стражи станет больше. Уйди подальше, вернись — увидишь. Дары Шамана станут богаче.',
          FS2,
          [[ASB, 1]],
        ),
      ],
      { refs: ws([READY2, 1], W(FS2, 0)) },
    ),
    mainDish,
    line(
      'Робун мёртв.',
      PL,
      [
        doneNpc('Робун мёртв?! Нет больше охотника! Несъедобный — великий! Держи, это лучшее, что есть у племени.', Q10, [
          [REPAIR, 2],
          [ER, 1],
        ]),
      ],
      { refs: ws(...ST3, W(Q10, 0), [ROBUN_DEAD, 1]) },
    ),
    line(
      'Все дела для племени сделаны. Что теперь?',
      PL,
      [
        doneNpc('Великий пир! Столица сильна: дома, стены, стража, меняла. Шаман будет присылать богатые дары. Ты — кость племени, Несъедобный!', FS3, [
          [ASB, 2],
          [ER, 2],
          [REPAIR, 3],
        ]),
      ],
      { refs: ws([READY3, 1], W(FS3, 0)) },
    ),
    line('Пока ничего.', PL, [line('Тогда иди, делай дела! Котёл ждёт.', NPC)]),
  ];
  const pDone = line('Я сделал дело.', PL, [line(['Показывай, Несъедобный!', 'Ну? Что сделал?'], NPC, dones)]);

  // ---------- доставка вестей в другие деревни
  const deliver2 = line(
    'Вождь Столицы людоедов шлёт слово: Столица снова сильна!',
    PL,
    [doneNpc('Хо! Столица сильна? Хорошо! Скажи: мы придём на большой пир. А это тебе — нога в дорогу... А, ты не ешь. Отдай своим мясным.', Q2, [[DRIED, 4]])],
    { refs: ws(W(Q2A, 1), W(Q2, 0)) },
  );
  const deliver7 = line(
    'Шаман Столицы людоедов предлагает союз.',
    PL,
    [doneNpc('Союз? Мясной лорд согласен — мясо любит компанию. Передай Шаману: пусть котлы горят вместе. Держи подарок.', Q7, [[GROG, 3]])],
    { refs: ws(W(Q7A, 1), W(Q7, 0)) },
  );

  // ---------- корни разговора (порядок и очки: квесты Столицы людоедов > соседи > общий)
  const QUEST = [pNeeds, pDone, ...COMMON];
  const greetQ = ['Несъедобный! Кости-друг пришёл. Племени нужна помощь, слушай.', 'Несъедобный! Хорошо, что пришёл. Дела есть.'];
  const rWiz = line(['Кости-друг пришёл к Шаману. Говори, Несъедобный.', 'Шаман видит тебя, Несъедобный. Мясо стынет, дела ждут.'], NPC, QUEST, {
    refs: ischar(WIZ),
    score: 100,
  });
  const rMeat = line('Несъедобный у Мясного лорда? Странное мясо — одни кости. Говори.', NPC, [deliver7, deliver2, ...COMMON], { refs: ischar(MEATLORD), score: 95 });
  const rVill = line('Несъедобный! Кости-друг пришёл. Чего хочешь?', NPC, [deliver2, ...COMMON], {
    refs: merge(ischar(CHIEF), { 'in town of': [R(CANNIBALS)] }),
    score: 90,
  });
  const rAny = line('Несъедобный! Кости-друг пришёл. Чего хочешь?', NPC, COMMON);

  // ---------- рост деревни: замены зданий и фракции-владельцы
  const repl = (a: string, b: string): string => rec(103, `SCF ${a} -> ${b}`, sid(), { refs: { 'to replace': [R(a)], 'replace with': [R(b, 100)] } });
  const RH = repl('3793-TwoStorey.mod', '3384-TwoStorey.mod'); // разрушенный дом -> целый
  const RG = repl('3007-Walls.mod', '3006-Walls.mod'); // самодельные ворота -> Defensive Gate II
  const RW = repl('3005-Walls.mod', '3004-Walls.mod'); // самодельная стена -> Defensive Wall II
  const RWS = repl('3082-walls.mod', '3014-walls.mod'); // короткая стена -> короткая Defensive Wall II
  const owner = (title: string, reps: string[]): string => {
    const o = A(CANNIBALS);
    return rec(10, title, sid(), {
      bools: o.bools,
      floats: o.floats,
      ints: over(o.ints, { 'default relation': 0, 'roaming population': 0 }),
      strs: o.strings,
      refs: { 'buildings replacements': [SITSPOTS, ...reps].map((x) => R(x)), relations: [R(CANNIBALS, 100)] },
    });
  };
  const F0 = owner('Людоеды Столицы', []);
  const F1 = owner('Людоеды Столицы ', [RH]);
  const F2 = owner('Людоеды Столицы  ', [RH, RG, RW, RWS]);
  const F3 = owner('Людоеды Столицы   ', [RH, RG, RW, RWS]);
  const IN_DEADCAT: Refs = { 'in town of': [F0, F1, F2, F3].map((x) => R(x)) };
  const rChief = line(greetQ, NPC, QUEST, { refs: merge(ischar(CHIEF), IN_DEADCAT), score: 100 });

  // ---------- пленник на плече: Шаман и вожди Столицы людоедов сами спрашивают о нём первой репликой,
  // как ванильные работорговцы (условие «несёт кого-то» стоит на реплике NPC, а не игрока)
  const spareMeat = line('Просто мясо, в подарок котлу.', PL, [line('Котёл всегда голодный! Держи сушёного мяса для твоих мясных.', NPC, [], { refs: give([DRIED, 3]) })], {
    refs: merge(ws(W(Q1, 1)), eff([TAKECAPTIVE, 0])),
  });
  const keepMeat = line('Нет, это не для котла.', PL, [line('Не для котла? Жалко... Ладно, говори, чего хочешь.', NPC, QUEST)]);
  const carryOpts = [giveMeat, mainDish, spareMeat, keepMeat];
  const carryText = ['Что это у тебя на плече, Несъедобный? Живое мясо? Пахнет вкусно!', 'Хо! Несъедобный принёс мясо! Это для котла?'];
  const rWizC = line(carryText, NPC, carryOpts, { refs: merge(ischar(WIZ), cnd([CARRYING, 1])), score: 150 });
  const rChiefC = line(carryText, NPC, carryOpts, { refs: merge(ischar(CHIEF), IN_DEADCAT, cnd([CARRYING, 1])), score: 150 });

  // for enemies=1: людоеды формально враждебны всем (отношение -100), без флага игра прячет «Говорить»
  const talk = rec(18, 'skeleton friend talk to', sid(), {
    bools: { 'for enemies': 1, locked: 0, monologue: 1, 'one at a time': 0 },
    floats: { 'chance permanent': 100, 'chance temporary': 100 },
    ints: { 'repetition limit': 0, 'score bonus': 0, 'target is type': 0 },
    refs: { lines: [rWizC, rChiefC, rWiz, rChief, rMeat, rVill, rAny].map((x) => R(x)) },
  });

  // ---------- фразы людоедов про скелета
  const jokes = [
    'Опять Несъедобный... Одни кости, даже бульона не сваришь.',
    'Не трогай его! Шаман сказал: кости священные.',
    'Эй, Кость! Мяса хочешь? А... ну да.',
    'Как он ходит без мяса? Колдовство...',
    'Я однажды грыз скелета. Зубы болели три дня.',
    'Несъедобный идёт. Прячь котёл — вдруг обидится.',
    'Кость-друг! Кость-друг пришёл!',
    'Смотрит на нас... Или у него глаз нет? Не понять.',
    'Мама говорила: не ешь железное. Он железный?',
    'Хорошо Несъедобному: ни голода, ни жажды. Скучно, наверное.',
    'Звенит, как ложка в котле.',
    'Если его сварить, будет суп из гаек.',
    'Несъедобный! Принёс мясо? Нет? Зачем пришёл тогда?',
    'Говорят, его кости из древних времён. Старое было мясо, наверное.',
    'Шшш... Не смейся над Несъедобным. Ушей нет, а слышит.',
    'Кость, у тебя есть мясные друзья? Познакомь, хе-хе.',
    'Он не спит, не ест... Как охотник, только хуже.',
    'Ууу, блестит! Красивые кости.',
  ];
  const gossip1 = [
    'Это Несъедобный нагрел наш котёл!',
    'Видел крыши? Кость помог отстроить дома.',
    'Соседи говорят: Столица снова сильна. Это всё Несъедобный.',
    'Несъедобный строит свою стоянку. Кости строят — мясо смотрит.',
  ];
  const gossip2 = [
    'Вожак фермеров мёртв. Несъедобный принёс нам тишину.',
    'Ворота крепкие! Это Кость велел чинить.',
    'Мясной лорд теперь наш друг. Несъедобный носил слово.',
    'Шаман смотрел древнюю книгу. Кость умный, как Шаман!',
  ];
  const gossip3 = ['Робун мёртв! Охотник сам стал мясом... почти.', 'Пир! Пир в честь Несъедобного!', 'Когда вырасту, буду костями, как Несъедобный.', 'Меняла в деревне! Это всё Кость.'];
  const barks = dialog(
    'skeleton friend barks',
    [
      line(gossip3, NPC, [], { refs: merge(skel(), ws(W(FS3, 1))), score: 7, chance: 50 }),
      line(gossip2, NPC, [], { refs: merge(skel(), ws(W(FS2, 1))), score: 6, chance: 50 }),
      line(gossip1, NPC, [], { refs: merge(skel(), ws(W(FS1, 1))), score: 5, chance: 50 }),
      line(jokes, NPC, [], { refs: skel() }),
    ],
    { enemies: 1, one: 1, chance: 35 },
  );
  // выкрик при виде скелета с пленником на плече: подсказка, что мясо надо нести и заговорить
  const carryBark = dialog(
    'skeleton friend sees meat',
    [
      line(
        ['Живое мясо! Несъедобный несёт мясо! Неси к Шаману, говори с ним!', 'Котёл! Котёл! Кость принёс мясо!', 'Эй, Несъедобный! Это для котла? Неси к вождю, говори!'],
        NPC,
        [],
        { refs: merge(skel(), cnd([CARRYING, 1])), score: 10 },
      ),
    ],
    { enemies: 1, one: 1 },
  );

  // ---------- повар Котлоед: приносишь любого живого — получаешь угощение
  const cookTake = [
    line('О-о, жирное! Котлоед доволен. Держи редкую вещь — для твоих костей.', NPC, [], { refs: give([REPAIR, 1]), score: 30, chance: 10 }),
    line('Хорошее мясо! Держи грог, угости своих мясных.', NPC, [], { refs: give([GROG, 2]), score: 20, chance: 30 }),
    line('Мясо — в котёл! Держи кубики еды.', NPC, [], { refs: give([FOODCUBE, 2]), score: 10, chance: 50 }),
    line('Тощее, но сгодится. Держи сушёного мяса.', NPC, [], { refs: give([DRIED, 3]) }),
  ];
  const cookGive = line('Вот, держи мясо.', PL, cookTake, { refs: merge(cnd([CARRYING, 1]), eff([TAKECAPTIVE, 0])) });
  const cookCarry = line(
    ['О! Мясо на плече! Котлоед видит. Давай сюда, в котёл!', 'Несъедобный принёс мясо Котлоеду? Давай, давай!'],
    NPC,
    [cookGive, line('Нет, это не тебе.', PL, [line('Жадные кости... Котёл подождёт.', NPC)])],
    { refs: cnd([CARRYING, 1]), score: 150 },
  );
  const cookRoot = line(['Я Котлоед, повар Шамана. Котёл любит мясо. Принёс?', 'Котлоед слушает. Мясо есть?', 'Котёл булькает, ждёт. Мясо принёс, Несъедобный?'], NPC, [
    cookGive,
    line('Что ты готовишь?', PL, [
      line(['Сегодня — суп из бандита. Завтра — тоже суп из бандита. Котлоед не жалуется.', 'Рагу из охотника. Жёсткое, но сытное. Тебе не предлагаю, хе-хе.'], NPC),
    ]),
    line('Ничего, бывай.', PL, [line('Неси мясо, Несъедобный. Любое — котёл не привередлив.', NPC)]),
  ]);
  const cookTalk = dialog('cook talk to', [cookCarry, cookRoot], { enemies: 1 });
  const cookPkg = rec(73, 'Котлоед', sid(), {
    strs: { tag: '' },
    refs: { dialogs: [R(cookTalk, 1), R(carryBark, 67), R(carryBark, 5), R(barks, 67), R(barks, 5)] },
  });
  // свой пакет вместо ванильного 3721: тот в rebirth.mod/Dialogue.mod переименован в «Cannibals --Unfinished»,
  // а пакет с «--» в имени игра игнорирует (и пока он висит на людоеде, не работают даже добавленные рядом пакеты)
  const SPKG = rec(73, 'Skeleton Friend Cannibals', sid(), {
    strs: { tag: '' },
    refs: { dialogs: [R(talk, 1), R(carryBark, 67), R(carryBark, 5), R(barks, 67), R(barks, 5)] },
  });
  const nobounty = { 'bounty chance': 0, 'bounty amount': 0 };
  // не unique: при смене этапа игра пересоздаёт жителей, а уникальный персонаж второй раз не появляется (так пропадали Шаман и Котлоед)
  const COOK = clone(CHIEF, 'Котлоед', {
    bools: { unique: 0, named: 1 },
    ints: nobounty,
    refs: { 'dialogue package': [R(cookPkg)], dialogue: [R(cookTalk)] },
    drop: ['bounty factions'],
  });
  const TRADER = clone(CHIEF, 'Меняла Столицы людоедов', {
    bools: { 'is trader': 1 },
    ints: nobounty,
    refs: { 'dialogue package': [R(SPKG)], dialogue: [R(talk)] },
    drop: ['bounty factions'],
  });
  const ENVOY = clone(CHIEF, 'Посланник Шамана', { ints: nobounty, refs: { 'dialogue package': [R(SPKG)] }, drop: ['bounty factions'] });

  // ---------- отряды жителей
  const FAC = [R(CANNIBALS)];
  const COOKSQ = clone(SQ_GUARDS, 'Котёл Котлоеда', {
    ints: { 'vendors fill total amount': 0, 'gear artifacts base value': 0 },
    refs: { leader: [R(COOK, 1)], 'AI packages': [R(AI_HOME)], 'dialog leader': [R(cookPkg)], faction: FAC },
    drop: ['squad', 'vendors'],
  });
  // дом 3384 (Storm_House_01_NEW) и ванильные раскладки для него из data/newland/leveldata/interiors.level:
  // 'General Shop' + вывеска 'Trader Sign', 'Slave Shop' (клетки), 'Residential Small' (жилой дом)
  const STORM = '3384-TwoStorey.mod';
  const TRADERSQ = clone(SQ_GUARDS, 'Лавка Столицы людоедов', {
    bools: { 'is trader': 1 },
    ints: { 'vendor money': 5000, 'vendors fill total amount': 40 },
    strs: { 'building name': '', 'layout interior': 'General Shop', 'layout exterior': 'Trader Sign' },
    refs: {
      leader: [R(TRADER, 1)],
      squad: [R(CANNIBAL, 2)],
      'AI packages': [R('2824-gamedata.base')],
      faction: FAC,
      'dialog leader': [R(SPKG)],
      building: [R(STORM)],
      vendors: [R('48781-rebirth.mod', 100), R('64678-rebirth.mod', 100), R('97904-rebirth.mod', 100), R('49374-rebirth.mod', 50), R('64913-rebirth.mod', 100)],
    },
  });
  const HOUSE_OK = clone(SQ_HOUSE, 'cannibal stormhouse repaired', {
    bools: { 'building ruined': 0 },
    strs: { 'layout interior': 'Residential Small' },
    refs: { building: [R(STORM)], faction: FAC },
  });
  // тюрьма: клетки из 'Slave Shop', ИИ тюремщиков как у «Rebirth Cage Guards» (49391-rebirth.mod)
  const PRISONSQ = clone(SQ_GUARDS, 'Тюрьма Столицы людоедов', {
    strs: { 'building name': '', 'layout interior': 'Slave Shop', 'layout exterior': '' },
    refs: { building: [R(STORM)], 'AI packages': [R('5221-gamedata.base'), R(AI_HOME)], faction: FAC, 'dialog leader': [R(SPKG)] },
    drop: ['vendors'],
  });
  const GATES_OK = clone(SQ_GATES, 'repaired gates', { bools: { 'building ruined': 0 }, refs: { faction: FAC } });
  // у этих отрядов нет своей фракции: иначе они стали бы жителями фракции-владельца
  for (const sq of [SQ_WIZ, SQ_HOUSE, SQ_GATES]) chg(sq, { refs: { faction: FAC, ...(sq === SQ_WIZ ? { 'dialog leader': [R(SPKG)] } : {}) } });

  // ---------- подменные версии Столицы людоедов по этапам
  type Resident = readonly [string, number, number];
  const town = (title: string, fac: string, residents: readonly Resident[], condWs: readonly Pair[]): string => {
    const o = A(DEADCAT);
    const refs = new Map<string, Reference[]>();
    for (const [c, l] of o.refs) if (c !== 'override town') refs.set(c, [...l]);
    refs.set('faction', [R(fac, 0, 100)]);
    refs.set(
      'residents',
      residents.map(([x, a, b]) => R(x, a, b)),
    );
    refs.set(
      'world state',
      condWs.map(([w, v]) => R(w, v)),
    );
    return rec(13, title, sid(), { bools: over<boolean | number>(o.bools, { 'residents override': 1 }), floats: o.floats, ints: o.ints, strs: o.strings, refs });
  };
  const BASE_RES: Resident[] = [
    [SQ_GUARDS, 1, 2],
    [SQ_RAID, 2, 1],
    [SQ_SCRAWNY, 2, 0],
    [SQ_WIZ, 1, 3],
  ];
  const COOK_RES: Resident[] = [[COOKSQ, 1, 3]];
  const O0 = town('Deadcat (SCF stage 0)', F0, [...BASE_RES, [SQ_HOUSE, 8, 3], [SQ_GATES, 1, 2], ...COOK_RES], [W(FS1, 0)]);
  // 6 домов 3384: 4 жилых, тюрьма, лавка
  const HOUSES: Resident[] = [
    [HOUSE_OK, 4, 3],
    [PRISONSQ, 1, 3],
    [TRADERSQ, 1, 3],
  ];
  const O1 = town('Deadcat (SCF stage 1)', F1, [...BASE_RES, ...HOUSES, [SQ_GATES, 1, 2], ...COOK_RES], [W(FS1, 1), W(FS2, 0)]);
  const MORE: Resident[] = [
    [SQ_GUARDS, 2, 2],
    [SQ_RAID, 3, 1],
    [SQ_SCRAWNY, 2, 0],
    [SQ_WIZ, 1, 3],
  ];
  const O2 = town('Deadcat (SCF stage 2)', F2, [...MORE, ...HOUSES, [GATES_OK, 1, 2], ...COOK_RES], [W(FS2, 1), W(FS3, 0)]);
  const O3 = town('Deadcat (SCF stage 3)', F3, [...MORE, ...HOUSES, [GATES_OK, 1, 2], ...COOK_RES], [W(FS3, 1)]);
  chg(DEADCAT, { refs: { 'override town': [O3, O2, O1, O0].map((x) => R(x)) } });
  // когда город уже подменён, игра смотрит только 'override town' текущей подмены, а не исходного города
  // (так в ванили: Okran's Shield (override) empire -> destroyed); без этого город навсегда застревает на этапе 0
  for (const [cur, nxt] of [
    [O0, [O3, O2, O1]],
    [O1, [O3, O2]],
    [O2, [O3]],
  ] as const) {
    ctx.editRecord(cur, (d) => d.refs.set('override town', nxt.map((x) => R(x))));
  }

  // ---------- визиты с дарами (как молебен Святой Нации)
  const ENVOYSQ = clone('99003-Dialogue.mod', 'Посланники Шамана', {
    refs: { leader: [R(ENVOY, 1)], squad: [R(CANNIBAL, 3)], faction: FAC },
    drop: ['special items', 'vendors'],
  });
  const visit = (stage: number, gate: Pair[], items: Pair[], chance: number, giftText: string): string => {
    const gift = dialog(
      `wizard gift talk ${stage}`,
      [line(giftText, NPC, [line('Спасибо Шаману.', PL, [line('Мясо тебе не нужно, а мудрость нужна! Пошли, братья, домой.', NPC)])], { refs: merge(give(...items), eff([ENDVISIT, 0])) })],
      { enemies: 1 },
    );
    const last = line('Ладно. Кости заняты — придём в другой раз.', NPC, [], { refs: eff([ENDVISIT, 0]) });
    const n3 = line('Несъедобный! Кости глухие, что ли? Дары стынут!', NPC, [last], { refs: eff([WAIT, 20]) });
    const n2 = line('Подойди, поговори с нами — дары твои.', NPC, [n3], { refs: eff([WAIT, 20]) });
    const n1 = line(['Несъедобный! Мы от Великого шамана!', 'Кости-друг! Шаман прислал нас с дарами!'], NPC, [n2], { refs: merge(eff([WAIT, 20]), { interrupt: [R(gift)] }) });
    const ann = dialog(`wizard gift announce ${stage}`, [n1], { enemies: 1 });
    const o = A('98647-Dialogue.mod');
    return rec(93, `Wizard gift visit ${stage}`, sid(), {
      bools: over<boolean | number>(o.bools, { 'is hostile': 0, 'ignores nogo zones': 1, 'territorial triggers': 1 }),
      ints: over(o.ints, { 'num forces': 4 }),
      floats: over(o.floats, { 'chance per day': chance, 'range near': 30000, 'range far': 60000, 'repeat limit': 99999 }),
      strs: { 'display name': 'Дары Шамана' },
      refs: {
        'dialog announcement': [R(ann)],
        'inherits from': [R('59669-Dialogue.mod')],
        'squads to use': [R(ENVOYSQ, 100)],
        'world state': gate.map(([w, v]) => R(w, v)),
      },
    });
  };
  const C1 = visit(
    1,
    [W(FS1, 1), W(FS2, 0)],
    [
      [ER, 1],
      [DRIED, 3],
    ],
    0.1,
    'Шаман шлёт мудрость Несъедобному! Бери книгу — пусть кости думают.',
  );
  const C2 = visit(
    2,
    [W(FS2, 1), W(FS3, 0)],
    [
      [ER, 2],
      [ASB, 1],
    ],
    0.12,
    'Шаман шлёт дары Несъедобному! Две книги мудрости и одна древняя. Бери!',
  );
  const C3 = visit(
    3,
    [W(FS3, 1)],
    [
      [ER, 2],
      [ASB, 2],
      [REPAIR, 1],
    ],
    0.15,
    'Великий шаман шлёт богатые дары кости племени! Книги, древние знаки и лекарство для костей.',
  );

  // ---------- подключение к людоедам
  // везде, где висит ванильный 3721, снимаем его (маркер удаления) и вешаем свой пакет; беседу даём и напрямую,
  // как у ванильных торговцев. Сам 3721 не трогаем.
  const hasPkg = (o: GameRecord, cat: string): boolean => (o.refs.get(cat) ?? []).some((x) => x.target === PKG);
  for (const o of src.all()) {
    if (o.type === 1 && hasPkg(o, 'dialogue package')) {
      chg(o.stringId, { refs: { 'dialogue package': [removedRef(PKG), R(SPKG)], dialogue: [R(talk)] } });
    } else if (o.type === 52) {
      const r: Refs = {};
      for (const c of ['dialog leader', 'dialog squad']) if (hasPkg(o, c)) r[c] = [removedRef(PKG), R(SPKG)];
      if (Object.keys(r).length) chg(o.stringId, { refs: r });
    }
  }
  // Шаман не unique (см. COOK); правка попадает в ту же запись мода, что вешает ему пакет диалогов
  chg(WIZ, { bools: { unique: 0 } });
  chg(CANNIBALS, { refs: { campaigns: [C1, C2, C3].map((x) => R(x)), relations: [F0, F1, F2, F3].map((x) => R(x, 100)) } });

  // ---------- постоянные ID: сейвы ссылаются на фракции/город/визиты мода по sid,
  // поэтому уникальные (тип, имя) получают номер из scf_ids.json, а не по порядку сборки
  const pin: ScfIds = { next: pinned.next, ids: { ...pinned.ids } };
  const added: string[] = [];
  const cnt = new Map<string, number>();
  for (const r of mine) cnt.set(r.key, (cnt.get(r.key) ?? 0) + 1);
  const num = new Map<string, number>();
  for (const r of mine) {
    if (cnt.get(r.key) !== 1) continue;
    if (!(r.key in pin.ids)) {
      pin.ids[r.key] = pin.next++;
      added.push(r.key);
    }
    num.set(r.sid, pin.ids[r.key]!);
  }
  let n = pin.next;
  for (const r of mine) if (!num.has(r.sid)) num.set(r.sid, n++);
  ctx.changeStringIds(new Map([...num].map(([from, v]) => [from, `${v}-${MOD_FILE}`])));

  ctx.setModInfo({
    fileType: 16,
    version: 1,
    author: 'Claude for player',
    description:
      'Людоеды дружат со скелетами: болтовня, торговля, найм, квесты вождей и Великого шамана в Столице людоедов, рост деревни, повар Котлоед, визиты с дарами.',
    dependencies: ['gamedata.base', 'rebirth.mod', 'Newwworld.mod', 'Dialogue.mod'],
    references: [],
    lastId: n,
  });
  return { added, ids: pin };
}
