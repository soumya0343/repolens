import React, { useState, useRef } from 'react';

interface TooltipProps {
  text: string;
  children?: React.ReactNode;
  position?: 'top' | 'bottom' | 'right';
}

const Tooltip: React.FC<TooltipProps> = ({ text, children, position = 'top' }) => {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  const tipStyle: React.CSSProperties = {
    position: 'absolute',
    zIndex: 9999,
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-bright)',
    borderRadius: 4,
    padding: '6px 10px',
    fontFamily: 'var(--sans)',
    fontSize: '0.72rem',
    color: 'var(--text)',
    lineHeight: 1.4,
    whiteSpace: 'normal',
    width: 220,
    pointerEvents: 'none',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    ...(position === 'top'    && { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }),
    ...(position === 'bottom' && { top:    'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }),
    ...(position === 'right'  && { left:   'calc(100% + 8px)', top: '50%',  transform: 'translateY(-50%)' }),
  };

  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children ?? (
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          border: '1px solid var(--border-bright)',
          fontFamily: 'var(--sans)', fontSize: '0.6rem', fontWeight: 700,
          color: 'var(--text-muted)', cursor: 'default', flexShrink: 0,
          lineHeight: 1,
        }}>?</span>
      )}
      {visible && <span style={tipStyle}>{text}</span>}
    </span>
  );
};

export default Tooltip;
