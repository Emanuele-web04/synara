import type { ThreadId } from "./baseSchemas";

export const BROWSER_ANNOTATION_MAX_ID_LENGTH = 128;
export const BROWSER_ANNOTATION_MAX_DOCUMENT_KEY_LENGTH = 128;
export const BROWSER_ANNOTATION_MAX_URL_LENGTH = 2_048;
export const BROWSER_ANNOTATION_MAX_PAGE_TITLE_LENGTH = 256;
export const BROWSER_ANNOTATION_MAX_SELECTOR_LENGTH = 1_024;
export const BROWSER_ANNOTATION_MAX_TAG_NAME_LENGTH = 64;
export const BROWSER_ANNOTATION_MAX_ROLE_LENGTH = 64;
export const BROWSER_ANNOTATION_MAX_NAME_LENGTH = 256;
export const BROWSER_ANNOTATION_MAX_TEXT_LENGTH = 280;
export const BROWSER_ANNOTATION_MAX_FINGERPRINT_LENGTH = 128;
export const BROWSER_ANNOTATION_MAX_COMMENT_LENGTH = 4_000;
export const BROWSER_ANNOTATION_MAX_MARKERS = 32;

export interface BrowserAnnotationDocument {
  /** regenerated per document by the isolated guest preload */
  token: string;
  /** one-way identity of the live URL, computed by the trusted main process */
  key: string;
  url: string;
}

export interface BrowserAnnotationSource {
  url: string;
  pageTitle: string;
}

export interface BrowserAnnotation {
  /** guest-proposed, validated by the main process before publication */
  id: string;
  source: BrowserAnnotationSource;
  selector: string;
  tagName: string;
  role: string | null;
  name: string | null;
  text: string | null;
  fingerprint: string;
  comment: string | null;
  capturedAt: string;
}

export interface BrowserAnnotationMarker {
  id: string;
  ordinal: number;
  documentKey: string;
  source: BrowserAnnotationSource;
  selector: string;
  fingerprint: string;
}

/** the guest can't inherit CSS custom properties — the renderer resolves the theme to bounded numeric colors first */
export interface BrowserAnnotationTheme {
  mode: "light" | "dark";
  accent: string;
  surface: string;
  text: string;
  mutedText: string;
  border: string;
  focusBorder: string;
  primary: string;
  primaryText: string;
}

export interface BrowserAnnotationStartInput {
  threadId: ThreadId;
  tabId: string;
  theme: BrowserAnnotationTheme;
}

export interface BrowserAnnotationCancelInput {
  threadId: ThreadId;
  tabId: string;
}

export interface BrowserAnnotationSyncMarkersInput {
  threadId: ThreadId;
  tabId: string;
  /** stale projections are ignored */
  version: number;
  markers: readonly BrowserAnnotationMarker[];
}

export interface BrowserAnnotationSession {
  sessionId: string;
  threadId: ThreadId;
  tabId: string;
  document: BrowserAnnotationDocument;
  source: BrowserAnnotationSource;
}

interface BrowserAnnotationEventBase {
  threadId: ThreadId;
  tabId: string;
  document: BrowserAnnotationDocument;
  source: BrowserAnnotationSource;
}

export type BrowserAnnotationCancelReason =
  | "user"
  | "submitted"
  | "navigation"
  | "detached"
  | "destroyed"
  | "replaced";

export type BrowserAnnotationEvent =
  | (BrowserAnnotationEventBase & {
      kind: "started";
      sessionId: string;
    })
  | (BrowserAnnotationEventBase & {
      kind: "cancelled";
      sessionId: string | null;
      reason: BrowserAnnotationCancelReason;
    })
  | (BrowserAnnotationEventBase & {
      kind: "document-changed";
      sessionId: null;
    })
  | (BrowserAnnotationEventBase & {
      kind: "markers-synced";
      sessionId: null;
      version: number;
      projectedMarkerIds: readonly string[];
    })
  | (BrowserAnnotationEventBase & {
      kind: "committed";
      sessionId: string;
      annotation: BrowserAnnotation;
    });

export interface BrowserAnnotationMethods {
  start: (input: BrowserAnnotationStartInput) => Promise<BrowserAnnotationSession>;
  cancel: (input: BrowserAnnotationCancelInput) => Promise<void>;
  syncMarkers: (input: BrowserAnnotationSyncMarkersInput) => Promise<void>;
  onEvent: (listener: (event: BrowserAnnotationEvent) => void) => () => void;
}
