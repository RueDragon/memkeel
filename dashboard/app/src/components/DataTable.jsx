import React, { useMemo, useState } from 'react';
import { Table, Input, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

// Bridge between the table views and Ant Design.
//
// Division of labour, kept deliberately simple after two rounds of pagination bugs:
//   - Ant Design owns sorting, paging and rendering. It already does all three well.
//   - We own the global text filter and the per-container width fitting.
// Mixing a second paginator (TanStack) into a controlled Ant Table made page clicks
// update state in one library while the other kept rendering page 1.
export default function DataTable({
  columns,
  data,
  onRowClick,
  pageSize = 10,
  searchable = true,
  searchPlaceholder = '筛选…',
  rowKey,
  extra,
  scrollY,
  minColumnWidth = 72,
}) {
  const [globalFilter, setGlobalFilter] = useState('');
  const [sortState, setSortState] = useState({});
  const [page, setPage] = useState(1);
  const [pageSizeState, setPageSizeState] = useState(pageSize);
  const [containerW, setContainerW] = useState(0);
  const boxRef = React.useRef(null);

  React.useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => {
      const table = el.querySelector('.ant-table-content, .ant-table-body');
      // clientWidth excludes the scrollbar but includes padding; subtract the table's
      // own horizontal padding so the fitted column sum matches the drawable row.
      const target = table ?? el;
      const style = getComputedStyle(target);
      const pad = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
      setContainerW(Math.max(0, target.clientWidth - pad));
    };
    measure();
    // Re-measure once after fonts and the table chrome settle; the first paint can be
    // a few pixels off, which is enough to trip a horizontal scrollbar.
    const raf = requestAnimationFrame(measure);
    const timer = setTimeout(measure, 120);
    if (typeof ResizeObserver === 'undefined') return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); ro.disconnect(); };
  }, []);

  const filtered = useMemo(() => {
    if (!globalFilter.trim()) return data;
    const needle = globalFilter.trim().toLowerCase();
    return data.filter((row) => Object.values(row).some((v) => {
      if (v == null) return false;
      if (typeof v === 'object') return JSON.stringify(v).toLowerCase().includes(needle);
      return String(v).toLowerCase().includes(needle);
    }));
  }, [data, globalFilter]);

  const sorted = useMemo(() => {
    const { key, order } = sortState;
    if (!key || !order) return filtered;
    const col = columns.find((c) => (c.key ?? c.dataIndex) === key);
    const dataIndex = col?.dataIndex ?? key;
    const dir = order === 'ascend' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[dataIndex];
      const bv = b[dataIndex];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? ''), 'zh') * dir;
    });
  }, [filtered, sortState, columns]);

  // Declared widths are treated as ratios. When they fit, they become percentages so
  // Ant sizes them against its own content box with no measurement race; only when the
  // columns would get unusably thin do we fall back to fixed pixels plus h-scroll.
  const weights = columns.map((c) => c.width ?? 160);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const needsScroll = containerW > 0 && containerW < columns.length * minColumnWidth;
  const fitted = useMemo(() => {
    if (!containerW || needsScroll) return weights.map(() => undefined);
    return weights.map((w) => `${((w / weightSum) * 100).toFixed(4)}%`);
  }, [weights, weightSum, containerW, needsScroll]);

  const antColumns = useMemo(() => columns.map((c, i) => ({
    key: c.key ?? c.dataIndex,
    title: c.title,
    dataIndex: c.dataIndex,
    width: fitted[i] ?? c.width,
    align: c.align,
    ellipsis: c.ellipsis ?? false,
    sorter: c.sorter !== false && c.sortable !== false && !!c.dataIndex,
    sortOrder: (c.key ?? c.dataIndex) === sortState.key ? sortState.order : null,
    render: c.render ? (_v, record) => c.render(record[c.dataIndex], record) : undefined,
  })), [columns, fitted, sortState]);

  return (
    <div ref={boxRef}>
      {(searchable || extra) && (
        <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
          {searchable
            ? <Input
                allowClear
                prefix={<SearchOutlined />}
                placeholder={searchPlaceholder}
                value={globalFilter}
                onChange={(e) => { setGlobalFilter(e.target.value); setPage(1); }}
                style={{ width: 280 }}
              />
            : <span />}
          {extra}
        </Space>
      )}
      <Table
        size="middle"
        tableLayout="fixed"
        rowKey={rowKey ?? ((record) => JSON.stringify(record))}
        columns={antColumns}
        dataSource={sorted}
        pagination={{
          current: page,
          pageSize: pageSizeState,
          showSizeChanger: true,
          size: 'small',
          showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
          pageSizeOptions: ['10', '20', '50', '100'],
          onShowSizeChange: (_cur, size) => { setPageSizeState(size); setPage(1); },
        }}
        onChange={(pagination, _filters, sorter) => {
          if (pagination?.pageSize && pagination.pageSize !== pageSizeState) {
            setPageSizeState(pagination.pageSize);
            setPage(1);
          } else if (pagination?.current && pagination.current !== page) {
            setPage(pagination.current);
          }
          const id = sorter?.columnKey ?? sorter?.field;
          if (!id) { setSortState({}); return; }
          setSortState({ key: id, order: sorter.order });
        }}
        // Only declare scroll.x when the columns genuinely cannot fit. Passing a pixel
        // width that merely rounds up past the container is what produced a horizontal
        // scrollbar on tables that visually had room.
        scroll={needsScroll ? { x: weightSum, y: scrollY ?? 'calc(100vh - 320px)' } : { y: scrollY ?? 'calc(100vh - 320px)' }}
        onRow={(record) => ({
          onClick: onRowClick ? () => onRowClick(record) : undefined,
          className: onRowClick ? 'row-clickable' : undefined,
        })}
      />
    </div>
  );
}
