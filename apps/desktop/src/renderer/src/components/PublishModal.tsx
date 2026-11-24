/**
 * «Publish to Steam Workshop» window: form → confirm → progress → result.
 * The upload itself runs in a separate process started by the main process (`main/publish.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { canPublish, checkPublish, PUBLISH_ERROR_TEXTS, sizeText, uiText, validateMod, WORKSHOP_TAGS, EXCLUDE_REASON_TEXTS, type PublishStage, type UploaderMessage, type UploadPhase } from '@kenshi-editor/core';
import type { PublishPrep, PublishPreview, PublishStartResult } from '../../../shared/api.ts';
import { useLang, useT, type Strings } from '../i18n.ts';
import { tryEdit, useProjectVersion } from '../hooks.ts';
import type { Project } from '../project.ts';
import { Modal } from './widgets.tsx';

type Step = 'form' | 'confirm' | 'running' | 'result';
type Final = Extract<UploaderMessage, { type: 'done' | 'error' | 'cancelled' }> | { type: 'start-failed'; reason: Exclude<PublishStartResult, { ok: true }>['reason'] };

const VIS_KEYS = ['vis_public', 'vis_friends', 'vis_private', 'vis_unlisted'] as const;
const visLabel = (t: Strings, v: number): string => t[VIS_KEYS[v] ?? 'vis_public'];

interface Props {
  project: Project;
  onSave: () => Promise<void>;
  onReport: (text: string) => void;
  onClose: () => void;
}

export function PublishModal({ project, onSave, onReport, onClose }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const size = (n: number): string => uiText(sizeText(n), lang);

  const [prep, setPrep] = useState<PublishPrep | undefined>();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState(ctx.info.description);
  const [changeNote, setChangeNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [visibility, setVisibility] = useState(2);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropRefused, setDropRefused] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [stage, setStage] = useState<PublishStage | 'start'>('start');
  const [progress, setProgress] = useState<{ phase: UploadPhase; done: number; total: number } | undefined>();
  const [createdId, setCreatedId] = useState<string | undefined>();
  const [final, setFinal] = useState<Final | undefined>();
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const firstLoad = useRef(true);
  const stepRef = useRef(step);
  stepRef.current = step;

  const load = useCallback(async (): Promise<void> => {
    if (project.path === undefined) {
      setPrep(undefined);
      return;
    }
    const p = await window.kedit.publishPrepare(project.path);
    setPrep(p);
    if (firstLoad.current) {
      firstLoad.current = false;
      setTitle(p.info?.title ?? p.modName);
      setTags(p.info?.tags ?? []);
      setVisibility(p.info && p.info.id !== '0' ? p.info.visibility : 2);
      setPreview(p.preview);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  // Uploader messages while this window is open.
  useEffect(
    () =>
      window.kedit.onPublishEvent((m) => {
        if (m.type === 'stage') setStage(m.stage);
        else if (m.type === 'progress') setProgress({ phase: m.phase, done: m.done, total: m.total });
        else if (m.type === 'created') setCreatedId(m.id);
        else if (m.type === 'done' || m.type === 'error' || m.type === 'cancelled') {
          setFinal(m);
          setStep('result');
          setCancelling(false);
          void load();
        }
      }),
    [load],
  );

  const validation = useMemo(() => {
    const issues = validateMod(ctx);
    return { errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length };
  }, [ctx, version]);

  const header = ctx.info.description;
  const problems = useMemo(
    () =>
      checkPublish({
        title,
        description: header,
        descriptionPending: desc !== header,
        changeNote,
        ...(preview ? { preview: { size: preview.size, format: preview.format ?? undefined } } : {}),
        dirty: project.dirty,
        location: project.path === undefined ? 'unsaved' : (prep?.location ?? 'other'),
        validation,
        fileCount: prep?.files.length ?? 0,
        totalSize: prep?.totalSize ?? 0,
        ...(prep?.copyOf ? { copyOf: prep.copyOf } : {}),
        ...(prep?.infoState === 'unreadable' ? { infoUnreadable: true } : {}),
        ...(prep?.info ? { infoModName: prep.info.mod } : {}),
        modName: prep?.modName ?? ctx.modName,
      }),
    [title, header, desc, changeNote, preview, prep, validation, version, project],
  );

  const existingId = prep?.info && prep.info.id !== '0' ? prep.info.id : undefined;
  const steamOff = prep?.steamRunning === false;
  const ready = prep !== undefined && canPublish(problems) && !steamOff;
  const allTags = [...WORKSHOP_TAGS, ...tags.filter((x) => !WORKSHOP_TAGS.includes(x))];
  const visOptions = visibility === 3 || prep?.info?.visibility === 3 ? [0, 1, 2, 3] : [0, 1, 2];

  const writeDesc = (): void => {
    const err = tryEdit(() => {
      ctx.setModInfo({ description: desc });
    });
    if (err) onReport(err);
  };

  const choosePreview = async (): Promise<void> => {
    const p = await window.kedit.publishChoosePreview();
    if (p) {
      setPreview(p);
      setDropRefused(false);
    }
  };

  /** A picture dragged from the desktop or Explorer onto the preview area. */
  const dropPreview = async (e: DragEvent): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    const path = file ? window.kedit.pathForFile(file) : '';
    const p = path ? await window.kedit.publishPreviewFromPath(path) : null;
    if (p) setPreview(p);
    setDropRefused(!p);
  };

  const start = async (): Promise<void> => {
    if (!prep || project.path === undefined) return;
    setStage('start');
    setProgress(undefined);
    setCreatedId(undefined);
    setFinal(undefined);
    setCopied(false);
    setStep('running');
    const r = await window.kedit.publishStart({
      modPath: project.path,
      title: title.trim(),
      description: header,
      changeNote,
      tags,
      visibility,
      previewPath: preview?.path ?? prep.imgPath,
      expectedId: prep.info?.id ?? '0',
    });
    if (!r.ok) {
      setFinal({ type: 'start-failed', reason: r.reason });
      setStep('result');
    }
  };

  const cancel = (): void => {
    setCancelling(true);
    void window.kedit.publishCancel();
  };

  // Closing while running stops the run first; the window closes once the uploader is done.
  const close = (): void => {
    if (stepRef.current === 'running') cancel();
    else onClose();
  };

  const resultId = final && final.type !== 'start-failed' ? (final.type === 'done' ? final.id : (final.id ?? createdId)) : undefined;

  let body: ReactNode;
  let footer: ReactNode;
  if (project.path !== undefined && !prep) {
    body = <p className="muted">{t.pubLoading}</p>;
    footer = <button onClick={onClose}>{t.pubClose}</button>;
  } else if (step === 'form') {
    body = (
      <div className="publish-form">
        {prep?.fake != null && <div className="banner info" data-testid="pub-fake">{t.pubFake(prep.fake)}</div>}
        {steamOff && (
          <div className="banner warn" data-testid="pub-steam-off">
            {t.pubSteamOff}{' '}
            <button className="small" onClick={() => void load()} data-testid="pub-recheck">
              {t.pubRecheck}
            </button>
          </div>
        )}
        {prep?.steamRunning === null && <div className="muted">{t.pubSteamUnknown}</div>}
        {prep?.location === 'mods' && (
          <div className={`banner ${existingId !== undefined ? 'warn' : 'info'}`} data-testid="pub-mode">
            {existingId !== undefined ? t.pubUpdate(existingId) : t.pubNew}
          </div>
        )}
        <div className="form">
          <label htmlFor="pub-title">{t.pubTitle}</label>
          <input id="pub-title" data-testid="pub-title" value={title} maxLength={256} onChange={(e) => { setTitle(e.target.value); }} />

          <label htmlFor="pub-desc">{t.pubDescription}</label>
          <div>
            <textarea id="pub-desc" data-testid="pub-desc" rows={7} value={desc} onChange={(e) => { setDesc(e.target.value); }} style={{ width: '100%' }} />
            <div className="muted small">{t.pubDescHint}</div>
            <div className="row">
              <button className="small" disabled={desc === header} onClick={writeDesc} title={t.pubWriteDescTip} data-testid="pub-write-desc">
                {t.pubWriteDesc}
              </button>
              <button
                className="small"
                disabled={!project.dirty}
                onClick={() => void onSave().then(() => load())}
                data-testid="pub-save"
              >
                {t.pubSaveMod}
              </button>
            </div>
          </div>

          <span>{t.pubTags}</span>
          <div className="publish-tags">
            {allTags.map((tag) => (
              <label key={tag} title={tag}>
                <input
                  type="checkbox"
                  data-testid={`pub-tag-${tag}`}
                  checked={tags.includes(tag)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setTags((c) => (on ? [...c, tag] : c.filter((x) => x !== tag)));
                  }}
                />{' '}
                {t.pubTagNames[tag] ?? tag}
              </label>
            ))}
          </div>

          <label htmlFor="pub-vis">{t.pubVisibility}</label>
          <select id="pub-vis" data-testid="pub-visibility" value={visibility} onChange={(e) => { setVisibility(Number(e.target.value)); }}>
            {visOptions.map((v) => (
              <option key={v} value={v}>
                {visLabel(t, v)}
              </option>
            ))}
          </select>

          <span>{t.pubPreview}</span>
          <div
            className={`publish-preview${dragOver ? ' drag-over' : ''}`}
            data-testid="pub-preview-drop"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
            }}
            onDrop={(e) => void dropPreview(e)}
          >
            {preview?.dataUrl ? <img src={preview.dataUrl} alt="" data-testid="pub-thumb" /> : <div className="publish-thumb-empty muted">{t.pubNoPreview}</div>}
            <div>
              {preview && (
                <div className="muted small" data-testid="pub-preview-info">
                  {t.pubPreviewFile(size(preview.size), preview.format ? preview.format.toUpperCase() : t.pubPreviewNotPicture)}
                </div>
              )}
              <button className="small" onClick={() => void choosePreview()} data-testid="pub-choose-preview">
                {t.pubChoosePreview}
              </button>
              <div className="muted small">{t.pubDropPreview}</div>
              {dropRefused && (
                <div className="small error" data-testid="pub-drop-refused">
                  {t.pubDropRefused}
                </div>
              )}
            </div>
          </div>

          <label htmlFor="pub-note">{t.pubChangeNote}</label>
          <div>
            <textarea id="pub-note" data-testid="pub-change-note" rows={3} value={changeNote} onChange={(e) => { setChangeNote(e.target.value); }} style={{ width: '100%' }} />
            <div className="muted small">{t.pubChangeNoteHint}</div>
          </div>

          <span>{t.pubFiles}</span>
          <div data-testid="pub-files">
            <div>{t.pubFilesSummary(prep?.files.length ?? 0, size(prep?.totalSize ?? 0))}</div>
            <ul className="publish-files">
              {(prep?.files ?? []).map((f) => (
                <li key={f.rel}>
                  <span>{f.rel}</span> <span className="muted">{size(f.size)}</span>
                </li>
              ))}
            </ul>
            {(prep?.excluded.length ?? 0) > 0 && (
              <div className="muted small">
                <button className="link" title={t.pubExcludedTip} onClick={() => { setShowExcluded((s) => !s); }} data-testid="pub-excluded">
                  {t.pubExcluded(prep?.excluded.length ?? 0)}
                </button>
                {showExcluded && (
                  <ul className="publish-files">
                    {prep?.excluded.map((f) => (
                      <li key={f.rel}>
                        {f.rel} — {uiText(EXCLUDE_REASON_TEXTS[f.reason], lang)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
        <h4>{t.pubChecks}</h4>
        <ul className="issues" data-testid="pub-checks">
          {problems.map((p) => (
            <li key={p.code} className={p.level} data-code={p.code}>
              {uiText(p.text, lang)}
            </li>
          ))}
        </ul>
      </div>
    );
    footer = (
      <>
        <span className="grow" />
        <button onClick={onClose} data-testid="pub-close">
          {t.pubClose}
        </button>
        <button className="primary" disabled={!ready} onClick={() => { setStep('confirm'); }} data-testid="pub-next">
          {t.pubNext}
        </button>
      </>
    );
  } else if (step === 'confirm') {
    const files = prep?.files.length ?? 0;
    const total = size(prep?.totalSize ?? 0);
    body = (
      <div data-testid="pub-confirm-text">
        <h4>{t.pubConfirmHead}</h4>
        {prep?.fake != null && <div className="banner info">{t.pubFake(prep.fake)}</div>}
        <p>{existingId !== undefined ? t.pubConfirmUpdate(existingId, files, total, visLabel(t, visibility)) : t.pubConfirmCreate(files, total, visLabel(t, visibility))}</p>
        <p>{t.pubConfirmInfo(`_${prep?.modName ?? ''}.info`)}</p>
        <p className="muted">{t.pubConfirmUndo}</p>
      </div>
    );
    footer = (
      <>
        <button onClick={() => { setStep('form'); }} data-testid="pub-back">
          {t.pubBack}
        </button>
        <span className="grow" />
        <button onClick={onClose}>{t.pubClose}</button>
        <button className="primary" onClick={() => void start()} data-testid="pub-confirm">
          {prep?.fake != null ? t.pubConfirmBtnFake : t.pubConfirmBtn}
        </button>
      </>
    );
  } else if (step === 'running') {
    const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : undefined;
    body = (
      <div data-testid="pub-progress">
        <p data-stage={stage}>{t[`stage_${stage}`]}</p>
        {stage === 'uploading' && progress && (
          <>
            <div className="muted">
              {t[`phase_${progress.phase}`]}
              {pct !== undefined ? ` — ${String(pct)}%` : ''}
            </div>
            <progress max={100} value={pct ?? 0} style={{ width: '100%' }} />
          </>
        )}
        {cancelling && <p className="muted">{stage === 'creating' || stage === 'writing-info' ? t.pubCancelWaitCreate : t.pubCancelling}</p>}
      </div>
    );
    footer = (
      <>
        <span className="grow" />
        <button onClick={cancel} disabled={cancelling} data-testid="pub-cancel">
          {cancelling ? t.pubCancelling : t.pubCancelUpload}
        </button>
      </>
    );
  } else {
    body = <Result final={final} createdId={resultId} t={t} lang={lang} copied={copied} onCopied={() => { setCopied(true); }} />;
    footer = (
      <>
        <button onClick={() => void window.kedit.publishShowLog()} data-testid="pub-show-log">
          {t.pubShowLog}
        </button>
        <span className="grow" />
        {final?.type !== 'done' && (
          <button onClick={() => { setStep('form'); }} data-testid="pub-try-again">
            {t.pubTryAgain}
          </button>
        )}
        <button className="primary" onClick={onClose} data-testid="pub-close">
          {t.pubClose}
        </button>
      </>
    );
  }

  return (
    <Modal title={t.pubWindow} onClose={close} wide testId="publish-modal" footer={footer}>
      {body}
    </Modal>
  );
}

function Result({ final, createdId, t, lang, copied, onCopied }: { final: Final | undefined; createdId: string | undefined; t: Strings; lang: string; copied: boolean; onCopied: () => void }): ReactNode {
  const links = createdId !== undefined && (
    <div className="row">
      <button onClick={() => void window.kedit.publishOpenPage(createdId)} data-testid="pub-open-page">
        {t.pubOpenPage}
      </button>
      <button onClick={() => void window.kedit.publishWebPage(createdId)} data-testid="pub-web-page">
        {t.pubWebPage}
      </button>
      <button onClick={() => void window.kedit.publishCopyLink(createdId).then((ok) => {
            if (ok) onCopied();
          })} data-testid="pub-copy-link">
        {copied ? t.pubCopied : t.pubCopyLink}
      </button>
    </div>
  );
  if (!final) return null;
  if (final.type === 'done') {
    return (
      <div data-testid="pub-result" data-result="done" data-id={final.id}>
        <div className="banner info">{final.created ? t.pubDoneCreated(final.id) : t.pubDoneUpdated(final.id)}</div>
        <p className="muted">{t.pubDoneNote}</p>
        {final.needsAgreement && (
          <div className="banner warn" data-testid="pub-agreement">
            {t.pubAgreement}{' '}
            <button className="small" onClick={() => void window.kedit.publishOpenAgreement()}>
              {t.pubAgreementBtn}
            </button>
          </div>
        )}
        {links}
      </div>
    );
  }
  if (final.type === 'cancelled') {
    return (
      <div data-testid="pub-result" data-result="cancelled">
        <div className="banner warn">{final.stage === 'uploading' ? t.pubCancelledUpload : t.pubCancelled}</div>
        {createdId !== undefined && <p>{t.pubIdKept(createdId)}</p>}
        {links}
      </div>
    );
  }
  if (final.type === 'start-failed') {
    return (
      <div data-testid="pub-result" data-result="start-failed" data-code={final.reason}>
        <div className="banner warn">{final.reason === 'busy' ? t.pubBusy : t.pubStartFailed(final.reason)}</div>
      </div>
    );
  }
  return (
    <div data-testid="pub-result" data-result="error" data-code={final.code}>
      <h4 className="danger">{t.pubFailed}</h4>
      <div className="banner warn">{uiText(PUBLISH_ERROR_TEXTS[final.code], lang)}</div>
      {final.detail !== undefined && <pre className="muted small publish-detail">{final.detail}</pre>}
      {createdId !== undefined && <p>{t.pubIdKept(createdId)}</p>}
      {links}
    </div>
  );
}
