-- AI delivery: review steps (evaluator, validation checker, code reviewer, code quality) that send
-- weak documents back to their agents; test-case steps keep their level in doc_type.
alter table sdlc_steps drop constraint sdlc_steps_kind_check;
alter table sdlc_steps add constraint sdlc_steps_kind_check check (kind in ('document', 'diagram', 'backlog', 'test_cases', 'review', 'code'));
