/**
 * «FCS codes» setting: whether the game's codes (T_ME, CE_EQUALS, DR_LONG_48, EV_… (1), field names)
 * are shown next to the plain words. Off by default, so a newcomer reads words only; remembered
 * across launches and shared by every view (graph, tree, line panel, wizard, play strip).
 *
 * Elements marked `fcs-code` (and the graph's `dg-code` / `dh-code`) are hidden by the
 * `no-fcs-codes` class on the document root; texts of `<select>` options ask `useFcsCodes()`.
 */
import { formatEnumValue, shortEnumLabel, type EnumDef } from '@kenshi-editor/core';
import { ValueStore, useStore } from './workbench/store.ts';

const KEY = 'kedit.fcsCodes';

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function applyRoot(on: boolean): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('no-fcs-codes', !on);
}

const store = new ValueStore<boolean>(stored());
applyRoot(store.get());

export function setFcsCodes(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable: the setting lasts until restart.
  }
  applyRoot(on);
  store.set(on);
}

/** Whether FCS codes are shown. */
export function useFcsCodes(): boolean {
  return useStore(store);
}

/**
 * An enum value as text: with codes on — `label · CODE (value)` as the core formats it; off — the
 * label alone (the code only when the value has no label).
 */
export function enumText(def: EnumDef, value: number, lang: string, codes: boolean): string {
  return codes ? formatEnumValue(def, value, lang) : shortEnumLabel(def, value, lang);
}

/** A label that carries its code in brackets at the end («as an NPC (dialogue package)»): without it when codes are off. */
export function withoutCode(label: string, codes: boolean): string {
  return codes ? label : label.replace(/\s*[(（][^()（）]*[)）]\s*$/, '');
}

/** Text made by `formatEnumValue` («Player talks · EV_PLAYER_TALK_TO_ME (1), …»): without the codes when they are off. */
export function stripEnumCodes(s: string, codes: boolean): string {
  return codes ? s : s.replace(/ · [A-Z][A-Z0-9_]* \(-?\d+\)/g, '');
}
