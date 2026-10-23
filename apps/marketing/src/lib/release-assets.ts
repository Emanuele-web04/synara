export type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

export function isInstallerAsset(name: string | undefined): boolean {
  return typeof name === "string" && /\.(dmg|exe|AppImage|deb|rpm)$/i.test(name);
}

export function findReleaseAssetUrl(
  assets: ReadonlyArray<ReleaseAsset>,
  pattern: RegExp,
): string | null {
  return (
    assets.find((asset) => asset.name && pattern.test(asset.name) && asset.browser_download_url)
      ?.browser_download_url ?? null
  );
}
