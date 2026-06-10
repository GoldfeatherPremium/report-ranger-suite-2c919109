CREATE OR REPLACE FUNCTION public.update_instructor_account(
  p_id uuid,
  p_label text,
  p_email text,
  p_password text,
  p_login_url text,
  p_notes text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  update public.turnitin_instructor_accounts
  set
    label = p_label,
    email = p_email,
    login_url = p_login_url,
    notes = p_notes,
    updated_at = now()
  where id = p_id;

  if p_password is not null and p_password <> '' then
    update public.turnitin_instructor_accounts
    set password_encrypted = public.encrypt_account_password(p_password)
    where id = p_id;
  end if;
end $function$;