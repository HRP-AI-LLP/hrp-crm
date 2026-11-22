-- How each person on a project is paid: by the hour (cost rate), by the day, a monthly salary,
-- a fixed amount for the project, a commission on what the project earns, or nothing here.
-- Hourly, daily and monthly turn into a cost per logged hour; fixed and commission are added to the
-- project's labour cost as a whole.
alter table project_members add column pay_basis text not null default 'hourly' check (pay_basis in ('hourly', 'daily', 'monthly', 'fixed', 'commission', 'none'));
alter table project_members add column pay_amount numeric(18, 2) check (pay_amount >= 0);
alter table project_members add column commission_pct numeric(6, 3) check (commission_pct >= 0 and commission_pct <= 100);
alter table project_members add column commission_on text not null default 'invoiced' check (commission_on in ('invoiced', 'collected'));
