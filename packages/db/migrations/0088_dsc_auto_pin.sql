-- A token's PIN, kept encrypted, so the browser's auto-sign loop can sign issued invoices with the
-- token without a person typing the PIN each time. Only used for 'token' certificates.
alter table dsc_certificates add column if not exists auto_pin_enc text;
