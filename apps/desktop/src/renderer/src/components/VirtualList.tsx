/**
 * Список с виртуальной прокруткой: строки одной высоты, в DOM — только видимые (плюс запас).
 * Держит десятки тысяч записей без задержек.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: readonly T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  /** Индекс строки, которую надо держать видимой (выбранная). */
  scrollToIndex?: number;
  className?: string;
  testId?: string;
  /** Ширина полосы прокрутки (0 — её нет): шапка над списком добавляет её справа, чтобы колонки совпадали. */
  onGutter?: (width: number) => void;
}

const OVERSCAN = 8;

export function VirtualList<T>({ items, rowHeight, renderRow, scrollToIndex, className, testId, onGutter }: Props<T>): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const gutterRef = useRef(onGutter);
  gutterRef.current = onGutter;
  const indexRef = useRef(scrollToIndex);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  indexRef.current = scrollToIndex;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      // Moving the list in the DOM (dockview re-parents panels on layout changes) resets scrollTop
      // without a scroll event; resync from the element so rows are rendered for the real position.
      const i = indexRef.current;
      if (el.scrollTop === 0 && i !== undefined && i >= 0 && el.clientHeight > 0) {
        const top = i * rowHeightRef.current;
        if (top + rowHeightRef.current > el.clientHeight) el.scrollTop = top + rowHeightRef.current - el.clientHeight;
      }
      setScrollTop(el.scrollTop);
      setHeight(el.clientHeight);
      gutterRef.current?.(el.offsetWidth - el.clientWidth);
    };
    // Полоса появляется и исчезает вместе с числом строк: следим и за самим списком, и за его содержимым.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    measure();
    return () => {
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || scrollToIndex === undefined || scrollToIndex < 0) return;
    const top = scrollToIndex * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [scrollToIndex, rowHeight]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div key={i} className="vrow" style={{ top: i * rowHeight, height: rowHeight }}>
        {renderRow(items[i]!, i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      data-testid={testId}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop);
      }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
