-- Model Router (TICKET-10). FULLY ADDITIVE: one new value on the SecretType enum so a workspace can store
-- an encrypted model_route_config (named provider profiles + route table) in the existing secrets table.
-- No table/column change. Inert unless MODEL_ROUTER_ENABLED. (ALTER TYPE ... ADD VALUE runs outside a
-- transaction; applied via psql autocommit.)
ALTER TYPE "SecretType" ADD VALUE IF NOT EXISTS 'model_route_config';
