import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "restart-resume",
  about: "A thread keeps its conversation across a daemon restart.",
  async run(t) {
    const thread = await t.assignedThread();
    const first = await thread.turn("Remember this codeword for later: marmalade. Reply with just the word ok.");
    expect(first.ok, `the first turn ended in an error: ${first.reply}`);

    await t.restartDaemon();
    const recalled = await thread.turn("What was the codeword I gave you? Reply with just the codeword.");
    expect(recalled.ok, `the turn after the restart ended in an error: ${recalled.reply}`);
    expect(/marmalade/i.test(recalled.reply), `the codeword was lost across the restart: ${recalled.reply}`);
    const lost = (await thread.condottoPosts()).some((m) => /couldn't pick up our earlier conversation/.test(m.text ?? ""));
    expect(!lost, "Condotto said it couldn't pick up the earlier conversation");
  },
});
