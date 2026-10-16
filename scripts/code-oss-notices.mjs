import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preserve notices for bundled dependencies rather than treating Microsoft's
 * MIT license as the license for every third-party file in the runtime. */
export async function writeCodeOssNotices(inputs, source, output) {
  const packages = new Set();
  for (const input of inputs) {
    const filename = path.resolve(input);
    const segments = filename.split(path.sep);
    const index = segments.lastIndexOf("node_modules");
    if (index === -1 || !segments[index + 1]) continue;
    const count = segments[index + 1].startsWith("@") ? 3 : 2;
    packages.add(segments.slice(0, index + count).join(path.sep));
  }
  const notices = ["Synara headless Code-OSS runtime: bundled third-party notices\n"];
  const upstream = await readFile(path.join(source, "ThirdPartyNotices.txt"), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (upstream) notices.push("Upstream Code-OSS third-party notices\n", upstream);
  for (const directory of [...packages].sort()) {
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    notices.push(
      `\n===== ${manifest.name}@${manifest.version} =====\nLicense: ${JSON.stringify(manifest.license ?? manifest.licenses ?? "See package notices")}\n`,
    );
    const files = (await readdir(directory))
      .filter((name) => /^(?:licen[sc]e|notice|copying)(?:[.-].*)?$/i.test(name))
      .sort();
    for (const name of files)
      notices.push(`\n--- ${name} ---\n`, await readFile(path.join(directory, name), "utf8"));
  }
  await writeFile(path.join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
}
