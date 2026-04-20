import { assert, describe, it } from "vitest";

import { getFileIconUrlForEntry, inferEntryKindFromPath } from "./file-icons";

describe("getFileIconUrlForEntry", () => {
  it("uses exact filename matches from the Seti mapping", () => {
    const packageJsonUrl = getFileIconUrlForEntry("package.json", "file", "dark");
    const dockerfileUrl = getFileIconUrlForEntry("Dockerfile", "file", "dark");
    const tsconfigUrl = getFileIconUrlForEntry("tsconfig.json", "file", "dark");
    const gitignoreUrl = getFileIconUrlForEntry(".gitignore", "file", "dark");

    assert.isTrue(packageJsonUrl.endsWith("/npm.svg"));
    assert.isTrue(dockerfileUrl.endsWith("/docker.svg"));
    assert.isTrue(tsconfigUrl.endsWith("/typescript.svg"));
    assert.isTrue(gitignoreUrl.endsWith("/git.svg"));
  });

  it("prefers the longest compound extension", () => {
    const tsxUrl = getFileIconUrlForEntry("checkbox.tsx", "file", "light");
    const dtsUrl = getFileIconUrlForEntry("types.d.ts", "file", "dark");
    const tsUrl = getFileIconUrlForEntry("logic.ts", "file", "dark");

    assert.isTrue(tsxUrl.endsWith("/react.svg"));
    assert.isTrue(dtsUrl.endsWith("/typescript.svg"));
    assert.isTrue(tsUrl.endsWith("/typescript.svg"));
  });

  it("resolves common language extensions", () => {
    assert.isTrue(getFileIconUrlForEntry("main.py", "file", "dark").endsWith("/python.svg"));
    assert.isTrue(getFileIconUrlForEntry("lib.rs", "file", "dark").endsWith("/rust.svg"));
    assert.isTrue(getFileIconUrlForEntry("main.go", "file", "dark").endsWith("/go.svg"));
    assert.isTrue(getFileIconUrlForEntry("index.html", "file", "dark").endsWith("/html.svg"));
    assert.isTrue(getFileIconUrlForEntry("styles.scss", "file", "dark").endsWith("/sass.svg"));
    assert.isTrue(getFileIconUrlForEntry("entrypoint.sh", "file", "dark").endsWith("/shell.svg"));
    assert.isTrue(getFileIconUrlForEntry("readme.md", "file", "dark").endsWith("/markdown.svg"));
    assert.isTrue(getFileIconUrlForEntry("general.mdc", "file", "dark").endsWith("/markdown.svg"));
    assert.isTrue(
      getFileIconUrlForEntry(".github/workflows/ci.yml", "file", "light").endsWith("/yml.svg"),
    );
  });

  it("maps directories to the generic folder icon", () => {
    const folderUrl = getFileIconUrlForEntry("packages/src", "directory", "light");
    const nestedUrl = getFileIconUrlForEntry("apps/web", "directory", "dark");

    assert.isTrue(folderUrl.endsWith("/folder.svg"));
    assert.isTrue(nestedUrl.endsWith("/folder.svg"));
  });

  it("falls back to defaults when there is no match", () => {
    const fileUrl = getFileIconUrlForEntry("foo.unknown-ext", "file", "dark");
    const plainUrl = getFileIconUrlForEntry("notes", "file", "dark");

    assert.isTrue(fileUrl.endsWith("/default.svg"));
    assert.isTrue(plainUrl.endsWith("/default.svg"));
  });

  it("is case insensitive on basename lookup", () => {
    const upperUrl = getFileIconUrlForEntry("PACKAGE.JSON", "file", "dark");
    const mixedUrl = getFileIconUrlForEntry("DockerFile", "file", "dark");

    assert.isTrue(upperUrl.endsWith("/npm.svg"));
    assert.isTrue(mixedUrl.endsWith("/docker.svg"));
  });

  it("treats known extensionless basenames as files", () => {
    assert.equal(inferEntryKindFromPath("Dockerfile"), "file");
    assert.equal(inferEntryKindFromPath("LICENSE"), "file");
    assert.equal(inferEntryKindFromPath("Gemfile"), "file");
    assert.equal(inferEntryKindFromPath("C:\\repo\\Dockerfile"), "file");
    assert.equal(inferEntryKindFromPath("scripts"), "directory");
  });
});
