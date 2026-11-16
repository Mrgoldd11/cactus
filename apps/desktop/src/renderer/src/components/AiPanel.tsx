/**
 * «AI changes»: change sets sent by the AI over the live link (MCP →
 * connect_editor → edit). Each is already applied in the window; it can be accepted or reverted.
 */
import type { ReactNode } from 'react';
import { decodeText, formatRecordDiff, type HostedChangeset } from '@kenshi-editor/core';
import type { LiveStatus } from '../../../shared/api.ts';
import { useLang, useT } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import { liveHost } from '../live.ts';
import type { Project } from '../project.ts';

interface Props {
  project: Project;
  changesets: readonly HostedChangeset[];
  status: LiveStatus;
  onGo: (sid: string) => void;
  onReport: (err: string | undefined) => void;
}

export function AiPanel({ project, changesets, status, onGo, onReport }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const list = [...changesets].reverse();
  return (
    <div className="ai-panel" data-testid="ai-panel">
      <div className="ai-conn muted" data-testid="ai-conn">
        {status.error !== undefined
          ? `${t.aiServerFailed}: ${status.error}`
          : status.port === undefined
            ? t.aiServerOff
            : status.clients.length > 0
              ? `${t.aiConnected}: ${status.clients.map((c) => c.name).join(', ')}`
              : t.aiWaiting}
      </div>
      {list.length === 0 && <p className="muted ai-empty">{t.aiNone}</p>}
      <div className="ai-list">
        {list.map((c) => (
          <div key={c.id} className={`ai-card ${c.status}`} data-testid="ai-changeset" data-status={c.status}>
            <div className="ai-card-head">
              <span className="ai-title">
                #{c.id} {c.title}
              </span>
              <span className={`ai-badge ${c.status}`}>{t[`aiStatus_${c.status}`]}</span>
            </div>
            <div className="muted ai-time">{new Date(c.at).toLocaleTimeString()}</div>
            {c.diffs.map((d) => {
              const [, ...fields] = formatRecordDiff(project.ctx, d, lang);
              const e = project.entry(d.stringId);
              const rec = d.after ?? d.before;
              return (
                <div key={d.stringId} className="ai-rec">
                  <button className={`link ai-rec-link ${d.change}`} onClick={() => { onGo(d.stringId); }} data-sid={d.stringId}>
                    {d.change === 'added' ? '+' : d.change === 'removed' ? '−' : '~'} {e?.localized || e?.name || (rec ? decodeText(rec.name) : d.stringId)}
                  </button>
                  {fields.length > 0 && <pre className="ai-fields">{fields.map((f) => f.trim()).join('\n')}</pre>}
                </div>
              );
            })}
            {(c.status === 'pending' || c.status === 'accepted') && (
              <div className="ai-actions">
                {c.status === 'pending' && (
                  <button
                    className="primary"
                    data-testid="ai-accept"
                    onClick={() => {
                      liveHost.accept(c.id);
                    }}
                  >
                    {t.aiAccept}
                  </button>
                )}
                <button
                  data-testid="ai-rollback"
                  onClick={() => {
                    onReport(
                      tryEdit(() => {
                        liveHost.rollback(c.id);
                      }),
                    );
                  }}
                >
                  {t.aiRollback}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
