-- Each home has exactly one currency (ISO 4217 code). All its bills, shares and balances are
-- integer minor units of that currency; amounts are never converted.
--
-- Homes created before this migration were entered in US dollars, so they become USD.
-- New homes default to INR. ADD COLUMN fills existing rows with the column default, so the
-- column is added with DEFAULT 'INR' and the rows that exist when the migration runs are
-- then set to 'USD'. Both statements are in this one file, which is applied as one unit.
ALTER TABLE homes ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR'
  CONSTRAINT homes_currency_supported CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP', 'AED'));

UPDATE homes SET currency = 'USD';
