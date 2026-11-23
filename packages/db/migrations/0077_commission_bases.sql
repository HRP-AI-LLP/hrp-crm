-- Commission on what a project earns: invoiced, collected, gross profit, net profit, or profit after
-- every expense (cash collected less all costs, including other people's commissions).
alter table project_members drop constraint if exists project_members_commission_on_check;
alter table project_members add constraint project_members_commission_on_check
  check (commission_on in ('invoiced', 'collected', 'gross_profit', 'net_profit', 'profit_after_all'));
