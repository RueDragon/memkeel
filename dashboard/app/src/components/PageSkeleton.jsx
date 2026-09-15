import React from 'react';

// Skeleton shaped like the panels it replaces, so the first paint reserves the real
// layout instead of flashing a centred spinner and then jumping.
export default function PageSkeleton() {
  return (
    <div className="view-enter">
      <div className="skeleton-panel" style={{ marginBottom: 12 }}>
        <div className="skeleton-line" style={{ width: '22%', height: 18, marginBottom: 14 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton-line" style={{ width: '52%', marginBottom: 8 }} />
              <div className="skeleton-line" style={{ width: '34%', height: 20 }} />
            </div>
          ))}
        </div>
      </div>
      <div className="skeleton-panel">
        <div className="skeleton-line" style={{ width: '16%', height: 16, marginBottom: 16 }} />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton-line" style={{ width: `${88 - (i % 3) * 12}%`, marginBottom: 11 }} />
        ))}
      </div>
    </div>
  );
}
