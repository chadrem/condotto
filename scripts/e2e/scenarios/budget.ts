import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "budget",
  about: "A thread with a budget is refused once it has spent it.",
  async run(t) {
    const thread = await t.assignedThread();
    await thread.command("budget 0.01", /Cost budget set to \$0\.01/);
    const session = thread.session();

    // The cap is checked between turns, and the first turn starts under it, so
    // spend crosses it during a turn and the refusal comes on a later one.
    for (let i = 0; i < 3; i++) {
      const base = t.db.lastAuditId();
      const sent = await thread.say("Reply with just the word ok.");
      const outcome = await t.waitFor(
        "the turn to run or be refused",
        () => {
          const events = t.db.audits(session.id, { after: base }).map((a) => a.event);
          if (events.includes("budget_exceeded")) return "refused";
          const ended = events.includes("message_out") || events.includes("error");
          return ended && thread.sessionOrNull()?.status !== "active" ? "ran" : null;
        },
        5 * 60_000,
      );
      if (outcome === "refused") {
        await thread.waitForPost(/reached its cost budget/, { after: sent });
        return;
      }
      t.note(`turn ${i + 1} ran; spent so far $${t.db.costUsd([session.id]).toFixed(4)}`);
    }
    expect(false, "three turns ran and the budget never refused one");
  },
});
