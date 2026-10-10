import * as fs from "node:fs/promises";
import * as path from "node:path";

export function isContainedPath(realRoot: string, candidatePath: string): boolean {
  const relativePath = path.relative(realRoot, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function isFileNotFoundError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isAlreadyExistsError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

function isLexicallyContainedPath(workspaceRoot: string, absolutePath: string): boolean {
  return isContainedPath(path.resolve(workspaceRoot), path.resolve(absolutePath));
}

// string-level checks can't see symlinks — resolve both sides and re-check on canonical paths (keeps in-root links under symlinked roots working, e.g. /tmp→/private/tmp)
export async function resolveRealPathWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(absolutePath),
  ]);
  return isContainedPath(realRoot, realTarget) ? realTarget : null;
}

// canonicalize the existing prefix, then append the missing suffix — realpath(dirname) can't validate paths whose parents don't exist yet
export async function resolveRealPathForCreateWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  if (!isLexicallyContainedPath(workspaceRoot, absolutePath)) {
    return null;
  }

  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalTarget = path.resolve(absolutePath);
  const realRoot = await fs.realpath(lexicalRoot);
  const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
  const components = relativeTarget === "" ? [] : relativeTarget.split(path.sep);
  let currentPath = realRoot;

  for (let index = 0; index < components.length; index += 1) {
    const candidatePath = path.join(currentPath, components[index]!);
    try {
      const realCandidate = await fs.realpath(candidatePath);
      if (!isContainedPath(realRoot, realCandidate)) {
        return null;
      }
      currentPath = realCandidate;
    } catch (cause) {
      if (!isFileNotFoundError(cause)) {
        throw cause;
      }

      // realpath reports ENOENT on a dangling symlink — not a safe "missing" component; its target could appear before use
      let candidateExists = true;
      try {
        await fs.lstat(candidatePath);
      } catch (lstatCause) {
        if (!isFileNotFoundError(lstatCause)) throw lstatCause;
        candidateExists = false;
      }
      if (candidateExists) throw cause;

      const unresolvedPath = path.join(currentPath, ...components.slice(index));
      return isContainedPath(realRoot, unresolvedPath) ? unresolvedPath : null;
    }
  }

  return currentPath;
}

// each parent is created+canonicalized separately so mkdir never gets a suffix that traverses an existing link
export async function prepareRealPathForWriteWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  if (!isLexicallyContainedPath(workspaceRoot, absolutePath)) {
    return null;
  }

  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalTarget = path.resolve(absolutePath);
  const realRoot = await fs.realpath(lexicalRoot);
  const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
  const components = relativeTarget === "" ? [] : relativeTarget.split(path.sep);
  const targetName = components.pop();
  let currentPath = realRoot;

  for (const component of components) {
    const candidatePath = path.join(currentPath, component);
    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidatePath);
    } catch (cause) {
      if (!isFileNotFoundError(cause)) {
        throw cause;
      }

      let candidateExists = true;
      try {
        await fs.lstat(candidatePath);
      } catch (lstatCause) {
        if (isFileNotFoundError(lstatCause)) {
          candidateExists = false;
        } else {
          throw lstatCause;
        }
      }
      if (candidateExists) {
        throw cause;
      }

      try {
        await fs.mkdir(candidatePath);
      } catch (mkdirCause) {
        // a concurrent creator is accepted only after canonical validation
        if (!isAlreadyExistsError(mkdirCause)) {
          throw mkdirCause;
        }
      }
      realCandidate = await fs.realpath(candidatePath);
    }

    if (!isContainedPath(realRoot, realCandidate)) {
      return null;
    }
    if (!(await fs.stat(realCandidate)).isDirectory()) {
      throw new Error(`Workspace write parent is not a directory: ${candidatePath}`);
    }
    currentPath = realCandidate;
  }

  if (targetName === undefined) {
    return currentPath;
  }
  return resolveRealPathForCreateWithinRoot(realRoot, path.join(currentPath, targetName));
}
