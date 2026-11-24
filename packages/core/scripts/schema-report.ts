/**
 * Report of mismatches between fcs.def and the data: `pnpm report`.
 * Writes reports/schema-report.md and reports/schema-report.json in the editor/ root (the folder is in .gitignore).
 *
 * 1. Vanilla (gamedata.base, Newwworld.mod, Dialogue.mod, rebirth.mod) against fcs.def.
 * 2. Installed mods against fcs.def + what vanilla already has: keys that
 *    occur only in mods.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCoverage, readDataFile, withInferredFields, type CoverageInput, type CoverageReport } from '../src/index.ts';
import { hasGame, installedModFiles, loadGameSchema, resolveGamePaths, vanillaFilePaths } from '../src/node/index.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'reports');
const paths = resolveGamePaths();
if (!hasGame(paths)) {
  console.error(`Игра не найдена: ${paths.kenshi}. Укажите KENSHI_DIR или kenshi-paths.json.`);
  process.exit(1);
}

const load = (p: string, label: string): CoverageInput => ({ label, file: readDataFile(readFileSync(p)) });
const vanilla = vanillaFilePaths(paths).map((p) => load(p, basename(p)));
const mods: CoverageInput[] = [];
const broken: string[] = [];
for (const m of installedModFiles(paths)) {
  const label = `${m.source}/${basename(dirname(m.path))}/${basename(m.path)}`;
  try {
    mods.push(load(m.path, label));
  } catch (e) {
    broken.push(`${label}: ${(e as Error).message}`);
  }
}

const schema = loadGameSchema(paths);
const vanillaReport = analyzeCoverage(schema, vanilla);
const withVanilla = withInferredFields(schema, vanilla.map((v) => v.file));
// Mod references also point to vanilla records — their types are needed to check the targets.
const modsReport = analyzeCoverage(withVanilla, [...vanilla, ...mods]);
const modOnly = modsReport.missingInSchema;

const cell = (v: unknown): string => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function table(head: string[], rows: unknown[][]): string {
  if (rows.length === 0) return '_нет_\n';
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}

function coverageSections(r: CoverageReport, title: string): string {
  return [
    `## ${title}`,
    '',
    `Файлов: ${r.files}, записей: ${r.records}, типов записей: ${r.types.length}.`,
    '',
    '### Типы записей в данных',
    '',
    table(['Тип', 'Записей', 'Файлов', 'Есть в fcs.def'], r.types.map((t) => [t.type, t.records, t.files, t.inSchema ? 'да' : '**нет**'])),
    '### Типы в данных, которых нет в fcs.def',
    '',
    r.typesWithoutSchema.length > 0 ? r.typesWithoutSchema.join(', ') + '\n' : '_нет_\n',
    '### Типы из fcs.def, которых нет в данных',
    '',
    r.schemaTypesWithoutData.length > 0 ? r.schemaTypesWithoutData.join(', ') + '\n' : '_нет_\n',
    '### Поля в данных, которых нет в fcs.def',
    '',
    'Для типов, у которых в fcs.def есть секция. Экземпляры (`instances`) показаны как `→ТИП_ЦЕЛИ`.',
    '',
    table(['Тип', 'Словарь', 'Ключ', 'Записей', 'Файлов', 'Пример'], r.missingInSchema.map((m) => [m.type, m.dict, `\`${m.key}\``, m.records, m.files, m.example])),
    '### Вид поля не совпадает со словарём в данных',
    '',
    table(['Тип', 'Поле fcs.def', 'Вид', 'Словарь в данных', 'Ключ', 'Записей', 'Пример'], r.kindMismatches.map((m) => [m.type, m.field, m.kind, m.dict, `\`${m.key}\``, m.records, m.example])),
    '### Ссылки на записи не того типа',
    '',
    table(['Тип', 'Категория', 'По fcs.def', 'В данных', 'Ссылок', 'Пример'], r.refTargetMismatches.map((m) => [m.type, m.category, m.expected, m.actual, m.refs, m.example])),
  ].join('\n');
}

const md = [
  '# Схема fcs.def и данные',
  '',
  `Игра: \`${paths.kenshi}\`. Отчёт собран \`pnpm report\`; это локальный файл, в репозиторий не входит.`,
  '',
  '## Схема',
  '',
  `Типов в fcs.def: ${schema.types.size}, полей (с повторами по типам): ${[...schema.types.values()].reduce((a, t) => a + t.fields.size, 0)}, enum в fcs_enums.def: ${schema.enums.size}, узлов дерева fcs_layout.def: верхнего уровня ${schema.layout.length}.`,
  '',
  '### Предупреждения при разборе',
  '',
  table(['Файл', 'Строка', 'Сообщение'], schema.warnings.map((w) => [w.source, w.line, w.message])),
  '### Enum, которых нет в fcs_enums.def (встроены в FCS)',
  '',
  table(['Enum', 'Поля'], [...schema.externalEnums].sort(([a], [b]) => a.localeCompare(b)).map(([n, f]) => [n, f.join(', ')])),
  coverageSections(vanillaReport, 'Ваниль'),
  '### Поля fcs.def, которых нет в ванили',
  '',
  'Только для типов, записи которых в ванили есть. Поля `null` не учитываются.',
  '',
  table(['Тип', 'Поле', 'Вид', 'Строка fcs.def'], vanillaReport.unusedFields.map((u) => [u.type, u.field, u.kind, u.line])),
  `## Моды (${mods.length})`,
  '',
  'Ключи, которых нет ни в fcs.def, ни в ванили.',
  '',
  broken.length > 0 ? `Не прочитаны:\n\n${broken.map((b) => `- ${b}`).join('\n')}\n` : 'Все моды прочитаны.\n',
  '### Типы записей, которых нет ни в fcs.def, ни в ванили',
  '',
  modsReport.typesWithoutSchema.length > 0 ? modsReport.typesWithoutSchema.join(', ') + '\n' : '_нет_\n',
  '### Ключи только из модов',
  '',
  table(['Тип', 'Словарь', 'Ключ', 'Записей', 'Модов', 'Пример'], modOnly.map((m) => [m.type, m.dict, `\`${m.key}\``, m.records, m.files, m.example])),
  '### Вид поля не совпадает со словарём (ваниль + моды)',
  '',
  table(['Тип', 'Поле', 'Вид', 'Словарь в данных', 'Записей', 'Пример'], modsReport.kindMismatches.map((m) => [m.type, m.field, m.kind, m.dict, m.records, m.example])),
].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'schema-report.md'), md);
writeFileSync(
  join(outDir, 'schema-report.json'),
  JSON.stringify(
    { kenshi: paths.kenshi, warnings: schema.warnings, externalEnums: Object.fromEntries(schema.externalEnums), vanilla: vanillaReport, mods: { files: mods.length, broken, report: modsReport } },
    null,
    2,
  ),
);

console.log(`Отчёт: ${join(outDir, 'schema-report.md')}`);
console.log(`Ваниль: ${vanillaReport.records} записей, типов без fcs.def: ${vanillaReport.typesWithoutSchema.length} (${vanillaReport.typesWithoutSchema.join(', ')})`);
console.log(`  полей вне fcs.def: ${vanillaReport.missingInSchema.length}, не совпал вид: ${vanillaReport.kindMismatches.length}, не того типа ссылок: ${vanillaReport.refTargetMismatches.length}, полей fcs.def без данных: ${vanillaReport.unusedFields.length}`);
console.log(`Моды: ${mods.length} файлов, не прочитаны: ${broken.length}, ключей только из модов: ${modOnly.length}, новых типов: ${modsReport.typesWithoutSchema.length}`);
