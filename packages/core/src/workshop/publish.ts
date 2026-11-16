/**
 * Pre-publish checks for a Workshop upload: what blocks the upload (errors) and what the author
 * should know (warnings, notes). Pure: the caller gathers the facts (files on disk, editor state).
 */
import type { UiText } from '../ui-text.ts';
import type { ImageFormat } from './info.ts';

/** Steam limits (`k_cchPublishedDocumentTitleMax` 128+1, description and change note 8000). */
export const WORKSHOP_TITLE_MAX = 128;
export const WORKSHOP_DESCRIPTION_MAX = 8000;
export const WORKSHOP_CHANGE_NOTE_MAX = 8000;
/** Steam refuses preview pictures over 1 MB. */
export const WORKSHOP_PREVIEW_MAX = 1024 * 1024;
/** Above this a note says the upload will take a while. */
export const WORKSHOP_LARGE_UPLOAD = 500 * 1024 * 1024;

/** Why a file of the mod folder is not uploaded. */
export type ExcludeReason = 'cactus' | 'backup' | 'temp' | 'system' | 'vcs';

/** A name in the mod folder that is never uploaded, and why (see `docs`/README for the rule). */
export function excludeReason(name: string, isDir: boolean): ExcludeReason | undefined {
  const n = name.toLowerCase();
  if (isDir) return ['.git', '.svn', '.hg', '__macosx'].includes(n) ? 'vcs' : undefined;
  // Cactus companion files: merge decisions, copy origin and any future `.kedit-*` file.
  if (n.includes('.kedit-')) return 'cactus';
  if (/\.(bak|backup|old|orig)$/.test(n) || /\.bak-[\w-]+$/.test(n) || /\.blend\d+$/.test(n)) return 'backup';
  if (/\.tmp$/.test(n) || /\.tmp-\d+$/.test(n) || n.startsWith('~$') || n.endsWith('~') || n.startsWith('.~lock.')) return 'temp';
  if (n === 'thumbs.db' || n === 'desktop.ini' || n === '.ds_store') return 'system';
  return undefined;
}

export const EXCLUDE_REASON_TEXTS: Readonly<Record<ExcludeReason, UiText>> = {
  cactus: { en: 'Cactus companion file', ru: 'служебный файл Cactus', zh: 'Cactus 辅助文件' },
  backup: { en: 'backup copy', ru: 'резервная копия', zh: '备份副本' },
  temp: { en: 'temporary file', ru: 'временный файл', zh: '临时文件' },
  system: { en: 'system file', ru: 'системный файл', zh: '系统文件' },
  vcs: { en: 'version control folder', ru: 'папка системы контроля версий', zh: '版本控制文件夹' },
};

/** File size for people: `512 B`, `3.4 MB` (units in the interface language). */
export function sizeText(bytes: number): UiText {
  const units = { en: ['B', 'KB', 'MB', 'GB'], ru: ['Б', 'КБ', 'МБ', 'ГБ'], zh: ['B', 'KB', 'MB', 'GB'] } as const;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < 3) {
    v /= 1024;
    u++;
  }
  const num = u === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0);
  return {
    en: `${num} ${units.en[u]!}`,
    ru: `${num.replace('.', ',')} ${units.ru[u]!}`,
    zh: `${num} ${units.zh[u]!}`,
  };
}

/** Where the mod file lives. */
export type ModLocation = 'mods' | 'workshop' | 'other' | 'unsaved';

/** Facts the checks look at. */
export interface PublishFacts {
  title: string;
  /** Description that will be sent: the mod header as saved. */
  description: string;
  /** The description typed in the publish window differs from the mod header. */
  descriptionPending?: boolean;
  changeNote: string;
  /** Preview picture; `undefined` — none chosen and no `_<mod>.img`. */
  preview?: { size: number; format: ImageFormat | undefined };
  /** Unsaved edits in the editor. */
  dirty: boolean;
  location: ModLocation;
  validation: { errors: number; warnings: number };
  fileCount: number;
  totalSize: number;
  /** The mod is a Cactus copy of someone else's mod (`.kedit-origin.json`). */
  copyOf?: { workshopId?: string };
  /** `_<mod>.info` exists but does not read. */
  infoUnreadable?: boolean;
  /** `<mod>` in `_<mod>.info` names another mod (folder or file renamed). */
  infoModName?: string;
  modName: string;
}

export type PublishProblemCode =
  | 'title-empty'
  | 'title-long'
  | 'description-empty'
  | 'description-long'
  | 'description-pending'
  | 'change-note-long'
  | 'preview-missing'
  | 'preview-large'
  | 'preview-format'
  | 'unsaved'
  | 'validation-errors'
  | 'validation-warnings'
  | 'in-workshop'
  | 'not-in-mods'
  | 'not-saved'
  | 'no-files'
  | 'large-upload'
  | 'copy-of'
  | 'info-unreadable'
  | 'info-other-mod'
  | 'total-size';

export interface PublishProblem {
  /** `error` blocks the upload. */
  level: 'error' | 'warning' | 'info';
  code: PublishProblemCode;
  text: UiText;
}

const n = (x: number): string => String(x);
/** Length in code points, as Steam counts characters. */
const chars = (s: string): number => Array.from(s).length;

/** Everything worth saying before an upload, errors first. */
export function checkPublish(f: PublishFacts): PublishProblem[] {
  const out: PublishProblem[] = [];
  const err = (code: PublishProblemCode, text: UiText): void => {
    out.push({ level: 'error', code, text });
  };
  const warn = (code: PublishProblemCode, text: UiText): void => {
    out.push({ level: 'warning', code, text });
  };
  const note = (code: PublishProblemCode, text: UiText): void => {
    out.push({ level: 'info', code, text });
  };

  if (f.location === 'unsaved') err('not-saved', { en: 'The mod is not saved to a file yet. Save it into the game’s mods folder first.', ru: 'Мод ещё не сохранён в файл. Сначала сохраните его в папку mods игры.', zh: 'Mod 还没有保存为文件。请先把它保存到游戏的 mods 文件夹。' });
  else if (f.location === 'workshop')
    err('in-workshop', { en: 'This mod file is in the Steam Workshop download folder: it is someone’s download, Steam overwrites it. Publish only from the game’s mods folder.', ru: 'Этот файл мода лежит в папке загрузок мастерской Steam: это чья-то загрузка, Steam её перезаписывает. Публиковать можно только из папки mods игры.', zh: '这个 Mod 文件位于 Steam 创意工坊的下载文件夹：那是别人的下载内容，Steam 会覆盖它。只能从游戏的 mods 文件夹发布。' });
  else if (f.location === 'other')
    err('not-in-mods', { en: 'The mod is not in the game’s mods folder (mods/<name>/<name>.mod). Save it there to publish.', ru: 'Мод лежит не в папке mods игры (mods/<имя>/<имя>.mod). Сохраните его туда, чтобы опубликовать.', zh: 'Mod 不在游戏的 mods 文件夹中（mods/<名称>/<名称>.mod）。请保存到那里再发布。' });

  if (f.dirty) err('unsaved', { en: 'There are unsaved changes. Steam gets the files on disk, so save first.', ru: 'Есть несохранённые изменения. В Steam уходят файлы с диска — сначала сохраните.', zh: '有未保存的更改。上传到 Steam 的是磁盘上的文件，请先保存。' });
  if (f.descriptionPending === true)
    err('description-pending', { en: 'The description here differs from the mod header. Press “Write into the mod” and save — Steam takes the description from the mod.', ru: 'Описание здесь отличается от заголовка мода. Нажмите «Записать в мод» и сохраните — Steam берёт описание из мода.', zh: '这里的描述与 Mod 头部不同。请点击“写入 Mod”并保存——Steam 使用 Mod 中的描述。' });

  const title = f.title.trim();
  if (!title) err('title-empty', { en: 'The title is empty.', ru: 'Название пустое.', zh: '标题为空。' });
  else if (chars(f.title) > WORKSHOP_TITLE_MAX)
    err('title-long', { en: `The title is longer than ${n(WORKSHOP_TITLE_MAX)} characters (Steam limit).`, ru: `Название длиннее ${n(WORKSHOP_TITLE_MAX)} знаков (ограничение Steam).`, zh: `标题超过 ${n(WORKSHOP_TITLE_MAX)} 个字符（Steam 限制）。` });

  if (!f.description.trim()) err('description-empty', { en: 'The description is empty (it is the description in the mod header).', ru: 'Описание пустое (это описание в заголовке мода).', zh: '描述为空（即 Mod 头部中的描述）。' });
  else if (chars(f.description) > WORKSHOP_DESCRIPTION_MAX)
    err('description-long', { en: `The description is longer than ${n(WORKSHOP_DESCRIPTION_MAX)} characters (Steam limit).`, ru: `Описание длиннее ${n(WORKSHOP_DESCRIPTION_MAX)} знаков (ограничение Steam).`, zh: `描述超过 ${n(WORKSHOP_DESCRIPTION_MAX)} 个字符（Steam 限制）。` });
  if (chars(f.changeNote) > WORKSHOP_CHANGE_NOTE_MAX)
    err('change-note-long', { en: `The change note is longer than ${n(WORKSHOP_CHANGE_NOTE_MAX)} characters.`, ru: `Заметка об изменениях длиннее ${n(WORKSHOP_CHANGE_NOTE_MAX)} знаков.`, zh: `更新说明超过 ${n(WORKSHOP_CHANGE_NOTE_MAX)} 个字符。` });

  if (!f.preview) err('preview-missing', { en: 'No preview picture. Choose a PNG, JPEG or GIF up to 1 MB.', ru: 'Нет картинки предпросмотра. Выберите PNG, JPEG или GIF до 1 МБ.', zh: '没有预览图片。请选择不超过 1 MB 的 PNG、JPEG 或 GIF。' });
  else {
    if (f.preview.format === undefined)
      err('preview-format', { en: 'The preview is not a PNG, JPEG or GIF picture.', ru: 'Предпросмотр — не картинка PNG, JPEG или GIF.', zh: '预览不是 PNG、JPEG 或 GIF 图片。' });
    if (f.preview.size > WORKSHOP_PREVIEW_MAX) {
      const s = sizeText(f.preview.size);
      err('preview-large', { en: `The preview is ${s.en}; Steam accepts up to 1 MB.`, ru: `Предпросмотр весит ${s.ru!}; Steam принимает до 1 МБ.`, zh: `预览大小为 ${s.zh!}；Steam 最多接受 1 MB。` });
    }
  }

  if (f.location === 'mods' && f.fileCount === 0)
    err('no-files', { en: 'The mod folder has no files to upload.', ru: 'В папке мода нет файлов для загрузки.', zh: 'Mod 文件夹中没有可上传的文件。' });

  if (f.validation.errors > 0)
    warn('validation-errors', { en: `Diagnostics found ${n(f.validation.errors)} error(s) in the mod. You can still publish, but check them first.`, ru: `Диагностика нашла в моде ошибок: ${n(f.validation.errors)}. Публиковать можно, но сначала стоит их посмотреть.`, zh: `诊断在 Mod 中发现 ${n(f.validation.errors)} 个错误。仍可发布，但建议先检查。` });
  if (f.copyOf)
    warn('copy-of', {
      en: `This mod is a copy of someone else’s mod${f.copyOf.workshopId !== undefined ? ` (Workshop ${f.copyOf.workshopId})` : ''}. Publishing other people’s work needs their permission.`,
      ru: `Этот мод — копия чужого мода${f.copyOf.workshopId !== undefined ? ` (мастерская, ${f.copyOf.workshopId})` : ''}. Для публикации чужой работы нужно разрешение автора.`,
      zh: `这个 Mod 是别人 Mod 的副本${f.copyOf.workshopId !== undefined ? `（创意工坊 ${f.copyOf.workshopId}）` : ''}。发布他人的作品需要获得作者许可。`,
    });
  if (f.infoUnreadable === true)
    warn('info-unreadable', { en: 'The Workshop file next to the mod (_<mod>.info) does not read; it will be written anew and a new item created.', ru: 'Файл мастерской рядом с модом (_<мод>.info) не читается; он будет записан заново, и будет создана новая запись.', zh: 'Mod 旁边的创意工坊文件（_<mod>.info）无法读取；它将被重新写入，并创建新的条目。' });
  if (f.infoModName !== undefined && f.infoModName.toLowerCase() !== f.modName.toLowerCase())
    warn('info-other-mod', {
      en: `The Workshop file next to the mod was written for “${f.infoModName}”. If that is another mod, its item will be overwritten.`,
      ru: `Файл мастерской рядом с модом записан для «${f.infoModName}». Если это другой мод, его запись будет перезаписана.`,
      zh: `Mod 旁边的创意工坊文件是为“${f.infoModName}”写的。如果那是另一个 Mod，它的条目将被覆盖。`,
    });
  if (f.validation.warnings > 0)
    note('validation-warnings', { en: `Diagnostics: ${n(f.validation.warnings)} warning(s).`, ru: `Диагностика: предупреждений — ${n(f.validation.warnings)}.`, zh: `诊断：${n(f.validation.warnings)} 个警告。` });

  const size = sizeText(f.totalSize);
  if (f.totalSize > WORKSHOP_LARGE_UPLOAD)
    warn('large-upload', { en: `The upload is large (${size.en}): it will take a while.`, ru: `Загрузка большая (${size.ru!}): это займёт время.`, zh: `上传内容较大（${size.zh!}）：需要一些时间。` });
  note('total-size', { en: `Files to upload: ${n(f.fileCount)}, ${size.en}.`, ru: `Файлов к загрузке: ${n(f.fileCount)}, ${size.ru!}.`, zh: `要上传的文件：${n(f.fileCount)} 个，${size.zh!}。` });

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** True if nothing blocks the upload. */
export function canPublish(problems: readonly PublishProblem[]): boolean {
  return !problems.some((p) => p.level === 'error');
}
