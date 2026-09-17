import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LOCALES, STORAGE_KEY, detectLocale, translate } from './messages.js';
// The catalogue lib/ writes its message references into. It is imported from outside this app on
// purpose: the same reference has to render identically here and in the CLI, and the published
// dashboard bundle carries its own copy of this module, so nothing is fetched at runtime.
import { renderMessages, translate as translateShared } from '../../../../lib/messages.mjs';

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
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
      // Some of what this page shows originates in lib/ as a message reference rather than a sentence,
      // because the server that builds the payload cannot know which language this client is showing.
      // It is rendered here, in the same locale, out of the catalogue those references were written
      // against.
      shared: (input) => renderMessages(input, (key, params) => translateShared(locale, key, params)),
    }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
