/**
 * Парсер `fcs_enums.def` — перечисления для выпадающих списков:
 * ```
 * enum Name { A, B=5, C }          // однострочный
 * enum shared EventTriggerEnum {   // многострочный, `// …` после значения — его описание
 *     //TASKS                      // комментарий на отдельной строке — название группы
 *     EV_PLAYER_TALK_TO_ME,        // описание
 * }
 * ```
 * Значения считаются как в C: с 0 или от последнего `=N`, дальше +1.
 */
import { unescapeDescription, type ParseWarning } from './fcs-def.ts';

export interface EnumValue {
  name: string;
  value: number;
  description?: string;
  /** Группа (комментарий на отдельной строке перед значением, напр. `TASKS`). */
  group?: string;
}

export interface EnumDef {
  name: string;
  shared: boolean;
  values: EnumValue[];
  line: number;
}

export interface FcsEnums {
  enums: Map<string, EnumDef>;
  warnings: ParseWarning[];
}

export function parseFcsEnums(text: string): FcsEnums {
  const enums = new Map<string, EnumDef>();
  const warnings: ParseWarning[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  let current: EnumDef | undefined;
  let open = false;
  let next = 0;
  let group: string | undefined;

  const addValues = (chunk: string, comment: string | undefined, lineNo: number, raw: string): void => {
    if (!current) return;
    const added: EnumValue[] = [];
    for (let item of chunk.split(',')) {
      item = item.trim().replace(/\s*=\s*/g, '=');
      if (item === '') continue;
      // Опечатка в файле игры: «CARAVAN. MILITARY» — точка вместо запятой.
      const parts = item.split(/\s*\.\s+|\s+/).filter((p) => p.length > 0);
      if (parts.length > 1) {
        warnings.push({ line: lineNo, message: `значения без запятой: «${item}»`, text: raw });
      }
      for (const part of parts) {
        const m = /^([A-Za-z_]\w*)\.?\s*(?:=\s*(-?\w+))?$/.exec(part);
        if (!m) {
          warnings.push({ line: lineNo, message: `не разобрано значение «${part}»`, text: raw });
          continue;
        }
        if (m[2] !== undefined) {
          const v = Number(m[2]);
          if (Number.isNaN(v)) {
            warnings.push({ line: lineNo, message: `нечисловое значение «${m[2]}»`, text: raw });
          } else next = v;
        }
        const ev: EnumValue = { name: m[1]!, value: next++ };
        if (group !== undefined) ev.group = group;
        current.values.push(ev);
        added.push(ev);
      }
    }
    const last = added.at(-1);
    if (comment !== undefined && last) last.description = comment;
  };

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    let line = raw;
    let comment: string | undefined;
    const c = line.indexOf('//');
    if (c >= 0) {
      comment = unescapeDescription(line.slice(c + 2).trim());
      line = line.slice(0, c);
    }
    line = line.trim();

    if (!open) {
      if (line === '') continue;
      const m = /^enum\s+(?:(shared)\s+)?([A-Za-z_]\w*)\s*(\{.*)?$/.exec(line);
      if (m) {
        current = { name: m[2]!, shared: m[1] !== undefined, values: [], line: lineNo };
        if (enums.has(current.name)) {
          warnings.push({ line: lineNo, message: `повтор enum ${current.name}`, text: raw });
        }
        enums.set(current.name, current);
        next = 0;
        group = undefined;
        line = m[3] ?? '';
      } else if (current && line.startsWith('{')) {
        // «{» на следующей строке после «enum Name»
      } else {
        warnings.push({ line: lineNo, message: 'строка вне enum', text: raw });
        continue;
      }
    }
    if (line.startsWith('{')) {
      open = true;
      line = line.slice(1);
    }
    if (!open) continue;

    const close = line.indexOf('}');
    const body = close >= 0 ? line.slice(0, close) : line;
    if (body.trim() === '') {
      // Комментарий на отдельной строке — название группы.
      if (comment !== undefined && comment !== '' && close < 0) group = comment;
    } else {
      addValues(body, comment, lineNo, raw);
    }
    if (close >= 0) {
      open = false;
      const after = line.slice(close + 1).trim();
      if (after !== '' && after !== ';') warnings.push({ line: lineNo, message: `текст после }: ${after}`, text: raw });
    }
  }
  if (open) warnings.push({ line: lines.length, message: 'enum не закрыт', text: '' });
  return { enums, warnings };
}
