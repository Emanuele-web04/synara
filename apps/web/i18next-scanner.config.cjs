// FILE: i18next-scanner.config.js
// Purpose: i18next-scanner configuration for extracting translation keys
//   from apps/web/src source files. Run via: bun run scan-i18n
// Layer: Web build tooling

// @ts-check

/** @type {import("i18next-scanner").Options} */
module.exports = {
  input: ["src/**/*.{ts,tsx}"],
  output: "./",
  options: {
    debug: false,
    removeUnusedKeys: false,
    sort: true,
    failOnUpdate: false,
    failOnWarnings: false,
    keySeparator: ".",
    nsSeparator: false,
    defaultValue: "__MISSING__",
    lngs: ["en", "zh-CN"],
    ns: ["translation"],
    defaultNs: "translation",
    resource: {
      loadPath: "src/i18n/locales/{{lng}}.json",
      savePath: "src/i18n/locales/{{lng}}.json",
      jsonIndent: 2,
    },
    interpolation: {
      prefix: "{{",
      suffix: "}}",
    },
  },
  transform: function customTransform(file, enc, done) {
    const { parser } = this;
    const content = file.contents.toString("utf-8");
    parser.parseFuncFromString(content, { list: ["t"] }, (key) => {
      // Use the key as its own default value during extraction
      parser.set(key, key);
    });
    done();
  },
};
