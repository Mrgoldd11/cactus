/**
 * Field help dictionary: en (see field-help.ts). No short names and no descriptions: the field
 * name and the fcs.def text are English already. Only what an empty value means.
 */
import type { FieldHelpDict } from './field-help.ts';

export const FIELD_HELP_EN: FieldHelpDict = {
  empty: {
    races: 'empty — all races',
    'races exclude': 'empty — no race excluded',
    ingredients: 'empty — not craftable',
    'ground mesh': 'empty — uses «mesh»',
    'BUILDING:material': 'empty — the local town material',
    'CHARACTER:mesh': 'empty — random mesh',
    body: 'empty — random body',
    race: 'empty — the race of the .body file',
    'bounty factions': 'empty — the Empire',
    'unique replacement spawn': 'empty — nobody spawns',
    'race override': 'empty — races unchanged',
    'building name': 'empty — the interior layout name',
    'limit inventory': 'empty — any items',
    'natural armour': 'empty — no natural armour',
    'special food': 'empty — normal food only',
    'upgrades to': 'empty — no upgrade',
  },
};
