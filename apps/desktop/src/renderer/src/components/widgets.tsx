/**
 * Small elements: an input with confirmation (Enter/leaving the field — apply, Esc —
 * cancel) and a modal window.
 */
import { useEffect, useState, type ReactNode } from 'react';

interface CommitInputProps {
  value: string;
  onCommit: (text: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  testId?: string;
  title?: string;
}

export function CommitInput({ value, onCommit, disabled, multiline, className, placeholder, testId, title }: CommitInputProps): ReactNode {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = (): void => {
    if (draft === value) return;
    onCommit(draft);
    setDraft(value);
  };
  const common = {
    value: draft,
    disabled,
    className,
    placeholder,
    title,
    'data-testid': testId,
    onBlur: commit,
  };
  if (multiline) {
    return (
      <textarea
        {...common}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) commit();
          else if (e.key === 'Escape') setDraft(value);
        }}
      />
    );
  }
  return (
    <input
      {...common}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}

export function Modal({ title, onClose, children, footer, wide, testId }: ModalProps): ReactNode {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} data-testid={testId} role="dialog">
        <div className="modal-title">
          <span>{title}</span>
          <button className="small" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
