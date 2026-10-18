import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import en from './locales/en';
import kn from './locales/kn';
import tcy from './locales/tcy';
import type { LanguageCode, TranslationKey } from './types';

const LANGUAGE_STORAGE_KEY = '@karavali-fresh/language';

type LanguageContextValue = {
  language: LanguageCode;
  isLanguageLoaded: boolean;
  setLanguage: (language: LanguageCode) => void;
  t: (key: TranslationKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function isLanguageCode(value: string | null): value is LanguageCode {
  return value === 'en' || value === 'kn' || value === 'tcy';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setCurrentLanguage] = useState<LanguageCode>('en');
  const [isLanguageLoaded, setIsLanguageLoaded] = useState(false);
  const userChangedLanguage = useRef(false);
  const pendingWrite = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;

    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((storedLanguage) => {
        if (active && !userChangedLanguage.current && isLanguageCode(storedLanguage)) {
          setCurrentLanguage(storedLanguage);
        }
      })
      .catch(() => {
        // English remains available if local storage cannot be read.
      })
      .finally(() => {
        if (active) setIsLanguageLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const setLanguage = useCallback((nextLanguage: LanguageCode) => {
    userChangedLanguage.current = true;
    setCurrentLanguage(nextLanguage);
    pendingWrite.current = pendingWrite.current
      .then(() => AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage))
      .catch(() => {
        // Keep the in-memory selection even if persistence is temporarily unavailable.
      });
  }, []);

  const t = useCallback(
    (key: TranslationKey) => {
      if (language === 'kn') return kn[key] ?? en[key];
      if (language === 'tcy') return tcy[key] ?? en[key];
      return en[key];
    },
    [language]
  );

  return (
    <LanguageContext.Provider value={{ language, isLanguageLoaded, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used inside LanguageProvider');
  return context;
}
