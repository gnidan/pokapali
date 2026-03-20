/**
 * Custom changelog generator for pokapali.
 *
 * - Wraps lines at ~72 chars (with 2-char indent = ~74)
 * - Converts #NNN to full GitHub issue/PR links
 * - Shows bump type in version heading
 */

const REPO = "https://github.com/gnidan/pokapali";
const WRAP = 72;

/**
 * Wrap a single paragraph to ~WRAP chars, with `indent`
 * spaces on continuation lines. Preserves any leading
 * whitespace on the first line.
 */
function wrapParagraph(text, indent) {
  const prefix = " ".repeat(indent);
  const leadingMatch = text.match(/^(\s*)/);
  const leading = leadingMatch ? leadingMatch[1] : "";
  const words = text.trim().split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = leading + word;
    } else if (current.length + 1 + word.length > WRAP) {
      lines.push(current);
      current = prefix + word;
    } else {
      current += " " + word;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

/**
 * Wrap a changelog entry. The first line is a markdown
 * list item ("- ..."), continuation lines get 2-space
 * indent. Sub-list items ("  - ...") are wrapped with
 * 4-space continuation.
 */
function wrapEntry(text) {
  const lines = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      lines.push("");
    } else if (line.startsWith("  - ")) {
      // Sub-list item: wrap with 4-space continuation
      lines.push(wrapParagraph(line, 4));
    } else if (line.startsWith("- ")) {
      // Top-level list item: wrap with 2-space continuation
      lines.push(wrapParagraph(line, 2));
    } else if (/^\s{2,}/.test(line)) {
      // Indented continuation paragraph
      lines.push(wrapParagraph(line, 2));
    } else {
      lines.push(wrapParagraph(line, 2));
    }
  }
  return lines.join("\n");
}

/**
 * Convert bare #NNN references to GitHub-autolinked
 * markdown references.
 */
function linkIssues(text) {
  return text.replace(/(?<!\[)#(\d+)(?!\])/g, `[#$1](${REPO}/issues/$1)`);
}

/** @type {import("@changesets/types").ChangelogFunctions} */
const changelogFunctions = {
  async getReleaseLine(changeset, _type) {
    const linked = linkIssues(changeset.summary);
    const [firstLine, ...rest] = linked.split("\n").map((l) => l.trimEnd());

    let entry = `- ${firstLine}`;
    if (rest.length > 0) {
      entry += "\n" + rest.map((l) => (l === "" ? "" : `  ${l}`)).join("\n");
    }

    return wrapEntry(entry);
  },

  async getDependencyReleaseLine(changesets, deps) {
    if (deps.length === 0) return "";

    const lines = ["- Updated dependencies"];
    for (const dep of deps) {
      lines.push(`  - ${dep.name}@${dep.newVersion}`);
    }
    return lines.join("\n");
  },
};

export default changelogFunctions;
