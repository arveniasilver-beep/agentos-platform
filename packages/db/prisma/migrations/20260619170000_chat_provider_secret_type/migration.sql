-- Per-workspace chat "brain" provider config (Anthropic default, or an OpenAI-compatible server like
-- DeepSeek / a local vLLM serving MiMo). Stored like the other provider configs: encrypted JSON.
ALTER TYPE "SecretType" ADD VALUE IF NOT EXISTS 'chat_provider_config';
