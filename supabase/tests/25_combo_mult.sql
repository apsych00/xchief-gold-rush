-- Invariant: the combo table pays 1x/1.5x/2x/3x by prior streak and caps at 3x forever after.
begin;

select plan(5);

select is(public.combo_mult(0), 1::numeric, 'streak 0 pays 1x');
select is(public.combo_mult(1), 1.5::numeric, 'streak 1 pays 1.5x');
select is(public.combo_mult(2), 2::numeric, 'streak 2 pays 2x');
select is(public.combo_mult(3), 3::numeric, 'streak 3 pays 3x');
select is(public.combo_mult(9), 3::numeric, 'streak 9 stays capped at 3x');

select * from finish();
rollback;
