/**
 * Protocol between Cactus and its Workshop uploader: a short-lived child process that talks to
 * Steam and exits. Both sides exchange JSON, one object per line.
 *
 * Parent → child (stdin): first line `{ type: 'publish', request }`; later optionally
 * `{ type: 'cancel' }`. Child → parent (stdout): `hello`, then `stage` / `progress` / `created`
 * / `log` lines, and exactly one final line — `done`, `error` or `cancelled`.
 */
import type { UiText } from '../ui-text.ts';

export const UPLOADER_PROTOCOL = 1;
/** Kenshi's Steam app id: FCS uploads under it, so does Cactus. */
export const STEAM_APP_ID_KENSHI = 233860;

/** What the parent asks for. */
export interface PublishRequest {
  /** Absolute path of the `.mod` file (in the game's `mods/<name>/`). */
  modPath: string;
  title: string;
  description: string;
  changeNote: string;
  tags: string[];
  visibility: number;
  /** Picture to use as the preview; copied to `_<mod>.img` unless it already is that file. */
  previewPath: string;
  /**
   * Item id the window showed (`'0'` — create). The uploader re-reads `_<mod>.info` and refuses if
   * it holds another id (FCS or another Cactus window published meanwhile).
   */
  expectedId: string;
  /** Folder for the staged copy of the upload (outside the game). */
  stagingDir: string;
}

export type PublishStage = 'init' | 'checking' | 'creating' | 'writing-info' | 'staging' | 'uploading';

/** `ISteamUGC` update phases (`EItemUpdateStatus`). */
export type UploadPhase = 'invalid' | 'preparing-config' | 'preparing-content' | 'uploading-content' | 'uploading-preview' | 'committing';

export const UPLOAD_PHASES: readonly UploadPhase[] = ['invalid', 'preparing-config', 'preparing-content', 'uploading-content', 'uploading-preview', 'committing'];

export type PublishErrorCode =
  | 'library-missing'
  | 'steam-not-running'
  | 'steam-init-failed'
  | 'not-logged-in'
  | 'no-license'
  | 'not-owner'
  | 'item-deleted'
  | 'rate-limit'
  | 'limit-exceeded'
  | 'timeout'
  | 'no-connection'
  | 'banned'
  | 'service-unavailable'
  | 'busy'
  | 'info-changed'
  | 'bad-request'
  | 'files'
  | 'crashed'
  | 'unknown';

export type UploaderMessage =
  | { type: 'hello'; protocol: number; fake: boolean }
  | { type: 'stage'; stage: PublishStage }
  | { type: 'progress'; phase: UploadPhase; done: number; total: number }
  | { type: 'created'; id: string; needsAgreement: boolean }
  | { type: 'log'; text: string }
  | { type: 'done'; id: string; created: boolean; needsAgreement: boolean }
  | { type: 'error'; code: PublishErrorCode; detail?: string; id?: string }
  | { type: 'cancelled'; stage: PublishStage | 'start'; id?: string };

export type ParentMessage = { type: 'publish'; request: PublishRequest } | { type: 'cancel' };

export function encodeMessage(m: UploaderMessage | ParentMessage): string {
  return `${JSON.stringify(m)}\n`;
}

/** One line from the child; `undefined` for anything that is not a protocol message. */
export function parseUploaderLine(line: string): UploaderMessage | undefined {
  const s = line.trim();
  if (!s.startsWith('{')) return undefined;
  try {
    const m = JSON.parse(s) as { type?: unknown };
    return typeof m.type === 'string' ? (m as UploaderMessage) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a byte stream into lines (keeps the unfinished tail). */
export class LineSplitter {
  private tail = '';
  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const lines = text.split(/\r?\n/);
    this.tail = lines.pop() ?? '';
    return lines.filter((l) => l.length > 0);
  }
  flush(): string[] {
    const rest = this.tail;
    this.tail = '';
    return rest ? [rest] : [];
  }
}

/**
 * Error code for a Steam error text. `steamworks.js` 0.4.0 rejects with the `Display` text of
 * steamworks-rs `SteamError` (`access denied`, `item deleted`, `temporary rate limit exceeded`…);
 * an init failure is always `failed to init the steamworks API`.
 */
export function classifySteamError(message: string): PublishErrorCode {
  const m = message.toLowerCase();
  if (m.includes('failed to init') || m.includes('steam probably isn') || m.includes('cannot connect to steam')) return 'steam-init-failed';
  if (m.includes('not logged on') || m.includes('logged in elsewhere') || m.includes('logon session replaced')) return 'not-logged-in';
  if (m.includes('access denied') || m.includes('insufficient privilege') || m.includes('access revoked')) return 'not-owner';
  if (m.includes('item deleted') || m.includes('file was not found')) return 'item-deleted';
  if (m.includes('rate limit') || m.includes('too many actions')) return 'rate-limit';
  if (m.includes('limit exceeded')) return 'limit-exceeded';
  if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
  if (m.includes('network connection') || m.includes('no connection') || m.includes('connect failed') || m.includes('remote disconnect')) return 'no-connection';
  if (m.includes('banned') || m.includes('account disabled') || m.includes('account locked')) return 'banned';
  if (m.includes('service is unavailable') || m.includes('service unavailable') || m.includes('service disabled')) return 'service-unavailable';
  if (m.includes('busy') || m.includes('request is pending') || m.includes('duplicate')) return 'busy';
  if (m.includes('parameter is invalid') || m.includes('invalid item type')) return 'bad-request';
  return 'unknown';
}

/** What each error means for the author, and what to do. */
export const PUBLISH_ERROR_TEXTS: Readonly<Record<PublishErrorCode, UiText>> = {
  'library-missing': {
    en: 'The Steam library did not load (steamworks.js / steam_api64.dll). Reinstall Cactus; the details are in the upload log.',
    ru: 'Не загрузилась библиотека Steam (steamworks.js / steam_api64.dll). Переустановите Cactus; подробности — в журнале загрузки.',
    zh: 'Steam 库未能加载（steamworks.js / steam_api64.dll）。请重新安装 Cactus；详情见上传日志。',
  },
  'steam-not-running': {
    en: 'Steam is not running. Start Steam, log in, and try again.',
    ru: 'Steam не запущен. Запустите Steam, войдите в аккаунт и попробуйте снова.',
    zh: 'Steam 未运行。请启动 Steam 并登录，然后重试。',
  },
  'steam-init-failed': {
    en: 'Steam is running but did not let Cactus in. Usually: you are not logged in, Steam is in offline mode, or this account does not own Kenshi.',
    ru: 'Steam запущен, но не пустил Cactus. Обычно причина одна из трёх: вы не вошли в аккаунт, Steam в автономном режиме или на этом аккаунте нет Kenshi.',
    zh: 'Steam 正在运行，但拒绝了 Cactus。通常原因是：未登录、Steam 处于离线模式，或此账户没有 Kenshi。',
  },
  'not-logged-in': {
    en: 'Steam says you are not logged in (or logged in elsewhere). Log in to Steam and try again.',
    ru: 'Steam сообщает, что вы не вошли в аккаунт (или вошли в другом месте). Войдите в Steam и попробуйте снова.',
    zh: 'Steam 表示您未登录（或已在其他地方登录）。请登录 Steam 后重试。',
  },
  'no-license': {
    en: 'This Steam account does not own Kenshi, so it cannot publish to Kenshi’s Workshop.',
    ru: 'На этом аккаунте Steam нет Kenshi, поэтому публиковать в мастерскую Kenshi нельзя.',
    zh: '此 Steam 账户没有 Kenshi，因此无法发布到 Kenshi 创意工坊。',
  },
  'not-owner': {
    en: 'Steam refused access: this Workshop item belongs to another account, or your account may not change it. If the mod was copied from someone, delete its _<mod>.info to publish as a new item.',
    ru: 'Steam отказал в доступе: эта запись мастерской принадлежит другому аккаунту или вашему аккаунту её менять нельзя. Если мод скопирован у кого-то, удалите его _<мод>.info, чтобы опубликовать как новую запись.',
    zh: 'Steam 拒绝访问：此创意工坊条目属于其他账户，或您的账户无权修改。如果 Mod 是从别人那里复制的，请删除它的 _<mod>.info 以作为新条目发布。',
  },
  'item-deleted': {
    en: 'The Workshop item in _<mod>.info no longer exists (deleted). Delete _<mod>.info next to the mod to publish it as a new item.',
    ru: 'Записи мастерской из _<мод>.info больше нет (удалена). Удалите _<мод>.info рядом с модом, чтобы опубликовать его как новую запись.',
    zh: '_<mod>.info 中的创意工坊条目已不存在（已删除）。请删除 Mod 旁边的 _<mod>.info，以作为新条目发布。',
  },
  'rate-limit': {
    en: 'Steam asks to slow down (too many uploads in a short time). Wait a few minutes and try again.',
    ru: 'Steam просит подождать (слишком много загрузок за короткое время). Подождите несколько минут и попробуйте снова.',
    zh: 'Steam 要求放慢速度（短时间内上传过多）。请等待几分钟后重试。',
  },
  'limit-exceeded': {
    en: 'Steam refused: a limit was exceeded (preview over 1 MB, too much content, or the account’s Workshop quota).',
    ru: 'Steam отказал: превышено ограничение (предпросмотр больше 1 МБ, слишком много данных или квота мастерской аккаунта).',
    zh: 'Steam 拒绝：超出了限制（预览超过 1 MB、内容过多或账户的创意工坊配额）。',
  },
  timeout: {
    en: 'Steam did not answer in time. Check the connection and try again.',
    ru: 'Steam не ответил вовремя. Проверьте подключение и попробуйте снова.',
    zh: 'Steam 未及时响应。请检查网络连接后重试。',
  },
  'no-connection': {
    en: 'Steam has no connection to its servers right now. Check the internet and Steam’s online status.',
    ru: 'У Steam сейчас нет связи с серверами. Проверьте интернет и что Steam в сети.',
    zh: 'Steam 当前无法连接到服务器。请检查网络以及 Steam 的在线状态。',
  },
  banned: {
    en: 'Steam refused: the account is banned or restricted from the Workshop / community.',
    ru: 'Steam отказал: аккаунт заблокирован или ограничен в мастерской / сообществе.',
    zh: 'Steam 拒绝：该账户被封禁或在创意工坊/社区中受限。',
  },
  'service-unavailable': {
    en: 'The Steam Workshop service is unavailable right now. Try again later.',
    ru: 'Сервис мастерской Steam сейчас недоступен. Попробуйте позже.',
    zh: 'Steam 创意工坊服务当前不可用。请稍后重试。',
  },
  busy: {
    en: 'Steam is busy with another request for this item. Wait a little and try again.',
    ru: 'Steam занят другим запросом по этой записи. Подождите немного и попробуйте снова.',
    zh: 'Steam 正在处理该条目的另一个请求。请稍候再试。',
  },
  'info-changed': {
    en: 'The Workshop file next to the mod changed since this window opened (FCS or another window published). Close and open the publish window again.',
    ru: 'Файл мастерской рядом с модом изменился после открытия окна (опубликовали из FCS или другого окна). Закройте и снова откройте окно публикации.',
    zh: '自本窗口打开后，Mod 旁边的创意工坊文件已发生变化（FCS 或其他窗口已发布）。请关闭并重新打开发布窗口。',
  },
  'bad-request': {
    en: 'Steam rejected the request as invalid (a field or the preview). The details are in the upload log.',
    ru: 'Steam отклонил запрос как неверный (одно из полей или предпросмотр). Подробности — в журнале загрузки.',
    zh: 'Steam 认为请求无效（某个字段或预览）。详情见上传日志。',
  },
  files: {
    en: 'Could not read or write the mod files for the upload. The details are below and in the upload log.',
    ru: 'Не удалось прочитать или записать файлы мода для загрузки. Подробности — ниже и в журнале загрузки.',
    zh: '无法读取或写入用于上传的 Mod 文件。详情见下方及上传日志。',
  },
  crashed: {
    en: 'The uploader stopped unexpectedly. The details are in the upload log.',
    ru: 'Загрузчик неожиданно остановился. Подробности — в журнале загрузки.',
    zh: '上传程序意外停止。详情见上传日志。',
  },
  unknown: {
    en: 'Steam returned an error Cactus does not know. The text is below and in the upload log.',
    ru: 'Steam вернул ошибку, незнакомую Cactus. Текст — ниже и в журнале загрузки.',
    zh: 'Steam 返回了 Cactus 无法识别的错误。错误内容见下方及上传日志。',
  },
};

/** Workshop page of an item: Steam client link and web link. */
export function workshopUrls(id: string): { steam: string; web: string } {
  return { steam: `steam://url/CommunityFilePage/${id}`, web: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}` };
}

/** Steam's Workshop legal agreement page (a new author must accept it once for items to show). */
export const WORKSHOP_AGREEMENT_URL = 'https://steamcommunity.com/sharedfiles/workshoplegalagreement';
