import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

const locale = import.meta.env.VITE_LOCALE || "en";

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: locale,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // React 已经处理了 XSS
  },
});

export default i18n;
