import { controlAccountScope } from "../hosts/controlQueryScope";
import { readExecutionContext } from "../hosts/executionContext";
import { emptyCatalog, type ProjectCatalog } from "./model";

export function projectCatalogKey(): string | null {
  const context = readExecutionContext();
  if (!context) return null;
  const remote = context.remote;
  const account = remote
    ? JSON.stringify([remote.accountAuthority, remote.userId, remote.organizationId])
    : controlAccountScope();
  return `synara:project-catalog:v1:${encodeURIComponent(JSON.stringify([context.controller.environmentId, account]))}`;
}
export function readProjectCatalog(key: string): ProjectCatalog {
  const raw = localStorage.getItem(key);
  if (!raw) return emptyCatalog();
  const value = JSON.parse(raw) as ProjectCatalog;
  const record = (item: unknown): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item);
  const ref = (item: unknown) =>
    record(item) && typeof item.environmentId === "string" && typeof item.projectId === "string";
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.checkouts) ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.excludedPairs) ||
    !value.excludedPairs.every((item) => typeof item === "string") ||
    !value.checkouts.every(
      (item) =>
        record(item) &&
        ref(item) &&
        [item.name, item.cwd, item.hostName, item.channel, item.observedAt].every(
          (field) => typeof field === "string",
        ) &&
        Array.isArray(item.repositoryUrls) &&
        item.repositoryUrls.every((url) => typeof url === "string") &&
        (item.hostId === undefined || typeof item.hostId === "string"),
    ) ||
    !value.groups.every(
      (item) =>
        record(item) &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        Array.isArray(item.members) &&
        item.members.every(ref) &&
        (item.preferredCheckout === undefined || ref(item.preferredCheckout)),
    )
  )
    throw new Error("The saved catalog cannot be read. Its contents have been preserved.");
  return value;
}
export function saveProjectCatalog(key: string, value: ProjectCatalog): void {
  if (key !== projectCatalogKey())
    throw new Error("The account changed. Reopen the project catalog.");
  localStorage.setItem(key, JSON.stringify(value));
}
