export interface KWinPrebuildMetadata {
  readonly builtOn: string;
  readonly kwinVersion: string;
  readonly arch: string;
  readonly file: string;
  readonly sha256?: string;
  /** Recorded by the build step; absent when the image's cmake config could not be read. */
  readonly qtVersion?: string;
  readonly kfVersion?: string;
  readonly glibcVersion?: string;
}

export const EXPECTED_KWIN_PREBUILDS: readonly (readonly [string, string])[];

export function assembleKWinPluginPrebuilds(options: {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly strict?: boolean;
  readonly expected?: readonly (readonly [string, string])[];
  readonly log?: (message: string) => void;
}): {
  readonly builds: readonly (KWinPrebuildMetadata & { readonly sha256: string })[];
  readonly missing: readonly (readonly [string, string])[];
};
