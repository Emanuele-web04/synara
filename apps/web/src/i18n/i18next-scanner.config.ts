const config = {
  input: ["../src/**/*.{ts,tsx}"],
  output: "./",
  options: {
    debug: false,
    removeUnusedKeys: false,
    sort: true,
    failOnUpdate: false,
    failOnWarnings: false,
    keySeparator: ".",
    nsSeparator: false,
    defaultValue: "",
    lngs: ["en"],
    ns: ["translation"],
    defaultNs: "translation",
    resource: {
      loadPath: "locales/{{lng}}.json",
      savePath: "locales/{{lng}}.json",
      jsonIndent: 2,
    },
    interpolation: {
      prefix: "{{",
      suffix: "}}",
    },
  },
  transform: function customTransform(
    this: {
      parser: { parseFuncFromString: (content: string, callback: (key: string) => void) => void };
      set: (key: string, value: string) => void;
    },
    file: { path: string; contents: string },
    done: () => void,
  ) {
    this.parser.parseFuncFromString(file.contents, (key: string) => {
      this.set(key, key);
    });
    done();
  },
};

export default config;
