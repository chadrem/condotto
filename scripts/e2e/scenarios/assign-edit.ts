import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "assign-edit",
  about: "An architect assigns a thread, asks for a file, and gets it, with the reply and footer in the thread.",
  async run(t) {
    const thread = await t.assignedThread();
    const session = thread.session();
    expect(session.repo_id === t.env.repoName, `session is on repo ${session.repo_id}, not ${t.env.repoName}`);

    const result = await thread.turn(
      "Create a file named hello.txt at the root of the repo containing exactly the two characters 42, " +
        "with no trailing newline. Then reply with just the word done.",
    );
    expect(result.ok, `the turn ended in an error: ${result.reply}`);
    expect(/done/i.test(result.reply), `the reply was not "done": ${result.reply}`);
    expect(/this turn/.test(result.posted.text ?? ""), "the reply in the thread has no cost footer");

    const hello = thread.file("hello.txt");
    expect(hello !== null, "hello.txt is not in the worktree");
    expect(hello.trim() === "42", `hello.txt holds ${JSON.stringify(hello)}, not "42"`);

    const writes = thread.audit("tool_call").filter((a) => a.detail.decision === "allow");
    expect(writes.length > 0, "no allowed tool call was audited");
  },
});
