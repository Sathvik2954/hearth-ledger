-- HearthLedger initial schema.
-- Money is stored as whole cents. typeof() checks stop SQLite's type affinity from
-- silently storing REAL or TEXT values in INTEGER columns.
-- No ON DELETE CASCADE: the API has no deletes, so the default (NO ACTION) makes any
-- delete that would orphan rows fail instead of removing data.

CREATE TABLE homes (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT homes_pk PRIMARY KEY (id),
  CONSTRAINT homes_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
  id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- 0-based insertion order within the home. Timestamps cannot do this: the Workers
  -- clock does not advance during a request, so rapid inserts can share a timestamp.
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT members_pk PRIMARY KEY (id),
  CONSTRAINT members_home_fk FOREIGN KEY (home_id) REFERENCES homes (id),
  CONSTRAINT members_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT members_position_non_negative_integer
    CHECK (typeof(position) = 'integer' AND position >= 0),
  -- Two members of one home can never share a position. Its index also serves
  -- "members of a home in order" queries.
  CONSTRAINT members_home_position_unique UNIQUE (home_id, position),
  -- Target for the shares composite foreign key below.
  CONSTRAINT members_id_home_unique UNIQUE (id, home_id)
);

CREATE TABLE bills (
  id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT bills_pk PRIMARY KEY (id),
  CONSTRAINT bills_home_fk FOREIGN KEY (home_id) REFERENCES homes (id),
  CONSTRAINT bills_title_not_blank CHECK (length(trim(title)) > 0),
  CONSTRAINT bills_total_positive_integer
    CHECK (typeof(total_cents) = 'integer' AND total_cents > 0),
  -- Target for the shares composite foreign key below.
  CONSTRAINT bills_id_home_unique UNIQUE (id, home_id)
);

CREATE INDEX bills_home_created_idx ON bills (home_id, created_at);

CREATE TABLE shares (
  id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  -- Denormalised so both composite foreign keys can pin the bill and the member
  -- to the same home: a share can never charge a member of another home.
  home_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- Zero is valid: 1 cent split between 3 members is [1, 0, 0].
  amount_cents INTEGER NOT NULL,
  paid_at TEXT,
  idempotency_key TEXT,
  CONSTRAINT shares_pk PRIMARY KEY (id),
  CONSTRAINT shares_bill_home_fk FOREIGN KEY (bill_id, home_id) REFERENCES bills (id, home_id),
  CONSTRAINT shares_member_home_fk FOREIGN KEY (member_id, home_id)
    REFERENCES members (id, home_id),
  CONSTRAINT shares_amount_non_negative_integer
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  -- Unpaid = both NULL, paid = both set. No half-paid rows.
  CONSTRAINT shares_paid_state_consistent CHECK ((paid_at IS NULL) = (idempotency_key IS NULL)),
  CONSTRAINT shares_idempotency_key_not_blank
    CHECK (idempotency_key IS NULL OR length(trim(idempotency_key)) > 0),
  -- One share per member per bill. Its index also serves "shares of a bill" queries.
  CONSTRAINT shares_bill_member_unique UNIQUE (bill_id, member_id),
  -- A key pays at most one share. SQLite UNIQUE allows many NULLs (unpaid shares).
  CONSTRAINT shares_idempotency_key_unique UNIQUE (idempotency_key)
);

-- Balances: a member's unpaid shares.
CREATE INDEX shares_member_unpaid_idx ON shares (member_id) WHERE paid_at IS NULL;
