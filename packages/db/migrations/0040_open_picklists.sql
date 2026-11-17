-- 0040: picklists people can extend. Choosing "Other…" and typing a value adds it as a choice for
-- everyone (custom fields: in custom_fields.options; standard fields: custom_objects.settings ->
-- extraChoices). The standard columns that take such values lose their fixed lists of values and keep
-- only a format check (the stored value is lowercase words joined by _).

alter table accounts drop constraint if exists accounts_account_type_check;
alter table accounts add constraint accounts_account_type_check check (account_type ~ '^[a-z0-9_]{1,80}$');

alter table vendors drop constraint if exists vendors_vendor_type_check;
alter table vendors add constraint vendors_vendor_type_check check (vendor_type ~ '^[a-z0-9_]{1,80}$');

alter table tickets drop constraint if exists tickets_category_check;
alter table tickets add constraint tickets_category_check check (category ~ '^[a-z0-9_]{1,80}$');
alter table tickets drop constraint if exists tickets_channel_check;
alter table tickets add constraint tickets_channel_check check (channel ~ '^[a-z0-9_]{1,80}$');
