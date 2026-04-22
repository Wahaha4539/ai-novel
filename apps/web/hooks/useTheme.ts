import { useState, useEffect } from 'react';

export type ThemeType = 'theme-cyberpunk' | 'theme-light' | 'theme-matrix';

export const THEMES: { id: ThemeType; label: string; color: string }[] = [
  { id: 'theme-cyberpunk', label: '深空暗影 (Cyberpunk)', color: '#06b6d4' },
  { id: 'theme-light', label: '晨曦琉璃 (Light)', color: '#3b82f6' },
  { id: 'theme-matrix', label: '矩阵之眼 (Matrix)', color: '#22c55e' },
];

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeType>('theme-cyberpunk');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedTheme = localStorage.getItem('app-theme') as ThemeType;
    if (savedTheme && THEMES.some(t => t.id === savedTheme)) {
      setThemeState(savedTheme);
      document.body.className = savedTheme;
    } else {
      document.body.className = 'theme-cyberpunk';
    }
  }, []);

  const setTheme = (newTheme: ThemeType) => {
    setThemeState(newTheme);
    localStorage.setItem('app-theme', newTheme);
    document.body.className = newTheme;
  };

  return { theme, setTheme, mounted };
}
