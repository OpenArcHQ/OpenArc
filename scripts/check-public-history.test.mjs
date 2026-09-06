import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const checker = fileURLToPath(new URL("./check-public-history.mjs", import.meta.url));
const name = "OpenArc";
const email = "openarc-github.carry493@slmails.com";

function withRepo(callback) {
  const directory = mkdtempSync(join(tmpdir(), "openarc-public-history-"));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function commit(directory, {
  authorName = name,
  authorEmail = email,
  committerName = name,
  committerEmail = email,
  message = "test commit",
} = {}) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  };
  execFileSync("git", ["-C", directory, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--allow-empty", "-m", message], { env });
}

function runChecker(directory) {
  return () => execFileSync(process.execPath, [checker], {
    cwd: directory,
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("accepts valid OpenArc author and committer identities", () => withRepo((directory) => {
  commit(directory);
  assert.match(runChecker(directory)(), /passed for 1 commit/);
}));

for (const field of ["authorName", "authorEmail", "committerName", "committerEmail"]) {
  test(`rejects wrong ${field}`, () => withRepo((directory) => {
    commit(directory, { [field]: field.endsWith("Name") ? "Someone Else" : "someone@example.test" });
    assert.throws(runChecker(directory), /Unapproved public commit identity/);
  }));
}

test("rejects a co-author trailer", () => withRepo((directory) => {
  commit(directory, { message: "test commit\n\nCo-authored-by: Other Person <other@example.test>" });
  assert.throws(runChecker(directory), /co-author trailer requires review/);
}));

test("rejects history containing an earlier invalid commit", () => withRepo((directory) => {
  commit(directory, { authorName: "Wrong Author" });
  commit(directory, { message: "valid later commit" });
  assert.throws(runChecker(directory), /Unapproved public commit identity/);
}));

test("rejects an empty repository", () => withRepo((directory) => {
  assert.throws(runChecker(directory), /Public history must contain a commit/);
}));
