// FILE: file-icons.ts
// Purpose: Resolve CDN URLs for file/folder icons using the Seti UI icon theme.
// Layer: app-level utility shared by composer, diff panel, timeline, sidebar.
// Depends on: jsDelivr serving the jesseweed/seti-ui repository.

const SETI_ICONS_BRANCH = "master";
const SETI_ICONS_BASE_URL = `https://cdn.jsdelivr.net/gh/jesseweed/seti-ui@${SETI_ICONS_BRANCH}/icons`;

const DEFAULT_FILE_ICON = "default";
const DEFAULT_FOLDER_ICON = "folder";

// Exact basename → Seti icon name (case-insensitive lookup). Add entries here
// when a well-known filename has a dedicated Seti icon we want to surface.
const FILE_ICON_BY_BASENAME: Record<string, string> = {
  "package.json": "npm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  ".npmrc": "npm",
  ".npmignore": "npm",
  "yarn.lock": "yarn",
  ".yarnrc": "yarn",
  ".yarnrc.yml": "yarn",
  "pnpm-lock.yaml": "npm",
  "pnpm-workspace.yaml": "npm",
  "bun.lockb": "npm",
  "bun.lock": "npm",
  "bower.json": "bower",
  ".bowerrc": "bower",
  "gruntfile.js": "grunt",
  "gruntfile.ts": "grunt",
  "gulpfile.js": "gulp",
  "gulpfile.ts": "gulp",
  "webpack.config.js": "webpack",
  "webpack.config.ts": "webpack",
  "rollup.config.js": "rollup",
  "rollup.config.ts": "rollup",
  "rollup.config.mjs": "rollup",
  dockerfile: "docker",
  ".dockerignore": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "docker-compose.override.yml": "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".gitconfig": "git",
  ".eslintrc": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.yml": "eslint",
  ".eslintrc.yaml": "eslint",
  ".eslintignore": "eslint",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.cjs": "eslint",
  "eslint.config.ts": "eslint",
  ".prettierrc": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.yml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierignore": "prettier",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
  "prettier.config.cjs": "prettier",
  ".stylelintrc": "stylelint",
  ".stylelintrc.json": "stylelint",
  "stylelint.config.js": "stylelint",
  ".babelrc": "babel",
  ".babelrc.js": "babel",
  ".babelrc.json": "babel",
  "babel.config.js": "babel",
  "babel.config.json": "babel",
  "babel.config.ts": "babel",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  "readme.md": "markdown",
  "tsconfig.json": "typescript",
  "tsconfig.base.json": "typescript",
  "tsconfig.build.json": "typescript",
  "tsconfig.node.json": "typescript",
  "tsconfig.eslint.json": "typescript",
  "go.mod": "go",
  "go.sum": "go",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "requirements.txt": "python",
  pipfile: "python",
  "pyproject.toml": "python",
  "setup.py": "python",
  "setup.cfg": "python",
  gemfile: "ruby",
  "gemfile.lock": "ruby",
  rakefile: "ruby",
  "package.swift": "swift",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "kotlin",
  "settings.gradle": "java",
  "settings.gradle.kts": "kotlin",
  ".editorconfig": "settings",
  ".env": "settings",
  ".env.local": "settings",
  ".env.development": "settings",
  ".env.production": "settings",
  ".env.test": "settings",
  ".env.example": "settings",
  "firebase.json": "firebase",
  ".firebaserc": "firebase",
  procfile: "heroku",
};

// Extension → Seti icon name. Longest extension wins because `extensionCandidates`
// yields compound extensions first (e.g. `.d.ts` before `.ts`).
const FILE_ICON_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "react",
  "d.ts": "typescript",
  js: "javascript",
  jsx: "react",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  mdc: "markdown",
  markdown: "markdown",
  yml: "yml",
  yaml: "yml",
  toml: "settings",
  ini: "settings",
  conf: "settings",
  cfg: "settings",
  env: "settings",
  html: "html",
  htm: "html",
  xhtml: "html",
  pug: "pug",
  jade: "pug",
  ejs: "ejs",
  twig: "twig",
  slim: "slim",
  mustache: "mustache",
  hbs: "mustache",
  handlebars: "mustache",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  styl: "stylus",
  stylus: "stylus",
  xml: "xml",
  svg: "svg",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  pyc: "python",
  pyi: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  php: "php",
  phtml: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  hpp: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "c-sharp",
  fs: "f-sharp",
  fsx: "f-sharp",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  scala: "scala",
  sbt: "scala",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  lhs: "haskell",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  ml: "ocaml",
  mli: "ocaml",
  elm: "elm",
  dart: "dart",
  jl: "julia",
  cr: "crystal",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  graphql: "graphql",
  gql: "graphql",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
  tex: "tex",
  bib: "tex",
  jinja: "jinja",
  jinja2: "jinja",
  dockerfile: "docker",
  lock: "lock",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "favicon",
  bmp: "image",
  tiff: "image",
  avif: "image",
};

// Seti ships a single `folder.svg` on the master branch; it has no per-name
// folder variants, so every directory resolves to the default here. The map
// exists so we can opportunistically add overrides later without touching
// callers.
const FOLDER_ICON_BY_BASENAME: Record<string, string> = {};

export function basenameOfPath(pathValue: string): string {
  const slashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  if (slashIndex === -1) return pathValue;
  return pathValue.slice(slashIndex + 1);
}

function pathLooksLikeKnownFile(pathValue: string): boolean {
  const basename = basenameOfPath(pathValue).toLowerCase();
  if (FILE_ICON_BY_BASENAME[basename]) {
    return true;
  }
  return extensionCandidates(basename).some((candidate) => FILE_ICON_BY_EXTENSION[candidate]);
}

export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  const base = basenameOfPath(pathValue);
  if (pathLooksLikeKnownFile(pathValue)) {
    return "file";
  }
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return "directory";
  }
  if (base.includes(".")) {
    return "file";
  }
  return "directory";
}

function extensionCandidates(fileName: string): string[] {
  const candidates: string[] = [];
  let dotIndex = fileName.indexOf(".");
  while (dotIndex !== -1 && dotIndex < fileName.length - 1) {
    const candidate = fileName.slice(dotIndex + 1);
    if (candidate.length > 0) candidates.push(candidate);
    dotIndex = fileName.indexOf(".", dotIndex + 1);
  }
  return candidates;
}

function resolveFileIconName(pathValue: string): string {
  const basename = basenameOfPath(pathValue).toLowerCase();
  const byName = FILE_ICON_BY_BASENAME[basename];
  if (byName) return byName;
  for (const candidate of extensionCandidates(basename)) {
    const byExt = FILE_ICON_BY_EXTENSION[candidate];
    if (byExt) return byExt;
  }
  return DEFAULT_FILE_ICON;
}

function resolveFolderIconName(pathValue: string): string {
  const basename = basenameOfPath(pathValue).toLowerCase();
  return FOLDER_ICON_BY_BASENAME[basename] ?? DEFAULT_FOLDER_ICON;
}

// `theme` is accepted for signature compatibility with call sites. Seti renders
// a single colored variant that reads fine on both light and dark backgrounds,
// so we ignore it here.
export function getFileIconUrlForEntry(
  pathValue: string,
  kind: "file" | "directory",
  _theme: "light" | "dark",
): string {
  const iconName =
    kind === "directory" ? resolveFolderIconName(pathValue) : resolveFileIconName(pathValue);
  return `${SETI_ICONS_BASE_URL}/${iconName}.svg`;
}
