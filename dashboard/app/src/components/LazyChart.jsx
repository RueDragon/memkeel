import React, { Suspense } from 'react';
import { Spin } from 'antd';

// ECharts is the heaviest dependency and only a few views use it. Lazy-loading keeps
// the initial bundle small so tables render fast on first paint.
const ReactECharts = React.lazy(() => import('echarts-for-react'));

export default function LazyChart({ option, height = 260, onEvents }) {
  return (
    <Suspense fallback={<div style={{ height, display: 'grid', placeItems: 'center' }}><Spin /></div>}>
      <ReactECharts
        option={option}
        style={{ height }}
        notMerge
        lazyUpdate
        onEvents={onEvents}
      />
    </Suspense>
  );
}