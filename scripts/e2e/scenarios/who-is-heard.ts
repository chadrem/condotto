import { expect, scenario } from "../lib/thread";

// What an app can prove about who is heard, and what it can't.
//
// The outsider posts with the tester app's user token: as the human who installed
// it, but Slack stamps every such post with the app's bot_id. So the adapter's
// bot gate drops it before the core sees it, and the core's own check (hears(),
// members, held messages) is never reached from here. That path needs a message a
// person typed, so it stays covered by the session-manager tests, not this suite.
const QUIET_MS = 20_000;

export default scenario({
  name: "who-is-heard",
  about: "A non-architect's post never becomes a turn and gets no reply.",
  async run(t) {
    t.ids.outsider ?? t.skip("no tester_user_token, so there is no outsider to post as");
    const thread = await t.assignedThread();
    const session = thread.session();

    const base = t.db.lastAuditId();
    const sent = await thread.say("Reply with just the word ok.", "outsider");
    await t.sleep(QUIET_MS);
    const events = t.db.audits(session.id, { after: base }).map((a) => a.event);
    expect(!events.includes("message_in"), "an outsider's message became a turn");
    expect(!events.includes("message_out"), "Condotto replied to an outsider");
    expect((await thread.condottoPosts(sent)).length === 0, "Condotto posted in reply to an outsider");
  },
});
