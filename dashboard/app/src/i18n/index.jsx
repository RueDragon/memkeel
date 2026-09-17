import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LOCALES, STORAGE_KEY, detectLocale, translate } from './messages.js';

const I18nContext = createContext(null);

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable or blocked; the choice then simply does not persist.
    return null;
  }
}

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(() => detectLocale(readStored(), typeof navigator === 'undefined' ? '' : navigator.language));

  const setLocale = useCallback((next) => {
    if (!LOCALES.includes(next)) return;
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same as above: switching still works for this session.
    }
  }, []);

  // Keeps the document language in step, which assistive technology and the browser's own
  // hyphenation and font fallback both read.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
