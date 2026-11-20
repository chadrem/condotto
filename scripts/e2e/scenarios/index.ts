// Every scenario, in the order a full run takes them: the most basic first, so a
// broken setup fails on the first one, and the restart near the end.
import type { Scenario } from "../lib/thread";
import assignEdit from "./assign-edit";
import budget from "./budget";
import cancel from "./cancel";
import concurrency from "./concurrency";
import files from "./files";
import planMode from "./plan-mode";
import restartResume from "./restart-resume";
import stop from "./stop";
import whoIsHeard from "./who-is-heard";

export const SCENARIOS: Scenario[] = [
  assignEdit,
  planMode,
  files,
  budget,
  whoIsHeard,
  cancel,
  stop,
  restartResume,
  concurrency,
];
