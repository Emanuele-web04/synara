import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

const isomorphicLocalStorage =
  typeof window !== "undefined"
    ? window.localStorage
    : {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      };

const storedLocale = (() => {
  try {
    const raw = isomorphicLocalStorage.getItem("synara:app-settings:v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.locale === "en" || parsed.locale === "zh-CN") return parsed.locale;
    }
  } catch {}
  return import.meta.env.VITE_LOCALE || "en";
})();

i18n.use(initReactI18next).init({
  lng: storedLocale,
  fallbackLng: "en",
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  interpolation: {
    escapeValue: false, // React 已经处理了 XSS
  },
});

export default i18n;
