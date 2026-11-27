-- SSE fan-out (r9-sse): each API replica LISTENs on `grad_job_events` and
-- fetches new events only for the jobs a notification names, instead of every
-- open stream polling the table. NOTIFY is transactional: it is delivered when
-- the writing transaction commits, and never for one that rolls back. A
-- replica that misses one (a dropped LISTEN connection) still delivers on its
-- safety poll (SSE_POLL_MS).

-- The hub reads every event type of a job after a cursor.
CREATE INDEX IF NOT EXISTS grad_job_events_job_seq_idx ON grad_job_events (job_id, seq);

CREATE OR REPLACE FUNCTION grad_notify_job_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('grad_job_events', NEW.job_id);
  RETURN NULL;
END $$;

-- A stream ends once its job is terminal and released (status, worker_id).
CREATE OR REPLACE FUNCTION grad_notify_job_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('grad_job_events', NEW.id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS grad_job_events_notify ON grad_job_events;
CREATE TRIGGER grad_job_events_notify AFTER INSERT ON grad_job_events
  FOR EACH ROW EXECUTE FUNCTION grad_notify_job_event();

DROP TRIGGER IF EXISTS grad_jobs_notify ON grad_jobs;
CREATE TRIGGER grad_jobs_notify AFTER UPDATE OF status, worker_id ON grad_jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.worker_id IS DISTINCT FROM NEW.worker_id)
  EXECUTE FUNCTION grad_notify_job_state();
