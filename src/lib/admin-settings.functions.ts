import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getWorkerCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: user, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!user || user.role !== "admin") throw new Error("Forbidden: admin only");

    const url = process.env.SUPABASE_URL ?? "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !serviceKey) throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

    return { supabaseUrl: url, serviceRoleKey: serviceKey };
  });
