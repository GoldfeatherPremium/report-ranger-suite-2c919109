CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Remove any prior schedules with same name
DO $$ BEGIN
  PERFORM cron.unschedule('dispatch-callbacks-30s');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN
  PERFORM cron.unschedule('dispatch-callbacks-30s-offset');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'dispatch-callbacks-30s',
  '* * * * *',
  $$ SELECT net.http_post(
       url := 'https://report-ranger-suite.lovable.app/api/public/cron/dispatch-callbacks',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 25000
     ); $$
);

SELECT cron.schedule(
  'dispatch-callbacks-30s-offset',
  '* * * * *',
  $$ SELECT pg_sleep(30); SELECT net.http_post(
       url := 'https://report-ranger-suite.lovable.app/api/public/cron/dispatch-callbacks',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 25000
     ); $$
);