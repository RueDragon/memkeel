import React, { useEffect, useState } from 'react';
import { VerticalAlignTopOutlined } from '@ant-design/icons';

// Some panes are much taller than their viewport — 对话回溯 deliberately opens a session
// at its newest checkpoint, so the pane starts scrolled to the bottom. This rides inside
// the scroll container as its last child, where `position: sticky; bottom` pins it to the
// bottom-right of whatever is visible, and it only appears once the pane is actually
// scrolled away from the top.
export default function ScrollToTop({ targetRef, offset = 200, label = '回到最上方' }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = targetRef?.current;
    if (!el) return undefined;
    const onScroll = () => setShown(el.scrollTop > offset);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [targetRef, offset]);

  if (!shown) return null;
  return (
    <button
      type="button"
      className="scroll-top"
      title={label}
      aria-label={label}
      onClick={() => targetRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <VerticalAlignTopOutlined />
    </button>
  );
}
