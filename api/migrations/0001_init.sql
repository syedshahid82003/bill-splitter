-- Homes table
CREATE TABLE homes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT homes_name_nonempty CHECK (length(name) > 0)
);

-- Members table: each member belongs to one home, order by rowid = insertion order
CREATE TABLE members (
  id      TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  name    TEXT NOT NULL CONSTRAINT members_name_nonempty CHECK (length(name) > 0),
  CONSTRAINT members_home_id_fk FOREIGN KEY (home_id) REFERENCES homes(id)
);

-- Bills table
CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  home_id     TEXT NOT NULL,
  title       TEXT NOT NULL CONSTRAINT bills_title_nonempty CHECK (length(title) > 0),
  total_cents INTEGER NOT NULL CONSTRAINT bills_total_positive CHECK (total_cents > 0),
  CONSTRAINT bills_home_id_fk FOREIGN KEY (home_id) REFERENCES homes(id)
);

-- Shares table: one row per member per bill
CREATE TABLE shares (
  id          TEXT PRIMARY KEY,
  bill_id     TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CONSTRAINT shares_amount_non_negative CHECK (amount_cents >= 0),
  paid_at     TEXT DEFAULT NULL,
  idempotency_key TEXT DEFAULT NULL,
  CONSTRAINT shares_bill_id_fk FOREIGN KEY (bill_id) REFERENCES bills(id),
  CONSTRAINT shares_member_id_fk FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT shares_bill_member_unique UNIQUE (bill_id, member_id)
);
