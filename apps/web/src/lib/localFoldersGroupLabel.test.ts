import { describe, expect, it } from "vitest";
import { getLocalFoldersGroupLabel } from "./localFoldersGroupLabel";

describe("getLocalFoldersGroupLabel", () => {
  it("recognizes Windows home directories", () => {
    expect(getLocalFoldersGroupLabel("C:\\Users\\tester", "Linux x86_64")).toBe(
      "Folders on this PC",
    );
    expect(getLocalFoldersGroupLabel("\\\\server\\users\\tester", "")).toBe("Folders on this PC");
  });

  it("recognizes macOS home directories before browser platform hints", () => {
    expect(getLocalFoldersGroupLabel("/Users/tester", "Win32")).toBe("Folders on this Mac");
  });

  it("keeps non-macOS server paths neutral despite conflicting browser hints", () => {
    expect(getLocalFoldersGroupLabel("/home/alice", "Win32")).toBe("Folders on this System");
    expect(getLocalFoldersGroupLabel("/home/alice", "MacIntel")).toBe("Folders on this System");
  });

  it("treats only case-sensitive /Users paths as macOS homes", () => {
    expect(getLocalFoldersGroupLabel("/Users/alice", "Linux x86_64")).toBe("Folders on this Mac");
    expect(getLocalFoldersGroupLabel("/users/alice", "MacIntel")).toBe("Folders on this System");
  });

  it("uses existing platform detection when the home directory is unavailable", () => {
    expect(getLocalFoldersGroupLabel(null, "Windows")).toBe("Folders on this PC");
    expect(getLocalFoldersGroupLabel(null, "MacIntel")).toBe("Folders on this Mac");
    expect(getLocalFoldersGroupLabel(null, "darwin")).toBe("Folders on this Mac");
  });

  it("uses a neutral fallback for unknown and non-macOS POSIX systems", () => {
    expect(getLocalFoldersGroupLabel("/home/windows-user", "Linux x86_64")).toBe(
      "Folders on this System",
    );
    expect(getLocalFoldersGroupLabel(null, "")).toBe("Folders on this System");
  });
});
