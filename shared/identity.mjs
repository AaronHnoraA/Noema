import { validate as validateUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";

export const NOEMA_ID_KINDS = Object.freeze(["repository", "page", "block"]);

export function normalizeNoemaIdKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!NOEMA_ID_KINDS.includes(kind)) {
    throw new TypeError(`Unsupported Noema identity kind: ${String(value)}`);
  }
  return kind;
}

export function newNoemaId(kind) {
  normalizeNoemaIdKind(kind);
  return uuidv7();
}

export function isUuidV7(value) {
  const id = String(value || "").trim();
  return validateUuid(id) && uuidVersion(id) === 7;
}

export function isPersistedNoemaId(value) {
  return String(value || "").trim().length > 0;
}
