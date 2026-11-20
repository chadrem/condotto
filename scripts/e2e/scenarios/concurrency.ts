import { expect, scenario } from "../lib/thread";

export default scenario({
  name: "concurrency",
  about: "Two threads working at once each get their own worktree and their own reply.",
  async run(t) {
    const [a, b] = await Promise.all([t.assignedThread("alpha"), t.assignedThread("beta")]);
    const ask = (name: string) =>
      `Create a file named ${name}.txt at the repo root containing exactly the word ${name}. Reply with just the word done.`;
    const [ra, rb] = await Promise.all([a.turn(ask("alpha")), b.turn(ask("beta"))]);
    expect(ra.ok && rb.ok, `a turn ended in an error: ${ra.ok ? rb.reply : ra.reply}`);

    expect(a.session().worktree_path !== b.session().worktree_path, "the two threads share a worktree");
    expect(a.file("alpha.txt")?.trim() === "alpha", "alpha.txt is missing or wrong in the alpha worktree");
    expect(b.file("beta.txt")?.trim() === "beta", "beta.txt is missing or wrong in the beta worktree");
    expect(a.file("beta.txt") === null && b.file("alpha.txt") === null, "a file crossed between worktrees");
  },
});
