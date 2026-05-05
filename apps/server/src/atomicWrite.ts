import { Effect, FileSystem, Path } from "effect";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempPath = `${input.filePath}.${process.pid}.${Date.now()}.tmp`;
    yield* fs.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fs.writeFileString(tempPath, input.contents);
    yield* fs.rename(tempPath, input.filePath);
  });
