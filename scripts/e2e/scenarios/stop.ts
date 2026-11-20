import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "stop",
  about: "A stopped session does not hear the thread any more.",
  async run(t) {
    const thread = await t.assignedThread();
    await thread.command("stop", /Session stopped/);
    expect(thread.session().status === "stopped", `the session is ${thread.session().status}, not stopped`);

    const base = t.db.lastAuditId();
    await thread.say("Reply with just the word ok.");
    await t.sleep(20_000);
    expect(thread.audit("message_in", base).length === 0, "a stopped session took a turn");
    expect(thread.audit("message_out", base).length === 0, "a stopped session replied");
  },
});
