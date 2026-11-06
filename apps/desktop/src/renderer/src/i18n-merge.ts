/** Строки панели «Слияние модов» (вливаются в общий словарь `i18n.ts`). */
export interface MergeCountsView {
  new: number;
  changed: number;
  deleted: number;
  conflicts: number;
  rejected: number;
  identical: number;
  alreadyMerged: number;
  blocked: number;
}

export interface MergePreviewView {
  accepted: number;
  created: number;
  changed: number;
  deleted: number;
  byClosure: number;
  toSource: number;
  toMine: number;
}

export interface MergeDoneView {
  accepted: number;
  created: number;
  changed: number;
  deleted: number;
  tookSource: number;
  keptMine: number;
  addedByClosure: number;
  skipped: number;
}

export const mergeEn = {
  panel_merge: 'Merge mods',
  mergeHint: 'Take records from another mod into yours: see what is new, changed or deleted, resolve conflicts field by field.',
  mgSource: 'Source mod',
  mgPick: '— choose a mod —',
  mgBrowse: 'Choose file…',
  mgRefresh: 'Re-read',
  mgRefreshTip: 'Read the source file again (if its author updated it).',
  mgIntro: (mod: string) => `Choose a mod whose records you want to bring into “${mod}”. The list shows only the differences. Nothing changes until you press “Merge selected”; one Ctrl+Z undoes the whole merge.`,
  mgIdentical: 'Nothing to merge: every record of the source is already in your mod.',
  mgCounts: (c: MergeCountsView) =>
    `new ${c.new}, changed ${c.changed}, deleted ${c.deleted}, conflicts ${c.conflicts}` +
    (c.alreadyMerged ? `, already merged ${c.alreadyMerged}` : '') +
    (c.identical ? `, identical ${c.identical}` : '') +
    (c.rejected ? `, skipped ${c.rejected}` : '') +
    (c.blocked ? `, cannot merge ${c.blocked}` : ''),
  mgKindNew: 'new',
  mgKindChanged: 'changed',
  mgKindDeleted: 'deleted',
  mgKindTip: 'Show or hide this kind of change.',
  mgType: 'Type',
  mgTypeAll: 'All types',
  mgSearch: 'Filter by name or id…',
  mgOnlyConflicts: 'Only conflicts',
  mgShowSkipped: 'Show skipped',
  mgShowSkippedTip: 'Show records you rejected before (they are hidden in later merges). Press ○ on a row to bring it back.',
  mgNextConflict: 'Next conflict',
  mgNoConflicts: 'No conflicts in the list.',
  mgShown: (shown: number, all: number) => `rows ${shown} of ${all}`,
  mgCap: (n: number) => `Showing the first ${n}.`,
  mgMore: 'Show more',
  mgIgnore: 'Ignore (leave as is, ask again next time)',
  mgAccept: 'Accept (merge this record)',
  mgReject: 'Reject (hide in later merges)',
  mgSelectShown: 'Select all shown',
  mgClear: 'Clear selection',
  mgRejectSelected: (n: number) => `Reject selected (${n})`,
  mgApply: (n: number) => `Merge selected (${n})`,
  mgRecursive: 'With linked records',
  mgRecursiveTip: 'Together with each chosen record, take everything it refers to among the changes (a whole dialogue with its lines).',
  mgFixRefs: 'Fix references',
  mgFixRefsTip: 'Also take new records that the chosen ones refer to, so no reference is left pointing at nothing.',
  mgConflictsDefault: 'Unresolved conflicts',
  mgConflictsMine: 'keep mine',
  mgConflictsSource: 'take from source',
  mgLevelData: 'Level data (zones, interiors)',
  mgLevelDataTip: 'The editor cannot read or write level data yet: it is only detected and noted in the report.',
  mgLevelFound: (n: number, dir: string) => `The source has level data (${n} files in ${dir}). The editor cannot merge it yet: files are left untouched; copy them by hand or merge in FCS.`,
  mgMissingDeps: (list: string) => `The source depends on mods that your mod does not: ${list}.`,
  mgPreview: (p: MergePreviewView) =>
    `Will merge ${p.accepted}: new ${p.created}, changed ${p.changed}, deleted ${p.deleted}` +
    (p.byClosure ? `; by links +${p.byClosure}` : '') +
    (p.toSource + p.toMine ? `; conflicts: from source ${p.toSource}, mine kept ${p.toMine}` : ''),
  mgNothing: 'Nothing selected.',
  mgDone: (d: MergeDoneView) =>
    d.accepted === 0
      ? 'Nothing was merged.'
      : `Merged ${d.accepted}: new ${d.created}, changed ${d.changed}, deleted ${d.deleted}` +
        (d.tookSource + d.keptMine ? `; conflicts: from source ${d.tookSource}, mine kept ${d.keptMine}` : '') +
        (d.addedByClosure ? `; by links +${d.addedByClosure}` : '') +
        (d.skipped ? `; skipped ${d.skipped}` : ''),
  mgDangling: (n: number) => `${n} references of merged records point at records that exist nowhere. Merge those too or turn on “Fix references”.`,
  mgUndoHint: 'Ctrl+Z undoes the whole merge in one step.',
  mgLevelNote: 'Level data (zones, leveldata.level, interiors.level) was not merged: the editor cannot write it yet. The files are untouched — copy them by hand or merge in FCS.',
  mgLast: (at: string, n: number) => `Last merged from this mod: ${at}, records ${n}.`,
  mgSkippedTitle: 'Skipped',
  mgRecordNew: 'A new record will be created.',
  mgRecordDeleted: 'The record will be deleted from your mod.',
  mgOpen: 'Open the record',
  mgMine: 'Yours',
  mgTheirs: 'Source',
  mgWas: 'was',
  mgBecomes: 'becomes',
  mgFieldConflict: 'Conflict: both mods changed this field',
  mgReasonBoth: 'Both your mod and the source changed the same field.',
  mgReasonMineDeleted: 'You deleted this record, the source changes it. Take it back from the source, or keep it deleted.',
  mgReasonSourceDeleted: 'The source deletes a record that your mod changed. Delete it too, or keep yours.',
  mgKeepRecord: 'Keep mine',
  mgTakeRecord: 'Take from source',
  mgDeleteRecord: 'Delete',
  mgRestoreRecord: 'Restore from source',
  mgBlocked: (why: string) => `Cannot be merged: ${why}`,
  mgStale: 'The source changed this record after you rejected it.',
  mgLinks: (n: number) => `Refers to ${n} other changed records.`,
  mgRowDangling: (n: number) => `Refers to ${n} records that exist nowhere.`,
  mgNoPlan: 'The list could not be built.',
  mgBadFile: 'Could not read the file.',
  mgStoreBad: (err: string) => `The merge file next to the mod is damaged, decisions were started anew: ${err}`,
  mgStatusMerged: (n: number, name: string) => `Merged ${n} records from ${name}`,
  mgFilesNote: 'Decisions (skipped records, what was merged and when) are saved next to the mod in a .kedit-merge.json file when you save.',
};

export type MergeStrings = typeof mergeEn;

export const mergeRu: MergeStrings = {
  panel_merge: 'Слияние модов',
  mergeHint: 'Забрать записи из другого мода в свой: что новое, что изменено и удалено, конфликты решаются по полям.',
  mgSource: 'Мод-источник',
  mgPick: '— выберите мод —',
  mgBrowse: 'Выбрать файл…',
  mgRefresh: 'Прочитать заново',
  mgRefreshTip: 'Перечитать файл источника (если автор обновил мод).',
  mgIntro: (mod: string) => `Выберите мод, записи которого нужно перенести в «${mod}». В списке только отличия. Пока вы не нажали «Слить выбранные», ничего не меняется; одно Ctrl+Z отменяет всё слияние.`,
  mgIdentical: 'Сливать нечего: все записи источника уже есть в вашем моде.',
  mgCounts: (c: MergeCountsView) =>
    `новых ${c.new}, изменённых ${c.changed}, удалённых ${c.deleted}, конфликтов ${c.conflicts}` +
    (c.alreadyMerged ? `, уже слито ${c.alreadyMerged}` : '') +
    (c.identical ? `, совпадает ${c.identical}` : '') +
    (c.rejected ? `, пропущено ${c.rejected}` : '') +
    (c.blocked ? `, нельзя слить ${c.blocked}` : ''),
  mgKindNew: 'новые',
  mgKindChanged: 'изменённые',
  mgKindDeleted: 'удалённые',
  mgKindTip: 'Показать или скрыть этот вид изменений.',
  mgType: 'Тип',
  mgTypeAll: 'Все типы',
  mgSearch: 'Фильтр по имени или id…',
  mgOnlyConflicts: 'Только конфликты',
  mgShowSkipped: 'Показать пропущенные',
  mgShowSkippedTip: 'Показать записи, которые вы отклонили раньше (при следующих слияниях они скрыты). Кнопка ○ в строке вернёт запись в список.',
  mgNextConflict: 'Следующий конфликт',
  mgNoConflicts: 'В списке нет конфликтов.',
  mgShown: (shown: number, all: number) => `строк ${shown} из ${all}`,
  mgCap: (n: number) => `Показаны первые ${n}.`,
  mgMore: 'Показать ещё',
  mgIgnore: 'Игнорировать (оставить как есть, при следующем слиянии спросим снова)',
  mgAccept: 'Принять (слить эту запись)',
  mgReject: 'Отклонить (не показывать при следующих слияниях)',
  mgSelectShown: 'Выбрать все показанные',
  mgClear: 'Снять выбор',
  mgRejectSelected: (n: number) => `Отклонить выбранные (${n})`,
  mgApply: (n: number) => `Слить выбранные (${n})`,
  mgRecursive: 'Со связанными',
  mgRecursiveTip: 'Вместе с каждой выбранной записью взять всё, на что она ссылается среди изменений (целый диалог со всеми репликами).',
  mgFixRefs: 'Исправить ссылки',
  mgFixRefsTip: 'Взять и новые записи, на которые ссылаются выбранные, чтобы ни одна ссылка не повисла в воздухе.',
  mgConflictsDefault: 'Нерешённые конфликты',
  mgConflictsMine: 'оставить моё',
  mgConflictsSource: 'взять из источника',
  mgLevelData: 'Данные уровня (зоны, интерьеры)',
  mgLevelDataTip: 'Редактор пока не умеет читать и записывать данные уровня: они только определяются и отмечаются в отчёте.',
  mgLevelFound: (n: number, dir: string) => `У источника есть данные уровня (файлов: ${n}, папка ${dir}). Редактор пока не умеет их сливать: файлы не тронуты — перенесите вручную или слейте в FCS.`,
  mgMissingDeps: (list: string) => `Источник зависит от модов, которых нет у вашего: ${list}.`,
  mgPreview: (p: MergePreviewView) =>
    `Будет слито ${p.accepted}: новых ${p.created}, изменённых ${p.changed}, удалённых ${p.deleted}` +
    (p.byClosure ? `; по ссылкам +${p.byClosure}` : '') +
    (p.toSource + p.toMine ? `; конфликты: из источника ${p.toSource}, оставлено ваших ${p.toMine}` : ''),
  mgNothing: 'Ничего не выбрано.',
  mgDone: (d: MergeDoneView) =>
    d.accepted === 0
      ? 'Ничего не слито.'
      : `Слито ${d.accepted}: новых ${d.created}, изменённых ${d.changed}, удалённых ${d.deleted}` +
        (d.tookSource + d.keptMine ? `; конфликты: из источника ${d.tookSource}, оставлено ваших ${d.keptMine}` : '') +
        (d.addedByClosure ? `; по ссылкам +${d.addedByClosure}` : '') +
        (d.skipped ? `; пропущено ${d.skipped}` : ''),
  mgDangling: (n: number) => `Ссылок слитых записей на несуществующие записи: ${n}. Слейте и их или включите «Исправить ссылки».`,
  mgUndoHint: 'Ctrl+Z отменяет всё слияние одним шагом.',
  mgLevelNote: 'Данные уровня (зоны, leveldata.level, interiors.level) не слиты: редактор пока не умеет их записывать. Файлы не тронуты — перенесите их вручную или слейте в FCS.',
  mgLast: (at: string, n: number) => `Последнее слияние из этого мода: ${at}, записей ${n}.`,
  mgSkippedTitle: 'Пропущено',
  mgRecordNew: 'Будет создана новая запись.',
  mgRecordDeleted: 'Запись будет удалена из вашего мода.',
  mgOpen: 'Открыть запись',
  mgMine: 'Ваше',
  mgTheirs: 'Источник',
  mgWas: 'было',
  mgBecomes: 'станет',
  mgFieldConflict: 'Конфликт: оба мода поменяли это поле',
  mgReasonBoth: 'И ваш мод, и источник поменяли одно и то же поле.',
  mgReasonMineDeleted: 'Вы удалили эту запись, а источник её меняет. Вернуть запись из источника или оставить удалённой.',
  mgReasonSourceDeleted: 'Источник удаляет запись, которую меняли вы. Удалить и у себя или оставить вашу.',
  mgKeepRecord: 'Оставить моё',
  mgTakeRecord: 'Взять из источника',
  mgDeleteRecord: 'Удалить',
  mgRestoreRecord: 'Вернуть из источника',
  mgBlocked: (why: string) => `Слить нельзя: ${why}`,
  mgStale: 'После отклонения источник изменил эту запись.',
  mgLinks: (n: number) => `Ссылается на другие изменённые записи: ${n}.`,
  mgRowDangling: (n: number) => `Ссылается на записи, которых нет нигде: ${n}.`,
  mgNoPlan: 'Не удалось построить список.',
  mgBadFile: 'Не удалось прочитать файл.',
  mgStoreBad: (err: string) => `Файл слияния рядом с модом повреждён, решения начаты заново: ${err}`,
  mgStatusMerged: (n: number, name: string) => `Слито записей: ${n} из ${name}`,
  mgFilesNote: 'Решения (пропущенные записи, что и когда слито) при сохранении записываются рядом с модом в файл .kedit-merge.json.',
};
