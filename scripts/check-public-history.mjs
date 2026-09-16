import { execFileSync } from "node:child_process";

const allowedName = "OpenArc";
const allowedEmail = "openarc-github.carry493@slmails.com";
const allowedTrailer = /^\s*co-authored-by:\s*claude [\w .-]+ <noreply@anthropic\.com>\s*$/iu;
const history = execFileSync("git", ["log", "--all", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce"], { encoding: "utf8" }).trim();
if (!history) throw new Error("Public history must contain a commit");
const commits = history.split("\n");
for (const row of commits) {
  const [sha, author, authorEmail, committer, committerEmail] = row.split("\t");
  if (author !== allowedName || committer !== allowedName || authorEmail !== allowedEmail || committerEmail !== allowedEmail) {
    throw new Error(`Unapproved public commit identity at ${sha}; values withheld`);
  }
  const message = execFileSync("git", ["show", "-s", "--format=%B", sha], { encoding: "utf8" });
  // The only accepted trailer is the non-personal AI-assistant attribution.
  const trailers = message.split("\n").filter((line) => /^\s*co-authored-by\s*:/iu.test(line));
  if (trailers.some((line) => !allowedTrailer.test(line))) throw new Error(`Public co-author trailer requires review at ${sha}`);
}
console.log(`Public history identity check passed for ${commits.length} commit(s)`);
