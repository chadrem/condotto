import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "plan-mode",
  about: "Plan mode proposes without changing anything, then `plan off` and a go-ahead make the change.",
  async run(t) {
    const thread = await t.assignedThread();
    const before = thread.file("src/ledger.ts");
    expect(before !== null, "the fixture has no src/ledger.ts");

    await thread.command("plan on", /Plan mode on/);
    const planned = await thread.turn(
      "Add an exported function double(n: number): number that returns n * 2 to src/ledger.ts.",
    );
    expect(planned.ok, `the planning turn ended in an error: ${planned.reply}`);
    const plan = (await thread.condottoPosts()).find((m) => /Here's my plan/.test(m.text ?? ""));
    expect(plan, "no plan was posted into the thread");
    expect(thread.file("src/ledger.ts") === before, "src/ledger.ts changed while plan mode was on");

    await thread.command("plan off", /Plan mode off/);
    const built = await thread.turn("Go ahead and implement that plan now.");
    expect(built.ok, `the implementing turn ended in an error: ${built.reply}`);
    expect(/double/.test(thread.file("src/ledger.ts") ?? ""), "src/ledger.ts has no double() after plan off");
  },
});
