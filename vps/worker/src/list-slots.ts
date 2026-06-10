import "dotenv/config";
import { supabase } from "./supabase.js";

const { data, error } = await supabase
  .from("turnitin_slots")
  .select("id, label, submit_url, turnitin_accounts(email, login_url)")
  .order("label");

if (error) { console.error("error:", error.message); process.exit(1); }

console.log("\nAvailable slots:\n");
for (const s of (data ?? [])) {
  const acc = s.turnitin_accounts as unknown as { email: string; login_url: string } | null;
  console.log(`  SLOT_ID=${s.id}`);
  console.log(`    label      : ${s.label}`);
  console.log(`    email      : ${acc?.email ?? "(unknown)"}`);
  console.log(`    submit_url : ${s.submit_url ?? "(not set)"}`);
  console.log();
}
