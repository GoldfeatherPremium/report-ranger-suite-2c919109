# Turnitin Instructor Worker — Teach & Replay

A fresh, independent worker for the **instructor** pipeline (Similarity + AI
Writing). Unlike the student worker (which runs a hard-coded Turnitin flow), this
worker **learns** the flow interactively: it logs into the instructor account,
screenshots every screen, and you tell it what to click. Each confirmed action is
recorded so the sequence can later be replayed automatically.

It shares **nothing** with the student worker at runtime and reuses the same
Supabase project (same `SUPABASE_URL` + service-role key).

## How it works

```
TEACH mode (npm run teach)              RUN mode (next phase)
────────────────────────────           ─────────────────────
login to instructor account            claim_next_instructor_job()
  ↓                                       ↓
screenshot screen  ──► Supabase         replay the learned flow with the
  ↓                    'training'         user's document
list clickable elements                   ↓
  ↓                                      capture Similarity + AI PDFs
you type the next action                  ↓
  ↓                                      upload reports, mark job done
execute + record step
  ↓
repeat → 'done' saves a flow
```

Screenshots land in the private `training` bucket and each step (screen URL,
detected elements, the action you chose) is saved to `turnitin_training_steps`.
On `done`, the ordered actions become a row in `turnitin_instructor_flows`.

## Setup (on the VPS)

```bash
cd /opt/<repo>/vps/worker-instructor
cp .env.example .env
nano .env            # SUPABASE_URL + SERVICE_ROLE_KEY (same as student) + WORKER_ID
npm install
npx playwright install --with-deps chromium
npm run build
```

Add the instructor **account** (and later its class/assignment) in the app:
**Admin → Instructor → Add account**.

## Teaching a flow

Run it attached to your terminal (it's interactive):

```bash
npm run teach
```

You'll see, for each screen:

```
STEP 3
url   : https://www.turnitin.com/...
shot  : https://...supabase.co/.../003.png?token=...
elements (12):
  [0] <a> "Assignments"  #nav-assignments
  [1] <button> "Upload Submission"
  ...
action>
```

Open the `shot:` link to view the screen (or paste it to share). Then type the
next action:

| Command | Does |
|---|---|
| `click 1` | click element #1 |
| `fill 4 My Title` | type into element #4 |
| `upload 7` | attach a file to file-input #7 (sample while teaching) |
| `press Enter` | press a key |
| `goto <url>` | navigate to a URL |
| `waittext Similarity` | wait for text to appear |
| `wait 3000` | pause, then re-capture |
| `scroll 600` | scroll down |
| `shot` | re-capture the current screen |
| `done [name]` | save the recorded sequence as a flow |
| `abort` | discard and exit |

When the flow reaches the finished reports, type `done`. Activate the saved flow
when you're ready to replay:

```sql
update turnitin_instructor_flows set status='active' where id='<flow-id>';
```

## Notes

- `upload` steps are recorded with a `<<JOB_FILE>>` placeholder; RUN mode swaps
  in the real document automatically.
- The browser runs headless on the VPS — screenshots are how you "see" it.
- This worker never touches the student pipeline or `pipeline='student'` jobs.
