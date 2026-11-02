import {
  synaraDesktopIdentity,
  type SynaraPackagedDesktopFlavor,
} from "@synara/shared/desktopIdentity";

export function createDesktopArtifactIdentity(input: {
  readonly platform: "mac" | "linux" | "win";
  readonly flavor: SynaraPackagedDesktopFlavor;
}) {
  // Stable's NSIS GUID deliberately survives public bundle ID changes. An
  // experimental installer must not register itself as that same product; beta
  // ships its own WINDOWS_BETA_INSTALLER_GUID, so it is exempt.
  if (input.platform === "win" && input.flavor !== "production" && input.flavor !== "beta") {
    throw new Error("Isolated desktop flavors are currently supported on macOS and Linux only.");
  }
  const identity = synaraDesktopIdentity(input.flavor);
  const suffix = input.flavor === "production" ? "" : `-${input.flavor}`;
  return {
    identity,
    packageMetadata: {
      name: `synara-desktop${suffix}`,
      productName: identity.displayName,
      synaraDesktopFlavor: input.flavor,
      // Debian packaging cannot infer these from the isolated staging tree.
      homepage: "https://github.com/Emanuele-web04/synara",
      author: {
        name: "Emanuele Di Pietro",
        email: "127427797+Emanuele-web04@users.noreply.github.com",
      },
    },
    buildConfig: {
      appId: identity.bundleId,
      productName: identity.displayName,
      artifactName: `${identity.displayName.replaceAll(" ", "-")}-\${version}-\${arch}.\${ext}`,
      ...(input.flavor !== "production"
        ? { protocols: [{ name: identity.displayName, schemes: [identity.scheme] }] }
        : {}),
    },
    releaseDirectoryName: `release${suffix}`,
  };
}
