-- Per-workspace media-generation provider configs (image + speech) for the agent's generate_image /
-- generate_speech tools. Stored like embeddings_config: provider + encrypted key.
ALTER TYPE "SecretType" ADD VALUE IF NOT EXISTS 'image_config';
ALTER TYPE "SecretType" ADD VALUE IF NOT EXISTS 'speech_config';
