-- A deal's charges can be hourly: a rate per hour times the hours estimated, billed later from time.
alter table deal_charges drop constraint if exists deal_charges_kind_check;
alter table deal_charges add constraint deal_charges_kind_check check (kind in ('one_time', 'recurring', 'hourly'));
