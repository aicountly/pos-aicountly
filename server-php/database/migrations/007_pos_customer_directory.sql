-- ---------------------------------------------------------------------------
-- 007 — the read path behind the Customers & Growth roster
--
-- One index, no new table, no new column. The customer roster is derived from
-- pos_carts every time it is asked for, because the alternative — a
-- pos_customers table kept in step with the bills — is a second copy of
-- something Books already owns, and this architecture does not keep those.
--
-- WHAT THE QUERY DOES. It groups every completed, customer-attached bill in a
-- company by customer_account_id to get visits, spend, first and last seen, the
-- last name and mobile typed at the counter, and the outlet last bought at.
-- idx_pos_carts_customer from 004 already leads on (cmp_id,
-- customer_account_id, created_at), which is the right order for that grouping,
-- but it carries none of the columns being aggregated, so every row still costs
-- a heap fetch. On a shop with a year of trade behind it that is the difference
-- between the table painting and the table timing out.
--
-- The INCLUDE columns are the ones the aggregate reads and nothing else, so the
-- index answers the whole grouping without touching the table. status is in the
-- predicate rather than the key because every dashboard query filters to
-- COMPLETED and a completed bill never becomes uncompleted.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pos_carts_customer_history
    ON pos_carts (cmp_id, customer_account_id, created_at DESC)
    INCLUDE (total_amount, terminal_id, customer_name, customer_mobile)
    WHERE status = 'COMPLETED' AND customer_account_id IS NOT NULL;

COMMENT ON INDEX idx_pos_carts_customer_history IS
    'Covers the Customers & Growth roster aggregate: visits, spend, first/last seen and the last identity typed at the counter, per customer, without a heap fetch.';
