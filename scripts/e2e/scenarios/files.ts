import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENTS_REL } from "../../../src/core/attachments";
import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "files",
  about: "A file dropped in the thread reaches the worktree, and a file the agent makes comes back.",
  async run(t) {
    const thread = await t.assignedThread();

    // A code made up for this run: the agent can only answer by reading the file,
    // and there is nothing for it to get wrong on the way (arithmetic was flaky).
    const code = `e2e-${crypto.randomUUID().slice(0, 8)}`;
    const read = await thread.uploadTurn(
      "code.txt",
      `The code is ${code}\n`,
      "Read the attached file and reply with only the code written in it.",
    );
    expect(read.ok, `the turn ended in an error: ${read.reply}`);
    expect(thread.audit("attachments_received").length > 0, "no attachments_received was audited");
    const dir = join(thread.session().worktree_path, ATTACHMENTS_REL);
    const landed = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(
      landed.some((e) => readFileSync(join(e.parentPath, e.name), "utf8").includes(code)),
      `the uploaded file is not under ${dir}`,
    );
    expect(read.reply.includes(code), `the reply does not carry the file's code ${code}: ${read.reply}`);

    const sent = await thread.turn(
      "Write a file at .condotto/outbox/report.txt containing exactly the word hello. Reply with just the word sent.",
    );
    expect(sent.ok, `the turn ended in an error: ${sent.reply}`);
    await t.waitFor(
      "report.txt to appear in the thread",
      async () => (await thread.condottoPosts()).some((m) => m.files?.some((f) => f.name === "report.txt")),
      60_000,
    );
    expect(thread.audit("attachment_sent").length > 0, "no attachment_sent was audited");
  },
});
