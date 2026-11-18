-- GeM: the estimated bid value shown in the list. Bank and card accounts: the password their statement
-- PDFs are protected with (sealed like other secrets), so mailed statements can be opened and read.

alter table gem_bids add column bid_value numeric(18, 2);

alter table bank_accounts
  add column statement_password_ciphertext text,
  add column statement_senders text check (length(statement_senders) <= 500);

-- Deals priced as a fixed bid or as a rate (hourly, daily, per task, per person-month, retainer, per unit…):
-- the amount follows rate × quantity (× months for people per month) whenever a rate is given.
alter table deals
  add column pricing_model   text check (pricing_model in ('fixed', 'hourly', 'daily', 'per_task', 'per_person_month', 'monthly_retainer', 'per_unit', 'milestone', 'subscription')),
  add column unit_rate       numeric(18, 2) check (unit_rate >= 0),
  add column units           numeric(18, 2) check (units >= 0),
  add column duration_months numeric(8, 2) check (duration_months >= 0);

create or replace function app.deal_amount_from_rate() returns trigger language plpgsql as $$
begin
  if new.pricing_model is not null and new.pricing_model not in ('fixed', 'milestone') and new.unit_rate is not null and new.units is not null then
    new.amount := round(new.unit_rate * new.units * case when new.pricing_model in ('per_person_month', 'subscription') then coalesce(nullif(new.duration_months, 0), 1) else 1 end, 2);
  end if;
  return new;
end
$$;
create trigger deals_amount_from_rate before insert or update of pricing_model, unit_rate, units, duration_months, amount on deals
  for each row execute function app.deal_amount_from_rate();
