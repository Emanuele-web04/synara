import { readFileSync } from "fs";

const s = readFileSync("D:/项目/synara/apps/web/src/i18n/locales/en.json", "utf8");

// Track depth and find where it goes wrong
let depth = 0;
let inStr = false;
let esc = false;

// Find the first time depth goes to 0 after the initial opening brace
const firstBrace = s.indexOf("{");
let depthAfterFirstBrace = 1; // We should be at depth 1

// Track each time depth changes, noting the line
const lines = s.split("\n");
let currentPos = 0;

for (let li = 0; li < lines.length; li++) {
  const line = lines[li];
  for (let ci = 0; ci < line.length; ci++) {
    const c = line[ci];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"' && !esc) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;

    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth < 0) {
        console.log(`NEGATIVE depth at line ${li + 1}, col ${ci}: depth=${depth}`);
        console.log(`  Line content: ${line.substring(Math.max(0, ci - 30), ci + 10)}`);
      }
    }
  }
  currentPos += line.length + 1;

  // Report depth at certain key lines
  if (li < 10 || li % 250 === 0) {
    const stripped = line.replace(/^\s+/, "");
    if (stripped.startsWith('"') || stripped.startsWith("}") || stripped.startsWith("{")) {
      console.log(`Line ${li + 1}: depth=${depth} | ${stripped.substring(0, 60)}`);
    }
  }
}

console.log(`\nFinal depth: ${depth} (should be 1 for the top-level object)`);

// Also find the position where depth first returns to 0 after the outermost {
let depth2 = 0;
let inStr2 = false;
let esc2 = false;
let foundFirstBrace = false;

for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (esc2) {
    esc2 = false;
    continue;
  }
  if (c === "\\") {
    esc2 = true;
    continue;
  }
  if (c === '"' && !esc2) {
    inStr2 = !inStr2;
    continue;
  }
  if (inStr2) continue;

  if (c === "{") {
    depth2++;
    if (!foundFirstBrace) {
      foundFirstBrace = true;
      console.log(`\nFirst opening brace at position ${i}`);
    }
  } else if (c === "}") {
    depth2--;
    if (depth2 === 1 && foundFirstBrace) {
      // This closes the outermost object
      // For a valid file, this should be the very last closing brace
      // Let's find what's near here
      const beforeText = s.substring(Math.max(0, i - 30), i);
      const afterText = s.substring(i, Math.min(s.length, i + 30));
      // Only report the first few times
      console.log(
        `Depth returns to 1 at position ${i}: ...${JSON.stringify(beforeText)}[}${JSON.stringify(afterText.substring(1))}`,
      );
    }
  }
}
