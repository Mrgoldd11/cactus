/** Файлы ванили в порядке загрузки (`data/`): gamedata.base → Newwworld → Dialogue → rebirth. */
export const VANILLA_FILES = ['gamedata.base', 'Newwworld.mod', 'Dialogue.mod', 'rebirth.mod'] as const;

export function isVanillaLayer(name: string): boolean {
  const n = name.toLowerCase();
  return VANILLA_FILES.some((f) => f.toLowerCase() === n);
}
