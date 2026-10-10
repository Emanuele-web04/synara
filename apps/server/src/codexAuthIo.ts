/** One security algorithm, with synchronous launch and asynchronous event readers. */
import fs from "node:fs";

interface Operation {
  readonly sync: () => unknown;
  readonly async: () => Promise<unknown>;
}
export type CodexAuthIo<A> = Generator<Operation, A, unknown>;

export function* codexAuthIo<A>(sync: () => A, async: () => Promise<A>): CodexAuthIo<A> {
  return (yield { sync, async }) as A;
}

export function runCodexAuthIoSync<A>(program: CodexAuthIo<A>): A {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = step.value.sync();
    } catch (error) {
      step = program.throw(error);
      continue;
    }
    step = program.next(value);
  }
  return step.value;
}

export async function runCodexAuthIoAsync<A>(program: CodexAuthIo<A>): Promise<A> {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value.async();
    } catch (error) {
      step = program.throw(error);
      continue;
    }
    step = program.next(value);
  }
  return step.value;
}

export interface CodexAuthHandle {
  readonly stat: () => CodexAuthIo<fs.BigIntStats>;
  readonly read: () => CodexAuthIo<Buffer>;
  readonly close: () => CodexAuthIo<void>;
}

const unexpectedSync = (): never => {
  throw new Error("Asynchronous auth handle in synchronous reader");
};

export const codexAuthFs = {
  lstat: (filePath: string) =>
    codexAuthIo(
      () => fs.lstatSync(filePath, { bigint: true }),
      () => fs.promises.lstat(filePath, { bigint: true }),
    ),
  stat: (filePath: string) =>
    codexAuthIo(
      () => fs.statSync(filePath, { bigint: true }),
      () => fs.promises.stat(filePath, { bigint: true }),
    ),
  realpath: (filePath: string) =>
    codexAuthIo(
      () => fs.realpathSync(filePath),
      () => fs.promises.realpath(filePath),
    ),
  open: (filePath: string, flags: number): CodexAuthIo<CodexAuthHandle> =>
    codexAuthIo(
      () => {
        const descriptor = fs.openSync(filePath, flags);
        return {
          stat: () =>
            codexAuthIo(
              () => fs.fstatSync(descriptor, { bigint: true }),
              async () => {
                throw new Error("Synchronous auth handle in asynchronous reader");
              },
            ),
          read: () =>
            codexAuthIo(
              () => fs.readFileSync(descriptor),
              async () => {
                throw new Error("Synchronous auth handle in asynchronous reader");
              },
            ),
          close: () =>
            codexAuthIo(
              () => fs.closeSync(descriptor),
              async () => {
                throw new Error("Synchronous auth handle in asynchronous reader");
              },
            ),
        };
      },
      async () => {
        const handle = await fs.promises.open(filePath, flags);
        return {
          stat: () => codexAuthIo(unexpectedSync, () => handle.stat({ bigint: true })),
          read: () => codexAuthIo(unexpectedSync, () => handle.readFile()),
          close: () => codexAuthIo(unexpectedSync, () => handle.close()),
        };
      },
    ),
};
