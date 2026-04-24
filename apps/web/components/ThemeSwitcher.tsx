import React, { useState, useRef, useEffect } from 'react';
import { useTheme, THEMES } from '../hooks/useTheme';

export function ThemeSwitcher() {
  const { theme, setTheme, mounted } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!mounted) return <div style={{ width: '30px', height: '30px' }} />; // Placeholder to prevent layout shift

  const currentTheme = THEMES.find(t => t.id === theme) || THEMES[0];

  return (
    <div className="relative" ref={dropdownRef} style={{ position: 'relative' }}>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center p-2"
        style={{ 
          background: isOpen ? 'var(--bg-hover-subtle)' : 'transparent',
          border: 'none',
          color: isOpen ? 'var(--text-main)' : 'var(--text-muted)',
          cursor: 'pointer',
          borderRadius: '0.5rem',
          transition: 'all 0.3s ease',
        }}
        onMouseEnter={(e) => { 
          if (!isOpen) {
            e.currentTarget.style.background = 'var(--bg-hover-subtle)'; 
          }
        }}
        onMouseLeave={(e) => { 
          if (!isOpen) {
            e.currentTarget.style.background = 'transparent'; 
          }
        }}
        title="切换主题"
      >
        <div style={{ width: '14px', height: '14px', borderRadius: '50%', background: currentTheme.color, boxShadow: `0 0 8px ${currentTheme.color}80` }} />
      </button>

      {isOpen && (
        <div 
          className="panel absolute bottom-full left-0 mb-2 p-2 animate-fade-in" 
          style={{ width: '180px', zIndex: 100, left: '0' }}
        >
          <div className="text-xs font-bold text-slate-500 mb-2 px-2" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>主题设置 / Themes</div>
          <div className="space-y-1">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTheme(t.id);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-3 text-sm p-2"
                style={{
                  borderRadius: '0.5rem',
                  background: theme === t.id ? 'var(--accent-cyan-bg)' : 'transparent',
                  color: theme === t.id ? 'var(--text-main)' : 'var(--text-muted)',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => { if(theme !== t.id) { e.currentTarget.style.background = 'var(--bg-hover-subtle)'; e.currentTarget.style.color = 'var(--text-main)' } }}
                onMouseLeave={(e) => { if(theme !== t.id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' } }}
              >
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: t.color, boxShadow: `0 0 6px ${t.color}80` }} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
