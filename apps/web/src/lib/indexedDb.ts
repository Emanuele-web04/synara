export function openIndexedDbDatabase(input: {
  name: string;
  version: number;
  storeName: string;
  keyPath: string;
  label: string;
}): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(input.name, input.version);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(input.storeName)) {
        database.createObjectStore(input.storeName, { keyPath: input.keyPath });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error(`Could not open the ${input.label}.`)),
    );
    request.addEventListener("blocked", () =>
      reject(new Error(`The ${input.label} upgrade was blocked.`)),
    );
  });
}

export function waitForIdbTransaction(transaction: IDBTransaction, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error(`${label} was aborted.`)),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error(`${label} failed.`)),
    );
  });
}

export function awaitIdbRequest<Result>(
  request: IDBRequest<Result>,
  errorMessage: string,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error(errorMessage)));
  });
}
