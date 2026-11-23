-- Deploy the receiver that omits account_hash first; it works with both schemas.
-- Remove legacy cross-install account linkage while preserving other product data.
UPDATE product_events SET account_hash = NULL WHERE account_hash IS NOT NULL;
DROP INDEX IF EXISTS idx_product_events_account_ts;
ALTER TABLE product_events DROP COLUMN account_hash;

-- Raw usage samples expire independently of the general diagnostic records.
CREATE INDEX IF NOT EXISTS idx_usage_turns_received ON usage_turns (received_at);

-- Frozen finite-vocabulary snapshot for unshipped migration0007, generated from
-- contracts productAnalytics/model and shared usageAnalytics. Preserve all counters.
UPDATE product_events SET command = CASE WHEN command IN ('shortcut:sidebar.toggle', 'shortcut:sidebar.search', 'shortcut:sidebar.activity', 'shortcut:sidebar.addProject', 'shortcut:sidebar.importThread', 'shortcut:space.previous', 'shortcut:space.next', 'shortcut:space.jump', 'shortcut:terminal.toggle', 'shortcut:terminal.split', 'shortcut:terminal.splitRight', 'shortcut:terminal.splitLeft', 'shortcut:terminal.splitDown', 'shortcut:terminal.splitUp', 'shortcut:terminal.new', 'shortcut:terminal.close', 'shortcut:terminal.workspace.newFullWidth', 'shortcut:terminal.workspace.closeActive', 'shortcut:terminal.workspace.terminal', 'shortcut:terminal.workspace.chat', 'shortcut:browser.toggle', 'shortcut:device.toggle', 'shortcut:diff.toggle', 'shortcut:diff.change.next', 'shortcut:diff.change.previous', 'shortcut:composer.focus.toggle', 'shortcut:chat.find', 'shortcut:modelPicker.toggle', 'shortcut:model.next', 'shortcut:model.previous', 'shortcut:model.effort.next', 'shortcut:traitsPicker.toggle', 'shortcut:settings.usage', 'shortcut:chat.new', 'shortcut:chat.newLatestProject', 'shortcut:chat.newChat', 'shortcut:chat.newLocal', 'shortcut:chat.newTerminal', 'shortcut:chat.newClaude', 'shortcut:chat.newCodex', 'shortcut:chat.newCursor', 'shortcut:chat.split', 'shortcut:sidechat.toggle', 'shortcut:view.recent.next', 'shortcut:view.recent.previous', 'shortcut:thread.jump', 'shortcut:thread.copyId', 'shortcut:thread.archive', 'shortcut:thread.snooze', 'shortcut:thread.markUnread', 'shortcut:chat.visible.next', 'shortcut:chat.visible.previous', 'shortcut:chat.attention.next', 'shortcut:threadTab.next', 'shortcut:threadTab.previous', 'shortcut:threadTab.close', 'shortcut:editor.openFavorite', 'shortcut:editor.file.save', 'shortcut:editor.commands', 'shortcut:editor.rename', 'shortcut:editor.goToDefinition', 'shortcut:editor.findReferences', 'shortcut:editor.goToSymbol', 'shortcut:editor.goToLine', 'shortcut:editor.problems', 'shortcut:editor.quickFix', 'shortcut:editor.debug.start', 'shortcut:editor.debug.stop', 'shortcut:editor.debug.toggleBreakpoint', 'shortcut:editor.debug.stepOver', 'shortcut:editor.debug.stepInto', 'shortcut:editor.debug.stepOut', 'shortcut:git.commitAndPush', 'shortcut:search.files', 'shortcut:search.content', 'shortcut:custom', 'slash:clear', 'slash:compact', 'slash:model', 'slash:plan', 'slash:debug', 'slash:default', 'slash:review', 'slash:fork', 'slash:side', 'slash:status', 'slash:subagents', 'slash:computer-use', 'slash:fast', 'slash:export', 'slash:goal', 'slash:rename', 'slash:feedback', 'slash:automation', 'slash:custom') THEN command
  WHEN command LIKE 'shortcut:%' THEN 'shortcut:custom' ELSE 'slash:custom' END
WHERE command IS NOT NULL;

UPDATE usage_turns SET
  provider = CASE WHEN provider IN ('codex', 'claudeAgent', 'cursor', 'antigravity', 'grok', 'droid', 'opencode', 'pi', 'devin', 'omp') THEN provider ELSE 'other' END,
  model = CASE
  WHEN provider = 'codex' AND model IN ('gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2') THEN model
  WHEN provider = 'claudeAgent' AND model IN ('claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5') THEN model
  WHEN provider = 'grok' AND model IN ('grok-4.6', 'grok-build-0.1', 'grok-build', 'grok-4.5') THEN model
  WHEN provider = 'droid' AND model IN ('auto', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-8-fast', 'claude-opus-4-7', 'claude-opus-4-7-fast', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-fast', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-fast', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-fast', 'gpt-5.2', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'glm-5.2', 'glm-5.2-fast', 'glm-5.1', 'nemotron-3-ultra', 'kimi-k2.7-code', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'minimax-m3', 'minimax-m2.7') THEN model
  WHEN provider = 'opencode' AND model IN ('openai/gpt-5') THEN model
  WHEN provider = 'cursor' AND model IN ('auto', 'composer-2.5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-4-5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-5-mini', 'grok-4.5', 'grok-4.6', 'gemini-3.1-pro', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash', 'kimi-k2.7-code', 'glm-5.2') THEN model
  WHEN provider = 'devin' AND model IN ('adaptive', 'swe-1-6', 'swe-1-7') THEN model
  ELSE 'other' END,
  effort = CASE WHEN effort IN ('default', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultrathink', 'ultracode') THEN effort ELSE 'other' END,
  interaction_mode = CASE WHEN interaction_mode IN ('default', 'plan', 'debug') THEN interaction_mode ELSE 'other' END,
  runtime_mode = CASE WHEN runtime_mode IN ('approval-required', 'auto', 'full-access') THEN runtime_mode ELSE 'other' END,
  origin = CASE WHEN origin IN ('user', 'automation', 'agent') THEN origin ELSE 'other' END;

-- The (event_id, provider) key requires merging unknown providers before deletion.
INSERT INTO usage_providers (
  event_id, install_id, day, app_version, platform, provider, threads, turns, turns_failed, received_at
)
SELECT event_id, MIN(install_id), MIN(day), MIN(app_version), MIN(platform), 'other',
       SUM(threads), SUM(turns), SUM(turns_failed), MIN(received_at)
FROM usage_providers WHERE provider NOT IN ('codex', 'claudeAgent', 'cursor', 'antigravity', 'grok', 'droid', 'opencode', 'pi', 'devin', 'omp', 'other')
GROUP BY event_id
ON CONFLICT (event_id, provider) DO UPDATE SET
  threads = usage_providers.threads + excluded.threads,
  turns = usage_providers.turns + excluded.turns,
  turns_failed = usage_providers.turns_failed + excluded.turns_failed;
DELETE FROM usage_providers WHERE provider NOT IN ('codex', 'claudeAgent', 'cursor', 'antigravity', 'grok', 'droid', 'opencode', 'pi', 'devin', 'omp', 'other');
