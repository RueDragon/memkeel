# Checkpoint Worker

Stop, PreCompact and SessionEnd atomically enqueue a checkpoint; they no longer wait for Obsidian writes. Hook success means queued, not durably consumed. SessionStart and UserPromptSubmit also wake the detached worker so a later session recovers an interrupted drain. No timer or Windows scheduled task is installed: after a reboot recovery begins with the next hook or explicit maintenance.

On Windows, queue drains and hook session updates use named kernel mutexes derived from their respective canonical directory paths. A hidden PowerShell helper owns each mutex and observes both the Node owner's PID and start time. If that owner dies, the helper releases the mutex; if the helper dies, Windows abandons the mutex. Queue recovery uses immutable event IDs and verified capture; session recovery preserves the existing session identity. Other memory locks are unchanged. Independently terminating the helper while its Node owner keeps writing remains an unverified fault scenario.

Legacy writer.lock migration occurs only while holding this mutex. A foreign, malformed, unverifiable or live-owner legacy record blocks migration. A provably dead local record is archived, not deleted. Upgrade only when old queue-writing processes are idle; already-running MCP processes retain the old implementation until restarted.

The worker records running, idle or failed status in state/checkpoint-worker.json. Doctor reports the worker, oldest pending checkpoint and pending count; a dead running worker is reported as interrupted. Failed captures remain pending with their error. A later hook or maintenance retries them. Competing wakeups wait for the current drain before checking the queue again, avoiding a checkpoint arriving just as an earlier worker exits.

Validation includes killed-owner recovery, concurrent exclusion, refusal to take a live legacy lock, capture failure/retry, idempotence and privacy gates. Desktop automatic Stop and reboot recovery are separate host checks, not implied by unit tests.
