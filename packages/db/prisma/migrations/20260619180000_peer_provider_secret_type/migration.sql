-- The "peer" (second) chat model a workspace can consult: e.g. brain=DeepSeek, peer=MiMo-VL. Stored
-- like the primary brain config (encrypted JSON). Enables cross-model consultation + image reading.
ALTER TYPE "SecretType" ADD VALUE IF NOT EXISTS 'peer_provider_config';
