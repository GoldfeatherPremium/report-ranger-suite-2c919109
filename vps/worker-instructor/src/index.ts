import "./load-env.js";
import { getInstructorAccount, getActiveFlow, log } from "./supabase.js";

// RUN / replay mode.
//
// Phase 1 ships TEACH mode only (see teach.ts). Replay — claiming real
// instructor jobs and re-running the learned flow to produce the Similarity +
// AI Writing PDFs — is built in the next phase. This entrypoint is intentionally
// inert so it can't grab jobs or do anything half-finished: it verifies a flow
// has been taught and then exits cleanly.
const WORKER_ID = process.env.WORKER_ID ?? `instructor-${process.pid}`;

async function main() {
  console.log(`turnitin-instructor-worker ${WORKER_ID} — RUN mode`);
  let flow = null;
  try {
    const account = await getInstructorAccount(process.env.TEACH_ACCOUNT_LABEL);
    flow = await getActiveFlow(account.id);
    if (flow && flow.length) {
      await log(WORKER_ID, "info", `found active flow with ${flow.length} steps — replay engine arrives in the next phase`);
      console.log(`An active flow exists (${flow.length} steps). Replay is not enabled yet.`);
    } else {
      await log(WORKER_ID, "info", "no active flow yet — run TEACH mode first (npm run teach)");
      console.log(`No active flow. Teach one first:  npm run teach`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
  // Exit 0: RUN is not yet a long-running service.
  process.exit(0);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
