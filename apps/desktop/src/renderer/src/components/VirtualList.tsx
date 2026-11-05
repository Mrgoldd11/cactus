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
}

const OVERSCAN = 8;

export function VirtualList<T>({ items, rowHeight, renderRow, scrollToIndex, className, testId }: Props<T>): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    setHeight(el.clientHeight);
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
