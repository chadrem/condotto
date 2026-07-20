// Delete the smoke scratch directory (fixture repo, worktrees, handoff state).
// The next smoke run rebuilds it from scratch.
import { resetSmokeHome } from "./smoke-fixture";

const root = resetSmokeHome();
console.log(`[smoke] removed ${root} — the next smoke run will rebuild it.`);
