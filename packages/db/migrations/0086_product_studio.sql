-- Idea → product: rules the AI follows on a project, and the brief a product was started from.
alter table projects add column if not exists ai_rules text check (ai_rules is null or length(ai_rules) <= 20000);
alter table projects add column if not exists product_brief jsonb;
