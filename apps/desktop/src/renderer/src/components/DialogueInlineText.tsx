/** Editing a line text in place (a graph node or a tree row): Enter — save, Shift+Enter — new line, Esc — cancel; leaving the field saves. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n.ts';

export function InlineText({ value, onCommit, onCancel }: { value: string; onCommit: (text: string) => void; onCancel: () => void }): ReactNode {
  const t = useT();
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (save) onCommit(text);
    else onCancel();
  };
  return (
    <>
      <textarea
        ref={ref}
        className="dg-edit nodrag nowheel nopan"
        data-testid="dg-edit"
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => {
          finish(true);
        }}
      />
      <div className="dg-edit-hint muted small">{t.dgEditHint}</div>
    </>
  );
}
