import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "cancel",
  about: "`cancel` stops a running turn and says so.",
  async run(t) {
    const thread = await t.assignedThread();
    const base = t.db.lastAuditId();
    const turn = thread.turn("Run the shell command `sleep 120`, and after it finishes reply with just the word finished.");
    // Awaited below, but a step before that can throw first; a rejection with no
    // handler by then would take the whole run down.
    turn.catch(() => {});

    await t.waitFor(
      "the agent to start the sleep",
      () => thread.audit("tool_call", base).some((a) => a.detail.tool === "Bash" && a.detail.decision === "allow"),
      3 * 60_000,
    );
    await thread.command("cancel", /Cancelling the running turn/);
    const result = await turn;
    expect(/Cancelled/.test(result.posted.text ?? ""), `the turn did not end as cancelled: ${result.posted.text}`);
    expect(thread.audit("turn_cancelled", base).length > 0, "no turn_cancelled was audited");
  },
});
