// Existing loans keep their business policy. The mirrored quota column makes
// every existing ledger/dashboard query use the same per-loan interest choice.
export const financiacionCorreccionesSchema = `
ALTER TABLE creditos ADD COLUMN IF NOT EXISTS mora_modo TEXT NOT NULL DEFAULT 'negocio' CHECK (mora_modo IN ('negocio','sin_interes'));
ALTER TABLE cuotas ADD COLUMN IF NOT EXISTS mora_modo TEXT NOT NULL DEFAULT 'negocio' CHECK (mora_modo IN ('negocio','sin_interes'));

CREATE OR REPLACE FUNCTION zilky_cuota_mora_modo() RETURNS trigger AS $$
BEGIN
  SELECT mora_modo INTO NEW.mora_modo FROM creditos WHERE id=NEW.credito_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cuotas_mora_modo_del_credito ON cuotas;
CREATE TRIGGER cuotas_mora_modo_del_credito BEFORE INSERT OR UPDATE OF credito_id,mora_modo ON cuotas
FOR EACH ROW EXECUTE FUNCTION zilky_cuota_mora_modo();

CREATE OR REPLACE FUNCTION zilky_credito_mora_modo() RETURNS trigger AS $$
BEGIN
  UPDATE cuotas SET mora_modo=NEW.mora_modo WHERE credito_id=NEW.id AND mora_modo IS DISTINCT FROM NEW.mora_modo;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS credito_mora_modo_cuotas ON creditos;
CREATE TRIGGER credito_mora_modo_cuotas AFTER UPDATE OF mora_modo ON creditos
FOR EACH ROW WHEN (OLD.mora_modo IS DISTINCT FROM NEW.mora_modo) EXECUTE FUNCTION zilky_credito_mora_modo();
`;
