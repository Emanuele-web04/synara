import type { ReactElement } from "react";
import { Trans } from "react-i18next";

import { i18n, useTranslation } from "./index";

/** Localized sentences with named React slots; interpolated data remains plain text. */
export function Translation({
  message,
  values,
  components,
}: {
  message: string;
  values?: Record<string, unknown>;
  components?: Record<string, ReactElement>;
}) {
  const { locale } = useTranslation();
  // Trans parses slot markup after translation. Escape data before that parse,
  // then decode only text nodes so user values cannot become component slots.
  return (
    <Trans
      i18n={i18n}
      t={i18n.getFixedT(locale)}
      i18nKey={message}
      tOptions={{ interpolation: { escapeValue: true } }}
      shouldUnescape
      {...(values ? { values } : {})}
      {...(components ? { components } : {})}
    />
  );
}
