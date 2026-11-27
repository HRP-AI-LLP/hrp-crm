-- Projects can be "under maintenance": fully delivered, now on ongoing support / recurring billing.
-- A distinct status so a delivered-but-live project is no longer shown as "active" development.
alter table projects drop constraint projects_status_check;
alter table projects add constraint projects_status_check
  check (status in ('planning', 'active', 'on_hold', 'maintenance', 'completed', 'cancelled'));
